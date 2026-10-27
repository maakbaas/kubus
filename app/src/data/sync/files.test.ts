// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { bytes, device, FakeServer, settled } from "../../test/fakeServer";
import { newId, type Collection } from "../../domain/model";

let server: FakeServer;
beforeEach(() => {
  server = new FakeServer().install();
});

const fieldsOf = (name: string): Collection["fields"] => [
  { id: newId(), collectionId: "", name: "Title", kind: "string", targetCollectionId: null, componentId: null, componentArgs: {}, choiceFilter: [], toggleIcon: null, strikeThrough: false, aiPrompt: null, aiOutput: null, position: 0 },
  { id: newId(), collectionId: "", name, kind: "image", targetCollectionId: null, componentId: null, componentArgs: {}, choiceFilter: [], toggleIcon: null, strikeThrough: false, aiPrompt: null, aiOutput: null, position: 1 },
];

/** A Photos collection with one item showing an image with these bytes; returns the file id. */
async function photo(repo: Awaited<ReturnType<typeof device>>, content: string) {
  let collection = (await repo.listCollections()).find((c) => c.name === "Photo");
  if (!collection) {
    const id = newId();
    await repo.saveCollection({ id, name: "Photo", pluralName: "Photos", icon: null, description: "", spaceIds: null, fields: fieldsOf("Image") }, "default");
    collection = (await repo.listCollections()).find((c) => c.id === id)!;
  }
  const fileId = await repo.putFile(bytes(content), "image/png");
  await repo.createItem(collection, { [collection.fields[0].id]: content, [collection.fields[1].id]: fileId }, "default");
  return fileId;
}

const localBytes = async (repo: Awaited<ReturnType<typeof device>>, id: string) =>
  (await (repo as unknown as { db: { select<T>(sql: string, bind: unknown[]): Promise<T[]> } }).db.select<{ data: Uint8Array | null }>(
    "SELECT data FROM files WHERE id = ?1",
    [id],
  ))[0]?.data ?? null;

/** Whether the device has a row for the file (with or without its bytes). */
const listed = async (repo: Awaited<ReturnType<typeof device>>, id: string) =>
  (await (repo as unknown as { db: { select<T>(sql: string, bind: unknown[]): Promise<T[]> } }).db.select("SELECT 1 FROM files WHERE id = ?1", [id])).length > 0;

describe("files and sync", () => {
  it("uploads a file's bytes before its row, and not inside /api/sync", async () => {
    const a = await device();
    const id = await photo(a, "one");
    await settled(a);
    expect(server.files.get(id)?.mime).toBe("image/png");
    expect(server.rows("files").map((r) => r.id)).toEqual([id]);
    expect(server.rows("files")[0]).not.toHaveProperty("data");
    const put = server.log.indexOf(`PUT /api/files/${id}`);
    expect(put).toBeGreaterThan(-1);
    expect(server.log.slice(put).some((l) => l === "POST /api/sync")).toBe(true);
  });

  it("holds a file's row back while its upload fails; the other rows go", async () => {
    const a = await device();
    const id = await photo(a, "two");
    server.failures.set(`PUT ${id}`, 503);
    await settled(a);
    expect(server.rows("files")).toEqual([]);
    expect(server.rows("items")).toHaveLength(1); // the item using it is synced all the same
    server.failures.clear();
    await settled(a);
    expect(server.rows("files").map((r) => r.id)).toEqual([id]);
  });

  it("downloads the bytes of files from other devices after a sync", async () => {
    const a = await device();
    const id = await photo(a, "three");
    await settled(a);
    const b = await device();
    expect([...(await localBytes(b, id))!]).toEqual([...bytes("three")]);
    expect(await b.getFile(id)).toEqual({ data: bytes("three"), mime: "image/png" });
  });

  it("with originals when opened, fetches a file when it is asked for, then keeps it", async () => {
    const a = await device();
    const id = await photo(a, "four");
    await settled(a);
    const b = await device({ originals: "opened" });
    expect(await localBytes(b, id)).toBeNull();
    expect((await b.getFile(id))?.data).toEqual(bytes("four"));
    expect(await localBytes(b, id)).toEqual(bytes("four"));
  });

  it("a device that keeps no bytes lets go of them once uploaded, and fetches them when asked", async () => {
    const headless = await device({ keepFiles: false });
    const id = await photo(headless, "five");
    await settled(headless);
    expect(server.files.has(id)).toBe(true);
    expect(await localBytes(headless, id)).toBeNull();
    expect((await headless.getFile(id))?.data).toEqual(bytes("five"));
    expect(await localBytes(headless, id)).toBeNull();
  });

  it("keeps the bytes of files the server lists when connecting replaces this device's data", async () => {
    const a = await device();
    const id = await photo(a, "six");
    await settled(a);
    const b = await device({ connect: false });
    await photo(b, "six"); // the same file, stored here before connecting
    await b.sync.configure({ url: "https://kubus.test", token: "secret", enabled: true, originals: "opened" });
    await settled(b);
    expect(await localBytes(b, id)).toEqual(bytes("six"));
    expect(server.log.filter((l) => l === `GET /api/files/${id}`)).toHaveLength(0);
  });
});

describe("thumbnails", () => {
  it("are given for small places, synced, and downloaded first (alone with originals when opened)", async () => {
    const a = await device();
    const id = await photo(a, "seven");
    await a.putThumbnail(id, bytes("7"), "image/webp");
    expect(await a.getFile(id, { small: true })).toEqual({ data: bytes("7"), mime: "image/webp", small: true });
    expect((await a.getFile(id))?.data).toEqual(bytes("seven"));
    await settled(a);
    expect(server.rows("thumbnails")).toHaveLength(1);

    const b = await device({ originals: "opened" });
    const thumbId = String(server.rows("thumbnails")[0].thumb_id);
    expect(await localBytes(b, thumbId)).toEqual(bytes("7"));
    expect(await localBytes(b, id)).toBeNull();
    expect((await b.getFile(id, { small: true }))?.small).toBe(true);
  });

  it("an image without one is given whole", async () => {
    const a = await device();
    const id = await photo(a, "eight");
    expect(await a.getFile(id, { small: true })).toEqual({ data: bytes("eight"), mime: "image/png" });
  });

  it("goes with its original once no item uses it", async () => {
    const a = await device();
    const id = await photo(a, "nine");
    await a.putThumbnail(id, bytes("9"), "image/webp");
    const collection = (await a.listCollections()).find((c) => c.name === "Photo")!;
    const [item] = await a.listItems(collection, "default");
    await a.deleteItem(item.id);
    expect(await a.getFile(id)).toBeNull();
    const thumbs = await (a as unknown as { db: { select<T>(sql: string): Promise<T[]> } }).db.select<{ n: number }>(
      "SELECT (SELECT count(*) FROM thumbnails) + (SELECT count(*) FROM files) AS n",
    );
    expect(thumbs[0].n).toBe(0);
  });
});

describe("cleaning up unused files", () => {
  it("releases files on other devices once a sync removes their last use", async () => {
    const a = await device();
    const id = await photo(a, "ten");
    await a.putThumbnail(id, bytes("10"), "image/webp");
    await settled(a);
    const b = await device();
    expect(await localBytes(b, id)).toEqual(bytes("ten"));

    const collection = (await a.listCollections()).find((c) => c.name === "Photo")!;
    const [item] = await a.listItems(collection, "default");
    await a.deleteItem(item.id);
    await settled(a);
    await settled(b);
    expect(await listed(b, id)).toBe(false);
    expect(await b.unusedFiles([id])).toEqual([id]);
  });

  it("releases a replaced image at once, unless a text still names it", async () => {
    const repo = await device({ connect: false });
    const old = await photo(repo, "old");
    const [collection] = await repo.listCollections();
    const [item] = await repo.listItems(collection, "default");
    const [title, image] = collection.fields;
    // Named in the title (any text counts): still in use when the image field lets go of it.
    await repo.updateItem(collection, item.id, { [title.id]: `see files/${old}`, [image.id]: await repo.putFile(bytes("new"), "image/png") });
    expect(await listed(repo, old)).toBe(true);
    await repo.updateItem(collection, item.id, { [title.id]: "plain" });
    expect(await listed(repo, old)).toBe(false);
  });

  it("keeps a file another item here still uses", async () => {
    const a = await device();
    const id = await photo(a, "eleven");
    await settled(a);
    const b = await device();
    await photo(b, "eleven"); // the same image in a second item, on b only for now
    const collection = (await a.listCollections()).find((c) => c.name === "Photo")!;
    const [first] = await a.listItems(collection, "default");
    await a.deleteItem(first.id);
    await settled(a);
    await settled(b);
    expect((await b.getFile(id))?.data).toEqual(bytes("eleven"));
  });

  it("uploads a file again when the server says it lacks it", async () => {
    const a = await device();
    const id = await photo(a, "twelve");
    await settled(a);
    server.files.delete(id); // deleted as unused (say, a week after the item using it was)
    let told = false;
    server.extra = (request) => {
      if (told || !(request.changes.field_values ?? []).some((r) => r.value_file === id)) return {};
      told = true;
      return { missingFiles: [id] };
    };
    await photo(a, "twelve"); // used again, by a new item
    await settled(a);
    expect(told).toBe(true);
    expect(server.files.get(id)?.data).toEqual(bytes("twelve"));
  });

  it("gets a file it released back from the server when an edit uses it again", async () => {
    const a = await device();
    const id = await photo(a, "twelve and a half");
    await settled(a);
    const collection = (await a.listCollections()).find((c) => c.name === "Photo")!;
    const [item] = await a.listItems(collection, "default");
    await a.updateItem(collection, item.id, { [collection.fields[1].id]: "" });
    expect(await localBytes(a, id)).toBeNull(); // released here
    await a.updateItem(collection, item.id, { [collection.fields[1].id]: id }); // undone
    expect((await a.getFile(id))?.data).toEqual(bytes("twelve and a half"));
    expect(await localBytes(a, id)).toEqual(bytes("twelve and a half"));
  });

  it("finds a file unused when no live item uses it, and a thumbnail through its original", async () => {
    const a = await device({ connect: false });
    const id = await photo(a, "thirteen");
    await a.putThumbnail(id, bytes("13"), "image/webp");
    const thumb = (await a.getFile(id, { small: true }))!;
    expect(thumb.small).toBe(true);
    expect(await a.unusedFiles([id])).toEqual([]);
  });
});
