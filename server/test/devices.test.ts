// @vitest-environment node
// Devices (the app's repository and sync engine) syncing through the real server (./serve.ts) and
// its Postgres (KUBUS_TEST_POSTGRES): what the app's sync tests check against their stand-in
// (app/src/test/fakeServer.ts), here end to end, so the two can't drift apart unnoticed.
// Part of the app's typecheck (it runs app code), not the server's.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { newId, type Collection } from "../../app/src/domain/model";
import { bytes, device as fakeServerDevice, settled } from "../../app/src/test/fakeServer";
import { SYNC_VERSION } from "../../shared/sync.ts";
import { startServer, TOKEN, type RunningServer } from "./serve.ts";

// ./postgres.ts loads pg, whose types are the server's packages: the app's typecheck goes without them.
const POSTGRES = "./postgres.ts";
const { ADMIN, createDatabase, dropDatabase } = (await import(POSTGRES)) as {
  ADMIN?: string;
  createDatabase(name: string): Promise<string>;
  dropDatabase(name: string): Promise<void>;
};

const DB = "kubus_devices_test";
type Device = Awaited<ReturnType<typeof fakeServerDevice>>;

describe.skipIf(!ADMIN)("devices syncing through the server", () => {
  let server: RunningServer;
  const devices: Device[] = [];
  const device = async () => {
    const repo = await fakeServerDevice({ url: server.url, token: TOKEN });
    devices.push(repo);
    expect(repo.sync.status.error).toBeNull();
    return repo;
  };

  beforeAll(async () => {
    server = await startServer(await createDatabase(DB));
  }, 30_000);

  afterEach(async () => {
    // Their event streams stay open otherwise.
    for (const d of devices.splice(0)) await d.sync.disconnect();
  });

  afterAll(async () => {
    await server?.stop();
    await dropDatabase(DB);
  });

  /** A collection with a title and an image field, made on `repo`. */
  async function photos(repo: Device): Promise<Collection> {
    const id = newId();
    const field = (name: string, kind: "string" | "image", position: number) => ({
      id: newId(), collectionId: "", name, kind, targetCollectionId: null, componentId: null, code: null, output: null,
      frameRatio: null, choiceFilter: [], toggleIcon: null, strikeThrough: false, position,
    });
    await repo.saveCollection({ id, name: "Photo", pluralName: "Photos", icon: null, description: "", spaceIds: null, fields: [field("Title", "string", 0), field("Image", "image", 1)] }, "default");
    return (await repo.listCollections()).find((c) => c.id === id)!;
  }

  it("carry collections, items, values and file bytes from one device to another", async () => {
    const a = await device();
    const collection = await photos(a);
    const fileId = await a.putFile(bytes("sunset"), "image/png");
    const itemId = await a.createItem(collection, { [collection.fields[0].id]: "Sunset", [collection.fields[1].id]: fileId }, "default");
    await settled(a);
    expect(a.sync.status.error).toBeNull();

    const b = await device();
    const there = (await b.listCollections()).find((c) => c.id === collection.id)!;
    expect(there.fields.map((f) => f.name)).toEqual(["Title", "Image"]);
    const item = await b.getItem(there, itemId);
    expect(item?.values[collection.fields[0].id]).toBe("Sunset");
    expect(await b.getFile(fileId)).toEqual({ data: bytes("sunset"), mime: "image/png" });
  });

  it("carry a dashboard with its tabs per space and a bookmark of one", async () => {
    const a = await device();
    const collection = await photos(a);
    await a.saveSpace({ id: "work", name: "Work", icon: null });
    await a.saveDashboard({ id: "board", name: "Board", icon: "Dashboard", description: "", spaceIds: ["default", "work"] }, "default");
    const [first] = await a.listDashboardViews("board", "default");
    const block = { id: "b", title: "", kind: "cards", filters: null, sort: [], groupBy: null, layout: { fields: null, editable: true, hiddenLabels: [], hideEmpty: false }, collectionId: collection.id, options: null };
    await a.saveDashboardView({ ...first, blocks: [block], filters: [{ id: "r", fieldId: "$date", operator: "between", value: "day-6..day+0" }], filterBar: true });
    await a.storeDashboardViews("board", "work");
    const [workTab] = await a.listDashboardViews("board", "work");
    await a.saveDashboardView({ ...workTab, name: "Work tab" });
    await a.addBookmark("dashboard", "board", workTab.id, "Board / Work tab", "work");
    await settled(a);

    const b = await device();
    expect((await b.listDashboards()).map((d) => [d.name, d.icon, d.spaceIds])).toEqual([["Board", "Dashboard", ["default", "work"]]]);
    expect(await b.listDashboardViews("board", "default")).toEqual([expect.objectContaining({ id: first.id, blocks: [block], filterBar: true, filters: [expect.objectContaining({ fieldId: "$date" })] })]);
    expect((await b.listDashboardViews("board", "work")).map((v) => [v.id, v.name, v.virtual])).toEqual([[workTab.id, "Work tab", undefined]]);
    expect(await b.listBookmarks("work")).toEqual([expect.objectContaining({ kind: "dashboard", collectionId: null, dashboardId: "board", targetId: workTab.id })]);
    await b.deleteDashboard("board");
    await settled(b);
    await settled(a);
    expect(await a.listDashboards()).toEqual([]);
    expect(await a.listBookmarks("work")).toEqual([]);
  });

  it("bring every device to the same state after edits and deletes on both", async () => {
    const a = await device();
    const collection = await photos(a);
    const title = collection.fields[0].id;
    const keep = await a.createItem(collection, { [title]: "Keep" }, "default");
    const drop = await a.createItem(collection, { [title]: "Drop" }, "default");
    await settled(a);
    const b = await device();
    await b.updateItem(collection, keep, { [title]: "Kept" });
    await a.deleteItem(drop);
    await settled(b);
    await settled(a);
    await settled(b);
    for (const repo of [a, b]) {
      const items = await repo.listItems(collection, "default");
      expect(items.map((i) => i.values[title])).toEqual(["Kept"]);
    }
  });

  it("carry the item links: the server stores a device's rows as they are, another device reads the same backlinks, and one from before the table is served", async () => {
    const a = await device();
    const fieldOf = (name: string, kind: "string" | "markdown" | "item", position: number, targetCollectionId: string | null = null) => ({
      id: newId(), collectionId: "", name, kind, targetCollectionId, componentId: null, code: null, output: null,
      frameRatio: null, choiceFilter: [], toggleIcon: null, strikeThrough: false, position,
    });
    const personId = newId();
    await a.saveCollection({ id: personId, name: "Person", pluralName: "People", icon: null, description: "", spaceIds: null, fields: [fieldOf("Name", "string", 0)] }, "default");
    const noteId = newId();
    await a.saveCollection(
      { id: noteId, name: "Note", pluralName: "Notes", icon: null, description: "", spaceIds: null, fields: [fieldOf("Body", "markdown", 0), fieldOf("About", "item", 1, personId)] },
      "default",
    );
    const listed = await a.listCollections();
    const person = listed.find((c) => c.id === personId)!;
    const note = listed.find((c) => c.id === noteId)!;
    const ada = await a.createItem(person, { [person.fields[0].id]: "Ada" }, "default");
    const bob = await a.createItem(person, { [person.fields[0].id]: "Bob" }, "default");
    const [body, about] = note.fields.map((f) => f.id);
    const id = await a.createItem(note, { [body]: `See [Ada](#/collections/${personId}/items/${ada}?field=x)`, [about]: bob }, "default");
    await settled(a);

    const send = (changes: Record<string, unknown[]>, version: number) =>
      fetch(`${server.url}/api/sync`, {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ since: 0, changes, version }),
      });
    const post = async (changes: Record<string, unknown[]>, version: number) => {
      const response = await send(changes, version);
      expect(response.status).toBe(200);
      return ((await response.json()) as { changes: Record<string, Record<string, unknown>[]> }).changes;
    };
    // As the device wrote them: jsonb gave the targets back as the same text.
    const stored = await post({}, SYNC_VERSION);
    const item = await a.getItem(note, id);
    expect(stored.item_links.map((r) => [r.id, r.targets, r.updated_at, r.deleted_at]).sort((x, y) => String(x[0]).localeCompare(String(y[0])))).toEqual(
      [
        [`${id}/${body}`, JSON.stringify([{ item: ada, collection: personId }]), item!.updatedAt, null],
        [`${id}/${about}`, JSON.stringify([{ item: bob, collection: personId }]), item!.updatedAt, null],
      ].sort((x, y) => String(x[0]).localeCompare(String(y[0]))),
    );

    const b = await device();
    expect((await b.listBacklinks(personId, ada, "default")).map((l) => [l.sourceItemId, l.fieldId])).toEqual([[id, body]]);
    expect((await b.listBacklinks(personId, bob, "default")).map((l) => [l.sourceItemId, l.fieldId])).toEqual([[id, about]]);

    // A device of the version before the table is refused (the strict gate): its value, written without the link, goes nowhere.
    const value = stored.field_values.find((r) => r.item_id === id && r.field_id === body)!;
    const later = new Date(Date.parse(String(value.updated_at)) + 5000).toISOString();
    const refused = await send({ field_values: [{ ...value, value_text: "no link any more", updated_at: later }] }, SYNC_VERSION - 1);
    expect(refused.status).toBe(426);
    expect(await refused.json()).toMatchObject({ update: "app", version: SYNC_VERSION });
    await settled(a);
    await settled(b);
    expect((await a.listBacklinks(personId, ada, "default")).map((l) => l.sourceItemId)).toEqual([id]);
    expect((await b.listBacklinks(personId, ada, "default")).map((l) => l.sourceItemId)).toEqual([id]);
    const kept = (await post({}, SYNC_VERSION)).item_links.find((r) => r.id === `${id}/${body}`)!;
    expect(kept).toMatchObject({ updated_at: item!.updatedAt, deleted_at: null });
  });

  it("notice a wiped server and start over on it", async () => {
    const a = await device();
    await photos(a);
    await settled(a);
    const b = await device();
    await a.sync.wipeServer();
    await settled(b);
    expect(b.sync.status.replaced).toMatchObject({ empty: true });
    // Connecting again to the empty database uploads b's data.
    await b.sync.reconnect();
    await settled(b);
    expect(b.sync.status.replaced).toBeNull();
    const c = await device();
    expect((await c.listCollections()).map((x) => x.name)).toContain("Photo");
  });
});
