import { describe, expect, it } from "vitest";
import type { FieldDef, ObjectInstance, ObjectType } from "./model";
import { applyQuery, defaultQuery, type QueryContext } from "./query";

const field = (id: string, name: string, kind: FieldDef["kind"], position: number): FieldDef => ({
  id, typeId: "t", name, kind, targetTypeId: null, templateId: null, templateArgs: {}, choiceFilter: [], toggleIcon: null, position,
});

const type: ObjectType = {
  id: "t", name: "Book", pluralName: "Books", icon: null, description: "", objectViews: [],
  fields: [field("title", "Title", "string", 0), field("pages", "Pages", "number", 1)],
  createdAt: "", updatedAt: "",
};

const book = (id: string, title: string, pages: number | null): ObjectInstance => ({
  id, typeId: "t", values: { title, pages }, createdAt: "", updatedAt: "",
});

const ctx: QueryContext = { refLabel: () => "" };
const books = [book("1", "Charlie", 300), book("2", "Alpha", null), book("3", "Bravo", 120)];
const ids = (r: ReturnType<typeof applyQuery>) => r.groups[0].objects.map((o) => o.id);

describe("applyQuery", () => {
  it("sorts by title by default", () => {
    expect(ids(applyQuery(type, books, defaultQuery(), ctx))).toEqual(["2", "3", "1"]);
  });

  it("keeps empty values last in both directions", () => {
    const asc = { ...defaultQuery(), sort: [{ fieldId: "pages", direction: "asc" as const }] };
    const desc = { ...asc, sort: [{ fieldId: "pages", direction: "desc" as const }] };
    expect(ids(applyQuery(type, books, asc, ctx))).toEqual(["3", "1", "2"]);
    expect(ids(applyQuery(type, books, desc, ctx))).toEqual(["1", "3", "2"]);
  });

  it("filters and searches", () => {
    const q = { ...defaultQuery(), filters: [{ id: "f", fieldId: "title", operator: "contains" as const, value: "a" }] };
    expect(applyQuery(type, books, q, ctx).total).toBe(3);
    expect(applyQuery(type, books, defaultQuery(), ctx, "brav").total).toBe(1);
  });
});
