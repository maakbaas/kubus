// @vitest-environment node
// The MCP endpoint (server/src/mcp.ts) without a server: the protocol, the tools a token's access
// offers, and each tool call as the /api/v1 request it makes (a fake API answers).
import { describe, expect, it } from "vitest";
import { handleMcp, PROTOCOL_VERSIONS, TOOLS } from "../src/mcp.ts";
import type { Access } from "../src/tokens.ts";
import { HttpError, type ApiRequest, type ApiResponse } from "../../shared/router.ts";

interface Seen {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
}

/** A fake /api/v1 answering `respond`, with the requests it got. */
function fakeApi(respond: (req: Seen) => ApiResponse | Promise<ApiResponse> = () => ({ status: 200, json: { ok: true } })) {
  const seen: Seen[] = [];
  const api = async (req: ApiRequest) => {
    const text = new TextDecoder().decode(await req.body(1024 * 1024));
    const got = { method: req.method, path: req.path, query: Object.fromEntries(req.query), body: text ? JSON.parse(text) : undefined };
    seen.push(got);
    return respond(got);
  };
  return { api, seen };
}

/** A request to the MCP endpoint: `body` as JSON (a string as is). */
async function mcp(body: unknown, { access = "all" as Access, method = "POST", headers = {} as Record<string, string>, api = fakeApi().api } = {}) {
  const data = new TextEncoder().encode(typeof body === "string" ? body : JSON.stringify(body));
  const answer = await handleMcp(
    { method, path: "/api/v1/mcp", query: new URLSearchParams(), headers: { host: "notes.example.com", "content-type": "application/json", ...headers }, body: async () => data },
    access,
    api,
  );
  return answer as ApiResponse & { json: any };
}

const call = (name: string, args?: unknown, id = 1) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, ...(args !== undefined && { arguments: args }) } });

describe("the MCP endpoint", () => {
  describe("protocol", () => {
    it("initializes with the client's version when it knows it, else its newest", async () => {
      const known = await mcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
      expect(known.status).toBe(200);
      expect(known.json).toMatchObject({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "kubus" } } });
      expect(known.json.result.instructions).toMatch(/list_collections/);
      const unknown = await mcp({ jsonrpc: "2.0", id: "a", method: "initialize", params: { protocolVersion: "2099-01-01" } });
      expect(unknown.json.result.protocolVersion).toBe(PROTOCOL_VERSIONS[0]);
      expect(unknown.json.id).toBe("a");
    });

    it("accepts notifications and responses with 202 and no body", async () => {
      for (const message of [{ jsonrpc: "2.0", method: "notifications/initialized" }, { jsonrpc: "2.0", id: 9, result: {} }]) {
        const answer = await mcp(message);
        expect(answer.status).toBe(202);
        expect(answer.json).toBeUndefined();
      }
    });

    it("answers pings, and unknown methods with a JSON-RPC error", async () => {
      expect((await mcp({ jsonrpc: "2.0", id: 2, method: "ping" })).json).toEqual({ jsonrpc: "2.0", id: 2, result: {} });
      expect((await mcp({ jsonrpc: "2.0", id: 3, method: "resources/list" })).json.error.code).toBe(-32601);
      expect((await mcp({ id: 4, method: "ping" })).json.error.code).toBe(-32600);
    });

    it("refuses what isn't JSON, other methods than POST, other sites and unknown protocol versions", async () => {
      const unparsable = await mcp("{nope");
      expect(unparsable.status).toBe(400);
      expect(unparsable.json.error.code).toBe(-32700);
      const get = await mcp(undefined, { method: "GET" });
      expect(get.status).toBe(405);
      expect(get.headers?.Allow).toBe("POST");
      expect((await mcp({ jsonrpc: "2.0", id: 1, method: "ping" }, { headers: { origin: "https://evil.example" } })).status).toBe(403);
      expect((await mcp({ jsonrpc: "2.0", id: 1, method: "ping" }, { headers: { origin: "https://notes.example.com" } })).status).toBe(200);
      expect((await mcp({ jsonrpc: "2.0", id: 1, method: "ping" }, { headers: { origin: "https://kubus.example", host: "127.0.0.1:8080", "x-forwarded-host": "kubus.example" } })).status).toBe(200);
      expect((await mcp({ jsonrpc: "2.0", id: 1, method: "ping" }, { headers: { "mcp-protocol-version": "1999-01-01" } })).status).toBe(400);
      expect((await mcp({ jsonrpc: "2.0", id: 1, method: "ping" }, { headers: { "mcp-protocol-version": "2025-06-18" } })).status).toBe(200);
    });

    it("answers a batch in protocol 2025-03-26 only", async () => {
      const batch = [{ jsonrpc: "2.0", id: 1, method: "ping" }, { jsonrpc: "2.0", method: "notifications/initialized" }, { jsonrpc: "2.0", id: 2, method: "ping" }];
      const old = await mcp(batch, { headers: { "mcp-protocol-version": "2025-03-26" } });
      expect(old.json.map((r: { id: number }) => r.id)).toEqual([1, 2]);
      expect((await mcp(batch, { headers: { "mcp-protocol-version": "2025-11-25" } })).status).toBe(400);
    });
  });

  describe("tools", () => {
    const names = async (access: Access) => ((await mcp({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { access })).json.result.tools as { name: string }[]).map((t) => t.name);

    it("lists every tool to a token that writes, only those that read to one that reads", async () => {
      expect(await names("all")).toEqual(TOOLS.map((t) => t.name));
      expect(await names("write")).toEqual(TOOLS.map((t) => t.name));
      const read = await names("read");
      expect(read).toContain("search");
      expect(read).not.toContain("create_item");
      expect(read).toHaveLength(TOOLS.filter((t) => !t.writes).length);
    });

    it("describes each tool with a schema and hints", async () => {
      const { tools } = (await mcp({ jsonrpc: "2.0", id: 1, method: "tools/list" })).json.result;
      const byName = (n: string) => tools.find((t: { name: string }) => t.name === n);
      expect(byName("list_items").inputSchema).toMatchObject({ type: "object", required: ["collection"] });
      expect(byName("get_item").annotations).toMatchObject({ readOnlyHint: true });
      expect(byName("create_item").annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
      expect(byName("delete_item").annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true });
    });

    it("refuses a tool that writes to a token that reads, without calling the API", async () => {
      const { api, seen } = fakeApi();
      const refused = await mcp(call("create_item", { collection: "Book", values: {} }), { access: "read", api });
      expect(refused.json.error).toMatchObject({ code: -32602, message: expect.stringMatching(/only reads/) });
      expect((await mcp(call("nope"), { api })).json.error.code).toBe(-32602);
      expect(seen).toEqual([]);
    });

    it("makes each call the /api/v1 request it stands for", async () => {
      const cases: [string, Record<string, unknown>, Seen][] = [
        ["search", { q: "dune", limit: 5 }, { method: "GET", path: "/api/v1/search", query: { q: "dune", limit: "5" }, body: undefined }],
        ["list_collections", {}, { method: "GET", path: "/api/v1/collections", query: {}, body: undefined }],
        ["get_collection", { collection: "Reading list" }, { method: "GET", path: "/api/v1/collections/Reading%20list", query: {}, body: undefined }],
        [
          "list_items",
          { collection: "Book", filters: [{ fieldId: "Read", operator: "isChecked" }], sort: [{ fieldId: "Title", direction: "asc" }], space: "Work", offset: 10 },
          { method: "GET", path: "/api/v1/collections/Book/items", query: { space: "Work", filters: '[{"fieldId":"Read","operator":"isChecked"}]', sort: '[{"fieldId":"Title","direction":"asc"}]', offset: "10" }, body: undefined },
        ],
        ["get_item", { id: "a/b" }, { method: "GET", path: "/api/v1/items/a%2Fb", query: {}, body: undefined }],
        ["view_items", { collection: "Book", view: "Unread", block: "Table" }, { method: "GET", path: "/api/v1/collections/Book/views/Unread/items", query: { block: "Table" }, body: undefined }],
        ["create_item", { collection: "Book", values: { Title: "Dune" } }, { method: "POST", path: "/api/v1/collections/Book/items", query: {}, body: { values: { Title: "Dune" } } }],
        ["update_item", { id: "x", values: { Pages: 1 } }, { method: "PATCH", path: "/api/v1/items/x", query: {}, body: { values: { Pages: 1 } } }],
        ["delete_item", { id: "x" }, { method: "DELETE", path: "/api/v1/items/x", query: {}, body: undefined }],
      ];
      for (const [name, args, expected] of cases) {
        const { api, seen } = fakeApi();
        await mcp(call(name, args), { api });
        expect(seen, name).toEqual([expected]);
      }
    });

    it("uploads an image as its bytes, of the type given or a data: URL's", async () => {
      const got: { path: string; type: string; bytes: number[] }[] = [];
      const api = async (req: ApiRequest): Promise<ApiResponse> => {
        got.push({ path: req.path, type: req.headers["content-type"] ?? "", bytes: [...(await req.body(1024))] });
        return { status: 201, json: { id: "abc", src: "files/abc" } };
      };
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64");
      const answer = await mcp(call("upload_image", { data: png, mimeType: "image/png" }), { api });
      expect(answer.json.result.structuredContent).toEqual({ id: "abc", src: "files/abc" });
      await mcp(call("upload_image", { data: `data:image/webp;base64,${png}` }), { api });
      expect(got).toEqual([
        { path: "/api/v1/files", type: "image/png", bytes: [0x89, 0x50, 0x4e, 0x47] },
        { path: "/api/v1/files", type: "image/webp", bytes: [0x89, 0x50, 0x4e, 0x47] },
      ]);
    });

    it("gives the answer as JSON text and structured content, a list under its name", async () => {
      const { api } = fakeApi((req) => ({ status: 200, json: req.path.endsWith("/collections") ? [{ name: "Book" }] : { id: "x", label: "Dune" } }));
      const item = (await mcp(call("get_item", { id: "x" }), { api })).json.result;
      expect(item).toEqual({ content: [{ type: "text", text: '{"id":"x","label":"Dune"}' }], structuredContent: { id: "x", label: "Dune" } });
      const list = (await mcp(call("list_collections"), { api })).json.result;
      expect(list.structuredContent).toEqual({ collections: [{ name: "Book" }] });
      expect(JSON.parse(list.content[0].text)).toEqual([{ name: "Book" }]);
    });

    it("turns the API's refusals and missing arguments into error results the model can act on", async () => {
      const { api, seen } = fakeApi(() => ({ status: 404, json: { error: "No collection “Films”" } }));
      const missing = (await mcp(call("get_collection", {}), { api })).json.result;
      expect(missing).toMatchObject({ isError: true, content: [{ type: "text", text: "Missing: collection" }] });
      expect(seen).toEqual([]);
      const refused = (await mcp(call("get_collection", { collection: "Films" }), { api })).json.result;
      expect(refused).toEqual({ isError: true, content: [{ type: "text", text: "No collection “Films” (HTTP 404)" }] });
      const thrown = async () => {
        throw new HttpError(503, "The API is starting");
      };
      expect((await mcp(call("list_spaces"), { api: thrown })).json.result).toMatchObject({ isError: true, content: [{ text: "The API is starting (HTTP 503)" }] });
    });
  });
});
