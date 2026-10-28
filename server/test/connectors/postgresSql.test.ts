// @vitest-environment node
// The Postgres connector's SQL without a database (postgres.test.ts runs it on one).
import { describe, expect, it } from "vitest";
import { cleanQuery, filterSql, Params, pgColumn, querySql, rowSql, type PgColumn } from "../../src/connectors/postgresSql.ts";
import type { SourceQuery } from "../../../shared/sources.ts";

const type = (name: string, category: string, element: { name: string; category: string } | null = null) => ({ name, display: name, category, element });

describe("pgColumn", () => {
  it("reads types as field types", () => {
    expect(pgColumn("a", type("int4", "N"))).toMatchObject({ kind: "number", read: "int" });
    expect(pgColumn("a", type("money", "N"))).toMatchObject({ kind: "number", read: "money" });
    expect(pgColumn("a", type("bool", "B"))).toMatchObject({ kind: "checkbox" });
    expect(pgColumn("a", type("timestamp", "D"))).toMatchObject({ kind: "datetime", read: "timestamp" });
    expect(pgColumn("a", type("time", "D"))).toMatchObject({ kind: "string", read: "text" });
    expect(pgColumn("a", type("_text", "A", { name: "text", category: "S" }))).toMatchObject({ kind: "string_list" });
    expect(pgColumn("a", type("_jsonb", "A", { name: "jsonb", category: "U" }))).toMatchObject({ kind: "string", plain: true, hidden: true });
    expect(pgColumn("a", type("interval", "T"))).toMatchObject({ kind: "string", plain: true });
    expect(pgColumn("a", type("uuid", "U"))).toMatchObject({ kind: "string" });
    expect(pgColumn("a", type("my_enum", "E"))).toMatchObject({ kind: "string" });
  });
  it("drops what can't be read", () => {
    for (const t of [type("bytea", "U"), type("tsvector", "U"), type("geometry", "U"), type("oid", "N"), type("_bytea", "A", { name: "bytea", category: "U" })]) {
      expect(pgColumn("a", t)).toBeNull();
    }
  });
});

const columns = new Map<string, PgColumn>(
  [
    pgColumn("id", type("int4", "N")),
    pgColumn("name", type("text", "S")),
    pgColumn("seen", type("timestamptz", "D")),
    pgColumn("tags", type("_text", "A", { name: "text", category: "S" })),
  ].map((c) => [c!.name, c!]),
);
const query = (over: Partial<SourceQuery> = {}): SourceQuery => ({
  target: { table: { schema: "public", name: "people" } }, key: "id", columns: ["name"], title: ["name"], untitled: "Person",
  filter: { and: [] }, search: "", sort: [], groupBy: null, groupOrder: "asc", timeZone: "UTC", offset: 0, limit: 10, counts: false, ...over,
});

describe("query SQL", () => {
  it("passes every value as a parameter and quotes every name", () => {
    const { rows } = querySql(query({ target: { table: { schema: "pub\"lic", name: "peo ple" } }, filter: { column: "name", operator: "contains", value: "x'; DROP TABLE y; --" } }), columns);
    expect(rows.text).toContain('FROM "pub""lic"."peo ple" AS q');
    expect(rows.text).not.toContain("DROP");
    expect(rows.values).toContain("%x'; DROP TABLE y; --%");
  });
  it("writes a filter's and / or tree with every rule bracketed", () => {
    const named = { column: "name", operator: "contains", value: "a" } as const;
    const big = { column: "id", operator: "gt", value: "3" } as const;
    const { rows } = querySql(query({ filter: { and: [{ or: [named, big] }, big] } }), columns);
    expect(rows.text).toMatch(/WHERE \(\(\(.+ILIKE \$1\) OR \(q\."id" > \$2::numeric\)\) AND \(q\."id" > \$3::numeric\)\)/);
    expect(querySql(query({ filter: { or: [] } }), columns).rows.text).toContain("WHERE FALSE");
    expect(querySql(query({ filter: { and: [] } }), columns).rows.text).not.toContain("WHERE FALSE");
  });
  it("compares numbers with the column itself, unless the value doesn't fit it", () => {
    const p = new Params();
    expect(filterSql(columns.get("id")!, { column: "id", operator: "gt", value: "3" }, p, "UTC")).toBe('q."id" > $1::numeric');
    expect(filterSql(columns.get("id")!, { column: "id", operator: "gt", value: "3.5" }, p, "UTC")).toBe('q."id"::numeric > $2::numeric');
  });
  it("compares a date & time by its day in the time zone, keeping to the column", () => {
    const p = new Params();
    expect(filterSql(columns.get("seen")!, { column: "seen", operator: "before", value: "2026-03-01" }, p, "Europe/Amsterdam")).toBe(
      'q."seen" < (($1::date + 0)::timestamp AT TIME ZONE $2)',
    );
    expect(p.values).toEqual(["2026-03-01", "Europe/Amsterdam"]);
  });
  it("orders by group, then sort, then key, and counts with the first page", () => {
    const s = querySql(query({ groupBy: "tags", groupOrder: "count", sort: [{ column: "$title", direction: "desc" }], counts: true }), columns);
    expect(s.rows.text).toMatch(/ORDER BY \(gx\.g = ''\), count\(\*\) OVER \(PARTITION BY gx\.g\) DESC, gx\.g ASC, lower\(COALESCE\(.*\)\) DESC NULLS LAST, q\."id" ASC LIMIT \$\d+ OFFSET \$\d+$/);
    expect(s.total?.text).toMatch(/^SELECT count\(\*\)::float8 AS n FROM/);
    expect(s.groups?.text).toContain("GROUP BY gx.g");
  });
  it("refuses unknown columns and pages out of range", () => {
    expect(() => querySql(query({ columns: ["nope"] }), columns)).toThrow(/no column “nope”/);
    expect(() => querySql(query({ limit: 100_000 }), columns)).toThrow(/limit/);
  });
  it("wraps a written query, without its trailing semicolons", () => {
    expect(cleanQuery("  SELECT 1 ;; ")).toBe("SELECT 1");
    expect(rowSql({ ...query({ target: { query: "SELECT * FROM t;" } }), keyValue: "5" }, columns).text).toContain("FROM (SELECT * FROM t) AS q WHERE q.\"id\" = $1 LIMIT 1");
  });
});
