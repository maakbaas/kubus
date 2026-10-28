import { describe, expect, it } from "vitest";
import type { SourceColumn, SourceRow } from "../../../shared/sources";
import { blankField, pickableFields, type Collection } from "./model";
import { addRows, canGroup, canSort, sourcePeriod, fieldOperators, namesOfTable, offeredKinds, rowItem, rowItemId, rowKey, sourceQuery, sourceShape, withHiddenColumns, withSourceColumns } from "./sources";
import { defaultQuery, TITLE } from "./query";

const columns: SourceColumn[] = [
  { name: "id", type: "integer", kind: "number" },
  { name: "name", type: "text", kind: "string" },
  { name: "born", type: "date", kind: "date" },
  { name: "data", type: "jsonb", kind: "string", plain: true, hidden: true },
  { name: "tags", type: "text[]", kind: "string_list" },
];
const people: Collection = {
  id: "people", name: "Person", pluralName: "People", icon: null, description: "", itemViews: [], spaceIds: null, createdAt: "", updatedAt: "",
  source: { name: "CRM", target: { table: { schema: "public", name: "people" } }, key: "id", columns },
  fields: [
    blankField("f-name", "Name", "string", { column: "name" }),
    blankField("f-born", "Born", "date", { column: "born" }),
    blankField("f-data", "Data", "string", { column: "data" }),
    blankField("f-tags", "Tags", "string_list", { column: "tags" }),
    blankField("f-calc", "Age", "component", { code: "{{ 1 }}", output: "number" }),
  ],
};

describe("remote collections", () => {
  it("make item ids from keys and back, safe in a link", () => {
    for (const key of ["1", "a/b?c#d", "ünïcode ✓", ""]) {
      expect(rowItemId(key)).toMatch(/^[A-Za-z0-9_-]*$/);
      expect(rowKey(rowItemId(key))).toBe(key);
    }
    expect(rowKey("%%%")).toBeNull();
  });

  it("offer only what their columns can do", () => {
    const [name, born, data, tags, calc] = people.fields;
    expect(fieldOperators(people, data).map((o) => o.id)).toEqual(["contains", "notContains", "isEmpty", "isNotEmpty"]);
    expect(fieldOperators(people, calc)).toEqual([]);
    expect(fieldOperators(people, name).map((o) => o.id)).toContain("is");
    expect(canSort(people, TITLE)).toBe(true);
    expect(canSort(people, "$updated")).toBe(false);
    expect(canSort(people, data.id)).toBe(false);
    expect(canSort(people, born.id)).toBe(true);
    expect(canGroup(people, tags)).toBe(true);
    expect(canGroup(people, data)).toBe(false);
    // No Created or Updated: rows have neither.
    expect(pickableFields(people).map((f) => f.id)).not.toContain("$created");
    expect(offeredKinds(people, name)).toEqual(["string", "markdown", "html"]);
    expect(offeredKinds(people, null)).toEqual(["component"]);
  });

  it("read rows as items", () => {
    const shape = sourceShape(people);
    expect(shape).toMatchObject({ key: "id", columns: ["name", "born", "data", "tags"], title: ["name", "data"], untitled: "Person" });
    const item = rowItem(people, shape, { key: "7", values: ["Ada", null, "{}", ["x"]] });
    expect(item).toMatchObject({ id: rowItemId("7"), values: { "f-name": "Ada", "f-data": "{}", "f-tags": ["x"] } });
    expect(item.values).not.toHaveProperty("f-born");
  });

  it("translate a view's query, its periods worked out", () => {
    const q = sourceQuery(
      people,
      {
        ...defaultQuery(),
        filters: [
          { id: "1", fieldId: "f-born", operator: "between", value: "2026-01-01..2026-01-31" },
          { id: "2", fieldId: "f-calc", operator: "is", value: "3" }, // a component field: left out
          { id: "3", fieldId: "f-name", operator: "contains", value: " ad " },
          { id: "4", fieldId: "f-name", operator: "is", value: "" }, // no value yet: doesn't filter
        ],
        sort: [{ fieldId: TITLE, direction: "desc" }, { fieldId: "f-data", direction: "asc" }],
        groupBy: "f-tags",
      },
      "  x ",
      "UTC",
    );
    expect(q).toMatchObject({
      filter: { and: [{ column: "born", operator: "between", value: "2026-01-01..2026-01-31" }, { column: "name", operator: "contains", value: "ad" }] },
      sort: [{ column: "$title", direction: "desc" }],
      groupBy: "tags",
      search: "x",
    });
    // A value that can't be compared matches nothing, as in the app.
    expect(sourceQuery(people, { ...defaultQuery(), filters: [{ id: "1", fieldId: "f-born", operator: "before", value: "soon" }] }, "", "UTC").filter).toEqual({ or: [] });
  });

  it("send the item itself as its row's key", () => {
    const is = (value: string) => sourceQuery(people, { ...defaultQuery(), filters: [{ id: "1", fieldId: "$id", operator: "is", value }] }, "", "UTC").filter;
    expect(is(rowItemId("42"))).toEqual({ column: "id", operator: "is", value: "42" });
    expect(fieldOperators(people, { ...blankField("$id", "Item", "item") }).map((o) => o.id)).toEqual(["is", "isNot"]);
  });

  it("send the view's (or page's) filter and the block's as one and / or tree", () => {
    const name = (value: string, join?: "or") => ({ id: value, fieldId: "f-name", operator: "contains" as const, value, ...(join && { join }) });
    const q = sourceQuery(people, { ...defaultQuery(), inherited: [name("a")], filters: [name("b", "or"), name("c")] }, "", "UTC");
    const leaf = (value: string) => ({ column: "name", operator: "contains", value });
    expect(q.filter).toEqual({ and: [{ or: [leaf("a"), leaf("b")] }, leaf("c")] });
  });

  it("keep their fields when the columns are read again", () => {
    const draft = { source: people.source, fields: people.fields.map(({ collectionId: _c, position: _p, ...f }) => f) };
    draft.fields[0] = { ...draft.fields[0], name: "Full name", kind: "markdown" };
    const next = withSourceColumns(draft, "CRM", people.source!.target, {
      columns: [columns[0], columns[1], { name: "born", type: "text", kind: "string" }, { name: "email", type: "text", kind: "string" }],
      key: ["id"],
    });
    expect(next.fields.map((f) => [f.name, f.kind, f.column])).toEqual([
      ["Full name", "markdown", "name"],
      ["Born", "string", "born"],
      ["Age", "component", null],
      ["id", "number", "id"],
      ["email", "string", "email"],
    ]);
    expect(next.source?.key).toBe("id");
  });

  it("start a time series' view with the last 7 days on its time column (none for other sources)", () => {
    const draft = { source: people.source, fields: people.fields.map(({ collectionId: _c, position: _p, ...f }) => f) };
    const series = withSourceColumns(draft, "CRM", people.source!.target, { columns, key: ["id"], time: "born" });
    expect(series.source?.time).toBe("born");
    expect(sourcePeriod(series)).toEqual([{ id: "f-born-period", fieldId: "f-born", operator: "between", value: "day-6..day+0" }]);
    expect(sourcePeriod(people)).toEqual([]);
    // A time column it no longer has: none.
    expect(withSourceColumns(draft, "CRM", people.source!.target, { columns, key: ["id"], time: "gone" }).source?.time).toBeUndefined();
  });

  it("hide a column's field, not bringing it back when the columns are read again, and show it again", () => {
    const draft = { source: people.source, fields: people.fields.map(({ collectionId: _c, position: _p, ...f }) => f) };
    const hidden = withHiddenColumns(draft, ["name"]);
    expect(hidden.fields.some((f) => f.column === "name")).toBe(false);
    expect(hidden.source?.hiddenColumns).toEqual(["name"]);
    const reread = withSourceColumns(hidden, "CRM", people.source!.target, { columns, key: ["id"] });
    expect(reread.fields.some((f) => f.column === "name")).toBe(false);
    expect(reread.source?.hiddenColumns).toEqual(["name"]);
    const shown = withHiddenColumns(reread, []);
    expect(shown.fields.at(-1)?.column).toBe("name");
    expect(shown.source?.hiddenColumns).toBeUndefined();
  });

  it("name a collection after its table", () => {
    expect(namesOfTable("customer_orders")).toEqual({ name: "Customer order", pluralName: "Customer orders" });
    expect(namesOfTable("companies")).toEqual({ name: "Company", pluralName: "Companies" });
    expect(namesOfTable("status")).toEqual({ name: "Status", pluralName: "Status" });
  });
});

describe("addRows", () => {
  const row = (key: string, v: number, group?: string): SourceRow => ({ key, values: [v], ...(group !== undefined && { group }) });
  const item = (r: SourceRow) => ({ id: r.key, collectionId: "c", spaceId: "s", createdAt: "", updatedAt: "", values: { v: r.values[0] as number } });

  it("makes only the rows added since, a new first page anew (unchanged rows keep their item)", () => {
    let made = 0;
    const make = (r: SourceRow) => (made++, item(r));
    const page1 = [row("a", 1, "x"), row("b", 2, "y")];
    const b1 = addRows(null, [1], page1, true, make, (items) => items);
    const both = [...page1, row("c", 3, "x"), row("a", 1, "y")];
    const b2 = addRows(b1, [1], both, true, make, (items) => items);
    expect(made).toBe(3);
    expect(b2.computed.map((i) => i.id)).toEqual(["a", "b", "c", "a"]);
    expect(b2.all.map((i) => i.id)).toEqual(["a", "b", "c"]);
    expect([...b2.byGroup].map(([k, list]) => [k, list.map((i) => i.id)])).toEqual([["x", ["a", "c"]], ["y", ["b", "a"]]]);
    // Another first page: built anew, a row that didn't change keeps its item.
    const before = b2.computed[1];
    const b3 = addRows(b2, [2], [row("b", 2), row("c", 9)], false, make, (items) => items);
    expect(made).toBe(4);
    expect(b3.computed[0]).toBe(before);
    expect(b3.computed.map((i) => i.values.v)).toEqual([2, 9]);
  });
});
