// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { ItemCache } from "../app/itemCache";
import type { Repository } from "../data/repository";
import { blankField, type Collection, type Item, type ItemLabel } from "../domain/model";
import { renderHook } from "../test/hooks";

const m = vi.hoisted(() => ({ store: {} as Record<string, unknown> }));
vi.mock("../app/store", () => ({ useStore: () => m.store }));
const { choicesFor, formatValue, useReferenceOptions } = await import("./useReferenceOptions");

const collection = (id: string, name: string, fields: Collection["fields"]): Collection => ({
  id, name, pluralName: `${name}s`, icon: null, description: "", itemViews: [], spaceIds: null, createdAt: "", updatedAt: "", fields,
});
const rule = (fieldId: string, operator: string, value: string) => ({ id: `${fieldId}-${operator}`, fieldId, operator, value }) as never;

const authors = collection("author", "Author", [blankField("aname", "Name", "string"), blankField("country", "Country", "string", { position: 1 })]);
const shelves = collection("shelf", "Shelf", [blankField("sname", "Name", "string")]);
const books = collection("book", "Book", [
  blankField("btitle", "Title", "string"),
  blankField("bauthor", "Author", "item", { targetCollectionId: "author" }),
  blankField("bshelf", "Shelf", "item", { targetCollectionId: "shelf" }),
]);
/** A book whose author field only offers Dutch authors. */
const limitedBooks = collection("book", "Book", [
  blankField("btitle", "Title", "string"),
  blankField("bauthor", "Author", "item", { targetCollectionId: "author", choiceFilter: [rule("country", "is", "NL")] }),
]);

const item = (id: string, collectionId: string, values: Item["values"], spaceId = "s1"): Item => ({ id, collectionId, spaceId, values, createdAt: "", updatedAt: "" });

function setup(all: Collection[], rows: Record<string, Item[]>, extra: Record<string, unknown> = {}) {
  const table = { ...rows };
  const repo = {
    listItems: vi.fn(async (c: Collection) => table[c.id] ?? []),
    getItem: vi.fn(async (c: Collection, id: string) => table[c.id]?.find((i) => i.id === id) ?? null),
    listLabels: vi.fn(async (c: Collection, ids?: string[]): Promise<ItemLabel[]> =>
      (table[c.id] ?? []).filter((i) => !ids || ids.includes(i.id)).map((i) => ({ id: i.id, label: (i.values[c.fields[0].id] as string) ?? null, spaceId: i.spaceId }))),
    subscribe: () => () => {},
  };
  const cache = new ItemCache(repo as unknown as Repository, (id) => all.find((c) => c.id === id), () => "s1");
  m.store = { cache, collections: all, components: [], space: { id: "s1" }, ...extra };
  return { cache, repo, table };
}

describe("useReferenceOptions", () => {
  const rows = () => ({
    author: [item("a1", "author", { aname: "Ann", country: "NL" }), item("a2", "author", { aname: "Bob", country: "BE" })],
    shelf: [item("sh1", "shelf", { sname: "Top" })],
  });

  it("gives nothing for a target still loading, then its labels, one list per referenced collection", async () => {
    setup([authors, shelves, books], rows());
    const h = renderHook(() => useReferenceOptions(books));
    expect(h.result.current).toEqual({});
    await h.settle();
    expect(h.result.current.author).toEqual([{ id: "a1", label: "Ann" }, { id: "a2", label: "Bob" }]);
    expect(h.result.current.shelf).toEqual([{ id: "sh1", label: "Top" }]);
  });

  it("a collection without references has no options and subscribes to nothing", async () => {
    const { repo } = setup([authors], rows());
    const h = renderHook(() => useReferenceOptions(authors));
    await h.settle();
    expect(h.result.current).toEqual({});
    expect(repo.listLabels).not.toHaveBeenCalled();
  });

  it("labels of other spaces are marked, not offered", async () => {
    setup([authors, shelves, books], { author: [item("a1", "author", { aname: "Ann" }, "s2")] });
    const h = renderHook(() => useReferenceOptions(books));
    await h.settle();
    expect(h.result.current.author).toEqual([{ id: "a1", label: "Ann", elsewhere: true }]);
  });

  it("an edit to one target rebuilds only its options; the others keep their identity", async () => {
    const { cache, table } = setup([authors, shelves, books], rows());
    const h = renderHook(() => useReferenceOptions(books));
    await h.settle();
    const before = h.result.current;
    table.author = [item("a1", "author", { aname: "Anna", country: "NL" }), table.author[1]];
    await cache.labels.refresh("author", "a1");
    await h.settle();
    const after = h.result.current;
    expect(after).not.toBe(before);
    expect(after.author[0].label).toBe("Anna");
    expect(after.shelf).toBe(before.shelf);
  });

  it("the same object while nothing the options are built from changed", async () => {
    const { cache } = setup([authors, shelves, books], rows());
    const h = renderHook(() => useReferenceOptions(books));
    await h.settle();
    const before = h.result.current;
    h.rerender();
    expect(h.result.current).toBe(before);
    // An edit that leaves the labels as they were changes nothing that shows them.
    await cache.labels.refresh("author", "a1");
    await h.settle();
    expect(h.result.current).toBe(before);
  });

  it("a field with a choice filter reads the target's items, and marks those it leaves out", async () => {
    setup([authors, limitedBooks], rows());
    const h = renderHook(() => useReferenceOptions(limitedBooks));
    await h.settle();
    expect(h.result.current.author).toEqual([{ id: "a1", label: "Ann" }, { id: "a2", label: "Bob", excludedBy: ["bauthor"] }]);
  });

  it("follows what the collection refers to, not the collection's identity", async () => {
    const { repo } = setup([authors, shelves, books], rows());
    const h = renderHook(({ c }: { c: Collection }) => useReferenceOptions(c), { props: { c: books } });
    await h.settle();
    const calls = repo.listLabels.mock.calls.length;
    h.rerender({ c: { ...books, name: "Renamed" } });
    await h.settle();
    expect(repo.listLabels.mock.calls.length).toBe(calls); // nothing loaded again
    h.unmount();
  });
});

describe("choicesFor", () => {
  const field = blankField("f", "F", "item");
  const options = [
    { id: "ok", label: "Ok" },
    { id: "out", label: "Out", excludedBy: ["f", "g"] },
    { id: "other", label: "Other", excludedBy: ["g"] },
    { id: "far", label: "Far", elsewhere: true },
  ];

  it("leaves out what the field's own filter excludes and other spaces' items", () => {
    expect(choicesFor(field, options, []).map((o) => o.id)).toEqual(["ok", "other"]);
  });

  it("keeps what is already chosen, so a value that no longer matches stays shown", () => {
    expect(choicesFor(field, options, ["out", "far"]).map((o) => o.id)).toEqual(["ok", "out", "other", "far"]);
  });
});

describe("formatValue", () => {
  const refs = { author: [{ id: "a1", label: "Ann" }, { id: "a2", label: "Bob" }] };
  const one = blankField("f", "Author", "item", { targetCollectionId: "author" });
  const many = blankField("g", "Authors", "item_list", { targetCollectionId: "author" });

  it("writes a value of a plain field as the field kind does", () => {
    expect(formatValue(blankField("n", "N", "number"), 12, refs)).toBe("12");
    expect(formatValue(blankField("s", "S", "string"), undefined, refs)).toBe("");
  });

  it("resolves a reference to its label, '(deleted)' when it is gone", () => {
    expect(formatValue(one, "a1", refs)).toBe("Ann");
    expect(formatValue(one, "zz", refs)).toBe("(deleted)");
  });

  it("joins a list of references", () => {
    expect(formatValue(many, ["a1", "a2", "zz"], refs)).toBe("Ann, Bob, (deleted)");
  });

  it("is empty for no value, or while the target is still loading", () => {
    expect(formatValue(one, undefined, refs)).toBe("");
    expect(formatValue(one, null, refs)).toBe("");
    expect(formatValue(one, "a1", {})).toBe("");
  });
});
