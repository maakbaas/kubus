import { describe, expect, it } from "vitest";
import { findCollection, itemPath } from "./backlinks";
import { entryItems, findListCollection, LIST_DONE, LIST_ITEM, LIST_POSITION, LIST_VALUE, listCollection, listCollectionId, listCollections, withEntryDone, type EntryMemo } from "./listEntries";
import { blankField, type Collection, type FieldDef, type Item } from "./model";
import { applyQuery } from "./query";
import { isReadOnly } from "./sources";

const field = (id: string, name: string, kind: FieldDef["kind"], rest: Partial<FieldDef> = {}) => blankField(id, name, kind, rest);
const collection = (id: string, name: string, plural: string, fields: FieldDef[], rest: Partial<Collection> = {}): Collection => ({
  id, name, pluralName: plural, icon: null, description: "", fields: fields.map((f, position) => ({ ...f, collectionId: id, position })),
  itemViews: [], spaceIds: null, createdAt: "t0", updatedAt: "t0", ...rest,
});
const item = (id: string, collectionId: string, values: Item["values"]): Item => ({ id, collectionId, spaceId: "default", values, createdAt: "c", updatedAt: "u" });

const people = collection("person", "Person", "People", [field("name", "Name", "string"), field("status", "Status", "string")]);
const books = collection("book", "Book", "Books", [
  field("title", "Title", "string"),
  field("todo", "Todo", "checklist", { toggleIcon: "star" }),
  field("tags", "Tags", "string_list"),
  field("scores", "Scores", "number_list"),
  field("authors", "Authors", "item_list", { targetCollectionId: "person" }),
  field("pages", "Pages", "number"),
]);
const remote = collection("feed", "Feed", "Feeds", [field("cats", "Categories", "string_list")], { source: { name: "s", target: "t", key: "id" } as unknown as Collection["source"] });
const all = [books, people, remote];
const list = (fieldId: string) => findListCollection(all, listCollectionId(fieldId))!;

describe("a list field's entries as a collection", () => {
  it("is offered for every list field of a native collection, read-only, and found by its id", () => {
    expect(listCollections(all).map((c) => c.pluralName)).toEqual(["Books / Todo", "Books / Tags", "Books / Scores", "Books / Authors"]);
    const todo = list("todo");
    expect(isReadOnly(todo)).toBe(true);
    expect(todo.listOf).toEqual({ collectionId: "book", fieldId: "todo", kind: "checklist", targetCollectionId: null });
    expect(findCollection(all, listCollectionId("todo"))).toBe(todo);
    expect(findCollection(all, listCollectionId("pages"))).toBeUndefined(); // not a list
    expect(findCollection(all, listCollectionId("gone"))).toBeUndefined();
    // The same object while nothing it is made from changes (blocks memoize on it).
    expect(listCollection(books, books.fields[1], all)).toBe(todo);
  });

  it("has the item it is in (a reference), the entry and its position; a checklist also Done; a list of items its items' fields", () => {
    const names = (c: Collection) => c.fields.map((f) => [f.id, f.name, f.kind]);
    expect(names(list("todo"))).toEqual([[LIST_ITEM, "Book", "item"], [LIST_VALUE, "Todo", "string"], [LIST_DONE, "Done", "checkbox"], [LIST_POSITION, "Position", "number"]]);
    expect(list("todo").fields[2].toggleIcon).toBe("star");
    expect(list("todo").fields[0].targetCollectionId).toBe("book");
    expect(names(list("scores"))[1]).toEqual([LIST_VALUE, "Scores", "number"]);
    expect(names(list("authors")).map(([id]) => id)).toEqual([LIST_ITEM, LIST_POSITION, "name", "status"]);
  });

  it("makes one row per entry of every item, keeping unchanged rows", () => {
    const dune = item("dune", "book", { todo: ["[x] read", "[ ] reread"], tags: ["sf"], scores: [4, 4.5], authors: ["frank", "gone"] });
    const emma = item("emma", "book", { todo: ["[ ] start"] });
    const memo: EntryMemo = new WeakMap();
    const todo = entryItems(list("todo"), [dune, emma], null, memo);
    expect(todo.map((r) => [r.id, r.values])).toEqual([
      ["dune~0", { [LIST_ITEM]: "dune", [LIST_VALUE]: "read", [LIST_DONE]: true, [LIST_POSITION]: 1 }],
      ["dune~1", { [LIST_ITEM]: "dune", [LIST_VALUE]: "reread", [LIST_DONE]: false, [LIST_POSITION]: 2 }],
      ["emma~0", { [LIST_ITEM]: "emma", [LIST_VALUE]: "start", [LIST_DONE]: false, [LIST_POSITION]: 1 }],
    ]);
    expect(entryItems(list("todo"), [dune, emma], null, memo)[0]).toBe(todo[0]);
    expect(entryItems(list("scores"), [dune], null).map((r) => r.values[LIST_VALUE])).toEqual([4, 4.5]);
    expect(entryItems(list("tags"), [dune, emma], null).map((r) => r.values[LIST_VALUE])).toEqual(["sf"]);
    // A list of items: the entries' items' values; one that is gone is left out.
    const frank = item("frank", "person", { name: "Frank", status: "alive" });
    const authors = entryItems(list("authors"), [dune], new Map([["frank", frank]]));
    expect(authors.map((r) => [r.id, r.values])).toEqual([["dune~0~frank", { name: "Frank", status: "alive", [LIST_ITEM]: "dune", [LIST_POSITION]: 1 }]]);
  });

  it("are filtered, sorted and grouped like any items: a checklist by Done, entries by their item", () => {
    const rows = entryItems(list("todo"), [item("dune", "book", { todo: ["[x] read", "[ ] reread"] }), item("emma", "book", { todo: ["[ ] start"] })], null);
    const result = applyQuery(list("todo"), rows, { filters: [], sort: [{ fieldId: LIST_POSITION, direction: "asc" }], groupBy: LIST_DONE }, { refLabel: (_f, id) => id });
    expect(result.groups.map((g) => [g.label, g.items.map((i) => i.values[LIST_VALUE])])).toEqual([["Checked", ["read"]], ["Not checked", ["start", "reread"]]]);
    const ofDune = applyQuery(list("todo"), rows, { filters: [{ id: "r", fieldId: LIST_ITEM, operator: "is", value: "dune" }], sort: [], groupBy: null }, { refLabel: (_f, id) => id });
    expect(ofDune.total).toBe(2);
  });

  it("open their item's page at the field, a list of items' entry its own item", () => {
    expect(itemPath(list("todo"), { id: "dune~1" })).toBe("/collections/book/items/dune?field=todo");
    expect(itemPath(list("authors"), { id: "dune~0~frank" })).toBe("/collections/person/items/frank");
  });

  it("tick a checklist's entry in its item's value, found again by its text when the list changed", () => {
    expect(withEntryDone(["[ ] a", "[ ] b"], 1, "b", true)).toEqual(["[ ] a", "[x] b"]);
    expect(withEntryDone(["[ ] new", "[ ] a", "[x] b"], 1, "b", false)).toEqual(["[ ] new", "[ ] a", "[ ] b"]);
    expect(withEntryDone(["[ ] a"], 3, "gone", true)).toBeNull();
  });
});
