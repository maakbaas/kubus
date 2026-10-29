import { describe, expect, it } from "vitest";
import {
  collectionTarget,
  isAddressQuery,
  itemTarget,
  matchScore,
  parseStoredLink,
  rankTargets,
  searchLinkTargets,
  storedLinkTarget,
  viewTarget,
  withoutShown,
  type LinkTargetData,
} from "./linkTargets";
import type { Collection, ItemLabel } from "./model";
import type { CollectionView } from "./views";

const field = (id: string, name: string) => ({ id, name }) as Collection["fields"][number];
const books = { id: "c1", name: "Book", pluralName: "Books", fields: [field("f1", "Title"), field("f2", "Author")], itemViews: [] } as unknown as Collection;
const people = { id: "c2", name: "Person", pluralName: "People", fields: [field("f3", "Name")], itemViews: [] } as unknown as Collection;
const remote = { id: "c3", name: "Row", pluralName: "Rows", fields: [], itemViews: [], source: { kind: "x" } } as unknown as Collection;
const views = [
  { id: "v1", collectionId: "c1", name: "Reading list" },
  { id: "v2", collectionId: "c2", name: "Authors" },
] as unknown as CollectionView[];
const labelsOf: Record<string, ItemLabel[]> = {
  c1: [
    { id: "i1", label: "Dune", spaceId: "s" },
    { id: "i2", label: "Authority", spaceId: "s" },
    { id: "i3", label: "Elsewhere", spaceId: "other" },
    { id: "i4", label: null, spaceId: "s" },
  ],
  c2: [{ id: "i5", label: "Frank Herbert", spaceId: "s" }],
};
const data: LinkTargetData = {
  collections: [books, people, remote],
  views,
  spaceId: "s",
  labels: async (c, ids) => (labelsOf[c.id] ?? []).filter((l) => !ids || ids.includes(l.id)),
};
const names = (ts: { name: string }[]) => ts.map((t) => t.name);

describe("parseStoredLink", () => {
  it("reads the app's own routes, with or without the address before the #", () => {
    expect(parseStoredLink("#/collections/c1/items")).toEqual({ collectionId: "c1" });
    expect(parseStoredLink("https://x.test/app/#/collections/c1/items?view=v1")).toEqual({ collectionId: "c1", viewId: "v1" });
    expect(parseStoredLink("#/collections/c1/items/i1?field=f2")).toEqual({ collectionId: "c1", itemId: "i1", fieldId: "f2" });
    expect(parseStoredLink("#/collections/c1/views/v1")).toEqual({ collectionId: "c1", viewId: "v1" });
    expect(parseStoredLink("/collections/c1/items/i1")).toEqual({ collectionId: "c1", itemId: "i1" });
  });
  it("is null for anything else, and for an unfinished address", () => {
    for (const t of ["books", "https://x.test", "#tag", "#/", "#/coll", "#/settings"]) expect(parseStoredLink(t)).toBeNull();
    expect(parseStoredLink("#/collections/c1/items/new")).toEqual({ collectionId: "c1" });
  });
});

describe("matchScore and rankTargets", () => {
  const all = [
    collectionTarget(books),
    collectionTarget(people),
    viewTarget(people, views[1]),
    viewTarget(books, views[0]),
    itemTarget(books, labelsOf.c1[0]),
    itemTarget(books, labelsOf.c1[1]),
  ];
  it("ranks exact, then prefix, then word start, then inside, then the place", () => {
    expect(names(rankTargets(all, "author"))).toEqual(["Authors", "Authority"]);
    expect(matchScore(all[0], "books")).toBe(0);
    expect(matchScore(all[0], "boo")).toBe(1);
    expect(matchScore(all[3], "list")).toBe(2);
    expect(matchScore(all[4], "un")).toBe(3);
    // Its place: the views of Books are found by "books" (an item's place is the singular name).
    expect(names(rankTargets(all, "books"))).toEqual(["Books", "Reading list"]);
    expect(names(rankTargets(all, "book"))).toEqual(["Books", "Reading list", "Authority", "Dune"]);
  });
  it("is case-insensitive, and an empty text takes everything in kind order", () => {
    expect(names(rankTargets(all, "DUNE"))).toEqual(["Dune"]);
    expect(rankTargets(all, "").map((t) => t.kind)).toEqual(["collection", "collection", "view", "view", "item", "item"]);
  });
  it("finds a target by its address only when the text looks like one", () => {
    expect(names(rankTargets(all, "#/collections/c1/items?view=v1"))).toEqual(["Reading list"]);
    expect(names(rankTargets(all, "view=v2"))).toEqual(["Authors"]);
    expect(rankTargets(all, "c1")).toEqual([]);
  });
  it("limits the list", () => {
    expect(rankTargets(all, "", 2)).toHaveLength(2);
  });
});

describe("withoutShown", () => {
  it("drops keys already shown and repeats", () => {
    const a = collectionTarget(books);
    const b = itemTarget(books, labelsOf.c1[0]);
    expect(withoutShown([a, b, b], ["collection:c1"])).toEqual([b]);
    expect(withoutShown([a, a], [])).toEqual([a]);
  });
});

describe("searchLinkTargets", () => {
  it("offers collections and views, and items when asked, of the shown space's native collections", async () => {
    expect(names(await searchLinkTargets("", data, { items: false }))).toEqual(["Books", "People", "Rows", "Authors", "Reading list"]);
    const withItems = await searchLinkTargets("", data, { items: true });
    expect(names(withItems)).toContain("Dune");
    expect(names(withItems)).not.toContain("Elsewhere");
    expect(names(withItems)).not.toContain("");
    expect((await searchLinkTargets("herbert", data, { items: true })).map((t) => t.href)).toEqual(["#/collections/c2/items/i5"]);
  });
  it("stores by id: view, item and field links", async () => {
    expect((await searchLinkTargets("reading", data, { items: true }))[0].href).toBe("#/collections/c1/items?view=v1");
    const [auth] = await searchLinkTargets("dune#auth", data, { items: false });
    expect(auth).toMatchObject({ kind: "field", name: "Author", href: "#/collections/c1/items/i1?field=f2", context: "Book › Dune" });
  });
  it("lists the fields of the items named when nothing follows the #, and only matching fields otherwise", async () => {
    expect(names(await searchLinkTargets("dune#", data, { items: false }))).toEqual(["Author", "Title"]);
    expect(await searchLinkTargets("dune#zzz", data, { items: false })).toEqual([]);
    // The item's name is no match for a field.
    expect(await searchLinkTargets("dune#dune", data, { items: false })).toEqual([]);
  });
  it("finds the page a pasted address names, and nothing for one that names nothing here", async () => {
    expect((await searchLinkTargets("#/collections/c1/items/i1?field=f1", data, { items: false })).map((t) => t.key)).toEqual(["field:i1:f1"]);
    expect((await searchLinkTargets("#/collections/c1/views/v1", data, { items: false })).map((t) => t.name)).toEqual(["Reading list"]);
    expect((await searchLinkTargets("#/collections/c1/items", data, { items: false })).map((t) => t.name)).toEqual(["Books"]);
    for (const gone of ["#/collections/zz/items", "#/collections/c1/items/zz", "#/collections/c1/views/zz", "#/collections/c1/items/i1?field=zz"]) {
      expect(await searchLinkTargets(gone, data, { items: false })).toEqual([]);
    }
  });
  it("storedLinkTarget does not look for the items of a remote collection", async () => {
    expect(await storedLinkTarget({ collectionId: "c3", itemId: "r1" }, data)).toBeNull();
  });
});

describe("isAddressQuery", () => {
  it("is true for text that looks like (part of) a link address, false for words and tags", () => {
    for (const t of ["#/collections/c1/items", "collections/c1", "items?view=v1", "view=v1", "dune#auth", " a/b "]) expect(isAddressQuery(t)).toBe(true);
    for (const t of ["", "dune", "reading list", "#tag", "  #tag"]) expect(isAddressQuery(t)).toBe(false);
  });
  it("lets a search show a page once: what is listed already is left out of the address matches", async () => {
    const found = await searchLinkTargets("items/i1", data, { items: true });
    expect(found.map((t) => t.key)).toEqual(["item:i1"]);
    expect(withoutShown(found, ["item:i1"])).toEqual([]);
    const both = await searchLinkTargets("collections/c1", data, { items: true });
    expect(new Set(both.map((t) => t.key)).size).toBe(both.length);
  });
});
