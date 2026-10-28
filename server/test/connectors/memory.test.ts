// @vitest-environment node
// Queries answered in memory (server/src/connectors/memory.ts): the same meaning as postgresSql.ts.
import { describe, expect, it } from "vitest";
import { findRow, queryRows, type MemoryRow } from "../../src/connectors/memory.ts";
import type { SourceColumn, SourceFilter, SourceQuery } from "../../../shared/sources.ts";

const columns = new Map<string, SourceColumn>(
  [
    { name: "id", type: "id", kind: "number" },
    { name: "name", type: "string", kind: "string" },
    { name: "nick", type: "string", kind: "string" },
    { name: "age", type: "number", kind: "number" },
    { name: "active", type: "boolean", kind: "checkbox" },
    { name: "seen", type: "date", kind: "datetime" },
  ].map((c) => [c.name, c as SourceColumn]),
);

const rows: MemoryRow[] = [
  { id: 1, name: "Ada", nick: "ada", age: 36, active: true, seen: "2026-03-01T23:30:00.000Z" },
  { id: 2, name: "Bob", nick: null, age: 41, active: false, seen: "2026-03-02T08:00:00.000Z" },
  { id: 3, name: "", nick: "Cy", age: null, active: null, seen: null },
  { id: 4, name: "dan", nick: "dan_100%", age: 7, active: true, seen: "2026-03-01T10:00:00.000Z" },
  { id: 5, name: "Customer 10", nick: null, age: 7, active: false, seen: null },
  { id: 6, name: "Customer 9", nick: null, age: 7, active: false, seen: null },
];

const base = (over: Partial<SourceQuery> = {}): SourceQuery => ({
  target: { table: { schema: null, name: "people" } },
  key: "id",
  columns: ["name", "age"],
  title: ["name", "nick"],
  untitled: "Person",
  filter: { and: [] },
  search: "",
  sort: [{ column: "$title", direction: "asc" }],
  groupBy: null,
  groupOrder: "asc",
  timeZone: "Europe/Amsterdam",
  offset: 0,
  limit: 50,
  counts: true,
  ...over,
});
const ids = (over: Partial<SourceQuery>) => queryRows(rows, columns, base(over)).rows.map((r) => Number(r.key));
const where = (...filters: SourceFilter[]) => ids({ filter: { and: filters }, sort: [] });

describe("queryRows", () => {
  it("sorts by title as the app does, empty values last either way", () => {
    expect(ids({})).toEqual([1, 2, 6, 5, 3, 4]);
    expect(ids({ sort: [{ column: "age", direction: "desc" }] })).toEqual([2, 1, 4, 5, 6, 3]);
    expect(ids({ sort: [{ column: "age", direction: "asc" }] })).toEqual([4, 5, 6, 1, 2, 3]);
  });
  it("filters as the app does", () => {
    expect(where({ column: "name", operator: "contains", value: "A" })).toEqual([1, 4]);
    expect(where({ column: "name", operator: "is", value: "ADA" })).toEqual([1]);
    expect(where({ column: "name", operator: "isEmpty", value: "" })).toEqual([3]);
    expect(where({ column: "age", operator: "gt", value: "30" })).toEqual([1, 2]);
    expect(where({ column: "age", operator: "isNot", value: "7" })).toEqual([1, 2, 3]);
    expect(where({ column: "age", operator: "gt", value: "x" })).toEqual([]);
    expect(where({ column: "active", operator: "isNotChecked", value: "" })).toEqual([2, 3, 5, 6]);
    // 23:30 UTC on 1 March is 2 March in Amsterdam.
    expect(where({ column: "seen", operator: "is", value: "2026-03-02" })).toEqual([1, 2]);
    expect(where({ column: "seen", operator: "before", value: "2026-03-02" })).toEqual([4]);
    expect(where({ column: "seen", operator: "between", value: "2026-03-01..2026-03-01" })).toEqual([4]);
    expect(ids({ filter: { or: [{ column: "age", operator: "lt", value: "10" }, { and: [{ column: "name", operator: "is", value: "bob" }] }] }, sort: [] })).toEqual([2, 4, 5, 6]);
    expect(ids({ filter: { or: [] } })).toEqual([]);
    expect(() => where({ column: "active", operator: "contains", value: "x" })).toThrow(/can't be filtered/);
    expect(() => where({ column: "nope", operator: "isEmpty", value: "" })).toThrow(/no column/);
  });
  it("searches the read columns", () => {
    expect(ids({ search: "customer", sort: [] })).toEqual([5, 6]);
    expect(ids({ search: "41", sort: [] })).toEqual([2]);
  });
  it("pages and counts", () => {
    const first = queryRows(rows, columns, base({ limit: 2 }));
    expect(first).toMatchObject({ more: true, total: 6 });
    expect(first.rows[0]).toEqual({ key: "1", values: ["Ada", 36] });
    const last = queryRows(rows, columns, base({ offset: 4, limit: 2, counts: false }));
    expect(last.more).toBe(false);
    expect(last.total).toBeUndefined();
  });
  it("groups, the empty group last", () => {
    const byAge = queryRows(rows, columns, base({ groupBy: "age", groupOrder: "count", sort: [] }));
    expect(byAge.groups).toEqual([{ key: "7", count: 3 }, { key: "36", count: 1 }, { key: "41", count: 1 }, { key: "", count: 1 }]);
    expect(byAge.rows.map((r) => r.group)).toEqual(["7", "7", "7", "36", "41", ""]);
    expect(queryRows(rows, columns, base({ groupBy: "active" })).groups).toEqual([{ key: "yes", count: 2 }, { key: "no", count: 4 }]);
    expect(queryRows(rows, columns, base({ groupBy: "seen", groupOrder: "desc" })).groups?.map((g) => g.key)).toEqual(["2026-03-02", "2026-03-01", ""]);
  });
  it("finds a row by its key", () => {
    expect(findRow(rows, columns, { ...base(), keyValue: "2" })).toEqual({ key: "2", values: ["Bob", 41] });
    expect(findRow(rows, columns, { ...base(), keyValue: "99" })).toBeNull();
  });
  it("filters, sorts and groups lists as the app does", () => {
    const tagged = new Map<string, SourceColumn>([...columns, ["tags", { name: "tags", type: "list", kind: "string_list" }]]);
    const list: MemoryRow[] = [
      { id: 1, name: "a", tags: ["Work", "home"] },
      { id: 2, name: "b", tags: [] },
      { id: 3, name: "c", tags: ["home"] },
      { id: 4, name: "d", tags: null },
    ];
    const q = (over: Partial<SourceQuery>) => queryRows(list, tagged, base({ columns: ["tags"], ...over }));
    const keys = (over: Partial<SourceQuery>) => q(over).rows.map((r) => Number(r.key));
    expect(keys({ filter: { column: "tags", operator: "contains", value: "WORK" } })).toEqual([1]);
    expect(keys({ filter: { column: "tags", operator: "isEmpty", value: "" } })).toEqual([2, 4]);
    expect(() => q({ filter: { column: "tags", operator: "is", value: "home" } })).toThrow();
    expect(keys({ sort: [{ column: "tags", direction: "desc" }] })).toEqual([1, 3, 2, 4]);
    const grouped = q({ groupBy: "tags", sort: [] });
    expect(grouped.groups).toEqual([{ key: "home", count: 2 }, { key: "Work", count: 1 }, { key: "", count: 2 }]);
    expect(grouped.total).toBe(4);
    expect(grouped.rows.map((r) => `${r.key}:${r.group}`)).toEqual(["1:home", "3:home", "1:Work", "2:", "4:"]);
  });
});
