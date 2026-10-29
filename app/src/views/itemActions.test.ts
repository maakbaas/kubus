// @vitest-environment node
// What a block can do with its items, against the real repository and the shared item cache.
import { describe, expect, it, vi } from "vitest";
import { ItemCache } from "../app/itemCache";
import { newId, type FieldDef, type Item } from "../domain/model";
import type { ViewQuery } from "../domain/query";
import { device } from "../test/fakeServer";
import { buildItemActions, readOnlyActions, stableItemActions, type ItemActionsOptions } from "./itemActions";
import type { ItemActions } from "./registry";

const field = (name: string, kind: FieldDef["kind"], position: number, extra: Partial<FieldDef> = {}): FieldDef => ({
  id: newId(), collectionId: "", name, kind, targetCollectionId: null, componentId: null, code: null, output: null,
  frameRatio: null, choiceFilter: [], toggleIcon: null, strikeThrough: false, position, ...extra,
});

const query = (extra: Partial<ViewQuery> = {}): ViewQuery => ({ filters: [], sort: [], groupBy: null, ...extra }) as ViewQuery;
const until = (check: () => boolean) => vi.waitFor(() => expect(check()).toBe(true), { timeout: 20_000 });

async function setup(over: Partial<ItemActionsOptions> = {}) {
  const repo = await device({ connect: false });
  const id = newId();
  await repo.saveCollection({ id, name: "Book", pluralName: "Books", icon: null, description: "", spaceIds: null, fields: [field("Title", "string", 0), field("Pages", "number", 1), field("Seen", "checkbox", 2)] }, "default");
  const collection = (await repo.listCollections()).find((c) => c.id === id)!;
  const [title, pages] = collection.fields;
  const cache = new ItemCache(repo, (cid) => (cid === id ? collection : undefined), () => "default");
  cache.items.subscribe(id, () => {});
  await until(() => cache.items.snapshot(id).items !== null);
  const opened: [string, string | undefined][] = [];
  const confirm = vi.fn(async () => true);
  const onError = vi.fn();
  const onSort = vi.fn();
  const stored = () => cache.items.snapshot(id).items!;
  const make = (extra: Partial<ItemActionsOptions> = {}) =>
    buildItemActions({ collection, stored: stored(), query: query(), preset: {}, onSort, confirm, onError, ...over, ...extra }, { repo, cache, spaceId: "default", openRelated: (p, m) => opened.push([p, m]) });
  return { repo, collection, title, pages, cache, opened, confirm, onError, onSort, stored, make, id };
}

describe("opening", () => {
  it("opens an item here, beside or in a tab, in edit mode when asked", async () => {
    const t = await setup();
    const actions = t.make();
    const item = { id: "i1" } as Item;
    actions.open(item);
    actions.open(item, "beside", { edit: true });
    actions.openNew!("tab");
    expect(t.opened).toEqual([
      [`/collections/${t.id}/items/i1`, undefined],
      [`/collections/${t.id}/items/i1?edit=1`, "beside"],
      [`/collections/${t.id}/items/new`, "tab"],
    ]);
  });
});

describe("remove", () => {
  it("deletes after the person confirms, naming the collection", async () => {
    const t = await setup();
    const itemId = await t.repo.createItem(t.collection, { [t.title.id]: "Dune" }, "default");
    await until(() => t.stored().some((i) => i.id === itemId));
    await t.make().remove!(t.stored()[0]);
    expect(t.confirm).toHaveBeenCalledWith({ title: "Delete Book?", body: "This Book will be removed." });
    await until(() => t.stored().length === 0);
  });

  it("keeps the item when the person says no", async () => {
    const t = await setup({ confirm: vi.fn(async () => false) });
    const itemId = await t.repo.createItem(t.collection, { [t.title.id]: "Dune" }, "default");
    await until(() => t.stored().length === 1);
    await t.make().remove!(t.stored()[0]);
    expect(await t.repo.getItem(t.collection, itemId)).not.toBeNull();
  });

  it("reports a failure instead of throwing", async () => {
    const t = await setup();
    const spy = vi.spyOn(t.repo, "deleteItem").mockRejectedValue(new Error("locked"));
    await t.make().remove!({ id: "x" } as Item);
    expect(t.onError).toHaveBeenCalledWith("locked");
    spy.mockRestore();
  });
});

describe("duplicate", () => {
  it("copies the stored values and numbers the title", async () => {
    const t = await setup();
    await t.repo.createItem(t.collection, { [t.title.id]: "Dune", [t.pages.id]: 412 }, "default");
    await until(() => t.stored().length === 1);
    const [dune] = t.stored();
    await t.make().duplicate!(dune);
    await until(() => t.stored().length === 2);
    const copy = t.stored().find((i) => i.id !== dune.id)!;
    expect(copy.values[t.title.id]).toBe("Dune 2");
    expect(copy.values[t.pages.id]).toBe(412);
  });

  it("copies the stored item, not the computed one passed in, and skips empty values", async () => {
    const t = await setup();
    await t.repo.createItem(t.collection, { [t.title.id]: "Dune" }, "default");
    await until(() => t.stored().length === 1);
    const [dune] = t.stored();
    const computed = { ...dune, values: { ...dune.values, [t.title.id]: "Dune (computed)" } };
    await t.make().duplicate!(computed);
    await until(() => t.stored().length === 2);
    const copy = t.stored().find((i) => i.id !== dune.id)!;
    expect(copy.values[t.title.id]).toBe("Dune 2");
    expect(copy.values[t.pages.id]).toBeUndefined();
  });

  it("reports a failure", async () => {
    const t = await setup();
    vi.spyOn(t.repo, "createItem").mockRejectedValue("disk full");
    await t.make().duplicate!({ id: "x", collectionId: t.id, spaceId: "default", values: {} } as Item);
    expect(t.onError).toHaveBeenCalledWith("disk full");
  });
});

describe("setValue", () => {
  it("shows the edit at once and saves it", async () => {
    const t = await setup();
    const itemId = await t.repo.createItem(t.collection, { [t.title.id]: "Dune" }, "default");
    await until(() => t.stored().length === 1);
    const item = t.stored()[0];
    const pending = t.make().setValue!(item, t.pages, 10);
    expect(t.stored()[0].values[t.pages.id]).toBe(10); // patched before the save finished
    await pending;
    expect((await t.repo.getItem(t.collection, itemId))!.values[t.pages.id]).toBe(10);
    expect(t.onError).not.toHaveBeenCalled();
  });

  it("on failure reports it and loads the list again, dropping the optimistic value", async () => {
    const t = await setup();
    await t.repo.createItem(t.collection, { [t.title.id]: "Dune" }, "default");
    await until(() => t.stored().length === 1);
    const item = t.stored()[0];
    vi.spyOn(t.repo, "updateItem").mockRejectedValue(new Error("read-only"));
    await t.make().setValue!(item, t.pages, 10);
    expect(t.onError).toHaveBeenCalledWith("read-only");
    await until(() => t.stored()[0].values[t.pages.id] == null);
  });
});

describe("create", () => {
  it("resolves once the new item is in the shared list", async () => {
    const t = await setup();
    await t.make().create!({ [t.title.id]: "Emma" });
    expect(t.stored().map((i) => i.values[t.title.id])).toEqual(["Emma"]);
  });
});

describe("sorting and grouping", () => {
  it("clicking a column sorts ascending, then descending, then ascending again; another column starts ascending", async () => {
    const t = await setup();
    const sortBy = (q: ViewQuery, id: string) => t.make({ query: q }).sortBy!(id);
    sortBy(query(), "f");
    expect(t.onSort).toHaveBeenLastCalledWith([{ fieldId: "f", direction: "asc" }]);
    sortBy(query({ sort: [{ fieldId: "f", direction: "asc" }] }), "f");
    expect(t.onSort).toHaveBeenLastCalledWith([{ fieldId: "f", direction: "desc" }]);
    sortBy(query({ sort: [{ fieldId: "f", direction: "desc" }] }), "f");
    expect(t.onSort).toHaveBeenLastCalledWith([{ fieldId: "f", direction: "asc" }]);
    sortBy(query({ sort: [{ fieldId: "f", direction: "desc" }] }), "g");
    expect(t.onSort).toHaveBeenLastCalledWith([{ fieldId: "g", direction: "asc" }]);
  });

  it("exposes the query's primary sort and grouping, and the preset a new item starts with", async () => {
    const t = await setup();
    const sort = { fieldId: "f", direction: "asc" } as const;
    const actions = t.make({ query: query({ sort: [sort], groupBy: t.title.id }), preset: { [t.pages.id]: 5 } });
    expect(actions.sort).toEqual(sort);
    expect(actions.groupBy).toBe(t.title.id);
    expect(actions.groupPreset!("Dune")).toEqual({ [t.pages.id]: 5, [t.title.id]: "Dune" });
  });
});

describe("stable actions", () => {
  it("delegate to the latest handlers and read the latest query, without changing identity", async () => {
    const t = await setup();
    const first = t.make();
    const latest = { current: first };
    const stable = stableItemActions(latest, false);
    const open = vi.fn();
    latest.current = { ...t.make({ query: query({ sort: [{ fieldId: "f", direction: "desc" }], groupBy: "g" }) }), open };
    stable.open({ id: "z" } as Item, "tab", { edit: true });
    expect(open).toHaveBeenCalledWith({ id: "z" }, "tab", { edit: true });
    expect(stable.sort).toEqual({ fieldId: "f", direction: "desc" });
    expect(stable.groupBy).toBe("g");
    stable.sortBy!("f");
    expect(t.onSort).toHaveBeenLastCalledWith([{ fieldId: "f", direction: "asc" }]);
  });

  it("forwards every editing action", async () => {
    const calls: string[] = [];
    const latest = {
      current: {
        open: () => calls.push("open"),
        remove: () => calls.push("remove"),
        duplicate: () => calls.push("duplicate"),
        setValue: async () => void calls.push("setValue"),
        openNew: () => calls.push("openNew"),
        create: async () => void calls.push("create"),
        groupPreset: () => (calls.push("groupPreset"), {}),
        sortBy: () => calls.push("sortBy"),
      } satisfies ItemActions,
    };
    const s = stableItemActions(latest, false);
    const item = {} as Item;
    const f = {} as FieldDef;
    s.open(item);
    s.remove!(item);
    s.duplicate!(item);
    await s.setValue!(item, f, 1);
    s.openNew!();
    await s.create!({});
    s.groupPreset!("k");
    s.sortBy!("f");
    expect(calls).toEqual(["open", "remove", "duplicate", "setValue", "openNew", "create", "groupPreset", "sortBy"]);
  });

  it("a remote collection's can only open and sort", async () => {
    const t = await setup();
    const latest = { current: t.make({ query: query({ groupBy: "g", sort: [{ fieldId: "f", direction: "asc" }] }) }) };
    const stable = stableItemActions(latest, true);
    expect(Object.keys(stable).sort()).toEqual(["groupBy", "open", "sort", "sortBy"]);
    expect(stable.remove).toBeUndefined();
    expect(stable.setValue).toBeUndefined();
    expect(stable.groupBy).toBe("g");
    expect(stable.sort).toEqual({ fieldId: "f", direction: "asc" });
    latest.current = t.make({ query: query({ groupBy: "h" }) });
    expect(stable.groupBy).toBe("h"); // reads through to the latest
  });

  it("readOnlyActions passes open and sortBy through", () => {
    const open = vi.fn();
    const sortBy = vi.fn();
    const ro = readOnlyActions({ open, sortBy, remove: vi.fn(), sort: { fieldId: "f", direction: "asc" } } as unknown as ItemActions);
    ro.open({} as Item);
    ro.sortBy!("x");
    expect(open).toHaveBeenCalled();
    expect(sortBy).toHaveBeenCalledWith("x");
    expect(ro.remove).toBeUndefined();
  });
});

