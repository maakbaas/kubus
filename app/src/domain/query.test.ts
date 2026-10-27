import { describe, expect, it } from "vitest";
import type { FieldDef, Item, Collection } from "./model";
import { applyQuery, defaultQuery, filterCodeValue, filterValueProblem, resolveFilterValues, type FilterRule, type QueryContext } from "./query";

const field = (id: string, name: string, kind: FieldDef["kind"], position: number): FieldDef => ({
  id, collectionId: "t", name, kind, targetCollectionId: null, componentId: null, code: null, output: null, frameRatio: null, choiceFilter: [], toggleIcon: null, strikeThrough: false, position,
});

const collection: Collection = {
  id: "t", name: "Book", pluralName: "Books", icon: null, description: "", itemViews: [], spaceIds: null,
  fields: [field("title", "Title", "string", 0), field("pages", "Pages", "number", 1)],
  createdAt: "", updatedAt: "",
};

const book = (id: string, title: string, pages: number | null): Item => ({
  id, collectionId: "t", spaceId: "default", values: { title, pages }, createdAt: "", updatedAt: "",
});

const ctx: QueryContext = { refLabel: () => "" };
const books = [book("1", "Charlie", 300), book("2", "Alpha", null), book("3", "Bravo", 120)];
const ids = (r: ReturnType<typeof applyQuery>) => r.groups[0].items.map((o) => o.id);

describe("applyQuery", () => {
  it("sorts by title by default", () => {
    expect(ids(applyQuery(collection, books, defaultQuery(), ctx))).toEqual(["2", "3", "1"]);
  });

  it("keeps empty values last in both directions", () => {
    const asc = { ...defaultQuery(), sort: [{ fieldId: "pages", direction: "asc" as const }] };
    const desc = { ...asc, sort: [{ fieldId: "pages", direction: "desc" as const }] };
    expect(ids(applyQuery(collection, books, asc, ctx))).toEqual(["3", "1", "2"]);
    expect(ids(applyQuery(collection, books, desc, ctx))).toEqual(["1", "3", "2"]);
  });

  it("filters and searches", () => {
    const q = { ...defaultQuery(), filters: [{ id: "f", fieldId: "title", operator: "contains" as const, value: "a" }] };
    expect(applyQuery(collection, books, q, ctx).total).toBe(3);
    expect(applyQuery(collection, books, defaultQuery(), ctx, "brav").total).toBe(1);
  });

  it("filters a checkbox on true or false", () => {
    const withRead: Collection = { ...collection, fields: [...collection.fields, field("read", "Read", "checkbox", 2)] };
    const items = books.map((b, i) => ({ ...b, values: { ...b.values, read: i === 0 } }));
    const is = (value: string) => ids(applyQuery(withRead, items, { ...defaultQuery(), filters: [{ id: "f", fieldId: "read", operator: "is" as const, value }] }, ctx));
    expect(is("true")).toEqual(["1"]);
    expect(is(" False ")).toEqual(["2", "3"]);
  });
});

describe("{{ }} code in filter values", () => {
  const done = field("done", "Done", "checkbox", 0);
  const pages = field("pages", "Pages", "number", 1);
  const tasks: Collection = { id: "t", name: "Task", pluralName: "Tasks", icon: null, description: "", fields: [done, pages], itemViews: [], spaceIds: null, createdAt: "", updatedAt: "" };
  const task = (id: string, d: boolean, p: number): Item => ({ id, collectionId: "t", spaceId: "default", values: { done: d, pages: p }, createdAt: "", updatedAt: "" });
  const items = [task("a", true, 10), task("b", false, 300)];
  const ids = (filters: FilterRule[], page: Parameters<typeof resolveFilterValues>[1] = null) =>
    applyQuery(tasks, items, { ...defaultQuery(), filters: resolveFilterValues(filters, page) }, { refLabel: () => "" }).groups.flatMap((g) => g.items.map((i) => i.id));

  it("is worked out as if its result had been typed", () => {
    expect(ids([{ id: "r", fieldId: "done", operator: "is", value: "{{ 1 == 1 }}" }])).toEqual(["a"]);
    expect(ids([{ id: "r", fieldId: "done", operator: "is", value: "{{ 1 == 2 }}" }])).toEqual(["b"]);
    expect(ids([{ id: "r", fieldId: "pages", operator: "gt", value: "{{ 10 * 10 }}" }])).toEqual(["b"]);
  });

  it("matches nothing when it can't be compared, never the wrong items", () => {
    expect(ids([{ id: "r", fieldId: "done", operator: "is", value: "maybe" }])).toEqual([]);
    expect(ids([{ id: "r", fieldId: "done", operator: "is", value: "{{ nope() }}" }])).toEqual([]);
    expect(ids([{ id: "r", fieldId: "done", operator: "is", value: "{{ $items.length }}" }])).toEqual([]);
    expect(filterCodeValue("{{ $item.Pages }}", null)).toMatch(/^⚠ \$item is the page's item/);
    expect(filterValueProblem(done, "is", "maybe")).toMatch(/true or false/);
  });

  it("reads the page's item as $item on an item page", () => {
    const page = { collection: tasks, item: task("p", false, 50), refLabel: () => "" };
    expect(ids([{ id: "r", fieldId: "pages", operator: "gt", value: "{{ $item.Pages }}" }], page)).toEqual(["b"]);
  });
});
