import { describe, expect, it } from "vitest";
import {
  BACKLINKS_FIELDS,
  backlinkId,
  backlinkItems,
  backlinkPath,
  backlinksCollection,
  BACKLINKS_ID,
  findCollection,
  itemPath,
  linkTargets,
  parseTargets,
  VIRTUAL_COLLECTIONS,
} from "./backlinks";
import { blankField, pickableFields, type Collection } from "./model";
import { isReadOnly } from "./sources";

const targets = (kind: string, text: string | null, over: { target?: string | null; ref?: string | null; json?: string | null } = {}) =>
  JSON.parse(linkTargets(kind, over.target ?? null, text, over.ref ?? null, over.json ?? null)) as { item: string; collection: string }[];

describe("linkTargets", () => {
  it("reads the items a Markdown text links to, whatever of their page the link names", () => {
    const md = [
      "See [Dune](#/collections/book/items/dune) and [its author](#/collections/book/items/dune?field=f1)",
      "[a block](#/collections/person/items/frank?view=v&block=b), [a collection](#/collections/book/items), [a view](#/collections/book/items?view=v)",
    ].join("\n");
    expect(targets("markdown", md)).toEqual([
      { item: "dune", collection: "book" },
      { item: "frank", collection: "person" },
    ]);
  });

  it("holds each item once, sorted by collection then item (the same text on every device)", () => {
    const md = "[b](#/collections/z/items/2) [a](#/collections/a/items/9) [c](#/collections/a/items/1) [again](#/collections/z/items/2)";
    expect(linkTargets("markdown", null, md, null, null)).toBe(
      '[{"item":"1","collection":"a"},{"item":"9","collection":"a"},{"item":"2","collection":"z"}]',
    );
  });

  it("keeps keys in the order Postgres' jsonb gives them back, so a row that went through the server reads the same", () => {
    const json = linkTargets("markdown", null, "[x](#/collections/c/items/i)", null, null);
    expect(Object.keys(JSON.parse(json)[0])).toEqual(["item", "collection"]);
  });

  it("reads HTML and AI text too, and ids as a remote row has them (base64url)", () => {
    expect(targets("html", `<a href="#/collections/crm/items/Zm9vOjE_-">row</a>`)).toEqual([{ item: "Zm9vOjE_-", collection: "crm" }]);
    expect(targets("ai", "A summary, see [x](#/collections/book/items/dune)")).toEqual([{ item: "dune", collection: "book" }]);
  });

  it("ignores a link that is not one to an item of the app", () => {
    expect(targets("markdown", "[web](https://example.com/#/collections/book/items/dune)")).toEqual([]);
    expect(targets("markdown", "[new](#/collections/book/items/new) [list](#/collections/book/items)")).toEqual([]);
    expect(targets("markdown", "[name form](book/dune) plain text")).toEqual([]);
    expect(targets("string", "[x](#/collections/book/items/dune)")).toEqual([]);
    expect(targets("component", "[x](#/collections/book/items/dune)")).toEqual([]);
    expect(targets("markdown", null)).toEqual([]);
  });

  it("takes a reference field's item, or its list of items, from the target collection", () => {
    expect(targets("item", null, { target: "person", ref: "frank" })).toEqual([{ item: "frank", collection: "person" }]);
    expect(targets("item", null, { target: "person", ref: null })).toEqual([]);
    expect(targets("item_list", null, { target: "person", json: '["b","a","b"]' })).toEqual([
      { item: "a", collection: "person" },
      { item: "b", collection: "person" },
    ]);
    // Lists that aren't item lists: nothing.
    expect(targets("string_list", null, { json: '["a"]' })).toEqual([]);
    expect(targets("item_list", null, { target: "person", json: "not json" })).toEqual([]);
    expect(targets("item_list", null, { target: "person", json: '{"a":1}' })).toEqual([]);
    expect(targets("item_list", null, { target: null, json: '["a"]' })).toEqual([]);
  });
});

describe("parseTargets", () => {
  it("reads the stored JSON, and nothing from anything else", () => {
    expect(parseTargets('[{"item":"a","collection":"c"}]')).toEqual([{ item: "a", collection: "c" }]);
    expect(parseTargets('[{"item":1},"x",null]')).toEqual([]);
    expect(parseTargets("{")).toEqual([]);
    expect(parseTargets(null)).toEqual([]);
    expect(parseTargets('{"a":1}')).toEqual([]);
  });
});

const book: Collection = {
  id: "book", name: "Book", pluralName: "Books", icon: null, description: "", itemViews: [], spaceIds: null, createdAt: "", updatedAt: "",
  fields: [blankField("t", "Title", "string"), blankField("n", "Notes", "markdown")],
};

describe("the Backlinks collection", () => {
  it("is virtual and read-only, with the fields Item, Title, Collection and Field, and Created / Updated of the linking item", () => {
    expect(backlinksCollection).toMatchObject({ id: BACKLINKS_ID, name: "Backlink", pluralName: "Backlinks", virtual: "backlinks", titleField: "title" });
    expect(isReadOnly(backlinksCollection)).toBe(true);
    expect(isReadOnly(book)).toBe(false);
    expect(backlinksCollection.fields.map((f) => [f.id, f.name, f.kind])).toEqual([
      ["item", "Item", "markdown"], ["title", "Title", "string"], ["collection", "Collection", "string"], ["field", "Field", "string"],
    ]);
    expect(pickableFields(backlinksCollection).map((f) => f.name)).toEqual(["Item", "Title", "Collection", "Field", "Created", "Updated"]);
    expect(BACKLINKS_FIELDS.every((id) => pickableFields(backlinksCollection).some((f) => f.id === id))).toBe(true);
  });

  it("is found by id beside the stored collections, only", () => {
    expect(findCollection([book], "book")).toBe(book);
    expect(findCollection([book], BACKLINKS_ID)).toBe(backlinksCollection);
    expect(findCollection([book], "gone")).toBeUndefined();
    expect(findCollection([book], null)).toBeUndefined();
    expect(VIRTUAL_COLLECTIONS).toEqual([backlinksCollection]);
  });

  it("makes a row of each link: a link to the linking item, its label, its collection, the field, its dates", () => {
    const link = { sourceCollectionId: "book", sourceItemId: "dune", fieldId: "n", itemCreatedAt: "2026-01-01T00:00:00.000Z", itemUpdatedAt: "2026-02-01T00:00:00.000Z" };
    const [row] = backlinkItems([link], [book], new Map([["dune", "Dune [1965]"]]));
    expect(row).toMatchObject({
      id: "book:dune:n",
      collectionId: BACKLINKS_ID,
      values: { item: "[Dune \\[1965\\]](#/collections/book/items/dune)", title: "Dune [1965]", collection: "Books", field: "Notes" },
      createdAt: link.itemCreatedAt,
      updatedAt: link.itemUpdatedAt,
    });
    expect(backlinkId(link)).toBe(row.id);
    expect(backlinkPath(row.id)).toBe("/collections/book/items/dune");
  });

  it("calls an untitled linking item by its collection's name, and leaves out a link whose collection or field is gone", () => {
    const link = { sourceCollectionId: "book", sourceItemId: "x", fieldId: "n", itemCreatedAt: "", itemUpdatedAt: "" };
    expect(backlinkItems([link], [book], new Map([["x", null]]))[0].values.title).toBe("Book");
    expect(backlinkItems([link], [book], new Map())[0].values.title).toBe("Book");
    expect(backlinkItems([{ ...link, fieldId: "gone" }], [book], new Map())).toEqual([]);
    expect(backlinkItems([{ ...link, sourceCollectionId: "gone" }], [book], new Map())).toEqual([]);
  });

  it("opens a row at the linking item, and any other item at its own page", () => {
    expect(itemPath(book, { id: "dune" })).toBe("/collections/book/items/dune");
    expect(itemPath(backlinksCollection, { id: "book:dune:n" })).toBe("/collections/book/items/dune");
  });
});
