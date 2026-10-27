// @vitest-environment node
// The D1 connector's SQL without a database: run here on SQLite itself (node:sqlite), as D1 would.
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { cleanQuery, d1Column, dayStart, querySql, rowSql, zoneOffsets, type D1Column } from "../../src/connectors/d1Sql.ts";
import type { SourceQuery } from "../../../shared/sources.ts";

describe("d1Column", () => {
  it("reads declared types as field types", () => {
    expect(d1Column("a", "INTEGER", [])).toMatchObject({ kind: "number" });
    expect(d1Column("a", "varchar(20)", [])).toMatchObject({ kind: "string" });
    expect(d1Column("a", "BOOLEAN", [])).toMatchObject({ kind: "checkbox" });
    expect(d1Column("a", "DATE", [])).toMatchObject({ kind: "date" });
    expect(d1Column("a", "DATETIME", [])).toMatchObject({ kind: "datetime" });
    expect(d1Column("a", "JSON", [])).toMatchObject({ kind: "string", plain: true, hidden: true });
    expect(d1Column("a", "BLOB", [])).toBeNull();
  });
  it("tells an undeclared column by its values", () => {
    expect(d1Column("a", null, [1, 2.5, null])).toMatchObject({ kind: "number" });
    expect(d1Column("a", null, ["2024-01-02", null])).toMatchObject({ kind: "date" });
    expect(d1Column("a", null, ["2024-01-02 10:00:00", "2024-01-02T10:00:00Z"])).toMatchObject({ kind: "datetime" });
    expect(d1Column("a", null, ["x", 1])).toMatchObject({ kind: "string" });
    expect(d1Column("a", null, [])).toMatchObject({ kind: "string" });
    expect(d1Column("a", null, [[1, 2]])).toBeNull();
  });
});

describe("cleanQuery", () => {
  it("allows one statement only", () => {
    expect(cleanQuery("SELECT 1;  ")).toBe("SELECT 1");
    expect(cleanQuery("SELECT ';' AS a, \"b;\" -- c;\n/* ; */")).toContain("SELECT");
    expect(() => cleanQuery("SELECT 1; DELETE FROM people")).toThrow(/one statement/);
    expect(() => cleanQuery("SELECT 'a'';'; DROP TABLE x")).toThrow(/one statement/);
    expect(() => cleanQuery(" ; ")).toThrow(/empty/);
  });
});

describe("zones", () => {
  it("knows a zone's offsets and days", () => {
    expect(zoneOffsets("UTC")).toEqual([{ from: -Infinity, minutes: 0 }]);
    expect(zoneOffsets("Europe/Amsterdam").length).toBeGreaterThan(100);
    expect(dayStart("2024-07-01", "Europe/Amsterdam")).toBe(Date.UTC(2024, 5, 30, 22) / 1000);
    expect(dayStart("2024-01-01", "Europe/Amsterdam")).toBe(Date.UTC(2023, 11, 31, 23) / 1000);
    expect(dayStart("2024-01-01", "UTC", 1)).toBe(Date.UTC(2024, 0, 2) / 1000);
  });
});

// D1's data on SQLite: stored the ways people store them (text dates, Unix times, 0 / 1).
const db = new DatabaseSync(":memory:");
db.exec(`CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT, born DATE, seen DATETIME, active BOOLEAN, score REAL);
  INSERT INTO people VALUES
    (1, 'Ann', '1990-05-01', '2024-06-30T23:30:00Z', 1, 3),
    (2, 'bob', '1985-01-02', 1719792000, 0, 4.5),
    (3, 'Carl', NULL, '2024-07-01 12:00:00', NULL, NULL),
    (4, '', '2000-12-31', 1719878400000, 'true', 3);`);
const columns = new Map<string, D1Column>(
  [d1Column("id", "INTEGER", []), d1Column("name", "TEXT", []), d1Column("born", "DATE", []), d1Column("seen", "DATETIME", []), d1Column("active", "BOOLEAN", []), d1Column("score", "REAL", [])].map((c) => [c!.name, c!]),
);
const query = (over: Partial<SourceQuery> = {}): SourceQuery => ({
  target: { table: { schema: null, name: "people" } }, key: "id", columns: ["name", "born", "seen", "active", "score"], title: ["name"], untitled: "Person",
  filter: { and: [] }, search: "", sort: [], groupBy: null, groupOrder: "asc", timeZone: "UTC", offset: 0, limit: 10, counts: false, ...over,
});
// node:sqlite takes `?1` as a named parameter (D1 binds it by position): rename them `$p1`, bound by name.
const run = (s: { sql: string; params: (string | number)[] }) =>
  db.prepare(s.sql.replace(/\?(\d+)/g, "$$p$1")).all(Object.fromEntries(s.params.map((v, i) => [`p${i + 1}`, v]))) as Record<string, unknown>[];
const ids = (over: Partial<SourceQuery>) => run(querySql(query(over), columns).rows).map((r) => Number(r.$key));

describe("query SQL", () => {
  it("reads values as the app stores them", () => {
    const rows = run(querySql(query(), columns).rows);
    expect(rows[1]).toMatchObject({ $key: "2", v0: "bob", v1: "1985-01-02", v2: "2024-07-01T00:00:00.000Z", v3: 0, v4: 4.5 });
    expect(rows[3]).toMatchObject({ v2: "2024-07-02T00:00:00.000Z", v3: 1, v4: 3 });
    expect(rows[2]).toMatchObject({ v1: null, v3: null });
  });
  it("passes every value as a parameter and quotes every name", () => {
    const { rows } = querySql(query({ target: { table: { schema: null, name: 'peo"ple' } }, filter: { column: "name", operator: "contains", value: "x'; DROP TABLE y; --" } }), columns);
    expect(rows.sql).toContain('FROM "peo""ple" AS q');
    expect(rows.sql).not.toContain("DROP");
  });
  it("filters as the app does", () => {
    expect(ids({ filter: { column: "name", operator: "contains", value: "B" } })).toEqual([2]);
    expect(ids({ filter: { column: "name", operator: "isEmpty", value: "" } })).toEqual([4]);
    expect(ids({ filter: { column: "score", operator: "gt", value: "3" } })).toEqual([2]);
    expect(ids({ filter: { column: "active", operator: "isChecked", value: "" } })).toEqual([1, 4]);
    expect(ids({ filter: { column: "born", operator: "before", value: "1991-01-01" } })).toEqual([1, 2]);
    expect(ids({ filter: { column: "seen", operator: "is", value: "2024-07-01" } })).toEqual([2, 3]);
    expect(ids({ filter: { column: "seen", operator: "is", value: "2024-07-01" }, timeZone: "Europe/Amsterdam" })).toEqual([1, 2, 3]);
    expect(ids({ filter: { or: [] } })).toEqual([]);
    expect(ids({ search: "carl" })).toEqual([3]);
  });
  it("sorts with empty values last and the key breaking ties", () => {
    expect(ids({ sort: [{ column: "score", direction: "desc" }] })).toEqual([2, 1, 4, 3]);
    expect(ids({ sort: [{ column: "$title", direction: "asc" }] })).toEqual([1, 2, 3, 4]);
  });
  it("groups and counts", () => {
    const s = querySql(query({ groupBy: "seen", timeZone: "Europe/Amsterdam", counts: true }), columns);
    expect(run(s.rows).map((r) => r.$group)).toEqual(["2024-07-01", "2024-07-01", "2024-07-01", "2024-07-02"]);
    expect(run(s.groups!)).toEqual([{ g: "2024-07-01", n: 3 }, { g: "2024-07-02", n: 1 }]);
    expect(run(s.total!)).toEqual([{ n: 4 }]);
    const scores = querySql(query({ groupBy: "score", groupOrder: "count", counts: true }), columns);
    expect(run(scores.groups!)).toEqual([{ g: "3", n: 2 }, { g: "4.5", n: 1 }, { g: "", n: 1 }]);
  });
  it("reads a written query as a subquery, and one row by its key", () => {
    const target = { query: "SELECT id, name FROM people WHERE id > 1 -- not the first;" };
    const { rows } = querySql(query({ target, columns: ["name"] }), columns);
    expect(run(rows).map((r) => r.v0)).toEqual(["bob", "Carl", ""]);
    expect(run(rowSql({ ...query(), keyValue: "3" }, columns))[0]).toMatchObject({ $key: "3", v0: "Carl" });
    expect(run(rowSql({ ...query(), target, columns: ["name"], keyValue: "2" }, columns))[0]).toMatchObject({ v0: "bob" });
  });
});
