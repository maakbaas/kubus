// @vitest-environment node
// The MySQL / MariaDB connector's SQL without a server (mysql.test.ts runs it on both).
import { describe, expect, it } from "vitest";
import { cleanQuery, filterSql, grantWarnings, membersOf, myColumn, Params, querySql, rowSql, type MyColumn } from "../../src/connectors/mysqlSql.ts";
import type { SourceQuery } from "../../../shared/sources.ts";

describe("myColumn", () => {
  it("reads types as field types", () => {
    expect(myColumn("a", "int", "int(10) unsigned")).toMatchObject({ kind: "number", read: "int" });
    expect(myColumn("a", "decimal", "decimal(6,2)")).toMatchObject({ kind: "number", read: "number" });
    expect(myColumn("a", "tinyint", "tinyint(1)")).toMatchObject({ kind: "checkbox" });
    expect(myColumn("a", "tinyint", "tinyint(4)")).toMatchObject({ kind: "number" });
    expect(myColumn("a", "bit", "bit(1)")).toMatchObject({ kind: "checkbox" });
    expect(myColumn("a", "datetime", "datetime(3)")).toMatchObject({ kind: "datetime" });
    expect(myColumn("a", "timestamp", "timestamp")).toMatchObject({ kind: "datetime" });
    expect(myColumn("a", "date", "date")).toMatchObject({ kind: "date" });
    expect(myColumn("a", "time", "time")).toMatchObject({ kind: "string", read: "text" });
    expect(myColumn("a", "enum", "enum('x','y')")).toMatchObject({ kind: "string", read: "text" });
    expect(myColumn("a", "set", "set('x','y''z')")).toMatchObject({ kind: "string_list", members: ["x", "y'z"] });
    expect(myColumn("a", "json", "json")).toMatchObject({ kind: "string", plain: true, hidden: true });
    expect(myColumn("a", "longtext", "longtext", true)).toMatchObject({ kind: "string", plain: true, hidden: true });
    expect(myColumn("a", "uuid", "uuid")).toMatchObject({ kind: "string" });
  });
  it("drops binary data and shapes", () => {
    for (const t of ["blob", "varbinary", "binary", "geometry", "point", "geomcollection"]) expect(myColumn("a", t, t)).toBeNull();
  });
  it("reads a SET's members", () => {
    expect(membersOf("set('a','b,c','d''e','f\\\\g')")).toEqual(["a", "b,c", "d'e", "f\\g"]);
  });
});

const col = (name: string, dataType: string, columnType = dataType) => myColumn(name, dataType, columnType)!;
const columns = new Map<string, MyColumn>([col("id", "int"), col("name", "varchar", "varchar(20)"), col("seen", "datetime"), col("born", "date"), col("tags", "set", "set('a','b')")].map((c) => [c.name, c]));
const query = (over: Partial<SourceQuery> = {}): SourceQuery => ({
  target: { table: { schema: "crm", name: "people" } }, key: "id", columns: ["name"], title: ["name"], untitled: "Person",
  filter: { and: [] }, search: "", sort: [], groupBy: null, groupOrder: "asc", timeZone: "UTC", offset: 0, limit: 10, counts: false, ...over,
});

describe("query SQL", () => {
  it("passes every value as a parameter and quotes every name", () => {
    const { rows } = querySql(query({ target: { table: { schema: "c`rm", name: "peo ple" } }, filter: { column: "name", operator: "contains", value: "x'; DROP TABLE y; --" } }), columns, "mysql");
    expect(rows.sql).toContain("FROM `c``rm`.`peo ple` AS q");
    expect(rows.sql).not.toContain("DROP");
    expect(rows.params).toContain("%x'; DROP TABLE y; --%");
  });
  it("numbers its ? in the order they appear, whatever order they were made in", () => {
    const { rows } = querySql(
      query({ groupBy: "tags", sort: [{ column: "$title", direction: "asc" }], filter: { column: "id", operator: "gt", value: "3" } }),
      columns,
      "mariadb",
    );
    // The SET's members (FROM), the filter (WHERE), then the sort's (ORDER BY: the group's text, the title).
    const [pad, back] = ["0000000000000000000\\1", "\\1"];
    expect(rows.params).toEqual(["a", "b", 3, pad, back, "Person", pad, back, "Person", pad, back]);
    expect(querySql(query({ sort: [{ column: "name", direction: "asc" }] }), columns, "mysql").rows.params).toEqual(["0000000000000000000$1", "$1", "0000000000000000000$1", "$1"]);
  });
  it("writes a filter's and / or tree with every rule bracketed, empty values last", () => {
    const named = { column: "name", operator: "contains", value: "a" } as const;
    const big = { column: "id", operator: "gt", value: "3" } as const;
    const { rows } = querySql(query({ filter: { and: [{ or: [named, big] }, big] }, sort: [{ column: "id", direction: "desc" }] }), columns, "mysql");
    expect(rows.sql).toMatch(/WHERE \(\(\(.+ LIKE LOWER\(\?\) ESCAPE '!'\) OR \(q\.`id` > \?\)\) AND \(q\.`id` > \?\)\)/);
    expect(rows.sql).toContain("ORDER BY (q.`id`) IS NULL, q.`id` DESC, q.`id` ASC LIMIT 11 OFFSET 0");
    expect(querySql(query({ filter: { or: [] } }), columns, "mysql").rows.sql).toContain("WHERE FALSE");
  });
  it("escapes LIKE's own characters with !", () => {
    const p = new Params();
    expect(p.statement(filterSql(columns.get("name")!, { column: "name", operator: "contains", value: "50%_!" }, p, "UTC")).params).toEqual(["%50!%!_!!%"]);
  });
  it("compares a date & time with the UTC bounds of its day in the time zone", () => {
    const p = new Params();
    const s = p.statement(filterSql(columns.get("seen")!, { column: "seen", operator: "is", value: "2026-03-02" }, p, "Europe/Amsterdam"));
    expect(s.sql).toBe("q.`seen` >= ? AND q.`seen` < ? AND (MONTH(q.`seen`) <> 0 AND DAY(q.`seen`) <> 0)");
    expect(s.params).toEqual(["2026-03-01 23:00:00", "2026-03-02 23:00:00"]);
    // Across the change to summer time.
    const q = new Params();
    expect(q.statement(filterSql(columns.get("seen")!, { column: "seen", operator: "between", value: "2026-03-29..2026-03-29" }, q, "Europe/Amsterdam")).params).toEqual([
      "2026-03-28 23:00:00",
      "2026-03-29 22:00:00",
    ]);
    // Minutes: 1:00 to 3:59 that morning, the clocks going from 2:00 to 3:00.
    const m = new Params();
    expect(m.statement(filterSql(columns.get("seen")!, { column: "seen", operator: "between", value: "2026-03-29T01:00..2026-03-29T03:59" }, m, "Europe/Amsterdam")).params).toEqual([
      "2026-03-29 00:00:00",
      "2026-03-29 02:00:00",
    ]);
  });
  it("matches nothing for a value that can't be compared", () => {
    const p = new Params();
    expect(filterSql(columns.get("id")!, { column: "id", operator: "is", value: "abc" }, p, "UTC")).toBe("FALSE");
    expect(filterSql(columns.get("born")!, { column: "born", operator: "before", value: "soon" }, p, "UTC")).toBe("FALSE");
    expect(() => filterSql(columns.get("tags")!, { column: "tags", operator: "is", value: "a" }, p, "UTC")).toThrow(/can't be filtered/);
  });
  it("groups a date & time by its day in the time zone", () => {
    const { groups } = querySql(query({ groupBy: "seen", counts: true, timeZone: "Europe/Amsterdam" }), columns, "mysql");
    expect(groups!.sql).toContain("WHEN q.`seen` < '2026-03-29 01:00:00' THEN 60 WHEN q.`seen` < '2026-10-25 01:00:00' THEN 120");
    expect(groups!.sql).toContain("LIMIT 1000");
  });
});

describe("rowSql", () => {
  it("compares the key column itself; a number key that isn't one names no row", () => {
    const shape = { target: { table: { schema: null, name: "people" } }, key: "id", columns: ["name"], title: ["name"], untitled: "Person" };
    expect(rowSql({ ...shape, keyValue: "2" }, columns)).toMatchObject({ sql: expect.stringContaining("FROM `people` AS q WHERE q.`id` = ? LIMIT 1"), params: ["2"] });
    expect(rowSql({ ...shape, keyValue: "x" }, columns).sql).toContain("WHERE FALSE");
  });
});

describe("cleanQuery", () => {
  it("is one SELECT or WITH", () => {
    expect(cleanQuery(" SELECT 1;; ")).toBe("SELECT 1");
    expect(cleanQuery("WITH a AS (SELECT 1) SELECT * FROM a")).toContain("WITH");
    expect(cleanQuery("SELECT ';', `a;b`, \"x\\\";\" -- ;\n# ;\n/* ; */ FROM t")).toContain("FROM t");
    expect(() => cleanQuery("DELETE FROM t")).toThrow(/one SELECT/);
    expect(() => cleanQuery("SELECT 1; DELETE FROM t")).toThrow(/one statement/);
    // A backslash escapes a quote in a string: the ; after it is outside.
    expect(() => cleanQuery("SELECT '\\''; DROP TABLE t; -- '")).toThrow(/one statement/);
    expect(() => cleanQuery("  ;")).toThrow(/empty/);
  });
});

describe("grantWarnings", () => {
  it("warns about a superuser or a user that can write", () => {
    expect(grantWarnings(["GRANT USAGE ON *.* TO `r`@`%`", "GRANT SELECT ON `crm`.* TO `r`@`%`", "GRANT SELECT (`a`, `b`) ON `crm`.`t` TO `r`@`%`"])).toEqual([]);
    expect(grantWarnings(["GRANT ALL PRIVILEGES ON *.* TO `root`@`localhost` IDENTIFIED BY PASSWORD '*AB' WITH GRANT OPTION"])[0]).toMatch(/superuser/);
    expect(grantWarnings(["GRANT SELECT, INSERT, SUPER, SHUTDOWN ON *.* TO `root`@`localhost`"])[0]).toMatch(/superuser/);
    expect(grantWarnings(["GRANT SELECT, INSERT ON `crm`.* TO `w`@`%`"])[0]).toMatch(/may write/);
    expect(grantWarnings(["GRANT ALL PRIVILEGES ON `crm`.* TO `w`@`%`"])[0]).toMatch(/may write/);
    expect(grantWarnings(["GRANT SELECT, UPDATE (`a`) ON `crm`.`t` TO `w`@`%`"])[0]).toMatch(/may write/);
    expect(grantWarnings(["GRANT `reader`@`%` TO `r`@`%`"])).toEqual([]);
  });
});
