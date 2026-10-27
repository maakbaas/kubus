// @vitest-environment node
// The n8n connector (server/src/connectors/n8n.ts) against a stand-in for n8n's public API.
import { afterEach, describe, expect, it, vi } from "vitest";
import { N8nConnector, n8nEndpoint } from "../../src/connectors/n8n.ts";
import type { SourceQuery } from "../../../shared/sources.ts";

const TABLES = [
  { id: "aaaaaaaaaaaaaaaa", name: "Leads", projectId: "p1", columns: [{ name: "score", type: "number", index: 1 }, { name: "email", type: "string", index: 0 }, { name: "met", type: "date", index: 2 }, { name: "won", type: "boolean", index: 3 }] },
  { id: "bbbbbbbbbbbbbbbb", name: "Notes", projectId: "p1", columns: [] },
  { id: "cccccccccccccccc", name: "Notes", projectId: "p2", columns: [] },
];
const LEADS = Array.from({ length: 300 }, (_, i) => ({
  id: i + 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
  email: `lead${i + 1}@example.com`,
  score: i % 10,
  met: i === 0 ? "2026-03-01T10:00:00.000Z" : null,
  won: i % 2 === 0,
}));

/** n8n's API: offset cursors, 250 a page at most. */
function stub() {
  const requests: { url: URL; method: string; key: string | null }[] = [];
  const page = (items: unknown[], url: URL) => {
    const offset = Number(url.searchParams.get("cursor") ?? 0);
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 100), 250);
    const next = offset + limit < items.length ? String(offset + limit) : null;
    return { data: items.slice(offset, offset + limit), nextCursor: next };
  };
  vi.stubGlobal("fetch", async (input: string, init: RequestInit) => {
    const url = new URL(input);
    requests.push({ url, method: init.method ?? "GET", key: new Headers(init.headers).get("X-N8N-API-KEY") });
    if (new Headers(init.headers).get("X-N8N-API-KEY") !== "secret") return new Response(JSON.stringify({ message: "unauthorized" }), { status: 401 });
    if (url.pathname === "/n8n/api/v1/data-tables") return Response.json(page(TABLES, url));
    if (url.pathname === "/n8n/api/v1/data-tables/aaaaaaaaaaaaaaaa/rows") return Response.json(page(LEADS, url));
    return new Response(JSON.stringify({ message: "Not found" }), { status: 404 });
  });
  return requests;
}

const config = (over: { url?: string; schemas?: string[] } = {}) => ({ name: "Flows", url: "n8n://:secret@n8n.example.com/n8n", schemas: [], queries: true, timeoutMs: 5000, ...over });
const leads = (over: Partial<SourceQuery> = {}): SourceQuery => ({
  target: { table: { schema: null, name: "Leads" } },
  key: "id",
  columns: ["email", "score", "met", "won"],
  title: ["email"],
  untitled: "Lead",
  filter: { and: [] },
  search: "",
  sort: [{ column: "score", direction: "desc" }],
  groupBy: null,
  groupOrder: "asc",
  timeZone: "UTC",
  offset: 0,
  limit: 10,
  counts: true,
  ...over,
});

afterEach(() => vi.unstubAllGlobals());

describe("n8n connector", () => {
  it("reads its endpoint from the connection string", () => {
    expect(n8nEndpoint("n8n+http://:k%40y@localhost:5678")).toEqual({ base: "http://localhost:5678/api/v1", key: "k@y" });
    expect(n8nEndpoint("n8n://n8n.example.com/")).toEqual({ base: "https://n8n.example.com/api/v1", key: "" });
  });
  it("lists tables, a shared name with its id, and only the projects asked for", async () => {
    stub();
    expect((await new N8nConnector(config()).tables()).map((t) => t.name)).toEqual(["Leads", "Notes (bbbbbbbbbbbbbbbb)", "Notes (cccccccccccccccc)"]);
    expect((await new N8nConnector(config({ schemas: ["p2"] })).tables()).map((t) => t.name)).toEqual(["Notes"]);
  });
  it("describes a table's columns in order, n8n's own after them", async () => {
    stub();
    const d = await new N8nConnector(config()).describe({ table: { schema: null, name: "Leads" } });
    expect(d.key).toEqual(["id"]);
    expect(d.columns.map((c) => [c.name, c.kind])).toEqual([
      ["email", "string"], ["score", "number"], ["met", "datetime"], ["won", "checkbox"], ["id", "number"], ["createdAt", "datetime"], ["updatedAt", "datetime"],
    ]);
    await expect(new N8nConnector(config()).describe({ query: "SELECT 1" })).rejects.toThrow(/tables only/);
  });
  it("reads every page of a table and queries it in memory, with GETs only", async () => {
    const requests = stub();
    const connector = new N8nConnector(config());
    const result = await connector.query(leads({ filter: { and: [{ column: "won", operator: "isChecked", value: "" }] } }));
    expect(result.total).toBe(150);
    expect(result.rows[0]).toEqual({ key: "9", values: ["lead9@example.com", 8, null, true] });
    expect(result.rows.every((r) => r.values[1] === 8)).toBe(true);
    expect(await connector.row({ ...leads(), keyValue: "1" })).toEqual({ key: "1", values: ["lead1@example.com", 0, "2026-03-01T10:00:00.000Z", true] });
    // One read of the rows (two pages) serves both, kept a moment.
    expect(requests.filter((r) => r.url.pathname.endsWith("/rows")).length).toBe(2);
    expect(requests.every((r) => r.method === "GET" && r.key === "secret")).toBe(true);
  });
  it("tells a wrong key from a wrong request", async () => {
    stub();
    await expect(new N8nConnector(config({ url: "n8n://:wrong@n8n.example.com/n8n" })).check()).rejects.toThrow(/401/);
    await expect(new N8nConnector(config()).query(leads({ target: { table: { schema: null, name: "Nope" } } }))).rejects.toThrow(/no data table/);
  });
});
