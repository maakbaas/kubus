// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { SourceColumn, SourceResult, SourceRow } from "../../../shared/sources";
import { blankField, type Collection } from "../domain/model";
import { addRows, rowItem, sourceShape } from "../domain/sources";
import { firstPage, remoteQueryResult, withNextPage, withPageError, type Loaded } from "./remotePages";

const columns: SourceColumn[] = [
  { name: "id", type: "integer", kind: "number" },
  { name: "name", type: "text", kind: "string" },
  { name: "done", type: "boolean", kind: "checkbox" },
];
const tasks: Collection = {
  id: "tasks", name: "Task", pluralName: "Tasks", icon: null, description: "", itemViews: [], spaceIds: null, createdAt: "", updatedAt: "",
  source: { name: "CRM", target: { table: { schema: "public", name: "tasks" } }, key: "id", columns },
  fields: [blankField("f-name", "Name", "string", { column: "name" }), blankField("f-done", "Done", "checkbox", { column: "done" })],
};
const row = (key: string, name: string, group?: string): SourceRow => ({ key, values: [name, false], ...(group !== undefined && { group }) });
const result = (rows: SourceRow[], extra: Partial<SourceResult> = {}): SourceResult => ({ rows, more: false, ...extra });
const loaded = (rows: SourceRow[], extra: Partial<Loaded> = {}): Loaded => ({ key: "k", batch: 1, rows, total: rows.length, groups: undefined, more: false, ...extra });

describe("firstPage", () => {
  it("holds the rows, the total and whether more follow", async () => {
    const page = await firstPage(Promise.resolve(result([row("1", "a")], { total: 40, more: true, groups: [{ key: "g", count: 40 }] })));
    expect(page).toEqual({ rows: [row("1", "a")], total: 40, groups: [{ key: "g", count: 40 }], more: true });
  });

  it("counts at least the rows in when the source could not count (no total, or a smaller one)", async () => {
    expect((await firstPage(Promise.resolve(result([row("1", "a"), row("2", "b")])))).total).toBe(2);
    expect((await firstPage(Promise.resolve(result([row("1", "a"), row("2", "b")], { total: 1 })))).total).toBe(2);
  });

  it("turns a failure into an empty page with the message, whatever was thrown", async () => {
    const empty = { rows: [], total: 0, groups: [], more: false };
    expect(await firstPage(Promise.reject(new Error("timeout")))).toEqual({ ...empty, error: "timeout" });
    expect(await firstPage(Promise.reject("plain text"))).toEqual({ ...empty, error: "plain text" });
  });
});

describe("withNextPage", () => {
  it("appends the rows, takes whether more follow, and keeps the total at least the rows in", () => {
    const next = withNextPage(loaded([row("1", "a")], { total: 1, more: true }), result([row("2", "b"), row("3", "c")], { more: true }))!;
    expect(next.rows.map((r) => r.key)).toEqual(["1", "2", "3"]);
    expect(next.total).toBe(3);
    expect(next.more).toBe(true);
    expect(next.key).toBe("k");
    expect(next.batch).toBe(1);
  });

  it("keeps a larger counted total", () => {
    expect(withNextPage(loaded([row("1", "a")], { total: 500 }), result([row("2", "b")]))!.total).toBe(500);
  });

  it("does not change what was held", () => {
    const before = loaded([row("1", "a")]);
    withNextPage(before, result([row("2", "b")]));
    expect(before.rows).toHaveLength(1);
  });

  it("nothing held (the query changed meanwhile): nothing", () => {
    expect(withNextPage(null, result([row("1", "a")]))).toBeNull();
  });
});

describe("withPageError", () => {
  it("notes the message and keeps the rows", () => {
    const l = withPageError(loaded([row("1", "a")]), new Error("lost connection"))!;
    expect(l.error).toBe("lost connection");
    expect(l.rows).toHaveLength(1);
    expect(withPageError(loaded([]), 42)!.error).toBe("42");
    expect(withPageError(null, new Error("x"))).toBeNull();
  });
});

describe("remoteQueryResult", () => {
  const shape = sourceShape(tasks);
  const build = (rows: SourceRow[], grouped: boolean) => addRows(null, [1], rows, grouped, (r) => rowItem(tasks, shape, r), (items) => items);

  it("one unnamed group with every row in the source's order, and the source's total", () => {
    const rows = [row("2", "b"), row("1", "a")];
    const built = build(rows, false);
    const out = remoteQueryResult(built, { groups: undefined, total: 9 }, tasks, undefined, false);
    expect(out.result.total).toBe(9);
    expect(out.result.groups).toHaveLength(1);
    expect(out.result.groups[0]).toMatchObject({ key: "", label: "" });
    expect(out.result.groups[0].items.map((i) => i.values["f-name"])).toEqual(["b", "a"]);
    expect(out.items).toHaveLength(2);
  });

  it("hands out copies: rows added later don't change what the block got", () => {
    const built = build([row("1", "a")], false);
    const first = remoteQueryResult(built, { groups: undefined, total: 1 }, tasks, undefined, false);
    addRows(built, [1], [row("1", "a"), row("2", "b")], false, (r) => rowItem(tasks, shape, r), (items) => items);
    expect(first.result.groups[0].items).toHaveLength(1);
    expect(first.items).toHaveLength(1);
  });

  it("grouped: the source's group order, labelled, only groups that have rows in", () => {
    const rows = [row("1", "a", "yes"), row("2", "b", "no"), row("3", "c", "yes")];
    const built = build(rows, true);
    const groups = [{ key: "no", count: 1 }, { key: "yes", count: 2 }, { key: "later", count: 7 }];
    const out = remoteQueryResult(built, { groups, total: 10 }, tasks, "f-done", true);
    expect(out.result.groups.map((g) => [g.key, g.label, g.items.length])).toEqual([["no", "Not checked", 1], ["yes", "Checked", 2]]);
    expect(out.result.total).toBe(10);
  });

  it("labels an empty group key and a group by a field that is gone", () => {
    const built = build([row("1", "a", "")], true);
    const out = remoteQueryResult(built, { groups: [{ key: "", count: 1 }], total: 1 }, tasks, "gone", true);
    expect(out.result.groups[0].label).toBe("(empty)");
  });
});
