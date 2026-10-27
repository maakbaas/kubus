import { describe, expect, it } from "vitest";
import type { SourceColumn } from "../../../shared/sources";
import { blankField, pickableFields, type Collection } from "./model";
import { canGroup, canSort, fieldOperators, namesOfTable, offeredKinds, rowItem, rowItemId, rowKey, sourceQuery, sourceShape, withSourceColumns } from "./sources";
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

  it("name a collection after its table", () => {
    expect(namesOfTable("customer_orders")).toEqual({ name: "Customer order", pluralName: "Customer orders" });
    expect(namesOfTable("companies")).toEqual({ name: "Company", pluralName: "Companies" });
    expect(namesOfTable("status")).toEqual({ name: "Status", pluralName: "Status" });
  });
});
