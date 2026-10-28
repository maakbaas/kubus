// @vitest-environment node
// The D1 connector (server/src/connectors/d1.ts) against a stand-in for Cloudflare's /raw endpoint
// that runs each statement on SQLite itself (node:sqlite), as D1 does: the requests it makes, how
// it reads the answers and errors, and that it stays read-only.
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SourceError } from "../../src/connectors/connector.ts";
import { D1Connector } from "../../src/connectors/d1.ts";
import type { SourceQuery } from "../../../shared/sources.ts";

const ENDPOINT = "https://api.cloudflare.com/client/v4/accounts/acc/d1/database/db-1/raw";

let db: DatabaseSync;
let requests: { url: string; authorization: string | null; sql: string; params: unknown[] }[];
/** Answers the stand-in gives instead of running the statement (Cloudflare's own errors). */
let override: ((sql: string) => Response | null) | null;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT, active BOOLEAN, score REAL, photo BLOB);
    INSERT INTO people VALUES (1, 'Ann', 1, 3, x'00'), (2, 'Bob', 0, 4.5, NULL), (3, NULL, 'yes', NULL, NULL);
    CREATE VIEW actives AS SELECT id, name FROM people WHERE active = 1;
    CREATE TABLE _cf_KV (key TEXT);`);
  requests = [];
  override = null;
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const { sql, params } = JSON.parse(String(init.body)) as { sql: string; params: (string | number)[] };
    requests.push({ url, authorization: new Headers(init.headers).get("authorization"), sql, params });
    const answer = override?.(sql);
    if (answer) return answer;
    try {
      const statement = db.prepare(sql);
      statement.setReturnArrays(true);
      const named = Object.fromEntries(params.map((v, i) => [`?${i + 1}`, v]));
      const columns = statement.columns().map((c) => c.name);
      if (columns.length === 0) {
        const { changes } = statement.run(named);
        return Response.json({ success: true, result: [{ success: true, results: { columns: [], rows: [] }, meta: { changed_db: Number(changes) > 0, changes: Number(changes) } }] });
      }
      const rows = (statement.all(named) as unknown as unknown[][]).map((r) => r.map((v) => (v instanceof Uint8Array ? [...v] : v)));
      return Response.json({ success: true, result: [{ success: true, results: { columns, rows }, meta: { changed_db: false, changes: 0 } }] });
    } catch (e) {
      return Response.json({ success: false, errors: [{ code: 7500, message: (e as Error).message }] }, { status: 400 });
    }
  });
});

afterEach(() => vi.unstubAllGlobals());

const connector = (over: { fields?: Record<string, string>; schemas?: string[]; queries?: boolean } = {}) =>
  new D1Connector({ name: "Edge", kind: "d1", fields: { account: "acc", database: "db-1" }, password: "token-1", schemas: [], queries: true, timeoutMs: 5000, ...over });

const people = (over: Partial<SourceQuery> = {}): SourceQuery => ({
  target: { table: { schema: null, name: "people" } },
  key: "id",
  columns: ["name", "active", "score"],
  title: ["name"],
  untitled: "Person",
  filter: { and: [] },
  search: "",
  sort: [{ column: "id", direction: "asc" }],
  groupBy: null,
  groupOrder: "asc",
  timeZone: "UTC",
  offset: 0,
  limit: 2,
  counts: true,
  ...over,
});

describe("D1 connector", () => {
  it("reads its account and database from the connection string, the token as its password", async () => {
    expect(await connector().check()).toEqual([]);
    expect(requests[0]).toMatchObject({ url: ENDPOINT, authorization: "Bearer token-1", sql: "SELECT 1" });
    expect(() => connector({ fields: { account: "acc", database: "" } })).toThrow(SourceError);
    expect(await connector({ schemas: ["main"] }).check()).toEqual(["D1 has no schemas: the source's schemas are ignored"]);
  });

  it("lists tables and views, not SQLite's or Cloudflare's own", async () => {
    expect(await connector().tables()).toEqual([
      { schema: null, name: "actives", type: "view" },
      { schema: null, name: "people", type: "table" },
    ]);
  });

  it("describes a table's columns and key, dropping binary data", async () => {
    const d = await connector().describe({ table: { schema: null, name: "people" } });
    expect(d.key).toEqual(["id"]);
    expect(d.columns.map((c) => [c.name, c.kind])).toEqual([["id", "number"], ["name", "string"], ["active", "checkbox"], ["score", "number"]]);
    expect(d.dropped).toEqual([{ name: "photo", type: "BLOB" }]);
    expect(JSON.stringify(d)).not.toContain('"read"');
  });

  it("pages, counts and turns checkboxes into true / false", async () => {
    const c = connector();
    const first = await c.query(people());
    expect(first).toEqual({
      rows: [{ key: "1", values: ["Ann", true, 3] }, { key: "2", values: ["Bob", false, 4.5] }],
      more: true,
      total: 3,
    });
    expect((await c.query(people({ offset: 2 }))).rows).toEqual([{ key: "3", values: [null, true, null] }]);
    expect(requests.every((r) => /^(SELECT|PRAGMA)/i.test(r.sql))).toBe(true);
  });

  it("groups, as the other connectors do", async () => {
    const result = await connector().query(people({ groupBy: "active", limit: 10 }));
    expect(result.groups).toEqual([{ key: "yes", count: 2 }, { key: "no", count: 1 }]);
    expect(result.rows.map((r) => [r.group, r.key])).toEqual([["yes", "1"], ["yes", "3"], ["no", "2"]]);
  });

  it("finds one row by its key", async () => {
    const c = connector();
    expect(await c.row({ ...people(), keyValue: "2" })).toEqual({ key: "2", values: ["Bob", false, 4.5] });
    expect(await c.row({ ...people(), keyValue: "99" })).toBeNull();
  });

  it("runs a written query as one statement, only when queries are allowed", async () => {
    const target = { query: "SELECT id, name FROM people WHERE score > 3;" };
    const d = await connector().describe(target);
    expect(d.columns.map((c) => c.name)).toEqual(["id", "name"]);
    await expect(connector().describe({ query: "SELECT 1; DELETE FROM people" })).rejects.toThrow(/one statement/);
    await expect(connector({ queries: false }).describe(target)).rejects.toThrow(/doesn't allow queries/);
    await expect(connector().describe({ table: { schema: "main", name: "people" } })).rejects.toThrow(/no schemas/);
    expect(db.prepare("SELECT count(*) AS n FROM people").get()).toEqual({ n: 3 });
  });

  it("tells the request's mistakes (400) from Cloudflare's and the token's", async () => {
    await expect(connector().describe({ table: { schema: null, name: "nothing" } })).rejects.toThrow(SourceError);
    override = () => Response.json({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }, { status: 403 });
    const error = await connector().tables().catch((e: Error) => e);
    expect(error).not.toBeInstanceOf(SourceError);
    expect((error as Error).message).toBe("Cloudflare: Authentication error");
  });

  it("refuses an answer that says the database changed", async () => {
    override = () => Response.json({ success: true, result: [{ success: true, results: { columns: ["1"], rows: [[1]] }, meta: { changed_db: true, changes: 1 } }] });
    await expect(connector().check()).rejects.toThrow(/changed the D1 database/);
  });

  it("gives up on a statement after the source's time limit", async () => {
    vi.stubGlobal("fetch", (_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason))),
    );
    await expect(new D1Connector({ name: "Slow", kind: "d1", fields: { account: "acc", database: "db-1" }, password: "t", schemas: [], queries: true, timeoutMs: 20 }).check()).rejects.toThrow(/took too long/);
  });
});
