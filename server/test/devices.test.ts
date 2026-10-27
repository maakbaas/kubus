// @vitest-environment node
// Devices (the app's repository and sync engine) syncing through the real server (./serve.ts) and
// its Postgres (KUBUS_TEST_POSTGRES): what the app's sync tests check against their stand-in
// (app/src/test/fakeServer.ts), here end to end, so the two can't drift apart unnoticed.
// Part of the app's typecheck (it runs app code), not the server's.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { newId, type Collection } from "../../app/src/domain/model";
import { bytes, device as fakeServerDevice, settled } from "../../app/src/test/fakeServer";
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
