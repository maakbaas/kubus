// @vitest-environment node
// The server's HTTP endpoints, as devices and other tools reach them: the real server
// (src/index.ts) in a child process (./serve.ts) on a database of its own (KUBUS_TEST_POSTGRES).
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SYNC_VERSION, type SyncRequest, type SyncResponse } from "../../shared/sync.ts";
import type { ApiTokenInfo, ApiTokenMade } from "../../shared/tokens.ts";
import { admin, ADMIN, createDatabase, dropDatabase, sourceFor } from "./postgres.ts";
import { HEADLESS_BUILT, request, startServer, TOKEN, type RunningServer } from "./serve.ts";

const DB = "kubus_http_test";
const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
const space = (id: string, name: string, at = "2026-10-01T00:00:00.000Z") =>
  ({ id, name, icon: null, position: 0, created_at: at, updated_at: at, deleted_at: null });

describe.skipIf(!ADMIN)("the server over HTTP", () => {
  let server: RunningServer;
  let databaseUrl: string;
  let staticDir: string;
  /** A stand-in for the language model's provider (OpenAI-style), with the requests it got. */
  let provider: Server;
  let providerUrl: string;
  const providerRequests: { path: string; authorization?: string; body: string }[] = [];

  const sync = async (body: Partial<SyncRequest>) => {
    const response = await request(server, "/api/sync", { method: "POST", json: { since: 0, changes: {}, version: SYNC_VERSION, compatible: SYNC_VERSION, ...body } });
    return { status: response.status, body: (await response.json()) as SyncResponse & { error?: string; update?: string } };
  };

  const settings = (over: Record<string, unknown> = {}) => ({
    ai: { url: providerUrl, key: "sk-server", fieldModel: "small", codeModel: "big" },
    sources: [],
    ...over,
  });

  beforeAll(async () => {
    databaseUrl = await createDatabase(DB);
    staticDir = mkdtempSync(join(tmpdir(), "kubus-static-"));
    writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>Kubus</title>");
    mkdirSync(join(staticDir, "assets"));
    writeFileSync(join(staticDir, "assets", "app-123.js"), "console.log(1)");
    writeFileSync(join(staticDir, "..", "kubus-outside.txt"), "secret");
    provider = createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        providerRequests.push({ path: req.url ?? "", authorization: req.headers.authorization, body });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: "42" } }] }));
      });
    });
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
    providerUrl = `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`;
    server = await startServer(databaseUrl, { STATIC_DIR: staticDir });
  }, 30_000);

  afterAll(async () => {
    await server?.stop();
    provider?.close();
    await dropDatabase(DB);
  });

  describe("access", () => {
    it("answers its health check without the token", async () => {
      const response = await fetch(`${server.url}/api/health`);
      expect(await response.json()).toEqual({ ok: true, syncVersion: SYNC_VERSION });
    });

    it("refuses /api without the right token", async () => {
      for (const authorization of ["", "Bearer wrong", `Bearer ${TOKEN}x`, "Bearer kubus_notatoken"]) {
        const response = await request(server, "/api/settings", { headers: { Authorization: authorization } });
        expect(response.status).toBe(401);
      }
      expect((await request(server, "/api/events", { headers: { Authorization: "Bearer wrong" } })).status).toBe(401);
      expect((await request(server, "/api/v1/collections", { headers: { Authorization: "Bearer wrong" } })).status).toBe(401);
    });

    it("answers CORS preflights, for the app on another origin", async () => {
      const response = await fetch(`${server.url}/api/sync`, { method: "OPTIONS" });
      expect(response.status).toBe(204);
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      expect(response.headers.get("access-control-allow-headers")).toMatch(/Authorization/);
    });
  });

  describe("the web app", () => {
    it("serves index.html for the app's routes, revalidated", async () => {
      for (const path of ["/", "/collections/books"]) {
        const response = await fetch(`${server.url}${path}`);
        expect(response.status).toBe(200);
        expect(await response.text()).toContain("<title>Kubus</title>");
        expect(response.headers.get("cache-control")).toBe("no-cache");
      }
    });

    it("serves hashed build output as immutable", async () => {
      const response = await fetch(`${server.url}/assets/app-123.js`);
      expect(response.headers.get("content-type")).toBe("text/javascript");
      expect(response.headers.get("cache-control")).toMatch(/immutable/);
    });

    it("answers 404 for a missing file and never serves one outside its directory", async () => {
      expect((await fetch(`${server.url}/missing.png`)).status).toBe(404);
      for (const path of ["/..%2fkubus-outside.txt", "/%2e%2e/kubus-outside.txt", "/assets/..%2f..%2fkubus-outside.txt"]) {
        const response = await fetch(`${server.url}${path}`);
        expect(response.status).not.toBe(200);
        expect(await response.text()).not.toBe("secret");
      }
    });

    it("refuses other methods", async () => {
      expect((await fetch(`${server.url}/`, { method: "POST" })).status).toBe(405);
    });
  });

  describe("files", () => {
    const data = new TextEncoder().encode("a picture");
    const id = sha256(data);

    it("refuses bytes that aren't the file its id names", async () => {
      const response = await request(server, `/api/files/${sha256(new TextEncoder().encode("other"))}`, { method: "PUT", body: data, headers: { "Content-Type": "image/png" } });
      expect(response.status).toBe(400);
      expect((await request(server, `/api/files/not-an-id`, { method: "HEAD" })).status).toBe(404);
    });

    it("stores, finds, serves and deletes a file", async () => {
      expect((await request(server, `/api/files/${id}`, { method: "HEAD" })).status).toBe(404);
      expect((await request(server, `/api/files/${id}`, { method: "PUT", body: data, headers: { "Content-Type": "image/png" } })).status).toBe(200);
      // Storing it again changes nothing.
      expect((await request(server, `/api/files/${id}`, { method: "PUT", body: data, headers: { "Content-Type": "image/png" } })).status).toBe(200);
      expect((await request(server, `/api/files/${id}`, { method: "HEAD" })).status).toBe(200);
      for (const path of [`/api/files/${id}`, `/api/v1/files/${id}`]) {
        const response = await request(server, path);
        expect(response.headers.get("content-type")).toBe("image/png");
        expect(response.headers.get("cache-control")).toMatch(/immutable/);
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(data);
      }
      expect((await request(server, `/api/files/${id}`, { method: "DELETE" })).status).toBe(200);
      expect((await request(server, `/api/files/${id}`)).status).toBe(404);
    });
  });

  describe("sync", () => {
    it("stores a device's rows and gives them to the others, from their cursor on", async () => {
      const first = await sync({ changes: { spaces: [space("http-s1", "Work")] } });
      expect(first.status).toBe(200);
      expect(first.body.changes.spaces?.some((r) => r.id === "http-s1")).toBeFalsy(); // its own: not sent back
      const other = await sync({});
      expect(other.body.changes.spaces?.find((r) => r.id === "http-s1")).toMatchObject({ name: "Work" });
      expect(other.body.database.id).toBe(first.body.database.id);
      const later = await sync({ since: other.body.cursor });
      expect(later.body.changes.spaces ?? []).toEqual([]);
    });

    it("keeps the latest write of a row", async () => {
      await sync({ changes: { spaces: [space("http-s2", "New", "2026-10-03T00:00:00.000Z")] } });
      await sync({ changes: { spaces: [space("http-s2", "Old", "2026-10-02T00:00:00.000Z")] } });
      expect((await sync({})).body.changes.spaces?.find((r) => r.id === "http-s2")).toMatchObject({ name: "New" });
    });

    it("answers 409 to a device of another database and 426 to one of another version, writing nothing", async () => {
      const mismatch = await sync({ database: "another", changes: { spaces: [space("http-s3", "Lost")] } });
      expect(mismatch.status).toBe(409);
      expect(mismatch.body.error).toMatch(/wiped or replaced/);
      const outdated = await sync({ version: 0, compatible: 0, changes: { spaces: [space("http-s3", "Lost")] } });
      expect(outdated.status).toBe(426);
      expect(outdated.body.update).toBe("app");
      const newer = await sync({ version: SYNC_VERSION + 1, compatible: SYNC_VERSION + 1, changes: { spaces: [space("http-s3", "Lost")] } });
      expect(newer.status).toBe(426);
      expect(newer.body.update).toBe("server");
      expect((await sync({})).body.changes.spaces?.some((r) => r.id === "http-s3")).toBeFalsy();
    });

    it("refuses a body that isn't a sync request", async () => {
      const response = await request(server, "/api/sync", { method: "POST", body: "not json", headers: { "Content-Type": "application/json" } });
      expect(response.status).toBe(400);
    });

    it("signals connected devices after a write, with its cursor", async () => {
      const controller = new AbortController();
      const events = await request(server, "/api/events", { signal: controller.signal });
      expect(events.headers.get("content-type")).toBe("text/event-stream");
      const reader = events.body!.getReader();
      const written = await sync({ changes: { spaces: [space("http-s4", "Signal")] } });
      let text = "";
      while (!text.includes(`data: ${written.body.cursor}\n`)) text += new TextDecoder().decode((await reader.read()).value);
      controller.abort();
    });
  });

  describe("settings, language model and sources", () => {
    it("never gives a secret back", async () => {
      const response = await request(server, "/api/settings", { method: "PUT", json: settings() });
      expect(response.status).toBe(200);
      const view = await (await request(server, "/api/settings")).json();
      expect(view.ai).toEqual({ url: providerUrl, fieldModel: "small", codeModel: "big", keySet: true });
      expect(JSON.stringify(view)).not.toContain("sk-server");
      expect(await (await request(server, "/api/ai")).json()).toEqual({ available: true, fieldModel: "small", codeModel: "big" });
    });

    it("refuses settings it can't store", async () => {
      expect((await request(server, "/api/settings", { method: "PUT", json: { ai: {} } })).status).toBe(400);
      expect((await request(server, "/api/settings", { method: "PUT", json: settings({ ai: { url: "ftp://model" } }) })).status).toBe(400);
    });

    it("forwards a device's model requests with its own key", async () => {
      providerRequests.length = 0;
      const response = await request(server, "/api/ai/chat/completions", { method: "POST", json: { model: "small", messages: [] } });
      expect(await response.json()).toEqual({ choices: [{ message: { content: "42" } }] });
      expect(providerRequests).toEqual([{ path: "/v1/chat/completions", authorization: "Bearer sk-server", body: JSON.stringify({ model: "small", messages: [] }) }]);
    });

    it("stores its secrets encrypted with KUBUS_SECRET_KEY, also those stored before it was set", async () => {
      await request(server, "/api/settings", { method: "PUT", json: settings() });
      const stored = async () => {
        const db = new pg.Client({ connectionString: databaseUrl });
        await db.connect();
        try {
          return JSON.stringify((await db.query("SELECT value FROM server_settings")).rows);
        } finally {
          await db.end();
        }
      };
      expect(await stored()).toContain("sk-server");
      const keyed = await startServer(databaseUrl, { KUBUS_SECRET_KEY: "test-secret-key" });
      try {
        for (const started = Date.now(); (await stored()).includes("sk-server") && Date.now() - started < 10_000; ) await new Promise((r) => setTimeout(r, 50));
        expect(await stored()).not.toContain("sk-server");
        expect(await stored()).toContain("kubus-sealed:v1:");
        expect((await (await request(keyed, "/api/settings")).json()).ai.keySet).toBe(true);
        providerRequests.length = 0;
        await request(keyed, "/api/ai/chat/completions", { method: "POST", json: { model: "small", messages: [] } });
        expect(providerRequests[0]?.authorization).toBe("Bearer sk-server");
      } finally {
        await keyed.stop();
      }
    });

    it("says so when it offers no model, or can't reach it", async () => {
      await request(server, "/api/settings", { method: "PUT", json: settings({ ai: { url: "http://127.0.0.1:9/v1", fieldModel: "small" } }) });
      expect((await request(server, "/api/ai/models")).status).toBe(502);
      await request(server, "/api/settings", { method: "PUT", json: settings({ ai: { url: "", fieldModel: "" } }) });
      expect(await (await request(server, "/api/ai")).json()).toMatchObject({ available: false });
      expect((await request(server, "/api/ai/models")).status).toBe(404);
    });

    it("reads a source with its connector, keeping its password to itself", async () => {
      const self = sourceFor(DB);
      const sources = [
        { name: "Self", ...self, schemas: [], timeoutSeconds: 10 },
        { name: "Odd", kind: "d1", fields: { account: "", database: "" }, schemas: [], timeoutSeconds: 10 },
      ];
      expect((await request(server, "/api/settings", { method: "PUT", json: settings({ sources }) })).status).toBe(200);
      const view = await (await request(server, "/api/settings")).json();
      const shown = view.sources.find((s: { name: string }) => s.name === "Self");
      expect(shown).toMatchObject({ connector: "postgres", kind: "postgres", fields: self.fields, passwordSet: self.password !== "" });
      expect(shown).not.toHaveProperty("password");
      expect(shown.warnings.join()).toMatch(/superuser/);
      expect(view.sources.find((s: { name: string }) => s.name === "Odd").problem).toMatch(/account ID and database ID/);

      expect(await (await request(server, "/api/sources")).json()).toEqual([
        { name: "Self", connector: "postgres" },
        { name: "Odd", connector: "none", problem: expect.stringMatching(/account ID/) },
      ]);
      const tables = await (await request(server, "/api/sources/Self/tables")).json();
      expect(tables).toContainEqual({ schema: "public", name: "spaces", type: "table" });
      const query = await request(server, "/api/sources/Self/query", {
        method: "POST",
        json: {
          target: { table: { schema: "public", name: "spaces" } }, key: "id", columns: ["name"], title: ["name"], untitled: "Space",
          filter: { and: [{ column: "name", operator: "is", value: "Work" }] }, search: "", sort: [], groupBy: null, timeZone: "UTC", offset: 0, limit: 10, counts: true,
        },
      });
      expect(await query.json()).toMatchObject({ rows: [{ key: "http-s1", values: ["Work"] }], total: 1 });
    });

    it("still reads a renamed source by its former name", async () => {
      const view = await (await request(server, "/api/settings")).json();
      const sources = view.sources.map(({ passwordSet: _p, connector: _c, problem: _pr, warnings: _w, ...s }: { name: string; passwordSet: unknown; connector: unknown; problem: unknown; warnings: unknown }) =>
        s.name === "Self" ? { ...s, name: "My Self" } : s,
      );
      expect((await request(server, "/api/settings", { method: "PUT", json: settings({ sources }) })).status).toBe(200);
      expect(await (await request(server, "/api/sources")).json()).toContainEqual(expect.objectContaining({ name: "My Self", formerNames: ["Self"] }));
      expect((await request(server, "/api/sources/My%20Self/tables")).status).toBe(200);
      expect((await request(server, "/api/sources/Self/tables")).status).toBe(200);
      // Back as it was, for the tests below.
      const back = sources.map((s: { name: string }) => (s.name === "My Self" ? { ...s, name: "Self" } : s));
      expect((await request(server, "/api/settings", { method: "PUT", json: settings({ sources: back }) })).status).toBe(200);
    });

    it("answers 404 for an unknown source, 502 for one it can't read, 400 for a request it can't answer", async () => {
      expect((await request(server, "/api/sources/Nope/tables")).status).toBe(404);
      expect((await request(server, "/api/sources/Odd/tables")).status).toBe(502);
      expect((await request(server, "/api/sources/Self/describe", { method: "POST", json: { target: { table: { schema: "public", name: "nothing_here" } } } })).status).toBe(400);
      expect((await request(server, "/api/sources/Self/describe", { method: "POST", json: {} })).status).toBe(400);
    });
  });

  describe.skipIf(!HEADLESS_BUILT)("the HTTP API (the headless device)", () => {
    /** The API, once its device has started and synced. */
    const api = async (path: string, init: RequestInit & { json?: unknown } = {}) => {
      for (let i = 0; i < 100; i++) {
        const response = await request(server, `/api/v1${path}`, init);
        if (response.status !== 503) return response;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(`The API didn't start:\n${server.output()}`);
    };

    it("writes through the device to the server's database, and reads what devices synced", async () => {
      const created = await api("/collections", { method: "POST", json: { name: "Book", fields: [{ name: "Title", kind: "string" }] } });
      expect(created.status).toBe(201);
      const item = await (await api("/collections/Book/items", { method: "POST", json: { values: { Title: "Dune" } } })).json();
      expect(item).toMatchObject({ collection: "Book", label: "Dune", values: { Title: "Dune" } });
      // Confirmed writes are on the server: another device gets them.
      expect((await sync({})).body.changes.items?.map((r) => r.id)).toContain(item.id);
      // A device's write reaches the API.
      await sync({ changes: { spaces: [space("http-s5", "From a device", new Date().toISOString())] } });
      let names: string[] = [];
      for (let i = 0; i < 50 && !names.includes("From a device"); i++) {
        names = ((await (await api("/spaces")).json()) as { name: string }[]).map((s) => s.name);
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(names).toContain("From a device");
    });

    it("answers 404 for what isn't there", async () => {
      expect((await api("/collections/Nothing")).status).toBe(404);
    });

    it("is an MCP server whose tools go through the API", async () => {
      await api("/collections"); // started
      const rpc = async (message: unknown, headers: Record<string, string> = { "MCP-Protocol-Version": "2025-11-25" }) => {
        const response = await request(server, "/api/v1/mcp", { method: "POST", json: message, headers: { Accept: "application/json, text/event-stream", ...headers } });
        return { status: response.status, type: response.headers.get("content-type"), body: response.status === 202 ? null : await response.json() };
      };
      const init = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } } }, {});
      expect(init).toMatchObject({ status: 200, type: "application/json", body: { result: { protocolVersion: "2025-11-25", capabilities: { tools: {} } } } });
      expect((await rpc({ jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
      const tools = (await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" })).body.result.tools.map((t: { name: string }) => t.name);
      expect(tools).toEqual(expect.arrayContaining(["search", "list_items", "create_item"]));
      const created = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "create_item", arguments: { collection: "Book", values: { Title: "Through MCP" } } } });
      expect(created.body.result.structuredContent).toMatchObject({ label: "Through MCP" });
      const found = await rpc({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "search", arguments: { q: "through mcp" } } });
      expect(found.body.result.structuredContent.items.map((i: { id: string }) => i.id)).toEqual([created.body.result.structuredContent.id]);
      const missing = await rpc({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "get_collection", arguments: { collection: "Nothing" } } });
      expect(missing.body.result.isError).toBe(true);

      expect((await request(server, "/api/v1/mcp", { method: "POST", json: { jsonrpc: "2.0", id: 1, method: "ping" }, headers: { Authorization: "Bearer wrong" } })).status).toBe(401);
      expect((await request(server, "/api/v1/mcp")).status).toBe(405);
      expect((await fetch(`${server.url}/.well-known/oauth-protected-resource`)).status).toBe(404);
    });
  });

  describe("API tokens", () => {
    const make = async (body: unknown) => {
      const response = await request(server, "/api/tokens", { method: "POST", json: body });
      return { status: response.status, body: (await response.json()) as ApiTokenMade & { error?: string } };
    };
    const as = (token: string, path: string, init: RequestInit & { json?: unknown } = {}) =>
      request(server, path, { ...init, headers: { Authorization: `Bearer ${token}` } });
    const list = async () => (await (await request(server, "/api/tokens")).json()) as ApiTokenInfo[];

    it("are made, listed without the token, and revoked by devices", async () => {
      const made = await make({ name: " Scripts ", access: "write" });
      expect(made.status).toBe(201);
      expect(made.body).toMatchObject({ name: "Scripts", access: "write", lastUsedAt: null });
      expect(made.body.token).toMatch(/^kubus_[A-Za-z0-9_-]{43}$/);
      const listed = (await list()).find((t) => t.id === made.body.id);
      expect(listed).toEqual({ id: made.body.id, name: "Scripts", access: "write", createdAt: made.body.createdAt, lastUsedAt: null });
      expect(JSON.stringify(await list())).not.toContain(made.body.token);
      expect((await as(made.body.token, "/api/v1/collections/Nothing")).status).not.toBe(401);
      expect((await request(server, `/api/tokens/${made.body.id}`, { method: "DELETE" })).status).toBe(200);
      expect((await request(server, `/api/tokens/${made.body.id}`, { method: "DELETE" })).status).toBe(404);
      expect((await list()).some((t) => t.id === made.body.id)).toBe(false);
      expect((await as(made.body.token, "/api/v1/collections")).status).toBe(401);
    });

    it("refuse a token without a name or access", async () => {
      expect((await make({ name: "", access: "read" })).status).toBe(400);
      expect((await make({ name: "x", access: "all" })).status).toBe(400);
      expect((await make(null)).status).toBe(400);
    });

    it("reach only /api/v1, never the devices' endpoints", async () => {
      const { token } = (await make({ name: "Everything", access: "write" })).body;
      for (const [method, path] of [["POST", "/api/sync"], ["GET", "/api/settings"], ["GET", "/api/tokens"], ["POST", "/api/tokens"], ["GET", "/api/events"], ["GET", "/api/ai"], ["POST", "/api/wipe"]]) {
        const response = await as(token, path, { method, ...(method === "POST" && { json: {} }) });
        expect(response.status, `${method} ${path}`).toBe(403);
        expect((await response.json()).error).toMatch(/only the API/);
      }
    });

    it("of read access only read: every write is refused with 403", async () => {
      const { token } = (await make({ name: "Reader", access: "read" })).body;
      for (const [method, path] of [["POST", "/api/v1/collections"], ["PATCH", "/api/v1/items/x"], ["DELETE", "/api/v1/items/x"], ["PUT", "/api/v1/items/x/ai/Summary"], ["POST", "/api/v1/files"]]) {
        const response = await as(token, path, { method });
        expect(response.status, `${method} ${path}`).toBe(403);
        expect((await response.json()).error).toMatch(/can only read/);
      }
      expect([200, 503]).toContain((await as(token, "/api/v1/collections")).status);
      expect([200, 404]).toContain((await as(token, "/api/v1/files/0000000000000000000000000000000000000000000000000000000000000000", { method: "HEAD" })).status);
    });

    it("reach the MCP server, a read one without its write tools", async () => {
      const { token } = (await make({ name: "Assistant", access: "read" })).body;
      const rpc = async (message: unknown) =>
        (await (await request(server, "/api/v1/mcp", {
          method: "POST",
          json: message,
          headers: { Authorization: `Bearer ${token}`, Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-11-25" },
        })).json()) as { result?: { tools: { name: string }[] }; error?: unknown };
      const tools = (await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" })).result!.tools.map((t) => t.name);
      expect(tools).toContain("search");
      expect(tools).not.toContain("create_item");
      const refused = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "create_item", arguments: { collection: "Book", values: {} } } });
      expect(refused.error).toBeDefined();
    });

    it("note when they were last used", async () => {
      const made = (await make({ name: "Cron", access: "read" })).body;
      await as(made.token, "/api/v1/collections");
      let used: string | null = null;
      for (let i = 0; i < 50 && !used; i++) {
        used = (await list()).find((t) => t.id === made.id)?.lastUsedAt ?? null;
        if (!used) await new Promise((r) => setTimeout(r, 50));
      }
      expect(used).not.toBeNull();
      expect(Date.parse(used!)).toBeGreaterThanOrEqual(Date.parse(made.createdAt));
    });
  });

  describe("wiping", () => {
    it("needs to be confirmed in so many words", async () => {
      expect((await request(server, "/api/wipe", { method: "POST", json: {} })).status).toBe(400);
    });

    it("drops the devices' data, the server's settings and API tokens, and makes a new database", async () => {
      const before = (await sync({})).body.database.id;
      await request(server, "/api/settings", { method: "PUT", json: settings() });
      const made = (await (await request(server, "/api/tokens", { method: "POST", json: { name: "Kept", access: "read" } })).json()) as ApiTokenMade;
      expect((await request(server, "/api/wipe", { method: "POST", json: { confirm: "wipe" } })).status).toBe(200);
      const after = await sync({ database: before });
      expect(after.status).toBe(409);
      const fresh = await sync({});
      expect(fresh.body.database.id).not.toBe(before);
      expect(fresh.body.changes.spaces?.some((r) => r.id === "http-s1")).toBeFalsy();
      expect((await (await request(server, "/api/settings")).json()).ai.keySet).toBe(false);
      expect((await (await request(server, "/api/ai")).json()).available).toBe(false);
      expect(((await (await request(server, "/api/tokens")).json()) as ApiTokenInfo[]).map((t) => t.id)).not.toContain(made.id);
      expect((await request(server, "/api/v1/collections", { headers: { Authorization: `Bearer ${made.token}` } })).status).toBe(401);
    });
  });
});

describe.skipIf(!ADMIN)("a server on a database migrated by a newer one", () => {
  const NEWER = "kubus_http_newer_test";
  let server: RunningServer;

  beforeAll(async () => {
    const url = await createDatabase(NEWER);
    await admin("CREATE TABLE schema_migrations (version integer PRIMARY KEY, description text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()); INSERT INTO schema_migrations VALUES (999, 'from the future');", NEWER);
    server = await startServer(url);
  }, 30_000);

  afterAll(async () => {
    await server?.stop();
    await dropDatabase(NEWER);
  });

  it("starts, but refuses to sync until it is wiped", async () => {
    expect(server.output()).toMatch(/newer Kubus server/);
    const refused = await request(server, "/api/sync", { method: "POST", json: { since: 0, changes: {}, version: SYNC_VERSION, compatible: SYNC_VERSION } });
    expect(refused.status).toBe(500);
    expect((await refused.json()).error).toMatch(/doesn't fit its schema/);
    expect((await request(server, "/api/wipe", { method: "POST", json: { confirm: "wipe" } })).status).toBe(200);
    expect((await request(server, "/api/sync", { method: "POST", json: { since: 0, changes: {}, version: SYNC_VERSION, compatible: SYNC_VERSION } })).status).toBe(200);
  });
});
