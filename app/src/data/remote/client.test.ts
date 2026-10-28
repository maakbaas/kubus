import { afterEach, describe, expect, it, vi } from "vitest";
import type { SourceQuery } from "../../../../shared/sources";
import { SourcesClient } from "./client";

const query = (over: Partial<SourceQuery> = {}): SourceQuery => ({
  target: { table: { schema: null, name: "people" } }, key: "id", columns: ["name"], title: ["name"], untitled: "Person",
  filter: { and: [] }, search: "", sort: [], groupBy: null, groupOrder: "asc", timeZone: "UTC", offset: 0, limit: 10, counts: true, ...over,
});

afterEach(() => vi.unstubAllGlobals());

describe("SourcesClient", () => {
  it("asks a query on its way once, and again once it is answered", async () => {
    const asked: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      asked.push(`${url} ${init.body}`);
      return Response.json({ rows: [], more: false, total: asked.length });
    });
    const client = new SourcesClient(() => ({ url: "https://kubus.example", token: "t" }) as never);
    const [a, b, other, elsewhere] = await Promise.all([
      client.query("db", query()),
      client.query("db", query()),
      client.query("db", query({ offset: 10 })),
      client.query("files", query()),
    ]);
    expect(a).toBe(b);
    expect(asked).toHaveLength(3);
    expect(other).not.toBe(a);
    expect(elsewhere).not.toBe(a);
    await client.query("db", query());
    expect(asked).toHaveLength(4);
  });
  it("forgets a query that failed", async () => {
    let fail = true;
    vi.stubGlobal("fetch", async () => (fail ? Response.json({ error: "down" }, { status: 502 }) : Response.json({ rows: [], more: false })));
    const client = new SourcesClient(() => ({ url: "https://kubus.example", token: "t" }) as never);
    await expect(client.query("db", query())).rejects.toThrow("down");
    fail = false;
    await expect(client.query("db", query())).resolves.toEqual({ rows: [], more: false });
  });
});

/** A client whose fetch is recorded: answers `answer` (default: an empty object). */
function recorded(answer: () => Response = () => Response.json({})) {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return answer();
  });
  const client = new SourcesClient(() => ({ url: "https://kubus.example", token: "tok" }) as never);
  return { client, calls };
}
const headers = (init: RequestInit) => init.headers as Record<string, string>;

describe("SourcesClient requests", () => {
  it("asks with the sync token: reads are GETs, the rest JSON posts", async () => {
    const { client, calls } = recorded(() => Response.json({ row: { key: "1", values: ["a"] } }));
    await client.list();
    await client.tables("my db");
    await client.describe("db", { query: "select 1" });
    expect(await client.row("db", { target: { query: "q" }, key: "id", columns: ["a"], title: ["a"], untitled: "R", keyValue: "1" })).toEqual({ key: "1", values: ["a"] });
    expect(calls.map((c) => [c.init.method, c.url])).toEqual([
      ["GET", "https://kubus.example/api/sources"],
      ["GET", "https://kubus.example/api/sources/my%20db/tables"],
      ["POST", "https://kubus.example/api/sources/db/describe"],
      ["POST", "https://kubus.example/api/sources/db/row"],
    ]);
    expect(headers(calls[0].init)).toEqual({ Authorization: "Bearer tok" });
    expect(headers(calls[2].init)).toEqual({ Authorization: "Bearer tok", "Content-Type": "application/json" });
    expect(JSON.parse(String(calls[2].init.body))).toEqual({ target: { query: "select 1" } });
    expect(calls[0].init.body).toBeUndefined();
  });

  it("answers null for a row the source doesn't have", async () => {
    const { client } = recorded(() => Response.json({ row: null }));
    expect(await client.row("db", { target: { query: "q" }, key: "id", columns: [], title: [], untitled: "R", keyValue: "9" })).toBeNull();
  });

  it("reads and stores the server's settings, and handles its API tokens", async () => {
    const { client, calls } = recorded();
    await client.serverSettings();
    await client.saveServerSettings({ ai: { url: "", fieldModel: "", codeModel: "" }, sources: [] });
    await client.apiTokens();
    await client.makeApiToken({ name: "n8n", access: "read" });
    await client.revokeApiToken("a/b");
    expect(calls.map((c) => [c.init.method, c.url.replace("https://kubus.example", "")])).toEqual([
      ["GET", "/api/settings"],
      ["PUT", "/api/settings"],
      ["GET", "/api/tokens"],
      ["POST", "/api/tokens"],
      ["DELETE", "/api/tokens/a%2Fb"],
    ]);
    expect(JSON.parse(String(calls[3].init.body))).toEqual({ name: "n8n", access: "read" });
  });
});

describe("SourcesClient errors", () => {
  it("asks for a server where there is none or no token", async () => {
    const fetched = vi.fn();
    vi.stubGlobal("fetch", fetched);
    for (const config of [{ url: "", token: "t" }, { url: "https://kubus.example", token: "" }]) {
      await expect(new SourcesClient(() => config as never).list()).rejects.toThrow(/Settings → Server/);
    }
    expect(fetched).not.toHaveBeenCalled();
  });

  it("says the server can't be reached when the request fails", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("network down");
    });
    await expect(new SourcesClient(() => ({ url: "https://kubus.example", token: "t" }) as never).tables("db")).rejects.toThrow("The Kubus server can't be reached");
  });

  it("passes on the server's message, or the status when it gave none", async () => {
    const answers = [Response.json({ error: "No source" }, { status: 404 }), new Response("<html>bad gateway</html>", { status: 502 })];
    const { client } = recorded(() => answers.shift()!);
    await expect(client.tables("x")).rejects.toThrow("No source");
    await expect(client.tables("x")).rejects.toThrow("The server answered 502");
  });
});

describe("SourcesClient rows shown", () => {
  const item = (collectionId: string, id: string) => ({ id, collectionId, spaceId: "default", values: {}, createdAt: "", updatedAt: "" }) as never;
  const client = () => new SourcesClient(() => ({ url: "u", token: "t" }) as never);

  it("remembers rows as shown, for an item page opened from a list", () => {
    const c = client();
    const a = item("c1", "1");
    c.remember([a, item("c1", "2")]);
    expect(c.shownItem("c1", "1")).toBe(a);
    expect(c.shownItem("c2", "1")).toBeUndefined();
    const newer = item("c1", "1");
    c.remember([newer]);
    expect(c.shownItem("c1", "1")).toBe(newer);
  });

  it("forgets the longest ago shown once 1000 are remembered", () => {
    const c = client();
    c.remember(Array.from({ length: 1002 }, (_, i) => item("c", String(i))));
    expect(c.shownItem("c", "0")).toBeUndefined();
    expect(c.shownItem("c", "1")).toBeUndefined();
    expect(c.shownItem("c", "2")).toBeDefined();
    expect(c.shownItem("c", "1001")).toBeDefined();
    c.remember([item("c", "2")]); // shown again: now the newest
    c.remember([item("c", "x")]);
    expect(c.shownItem("c", "2")).toBeDefined();
    expect(c.shownItem("c", "3")).toBeUndefined();
  });

  it("tells whoever listens to read a collection (or every one) again, until they stop", () => {
    const c = client();
    const heard: (string | null)[] = [];
    const stop = c.onRefresh((id) => heard.push(id));
    c.refresh("c1");
    c.refresh(null);
    stop();
    c.refresh("c2");
    expect(heard).toEqual(["c1", null]);
  });
});

