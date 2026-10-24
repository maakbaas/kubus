import { describe, expect, it } from "vitest";
import type { FieldDef, Item, Collection } from "./model";
import { applyQuery, defaultQuery, type QueryContext } from "./query";

const field = (id: string, name: string, kind: FieldDef["kind"], position: number): FieldDef => ({
  id, collectionId: "t", name, kind, targetCollectionId: null, componentId: null, componentArgs: {}, choiceFilter: [], toggleIcon: null, position,
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
});
