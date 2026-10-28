import { describe, expect, it } from "vitest";
import type { Component } from "./components";
import { draftProblem, draftProblems, settingsProblem } from "./collectionDraft";
import { blankField, collectionDraft, type Collection, type CollectionDraft } from "./model";

const field = (id: string, name: string, kind: Parameters<typeof blankField>[2] = "string", rest: Partial<CollectionDraft["fields"][number]> = {}) => {
  const { collectionId: _c, position: _p, ...f } = blankField(id, name, kind);
  return { ...f, ...rest } as CollectionDraft["fields"][number];
};
const draft = (fields: CollectionDraft["fields"], extra: Partial<CollectionDraft> = {}): CollectionDraft => ({
  id: "c", name: "Book", pluralName: "Books", icon: null, description: "", spaceIds: null, fields, ...extra,
});
const shared = (id: string, code = "{{ $item.Title }}"): Component => ({ id, name: id, description: "", code, output: "markdown", frameRatio: null, ai: false, createdAt: "", updatedAt: "" });

describe("settingsProblem", () => {
  it("a reference needs a collection to point to", () => {
    expect(settingsProblem(field("f", "Author", "item"), [])).toBe("Choose a collection");
    expect(settingsProblem(field("f", "Authors", "item_list"), [])).toBe("Choose a collection");
    expect(settingsProblem(field("f", "Author", "item", { targetCollectionId: "a" }), [])).toBeUndefined();
  });

  it("a component field needs a component that works", () => {
    expect(settingsProblem(field("f", "Calc", "component"), [])).toMatch(/Choose a component/);
    expect(settingsProblem(field("f", "Calc", "component", { componentId: "gone" }), [])).toMatch(/gone/);
    expect(settingsProblem(field("f", "Calc", "component", { componentId: "k" }), [shared("k")])).toBeUndefined();
    expect(settingsProblem(field("f", "Calc", "component", { code: "  " }), [])).toBe("Write the component");
  });

  it("a remote collection's own fields are component fields; a column shows one", () => {
    expect(settingsProblem(field("f", "Note", "string"), [], true)).toBe("A remote collection's own fields are component fields");
    expect(settingsProblem(field("f", "Name", "string", { column: "name" }), [], true)).toBeUndefined();
    expect(settingsProblem(field("f", "Calc", "component", { code: "{{ $item.Name }}", output: "markdown" }), [], true)).toBeUndefined();
  });
});

describe("draftProblems", () => {
  it("a good draft is valid", () => {
    const p = draftProblems(draft([field("a", "Title")]), []);
    expect(p).toEqual({ nameError: undefined, pluralError: undefined, fieldErrors: {}, targetErrors: {}, noFields: false, sourceError: undefined, valid: true });
  });

  it("both names are required (blank is empty)", () => {
    const p = draftProblems(draft([field("a", "Title")], { name: "  ", pluralName: "" }), []);
    expect(p).toMatchObject({ nameError: "Singular name is required", pluralError: "Name is required", valid: false });
  });

  it("field names are required and unique, ignoring case and spaces around", () => {
    const p = draftProblems(draft([field("a", "Title"), field("b", " title "), field("c", " ")]), []);
    expect(p.fieldErrors).toEqual({ b: "Duplicate field name", c: "Name is required" });
    expect(p.valid).toBe(false);
  });

  it("a collection always has a field", () => {
    expect(draftProblems(draft([]), [])).toMatchObject({ noFields: true, valid: false });
  });

  it("targets and components are checked per field", () => {
    const p = draftProblems(draft([field("a", "Title"), field("b", "Author", "item")]), []);
    expect(p.targetErrors).toEqual({ b: "Choose a collection" });
  });

  it("a remote collection needs the column that tells rows apart", () => {
    const source = { name: "CRM", target: { table: { schema: "public", name: "t" } }, key: "id", columns: [{ name: "name", type: "text", kind: "string" as const }] };
    const bad = draftProblems(draft([field("a", "Name", "string", { column: "name" })], { source }), []);
    expect(bad).toMatchObject({ sourceError: "Choose the column that tells rows apart", valid: false });
    const good = draftProblems(draft([field("a", "Name", "string", { column: "name" })], { source: { ...source, key: "name" } }), []);
    expect(good.valid).toBe(true);
  });
});

describe("draftProblem", () => {
  it("is null for a good draft", () => {
    expect(draftProblem(draft([field("a", "Title")]), [])).toBeNull();
  });

  it("names the first problem, names before fields", () => {
    expect(draftProblem(draft([field("a", " ")], { name: "" }), [])).toBe("Singular name is required");
    expect(draftProblem(draft([field("a", "Title")], { pluralName: "" }), [])).toBe("Name is required");
    expect(draftProblem(draft([]), [])).toBe("A collection needs at least one field");
  });

  it("then the source, then the first field with a problem, by its name", () => {
    const source = { name: "CRM", target: { table: { schema: "public", name: "t" } }, key: "id", columns: [] };
    expect(draftProblem(draft([field("a", "Name", "string", { column: "name" })], { source }), [])).toBe("Choose the column that tells rows apart");
    expect(draftProblem(draft([field("a", "Title"), field("b", "Title")]), [])).toBe("Field “Title”: Duplicate field name");
    expect(draftProblem(draft([field("a", "Title"), field("b", "Author", "item")]), [])).toBe("Field “Author”: Choose a collection");
  });
});

describe("collectionDraft", () => {
  it("takes a collection as it is, without the fields' collection and position", () => {
    const collection = {
      id: "c", name: "Book", pluralName: "Books", icon: "book", description: "d", spaceIds: ["s"], itemViews: [], createdAt: "", updatedAt: "",
      fields: [blankField("a", "Title", "string", { collectionId: "c", position: 3 })],
    } as Collection;
    const d = collectionDraft(collection);
    expect(d).toMatchObject({ id: "c", name: "Book", pluralName: "Books", icon: "book", description: "d", spaceIds: ["s"], source: null, titleField: null });
    expect(d.fields[0]).not.toHaveProperty("collectionId");
    expect(d.fields[0]).not.toHaveProperty("position");
    expect(d.fields[0]).toMatchObject({ id: "a", name: "Title", kind: "string" });
    expect(d).not.toHaveProperty("itemViews");
  });
});
