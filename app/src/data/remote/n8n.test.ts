// @vitest-environment node
// The n8n connector (server/src/connectors/n8n.ts) against a stand-in for n8n's public API.
import { afterEach, describe, expect, it, vi } from "vitest";
import { N8nConnector, n8nEndpoint, n8nRules, type N8nRule } from "../../../../server/src/connectors/n8n.ts";
import type { SourceQuery } from "../../../../shared/sources";

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

/** n8n's row filter and search (as on Postgres: ilike's only wildcard is %, neq keeps nulls). */
function n8nFilters(rows: Record<string, unknown>[], url: URL): Record<string, unknown>[] {
  const filter = url.searchParams.get("filter");
  const search = url.searchParams.get("search");
  const like = (pattern: string) => new RegExp(`^${pattern.split("%").map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "is");
  const cmp = (a: unknown, b: unknown) => (typeof b === "string" && typeof a === "string" ? Date.parse(a) - Date.parse(b) : Number(a) - Number(b));
  return rows.filter((row) => {
    for (const f of filter ? (JSON.parse(filter) as { filters: N8nRule[] }).filters : []) {
      const v = row[f.columnName] ?? null;
      const ok = {
        eq: () => (f.value === null ? v === null : v !== null && cmp(v, f.value) === 0),
        neq: () => (f.value === null ? v !== null : v === null || cmp(v, f.value) !== 0),
        ilike: () => v !== null && like(String(f.value)).test(String(v)),
        gt: () => v !== null && cmp(v, f.value) > 0,
        gte: () => v !== null && cmp(v, f.value) >= 0,
        lt: () => v !== null && cmp(v, f.value) < 0,
        isEmpty: () => v === null || v === "",
        isNotEmpty: () => v !== null && v !== "",
      }[f.condition]();
      if (!ok) return false;
    }
    const own = TABLES[0].columns.map((c) => c.name);
    return !search || own.some((name) => row[name] !== null && like(`%${search}%`).test(String(row[name])));
  });
}

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
    if (url.pathname === "/n8n/api/v1/data-tables/aaaaaaaaaaaaaaaa/rows") return Response.json(page(n8nFilters(LEADS, url), url));
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
    await connector.query(leads({ filter: { and: [{ column: "won", operator: "isChecked", value: "" }] }, offset: 10 }));
    // One read of the rows (two pages) serves both pages, kept a moment.
    expect(requests.filter((r) => r.url.pathname.endsWith("/rows")).length).toBe(2);
    expect(requests.every((r) => r.method === "GET" && r.key === "secret")).toBe(true);
  });
  it("asks n8n only for the rows a filter could keep, and filters them exactly", async () => {
    const requests = stub();
    const connector = new N8nConnector(config());
    const result = await connector.query(
      leads({
        filter: { and: [{ column: "score", operator: "is", value: "4" }, { column: "email", operator: "contains", value: "LEAD1" }, { or: [{ column: "won", operator: "isChecked", value: "" }, { column: "score", operator: "gt", value: "5" }] }] },
      }),
    );
    // Score 4 (and so won): lead15, lead105, lead115 … lead195.
    expect(result.total).toBe(11);
    expect(result.rows.slice(0, 3).map((r) => r.values[0])).toEqual(["lead15@example.com", "lead105@example.com", "lead115@example.com"]);
    const rowsRequests = requests.filter((r) => r.url.pathname.endsWith("/rows"));
    expect(rowsRequests.length).toBe(1);
    expect(JSON.parse(rowsRequests[0].url.searchParams.get("filter")!)).toEqual({
      type: "and",
      filters: [{ columnName: "score", condition: "eq", value: 4 },{ columnName: "email", condition: "ilike", value: "%LEAD1%" }],
    });
  });
  it("passes a search on when every searched column is text, and finds one row by its id", async () => {
    const requests = stub();
    const connector = new N8nConnector(config());
    expect((await connector.query(leads({ columns: ["email"], search: " lead29@ " }))).total).toBe(1);
    expect(requests.at(-1)!.url.searchParams.get("search")).toBe("lead29@");
    expect((await connector.query(leads({ search: "lead29@" }))).total).toBe(1);
    expect(requests.at(-1)!.url.searchParams.has("search")).toBe(false);
    expect(await connector.row({ ...leads(), keyValue: "1" })).toEqual({ key: "1", values: ["lead1@example.com", 0, "2026-03-01T10:00:00.000Z", true] });
    expect(JSON.parse(requests.at(-1)!.url.searchParams.get("filter")!).filters).toEqual([{ columnName: "id", condition: "eq", value: 1 }]);
    // One page each, but two for the search not sent (the whole table).
    expect(requests.filter((r) => r.url.pathname.endsWith("/rows")).length).toBe(4);
  });
  it("narrows dates by day loosely enough for n8n on SQLite", async () => {
    const met = { name: "met", type: "date", kind: "datetime" } as const;
    expect(n8nRules(met, { column: "met", operator: "is", value: "2026-03-01" }, "Europe/Amsterdam")).toEqual([
      { columnName: "met", condition: "gte", value: "2026-02-27T00:00:00.000Z" },
      { columnName: "met", condition: "lt", value: "2026-03-01T23:00:00.000Z" },
    ]);
    // As text, SQLite's "2026-03-01 10:00:00" is above the lower bound and below the upper.
    expect("2026-03-01 10:00:00.000" >= "2026-02-27T00:00:00.000Z" && "2026-03-01 10:00:00.000" < "2026-03-01T23:00:00.000Z").toBe(true);
    stub();
    const result = await new N8nConnector(config()).query(leads({ filter: { and: [{ column: "met", operator: "is", value: "2026-03-01" }] }, timeZone: "Europe/Amsterdam" }));
    expect(result.rows.map((r) => r.key)).toEqual(["1"]);
    // Rules n8n can't narrow by aren't sent.
    expect(n8nRules({ name: "email", type: "string", kind: "string" }, { column: "email", operator: "contains", value: "café" }, "UTC")).toBeNull();
    expect(n8nRules({ name: "won", type: "boolean", kind: "checkbox" }, { column: "won", operator: "isChecked", value: "" }, "UTC")).toBeNull();
  });
  it("tells a wrong key from a wrong request", async () => {
    stub();
    await expect(new N8nConnector(config({ url: "n8n://:wrong@n8n.example.com/n8n" })).check()).rejects.toThrow(/401/);
    await expect(new N8nConnector(config()).query(leads({ target: { table: { schema: null, name: "Nope" } } }))).rejects.toThrow(/no data table/);
  });
});
