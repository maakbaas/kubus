// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { ItemCache } from "../app/itemCache";
import type { Repository } from "../data/repository";
import { blankField, type Collection, type Item, type ItemLabel } from "../domain/model";
import { renderHook } from "../test/hooks";

const m = vi.hoisted(() => ({ store: {} as Record<string, unknown>, fill: vi.fn() }));
vi.mock("../app/store", () => ({ useStore: () => m.store }));
vi.mock("../app/useAi", () => ({ useAiFill: m.fill }));
const { useCollectionData } = await import("./useCollectionData");

const collection = (id: string, name: string, fields: Collection["fields"]): Collection => ({
  id, name, pluralName: `${name}s`, icon: null, description: "", itemViews: [], spaceIds: null, createdAt: "", updatedAt: "", fields,
});
const item = (id: string, collectionId: string, values: Item["values"]): Item => ({ id, collectionId, spaceId: "s1", values, createdAt: "", updatedAt: "" });

const authors = collection("author", "Author", [blankField("aname", "Name", "string")]);
const books = collection("book", "Book", [
  blankField("btitle", "Title", "string"),
  blankField("bauthor", "Author", "item", { targetCollectionId: "author" }),
  blankField("blabel", "Label", "component", { position: 2, code: "{{ $item.Title }} by {{ $item.Author }}", output: "markdown" }),
]);

function setup(table: Record<string, Item[]>, fail = false) {
  const repo = {
    listItems: vi.fn(async (c: Collection) => {
      if (fail && c.id === "book") throw new Error("disk");
      return table[c.id] ?? [];
    }),
    getItem: vi.fn(async (c: Collection, id: string) => table[c.id]?.find((i) => i.id === id) ?? null),
    listLabels: vi.fn(async (c: Collection): Promise<ItemLabel[]> => (table[c.id] ?? []).map((i) => ({ id: i.id, label: i.values[c.fields[0].id] as string, spaceId: "s1" }))),
    subscribe: () => () => {},
  };
  const all = [authors, books];
  const cache = new ItemCache(repo as unknown as Repository, (id) => all.find((c) => c.id === id), () => "s1");
  m.store = { cache, collections: all, components: [], space: { id: "s1" } };
  m.fill.mockClear();
  return { cache };
}

describe("useCollectionData", () => {
  const table = () => ({
    author: [item("a1", "author", { aname: "Ann" })],
    book: [item("b1", "book", { btitle: "Dune", bauthor: "a1" }), item("b2", "book", { btitle: "Emma", bauthor: "gone" })],
  });

  it("has no items until they and the labels of what they refer to are in", async () => {
    setup(table());
    const h = renderHook(() => useCollectionData(books));
    expect(h.result.current.items).toBeNull();
    expect(h.result.current.stored).toBeNull();
    await h.settle();
    expect(h.result.current.items).toHaveLength(2);
  });

  it("computes component fields, reading a deleted reference as nothing there but as '(deleted)' in queries", async () => {
    setup(table());
    const h = renderHook(() => useCollectionData(books));
    await h.settle();
    const { items, stored, ctx } = h.result.current;
    expect(items!.map((i) => i.values.blabel)).toEqual(["Dune by Ann", "Emma by "]);
    expect(stored!.map((i) => i.values.blabel)).toEqual([undefined, undefined]); // as stored
    const author = books.fields[1];
    expect(ctx.refLabel(author, "a1")).toBe("Ann");
    expect(ctx.refLabel(author, "gone")).toBe("(deleted)");
  });

  it("gives the reference options and offers the items to the AI fill", async () => {
    setup(table());
    const h = renderHook(() => useCollectionData(books));
    await h.settle();
    expect(h.result.current.refs.author).toEqual([{ id: "a1", label: "Ann" }]);
    const [, computed] = m.fill.mock.calls[m.fill.mock.calls.length - 1];
    expect(computed).toBe(h.result.current.items);
  });

  it("keeps the items it computed while nothing changed, and computes only an edited one again", async () => {
    const t = table();
    const { cache } = setup(t);
    const h = renderHook(() => useCollectionData(books));
    await h.settle();
    const first = h.result.current.items!;
    h.rerender();
    expect(h.result.current.items).toBe(first);
    t.book = [t.book[0], item("b2", "book", { btitle: "Emma 2", bauthor: "gone" })];
    await cache.items.refresh("book", "b2");
    await h.settle();
    const next = h.result.current.items!;
    expect(next).not.toBe(first);
    expect(next[0]).toBe(first[0]); // unchanged: the same object, so rows aren't drawn again
    expect(next[1].values.blabel).toBe("Emma 2 by ");
  });

  it("reports why the items could not be read", async () => {
    setup(table(), true);
    const h = renderHook(() => useCollectionData(books));
    await h.settle();
    expect(h.result.current.error).toBe("disk");
    expect(h.result.current.items).toBeNull();
  });

  it("a collection without references needs no labels", async () => {
    setup({ author: [item("a1", "author", { aname: "Ann" })] });
    const h = renderHook(() => useCollectionData(authors));
    await h.settle();
    expect(h.result.current.items).toHaveLength(1);
    expect(h.result.current.refs).toEqual({});
  });
});
