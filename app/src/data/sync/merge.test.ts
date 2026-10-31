// @vitest-environment node
// Two devices syncing through FakeServer (the protocol of server/src/sync.ts): how their edits merge.
// A row replaces another only when its updated_at is newer, and values are rows of their own, so
// edits to different fields never conflict. Stamps never go back (domain/model.ts `now`), so in
// these tests a later edit is a newer one, whichever device syncs first.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { collectionDraft, newId, type Collection, type FieldDef } from "../../domain/model";
import { device, FakeServer, settled } from "../../test/fakeServer";
import { dashboardViewLink, itemLink } from "../../domain/bookmarks";
import type { DataChange } from "../repository";
import { SYNC_VERSION } from "../../../../shared/sync";

// Each test builds devices and a database: on a busy machine that outlasts the default 5 s.
vi.setConfig({ testTimeout: 30_000 });

let server: FakeServer;
type Repo = Awaited<ReturnType<typeof device>>;
let a: Repo;
let b: Repo;

beforeEach(async () => {
  server = new FakeServer().install();
  a = await device();
  b = await device();
});

const field = (name: string, kind: FieldDef["kind"] = "string"): FieldDef => ({
  id: newId(), collectionId: "", name, kind, targetCollectionId: null, componentId: null, code: null, output: null,
  frameRatio: null, choiceFilter: [], toggleIcon: null, strikeThrough: false, position: 0,
});

/** A Note collection (Title, Body, Pages) made on `a`, known to both devices; returns it as `a` and `b` list it. */
async function notes() {
  const id = newId();
  await a.saveCollection({ id, name: "Note", pluralName: "Notes", icon: null, description: "", spaceIds: null, fields: [field("Title"), field("Body"), field("Pages", "number")] }, "default");
  await settled(a);
  await settled(b);
  const on = async (repo: Repo): Promise<Collection> => (await repo.listCollections()).find((c) => c.id === id)!;
  return { a: await on(a), b: await on(b), id };
}

const valuesOn = async (repo: Repo, collection: Collection, itemId: string) => (await repo.getItem(collection, itemId))?.values;

describe("edits on two devices", () => {
  it("keep both when they touch different fields of one item", async () => {
    const n = await notes();
    const id = await a.createItem(n.a, { [n.a.fields[0].id]: "Plan" }, "default");
    await settled(a);
    await settled(b);
    // Both edit before either syncs.
    await a.updateItem(n.a, id, { [n.a.fields[1].id]: "from A" });
    await b.updateItem(n.b, id, { [n.b.fields[2].id]: 7 });
    await settled(a);
    await settled(b);
    await settled(a);
    const expected = { [n.a.fields[0].id]: "Plan", [n.a.fields[1].id]: "from A", [n.a.fields[2].id]: 7 };
    expect(await valuesOn(a, n.a, id)).toEqual(expected);
    expect(await valuesOn(b, n.b, id)).toEqual(expected);
  });

  it("let the newest edit of one field win, whichever device syncs first", async () => {
    const n = await notes();
    const id = await a.createItem(n.a, { [n.a.fields[0].id]: "Plan" }, "default");
    await settled(a);
    await settled(b);
    const title = n.a.fields[0].id;
    await a.updateItem(n.a, id, { [title]: "first (A)" });
    await b.updateItem(n.b, id, { [title]: "second (B)" });
    await settled(b); // the newer edit reaches the server first
    await settled(a); // the older one comes after: the server keeps the newer
    await settled(b);
    await settled(a);
    expect((await valuesOn(a, n.a, id))?.[title]).toBe("second (B)");
    expect((await valuesOn(b, n.b, id))?.[title]).toBe("second (B)");
    expect(server.rows("field_values").find((r) => r.field_id === title)?.value_text).toBe("second (B)");
  });

  it("let a later edit bring back an item another device deleted, and a later delete win over an edit", async () => {
    const n = await notes();
    const title = n.a.fields[0].id;
    const kept = await a.createItem(n.a, { [title]: "Kept" }, "default");
    const gone = await a.createItem(n.a, { [title]: "Gone" }, "default");
    await settled(a);
    await settled(b);
    // A deletes `kept` first, then B edits it: the later edit brings it back.
    await a.deleteItem(kept);
    await b.updateItem(n.b, kept, { [title]: "Kept, edited" });
    // B edits `gone` first, then A deletes it: the later delete wins.
    await b.updateItem(n.b, gone, { [title]: "Gone, edited" });
    await a.deleteItem(gone);
    for (const repo of [a, b, a, b]) await settled(repo);
    for (const [repo, c] of [[a, n.a], [b, n.b]] as const) {
      expect((await repo.getItem(c, kept))?.values[title]).toBe("Kept, edited");
      expect(await repo.getItem(c, gone)).toBeNull();
    }
  });

  it("drop the values of a field another device removed, and keep the others", async () => {
    const n = await notes();
    const [title, body] = n.a.fields;
    const id = await a.createItem(n.a, { [title.id]: "T", [body.id]: "B" }, "default");
    await settled(a);
    await settled(b);
    await a.saveCollection({ ...collectionDraft(n.a), fields: n.a.fields.filter((f) => f.id !== body.id) }, "default");
    await settled(a);
    await settled(b);
    const onB = (await b.listCollections()).find((c) => c.id === n.id)!;
    expect(onB.fields.map((f) => f.name)).toEqual(["Title", "Pages"]);
    expect((await b.getItem(onB, id))?.values).toEqual({ [title.id]: "T" });
  });

  it("carry a deleted collection to the other device with its items", async () => {
    const n = await notes();
    await a.createItem(n.a, {}, "default");
    await settled(a);
    await settled(b);
    expect(await b.countItemsByCollection(null)).toEqual({ [n.id]: 1 });
    await a.deleteCollection(n.id);
    await settled(a);
    await settled(b);
    expect(await b.listCollections()).toEqual([]);
    expect(await b.countItemsByCollection(null)).toEqual({});
    expect(await b.listAllViews()).toEqual([]);
  });

  it("carry spaces, views, bookmarks, components and item views", async () => {
    const n = await notes();
    await a.saveSpace({ id: "work", name: "Work", icon: "Briefcase" });
    const id = await a.createItem(n.a, {}, "work");
    await a.addBookmark(itemLink(n.id, id), "Remembered", "work");
    const ts = new Date().toISOString();
    await a.saveComponent({ id: "badge", name: "Badge", description: "", code: "{{ $item.Title }}", output: "markdown", frameRatio: null, ai: false, createdAt: ts, updatedAt: ts });
    const [all] = await a.listViews(n.id, "default");
    await a.saveView({ ...all, id: "second", name: "Second", position: 1, createdAt: ts, updatedAt: ts });
    await a.saveItemViews(n.id, [{ id: "compact", name: "Compact", isDefault: true, collapsed: { blocks: [], groups: {} }, layout: { fields: null, filters: [], hiddenLabels: [], blocks: [], editable: true, hideEmpty: false } }]);
    await settled(a);
    await settled(b);
    expect((await b.listSpaces()).map((s) => [s.id, s.icon])).toEqual([["default", null], ["work", "Briefcase"]]);
    expect((await b.listBookmarks("work")).map((x) => x.label)).toEqual(["Remembered"]);
    expect((await b.listComponents()).map((c) => c.name)).toEqual(["Badge"]);
    expect((await b.listViews(n.id, "default")).map((v) => v.name)).toEqual(["All", "Second"]);
    const onB = (await b.listCollections()).find((c) => c.id === n.id)!;
    expect(onB.itemViews.map((v) => v.id)).toEqual(["compact"]);
    await a.deleteSpace("work");
    await settled(a);
    await settled(b);
    expect((await b.listSpaces()).map((s) => s.id)).toEqual(["default"]);
    expect(await b.getItem(onB, id)).toBeNull();
    expect(await b.listBookmarks("work")).toEqual([]);
  });

  it("carry dashboards, their tabs per space and their bookmarks; edits of two tabs both stay", async () => {
    const n = await notes();
    await a.saveSpace({ id: "work", name: "Work", icon: null });
    await a.saveDashboard({ id: "d", name: "Home", icon: "Dashboard", description: "", spaceIds: null }, "default");
    const [first] = await a.listDashboardViews("d", "default");
    const ts = new Date().toISOString();
    const block = { id: "b", title: "", kind: "table", filters: null, sort: [], groupBy: null, layout: { fields: null, editable: true, hiddenLabels: [], hideEmpty: false }, collectionId: n.id, options: null };
    await a.saveDashboardView({ ...first, id: "second", name: "Second", position: 1, blocks: [block], createdAt: ts, updatedAt: ts });
    await a.addBookmark(dashboardViewLink("d", "second"), "Home / Second", "default");
    await settled(a);
    await settled(b);
    expect((await b.listDashboards()).map((d) => [d.name, d.icon])).toEqual([["Home", "Dashboard"]]);
    expect((await b.listDashboardViews("d", "default")).map((v) => [v.name, v.blocks.length])).toEqual([["Dashboard", 0], ["Second", 1]]);
    expect((await b.listDashboardViews("d", "work")).every((v) => v.virtual)).toBe(true);
    expect((await b.listBookmarks("default")).map((x) => [x.link, x.label])).toEqual([[dashboardViewLink("d", "second"), "Home / Second"]]);
    // Each tab is a row of its own: a rename on one device and a change of another tab on the other both stay.
    const onB = await b.listDashboardViews("d", "default");
    await a.saveDashboardView({ ...first, name: "Start" });
    await b.saveDashboardView({ ...onB[1], filters: [{ id: "r", fieldId: "$date", operator: "between", value: "day-6..day+0" }] });
    await settled(a);
    await settled(b);
    await settled(a);
    for (const repo of [a, b]) expect((await repo.listDashboardViews("d", "default")).map((v) => [v.name, v.filters.length])).toEqual([["Start", 0], ["Second", 1]]);
    await b.deleteDashboard("d");
    await settled(b);
    await settled(a);
    expect(await a.listDashboards()).toEqual([]);
    expect(await a.listAllDashboardViews()).toEqual([]);
    expect(await a.listBookmarks("default")).toEqual([]);
  });

  it("carry AI values with the fingerprint of their prompt, and the edited mark", async () => {
    const id = newId();
    await a.saveCollection({ id, name: "Memo", pluralName: "Memos", icon: null, description: "", spaceIds: null, fields: [field("Text"), { ...field("Gen", "ai"), code: "Say {{ $item.Text }}", output: "string" }] }, "default");
    const memo = (await a.listCollections()).find((c) => c.id === id)!;
    const item = await a.createItem(memo, { [memo.fields[0].id]: "hi" }, "default");
    await a.setGenerated(memo, item, memo.fields[1], "hello", "hash-1");
    await settled(a);
    await settled(b);
    const onB = (await b.listCollections()).find((c) => c.id === id)!;
    expect(await b.getItem(onB, item)).toMatchObject({ values: { [memo.fields[1].id]: "hello" }, aiInputs: { [memo.fields[1].id]: "hash-1" } });
    await b.updateItem(onB, item, { [memo.fields[1].id]: "mine" });
    await settled(b);
    await settled(a);
    expect(await a.getItem(memo, item)).toMatchObject({ values: { [memo.fields[1].id]: "mine" }, aiEdited: { [memo.fields[1].id]: true } });
  });
});

describe("clocks", () => {
  it("let a local edit win over a row from a device whose clock runs ahead, once that row was seen", async () => {
    const n = await notes();
    const title = n.a.fields[0].id;
    const id = await a.createItem(n.a, { [title]: "Plan" }, "default");
    await settled(a);
    await settled(b);
    // A device with a clock far ahead writes the title.
    const future = "2999-01-01T00:00:00.000Z";
    const old = server.rows("field_values").find((r) => r.item_id === id && r.field_id === title)!;
    server.sync({ since: 0, changes: { field_values: [{ ...old, value_text: "from the future", updated_at: future }] }, version: SYNC_VERSION });
    await settled(b);
    expect((await valuesOn(b, n.b, id))?.[title]).toBe("from the future");
    // B edits after having seen it: its stamp is later than the one it saw, so its edit is the newest.
    await b.updateItem(n.b, id, { [title]: "B answers" });
    await settled(b);
    await settled(a);
    const stored = server.rows("field_values").find((r) => r.item_id === id && r.field_id === title)!;
    expect(stored.value_text).toBe("B answers");
    expect(String(stored.updated_at) > future).toBe(true);
    expect((await valuesOn(a, n.a, id))?.[title]).toBe("B answers");
  });
});

describe("what a sync reports to the app", () => {
  const collect = (repo: Repo) => {
    const changes: DataChange[] = [];
    repo.subscribe((c) => changes.push(c));
    return changes;
  };

  it("tells which item, collection, view or list changed, as a local write would", async () => {
    const n = await notes();
    const changes = collect(b);
    const id = await a.createItem(n.a, { [n.a.fields[0].id]: "x" }, "default");
    await settled(a);
    await settled(b);
    expect(changes).toContainEqual({ scope: "items", collectionId: n.id, itemId: id });
    changes.length = 0;
    // Only a value changed: the item is found through its value.
    await a.updateItem(n.a, id, { [n.a.fields[1].id]: "more" });
    await settled(a);
    await settled(b);
    expect(changes).toEqual([{ scope: "items", collectionId: n.id, itemId: id }]);
    changes.length = 0;
    await a.saveSpace({ id: "work", name: "Work", icon: null });
    await a.saveComponent({ id: "c", name: "C", description: "", code: "", output: "markdown", frameRatio: null, ai: false, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" });
    await a.addBookmark(itemLink(n.id, id), "x", "default");
    const [all] = await a.listViews(n.id, "default");
    await a.saveView({ ...all, name: "Renamed" });
    await a.saveCollection({ ...collectionDraft(n.a), name: "Memo" }, "default");
    await a.saveDashboard({ id: "d", name: "Home", icon: null, description: "", spaceIds: null }, "default");
    await settled(a);
    await settled(b);
    expect(changes).toEqual(
      expect.arrayContaining([
        { scope: "spaces" }, { scope: "components" }, { scope: "bookmarks" }, { scope: "collections" }, { scope: "views", collectionId: n.id }, { scope: "dashboards" },
        { scope: "dashboardViews", dashboardId: "d" },
      ]),
    );
  });

  it("replaces everything a device showed when it connects to a server with data", async () => {
    const n = await notes();
    await a.createItem(n.a, {}, "default");
    await settled(a);
    // A device with data of its own, not yet connected.
    const fresh = await device({ connect: false });
    const ownId = newId();
    await fresh.saveCollection({ id: ownId, name: "Own", pluralName: "Owns", icon: null, description: "", spaceIds: null, fields: [field("Name")] }, "default");
    await fresh.saveDashboard({ id: "own-board", name: "Own", icon: null, description: "", spaceIds: null }, "default");
    const changes = collect(fresh);
    await fresh.sync.configure({ url: "https://kubus.test", token: "secret", enabled: true, originals: "always" });
    await settled(fresh);
    expect(changes).toEqual(
      expect.arrayContaining([
        { scope: "spaces" }, { scope: "collections" }, { scope: "components" }, { scope: "bookmarks" }, { scope: "items", collectionId: ownId }, { scope: "views", collectionId: ownId },
        { scope: "dashboards" }, { scope: "dashboardViews", dashboardId: "own-board" },
      ]),
    );
    expect((await fresh.listCollections()).map((c) => c.id)).toEqual([n.id]); // the server's data replaced its own
    expect(await fresh.listDashboards()).toEqual([]);
    expect(await fresh.countItemsByCollection(null)).toEqual({ [n.id]: 1 });
  });

  it("calls whoever listens with the rows a sync brought and those it sent, and says when it is a first download", async () => {
    const n = await notes();
    const pulled: { initial: boolean; tables: string[]; pushed: string[] }[] = [];
    b.sync.onPulled((p) => pulled.push({ initial: p.initial, tables: Object.keys(p.changes).sort(), pushed: Object.keys(p.pushed).sort() }));
    await a.createItem(n.a, {}, "default");
    await settled(a);
    await settled(b);
    expect(pulled.some((p) => p.tables.includes("items") && !p.initial)).toBe(true);
    await b.createItem(n.b, {}, "default");
    await settled(b);
    expect(pulled.some((p) => p.pushed.includes("items"))).toBe(true);
    const fresh = await device({ connect: false });
    const firsts: boolean[] = [];
    fresh.sync.onPulled((p) => firsts.push(p.initial));
    await fresh.sync.configure({ url: "https://kubus.test", token: "secret", enabled: true, originals: "always" });
    expect(firsts[0]).toBe(true);
  });
});

describe("a device that edits offline", () => {
  it("keeps its changes queued while the server can't be reached, and sends them later", async () => {
    const n = await notes();
    const title = n.a.fields[0].id;
    const real = server.fetch;
    let online = false;
    // Offline: nothing gets through.
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      if (!online) throw new TypeError("offline");
      return real(url, init);
    });
    const id = await a.createItem(n.a, { [title]: "Written offline" }, "default");
    await a.sync.syncNow();
    expect(a.sync.status).toMatchObject({ state: "error", error: expect.stringMatching(/Cannot reach/) });
    expect(server.rows("items").map((r) => r.id)).not.toContain(id);
    online = true;
    await settled(a);
    await settled(b);
    expect(a.sync.status.state).toBe("idle");
    expect((await valuesOn(b, n.b, id))?.[title]).toBe("Written offline");
  });
});
