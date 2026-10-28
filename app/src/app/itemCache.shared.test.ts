// @vitest-environment node
// SharedCache and ItemCache against stand-in sources: loading, errors, racing loads, single-item
// refreshes, the grace period, spaces and changed fields.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DataChange, Repository } from "../data/repository";
import type { Collection, Item } from "../domain/model";
import { ItemCache, SharedCache } from "./itemCache";

interface Row {
  id: string;
  v: string;
}
const col = (id: string, ...fieldIds: string[]) => ({ id, fields: fieldIds.map((f) => ({ id: f })) }) as unknown as Collection;

/** A source over a mutable table, whose reads can be held back. */
function setup(opts: { same?: boolean; known?: boolean } = {}) {
  const table = new Map<string, Row>([["a", { id: "a", v: "1" }], ["b", { id: "b", v: "2" }]]);
  const collections = new Map<string, Collection>(opts.known === false ? [] : [["c", col("c", "f1")]]);
  const gate = { list: undefined as Promise<void> | undefined, fail: undefined as string | undefined, oneFail: undefined as string | undefined };
  const source = {
    list: vi.fn(async () => {
      if (gate.list) await gate.list;
      if (gate.fail) throw new Error(gate.fail);
      return [...table.values()].map((r) => ({ ...r }));
    }),
    one: vi.fn(async (_c: Collection, id: string) => {
      if (gate.oneFail) throw gate.oneFail;
      const r = table.get(id);
      return r ? { ...r } : null;
    }),
    ...(opts.same && { same: (a: Row, b: Row) => a.v === b.v }),
  };
  const cache = new SharedCache<Row>(source, (id) => collections.get(id));
  return { cache, table, collections, source, gate };
}

const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("SharedCache loading", () => {
  it("is empty until something subscribes, then loads once for all viewers", async () => {
    const { cache, source } = setup();
    expect(cache.snapshot("c")).toEqual({ items: null, version: 0 });
    const l1 = vi.fn();
    const l2 = vi.fn();
    cache.subscribe("c", l1);
    cache.subscribe("c", l2);
    expect(cache.snapshot("c").items).toBeNull();
    await flush();
    expect(source.list).toHaveBeenCalledTimes(1);
    expect(cache.snapshot("c").items?.map((r) => r.id)).toEqual(["a", "b"]);
    expect(cache.snapshot("c").version).toBe(1);
    expect(l1).toHaveBeenCalledTimes(1);
    expect(l2).toHaveBeenCalledTimes(1);
  });

  it("a collection that does not exist is an empty list, not a load", async () => {
    const { cache, source } = setup({ known: false });
    cache.subscribe("nope", () => {});
    await flush();
    expect(cache.snapshot("nope").items).toEqual([]);
    expect(source.list).not.toHaveBeenCalled();
    await cache.reload("nope"); // nothing to load
    await cache.refresh("nope", "a");
    expect(source.one).not.toHaveBeenCalled();
  });

  it("keeps what was loaded and reports the error when a reload fails", async () => {
    const { cache, gate } = setup();
    cache.subscribe("c", () => {});
    await flush();
    gate.fail = "disk";
    await cache.reload("c");
    expect(cache.snapshot("c")).toMatchObject({ error: "disk" });
    expect(cache.snapshot("c").items).toHaveLength(2);
    gate.fail = undefined;
    await cache.reload("c");
    expect(cache.snapshot("c").error).toBeUndefined();
  });

  it("an older, slower load never overwrites a newer one", async () => {
    const { cache, table, gate } = setup();
    let release!: () => void;
    gate.list = new Promise<void>((r) => (release = r));
    cache.subscribe("c", () => {}); // first load, held
    await flush();
    gate.list = undefined;
    table.set("a", { id: "a", v: "new" });
    await cache.reload("c"); // second load finishes first
    expect(cache.snapshot("c").items?.[0].v).toBe("new");
    release(); // the first one returns with the old table snapshot... taken after: still must be ignored
    await flush();
    expect(cache.snapshot("c").version).toBe(1);
  });

  it("an older load that fails is ignored too", async () => {
    const { cache, gate } = setup();
    let fail!: () => void;
    gate.list = new Promise<void>((_, rej) => (fail = () => rej(new Error("late"))));
    cache.subscribe("c", () => {});
    await flush();
    gate.list = undefined;
    await cache.reload("c");
    fail();
    await flush();
    expect(cache.snapshot("c").error).toBeUndefined();
  });

  it("with `same`, a reload that finds nothing different keeps the list and tells nobody", async () => {
    const { cache } = setup({ same: true });
    const listener = vi.fn();
    cache.subscribe("c", listener);
    await flush();
    const loaded = cache.snapshot("c");
    listener.mockClear();
    await cache.reload("c");
    expect(cache.snapshot("c")).toBe(loaded);
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("SharedCache single items", () => {
  it("replaces a changed item in place, adds a new one first, drops a gone one", async () => {
    const { cache, table } = setup();
    cache.subscribe("c", () => {});
    await flush();
    const [a0, b0] = cache.snapshot("c").items!;

    table.set("a", { id: "a", v: "changed" });
    await cache.refresh("c", "a");
    const [a1, b1] = cache.snapshot("c").items!;
    expect(a1.v).toBe("changed");
    expect(b1).toBe(b0); // the other item keeps its identity
    expect(a1).not.toBe(a0);

    table.set("z", { id: "z", v: "9" });
    await cache.refresh("c", "z");
    expect(cache.snapshot("c").items!.map((r) => r.id)).toEqual(["z", "a", "b"]);

    table.delete("b");
    await cache.refresh("c", "b");
    expect(cache.snapshot("c").items!.map((r) => r.id)).toEqual(["z", "a"]);
  });

  it("with `same`, an unchanged item is not replaced", async () => {
    const { cache, table } = setup({ same: true });
    cache.subscribe("c", () => {});
    await flush();
    const loaded = cache.snapshot("c");
    await cache.refresh("c", "a");
    expect(cache.snapshot("c")).toBe(loaded);
    table.set("a", { id: "a", v: "other" });
    await cache.refresh("c", "a");
    expect(cache.snapshot("c").items![0].v).toBe("other");
  });

  it("a refresh during the first load starts the load again", async () => {
    const { cache, source, gate } = setup();
    let release!: () => void;
    gate.list = new Promise<void>((r) => (release = r));
    cache.subscribe("c", () => {});
    const again = cache.refresh("c", "a");
    release();
    await again;
    await flush();
    expect(source.list).toHaveBeenCalledTimes(2);
    expect(source.one).not.toHaveBeenCalled();
  });

  it("a failing read keeps the list and reports the error", async () => {
    const { cache, gate } = setup();
    cache.subscribe("c", () => {});
    await flush();
    gate.oneFail = "boom";
    await cache.refresh("c", "a");
    expect(cache.snapshot("c")).toMatchObject({ error: "boom" });
    expect(cache.snapshot("c").items).toHaveLength(2);
  });

  it("settled waits for the reload under way instead of starting another", async () => {
    const { cache, source } = setup();
    cache.subscribe("c", () => {});
    await flush();
    const first = cache.refresh("c", "a");
    const second = cache.settled("c", "a");
    await Promise.all([first, second]);
    expect(source.one).toHaveBeenCalledTimes(1);
    await cache.settled("c", "a"); // none under way: a new one
    expect(source.one).toHaveBeenCalledTimes(2);
  });

  it("patch changes one item right away; nothing shown means nothing to patch", async () => {
    const { cache } = setup();
    cache.patch("c", "a", (r) => ({ ...r, v: "x" })); // not subscribed
    expect(cache.snapshot("c").items).toBeNull();
    const listener = vi.fn();
    cache.subscribe("c", listener);
    cache.patch("c", "a", (r) => ({ ...r, v: "x" })); // still loading
    await flush();
    const [a, b] = cache.snapshot("c").items!;
    listener.mockClear();
    cache.patch("c", "a", (r) => ({ ...r, v: "x" }));
    const [a2, b2] = cache.snapshot("c").items!;
    expect(a2.v).toBe("x");
    expect(a2).not.toBe(a);
    expect(b2).toBe(b);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("SharedCache change feed", () => {
  const change = (extra: Partial<DataChange>): DataChange => ({ scope: "items", collectionId: "c", ...extra }) as DataChange;

  it("an item change re-reads that item, a collection-wide one the list, others nothing", async () => {
    const { cache, source } = setup();
    cache.subscribe("c", () => {});
    await flush();
    cache.handle(change({ itemId: "a" }));
    await flush();
    expect(source.one).toHaveBeenCalledTimes(1);
    expect(source.list).toHaveBeenCalledTimes(1);
    cache.handle(change({}));
    await flush();
    expect(source.list).toHaveBeenCalledTimes(2);
    cache.handle({ scope: "collections" } as DataChange);
    await flush();
    expect(source.list).toHaveBeenCalledTimes(2);
    expect(source.one).toHaveBeenCalledTimes(1);
  });

  it("changes of collections nobody shows are ignored", async () => {
    const { cache, source } = setup();
    cache.handle(change({ itemId: "a" }));
    cache.handle(change({}));
    await flush();
    expect(source.one).not.toHaveBeenCalled();
    expect(source.list).not.toHaveBeenCalled();
  });
});

describe("SharedCache lifetime", () => {
  it("stays loaded for a grace period after the last viewer left, so coming back is instant", async () => {
    const { cache, source } = setup();
    const off = cache.subscribe("c", () => {});
    await flush();
    off();
    await vi.advanceTimersByTimeAsync(9_000);
    const back = cache.subscribe("c", () => {});
    expect(cache.snapshot("c").items).toHaveLength(2);
    expect(source.list).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(20_000); // a viewer is back: not dropped
    expect(cache.snapshot("c").items).toHaveLength(2);
    back();
    await vi.advanceTimersByTimeAsync(10_001);
    expect(cache.snapshot("c").items).toBeNull(); // dropped
  });

  it("another viewer keeps it alive when one leaves", async () => {
    const { cache } = setup();
    const off1 = cache.subscribe("c", () => {});
    cache.subscribe("c", () => {});
    await flush();
    off1();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(cache.snapshot("c").items).toHaveLength(2);
  });

  it("reloadAll loads what is shown again from scratch and forgets what nothing shows", async () => {
    const { cache, source } = setup();
    const off = cache.subscribe("c", () => {});
    cache.subscribe("d", () => {});
    await flush();
    off(); // "c" has no viewers (within its grace period)
    cache.reloadAll();
    expect(cache.snapshot("c").items).toBeNull(); // gone
    expect(source.list).toHaveBeenCalledTimes(1); // "d" is unknown to the source's collections: empty, nothing to load
  });

  it("reloadAll resets a shown list to loading, then loads it", async () => {
    const { cache } = setup();
    cache.subscribe("c", () => {});
    await flush();
    cache.reloadAll();
    expect(cache.snapshot("c").items).toBeNull();
    await flush();
    expect(cache.snapshot("c").items).toHaveLength(2);
  });

  it("collectionsChanged reloads only lists whose collection got other fields", async () => {
    const { cache, collections, source } = setup();
    cache.subscribe("c", () => {});
    await flush();
    cache.collectionsChanged();
    await flush();
    expect(source.list).toHaveBeenCalledTimes(1);
    collections.set("c", col("c", "f1", "f2"));
    cache.collectionsChanged();
    await flush();
    expect(source.list).toHaveBeenCalledTimes(2);
    cache.collectionsChanged(); // the new fields are known now
    await flush();
    expect(source.list).toHaveBeenCalledTimes(2);
  });
});

describe("ItemCache", () => {
  function make() {
    const collection = col("c", "f1");
    let space = "s1";
    let feed: (c: DataChange) => void = () => {};
    const unsubscribe = vi.fn();
    const items = new Map<string, Item>([
      ["a", { id: "a", collectionId: "c", spaceId: "s1", values: {} } as Item],
      ["b", { id: "b", collectionId: "c", spaceId: "s2", values: {} } as Item],
    ]);
    const repo = {
      listItems: vi.fn(async (_c: Collection, s: string) => [...items.values()].filter((i) => i.spaceId === s)),
      getItem: vi.fn(async (_c: Collection, id: string) => items.get(id) ?? null),
      listLabels: vi.fn(async (_c: Collection, ids?: string[]) => [...items.values()].filter((i) => !ids || ids.includes(i.id)).map((i) => ({ id: i.id, label: `L${i.id}`, spaceId: i.spaceId }))),
      subscribe: (f: (c: DataChange) => void) => ((feed = f), unsubscribe),
    };
    const cache = new ItemCache(repo as unknown as Repository, (id) => (id === "c" ? collection : undefined), () => space);
    return { cache, repo, items, feed: (c: DataChange) => feed(c), unsubscribe, setSpace: (s: string) => (space = s) };
  }

  it("lists the current space's items and every space's labels", async () => {
    const { cache } = make();
    cache.items.subscribe("c", () => {});
    cache.labels.subscribe("c", () => {});
    await flush();
    expect(cache.items.snapshot("c").items!.map((i) => i.id)).toEqual(["a"]);
    expect(cache.labels.snapshot("c").items!.map((l) => l.id)).toEqual(["a", "b"]);
  });

  it("an item that moved to another space leaves the list; one that arrived joins it", async () => {
    const { cache, items, feed } = make();
    cache.items.subscribe("c", () => {});
    await flush();
    items.set("a", { ...items.get("a")!, spaceId: "s2" });
    feed({ scope: "items", collectionId: "c", itemId: "a" } as DataChange);
    await flush();
    expect(cache.items.snapshot("c").items).toEqual([]);
    items.set("b", { ...items.get("b")!, spaceId: "s1" });
    feed({ scope: "items", collectionId: "c", itemId: "b" } as DataChange);
    await flush();
    expect(cache.items.snapshot("c").items!.map((i) => i.id)).toEqual(["b"]);
  });

  it("a read of a deleted item drops it from labels", async () => {
    const { cache, items, feed } = make();
    cache.labels.subscribe("c", () => {});
    await flush();
    items.delete("a");
    feed({ scope: "items", collectionId: "c", itemId: "a" } as DataChange);
    await flush();
    expect(cache.labels.snapshot("c").items!.map((l) => l.id)).toEqual(["b"]);
  });

  it("switching space reloads items for the new space; dispose stops listening", async () => {
    const { cache, setSpace, repo, unsubscribe } = make();
    cache.items.subscribe("c", () => {});
    await flush();
    setSpace("s2");
    cache.spaceChanged();
    await flush();
    expect(cache.items.snapshot("c").items!.map((i) => i.id)).toEqual(["b"]);
    expect(repo.listLabels).not.toHaveBeenCalled();
    cache.collectionsChanged();
    cache.dispose();
    expect(unsubscribe).toHaveBeenCalled();
  });
});
