// @vitest-environment node
// The item links (item_links, docs/data-model.md "Item links") through sync: the index row and its value
// carry the same stamp, so they merge to the same version, whichever device syncs first; devices of
// the version before the table (SYNC_VERSION 1) write values only, and the devices that know it make their rows.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { newId, now, type Collection, type FieldDef, type FieldKind } from "../../domain/model";
import { SERVER_URL, TOKEN, FakeServer, settled } from "../../test/fakeServer";
import { DirectSqlClient } from "../sqlite/direct";
import { SqliteRepository } from "../sqlite/SqliteRepository";
import { memoryEnvironment } from "./environment";
import type { DataChange } from "../repository";
import type { WireRow } from "../../../../shared/sync";

vi.setConfig({ testTimeout: 30_000 });

let server: FakeServer;

/** A device that keeps hold of its database, to look at the rows. */
async function open(connect = true) {
  const client = await DirectSqlClient.open();
  const repo = await SqliteRepository.open(client, memoryEnvironment());
  if (connect) {
    await repo.sync.configure({ url: SERVER_URL, token: TOKEN, enabled: true, originals: "always" });
    await settled(repo);
  }
  return { client, repo };
}
type Device = Awaited<ReturnType<typeof open>>;

beforeEach(() => {
  server = new FakeServer().install();
});

/** A stamp a moment after the latest one (not far ahead: stamps never go back, and the tests after would all be later). */
const later = () => new Date(Date.parse(now()) + 1000).toISOString();

const field = (name: string, kind: FieldKind = "string", over: Partial<FieldDef> = {}): FieldDef => ({
  id: newId(), collectionId: "", name, kind, targetCollectionId: null, componentId: null, code: null, output: null,
  frameRatio: null, choiceFilter: [], toggleIcon: null, strikeThrough: false, position: 0, ...over,
});

/** Person and Note collections made on `a` and known to the others; returns them as `d` lists them. */
async function world(a: Device, others: Device[]) {
  const personId = newId();
  const noteId = newId();
  await a.repo.saveCollection({ id: personId, name: "Person", pluralName: "People", icon: null, description: "", spaceIds: null, fields: [field("Name")] }, "default");
  const person = (await a.repo.listCollections()).find((c) => c.id === personId)!;
  const refs = { targetCollectionId: personId };
  await a.repo.saveCollection(
    { id: noteId, name: "Note", pluralName: "Notes", icon: null, description: "", spaceIds: null, fields: [field("Title"), field("Body", "markdown"), field("About", "item", refs)].map((f, position) => ({ ...f, position })) },
    "default",
  );
  const ada = await a.repo.createItem(person, { [person.fields[0].id]: "Ada" }, "default");
  const bob = await a.repo.createItem(person, { [person.fields[0].id]: "Bob" }, "default");
  for (const d of [a, ...others]) await settled(d.repo);
  const on = async (d: Device) => {
    const all = await d.repo.listCollections();
    return { person: all.find((c) => c.id === personId)!, note: all.find((c) => c.id === noteId)! };
  };
  return { on, ada, bob };
}

interface Row { id: string; source_item_id: string; source_field_id: string; targets: string; updated_at: string; deleted_at: string | null }
const indexOf = (d: Device) => d.client.select<Row>("SELECT * FROM item_links ORDER BY id");
const stampOf = async (d: Device, itemId: string, fieldId: string) =>
  (await d.client.select<{ updated_at: string }>("SELECT updated_at FROM field_values WHERE item_id = ?1 AND field_id = ?2", [itemId, fieldId]))[0]?.updated_at;
const link = (c: Collection, id: string) => `[x](#/collections/${c.id}/items/${id})`;
const backlinks = async (d: Device, c: Collection, itemId: string) => (await d.repo.listBacklinks(c.id, itemId, "default")).map((l) => l.sourceItemId).sort();
const queuedLinks = async (d: Device) => (await d.client.select<{ pk: string }>("SELECT DISTINCT pk FROM sync_outbox WHERE tbl = 'item_links'")).map((r) => r.pk);

describe("the index through sync", () => {
  it("reaches the other devices with the value, and they read the same backlinks without making rows of their own", async () => {
    const a = await open();
    const b = await open();
    const w = await world(a, [b]);
    const { person, note } = await w.on(a);
    const id = await a.repo.createItem(note, { [note.fields[1].id]: link(person, w.ada), [note.fields[2].id]: w.bob }, "default");
    await settled(a.repo);
    await settled(b.repo);
    expect(server.rows("item_links").map((r) => r.id).sort()).toEqual([`${id}/${note.fields[1].id}`, `${id}/${note.fields[2].id}`].sort());
    expect(await indexOf(b)).toEqual(await indexOf(a));
    expect(await backlinks(b, person, w.ada)).toEqual([id]);
    expect(await backlinks(b, person, w.bob)).toEqual([id]);
    // Nothing for b to send back: it healed nothing, and applying queues nothing.
    expect(await queuedLinks(b)).toEqual([]);
    await settled(b.repo);
    expect(server.rows("item_links")).toHaveLength(2);
  });

  it("travels with the table's own columns, the targets as JSON the server hands back unchanged", async () => {
    const a = await open();
    const w = await world(a, []);
    const { person, note } = await w.on(a);
    const id = await a.repo.createItem(note, { [note.fields[1].id]: `${link(person, w.bob)} ${link(person, w.ada)}` }, "default");
    await settled(a.repo);
    const wire = server.rows("item_links")[0] as WireRow;
    expect(Object.keys(wire).sort()).toEqual(["deleted_at", "id", "source_field_id", "source_item_id", "targets", "updated_at"]);
    expect(wire).toMatchObject({ id: `${id}/${note.fields[1].id}`, source_item_id: id, deleted_at: null, updated_at: await stampOf(a, id, note.fields[1].id) });
  });

  it("drops a link on the other devices when its text is edited away, and brings it back", async () => {
    const a = await open();
    const b = await open();
    const w = await world(a, [b]);
    const { person, note } = await w.on(a);
    const body = note.fields[1].id;
    const id = await a.repo.createItem(note, { [body]: link(person, w.ada) }, "default");
    await settled(a.repo);
    await settled(b.repo);
    await a.repo.updateItem(note, id, { [body]: "no more" });
    await settled(a.repo);
    await settled(b.repo);
    expect(await backlinks(b, person, w.ada)).toEqual([]);
    expect((await indexOf(b))[0]).toMatchObject({ targets: "[]", deleted_at: await stampOf(b, id, body) });
    await a.repo.updateItem(note, id, { [body]: link(person, w.bob) });
    await settled(a.repo);
    await settled(b.repo);
    expect(await backlinks(b, person, w.bob)).toEqual([id]);
    expect(await indexOf(b)).toEqual(await indexOf(a));
  });

  it("tells the app when only a link row arrives, as for the item it belongs to", async () => {
    const a = await open();
    const b = await open();
    const w = await world(a, [b]);
    const { person, note } = await w.on(a);
    const id = await a.repo.createItem(note, {}, "default");
    await settled(a.repo);
    await settled(b.repo);
    const changes: DataChange[] = [];
    b.repo.subscribe((c) => changes.push(c));
    // A row of its own on the server, without a value change (a device that made it later).
    const t = server.tables.get("item_links")!;
    t.set("x", { row: { id: "x", source_item_id: id, source_field_id: note.fields[1].id, targets: JSON.stringify([{ item: w.ada, collection: person.id }]), updated_at: later(), deleted_at: null }, seq: ++server.seq });
    await settled(b.repo);
    expect(changes).toContainEqual({ scope: "items", collectionId: note.id, itemId: id });
  });
});

describe("two devices editing the same Markdown", () => {
  /** Both edit the body offline, `first` syncs first; returns what each device and the server hold. */
  async function conflict(first: "a" | "b") {
    const a = await open();
    const b = await open();
    const w = await world(a, [b]);
    const { person, note } = await w.on(a);
    const onB = await w.on(b);
    const body = note.fields[1].id;
    const id = await a.repo.createItem(note, { [body]: link(person, w.ada) }, "default");
    await settled(a.repo);
    await settled(b.repo);
    await a.repo.updateItem(note, id, { [body]: `from A: ${link(person, w.bob)}` });
    await b.repo.updateItem(onB.note, id, { [body]: `from B: ${link(person, w.ada)} ${link(note, "somewhere")}` });
    const order = first === "a" ? [a, b, a, b] : [b, a, b, a];
    for (const d of order) await settled(d.repo);
    return { a, b, w, person, note, id, body };
  }

  for (const first of ["a", "b"] as const) {
    it(`leave the index matching the merged value, whichever syncs first (${first} first)`, async () => {
      const { a, b, id, body, person, w, note } = await conflict(first);
      // B edited last, so its text won everywhere.
      for (const d of [a, b]) {
        const row = (await d.client.select<{ value_text: string }>("SELECT value_text FROM field_values WHERE item_id = ?1 AND field_id = ?2", [id, body]))[0];
        expect(row.value_text).toContain("from B");
      }
      const stamp = await stampOf(a, id, body);
      expect(await stampOf(b, id, body)).toBe(stamp);
      expect(server.rows("field_values").find((r) => r.item_id === id && r.field_id === body)?.updated_at).toBe(stamp);
      for (const where of [await indexOf(a), await indexOf(b), server.rows("item_links") as unknown as Row[]]) {
        const row = where.find((r) => r.id === `${id}/${body}`)!;
        expect(row.updated_at).toBe(stamp);
        expect(JSON.parse(String(row.targets))).toEqual([
          { item: "somewhere", collection: note.id },
          { item: w.ada, collection: person.id },
        ].sort((x, y) => (x.collection < y.collection ? -1 : 1)));
      }
      expect(await backlinks(a, person, w.ada)).toEqual([id]);
      expect(await backlinks(a, person, w.bob)).toEqual([]);
      expect(await backlinks(b, person, w.bob)).toEqual([]);
    });
  }

  it("keep each device's value and row together when both carry the same stamp (the first to reach the server stays there)", async () => {
    const a = await open();
    const b = await open();
    const w = await world(a, [b]);
    const { person, note } = await w.on(a);
    const onB = await w.on(b);
    const body = note.fields[1].id;
    const id = await a.repo.createItem(note, {}, "default");
    await settled(a.repo);
    await settled(b.repo);
    const tie = later();
    await a.repo.updateItem(note, id, { [body]: `A ${link(person, w.ada)}` });
    await b.repo.updateItem(onB.note, id, { [body]: `B ${link(person, w.bob)}` });
    // The same millisecond: the triggers give the row the stamp the value gets.
    for (const d of [a, b]) await d.client.write([{ sql: "UPDATE field_values SET updated_at = ?1 WHERE item_id = ?2 AND field_id = ?3", bind: [tie, id, body] }]);
    for (const d of [a, b]) expect((await indexOf(d))[0].updated_at).toBe(tie);
    for (const d of [a, b, a, b]) await settled(d.repo);
    const text = (d: Device) => d.client.select<{ value_text: string }>("SELECT value_text FROM field_values WHERE item_id = ?1 AND field_id = ?2", [id, body]).then((r) => r[0].value_text);
    // Whichever pair the server kept, on every device the row says what its own value says.
    for (const d of [a, b]) {
      const targets = JSON.parse((await indexOf(d))[0].targets) as { item: string }[];
      expect(targets.map((t) => t.item)).toEqual([(await text(d)).startsWith("A") ? w.ada : w.bob]);
    }
    const kept = server.rows("field_values").find((r) => r.item_id === id && r.field_id === body)!;
    expect(JSON.parse(String(server.rows("item_links")[0].targets)).map((t: { item: string }) => t.item)).toEqual([String(kept.value_text).startsWith("A") ? w.ada : w.bob]);
  });
});

describe("a device from before the table", () => {
  /** What an older device sends: field values only (SYNC_VERSION 1), no index rows. */
  const olderDeviceWrites = (rows: WireRow[]) => {
    const answer = server.sync({ since: server.seq, changes: { field_values: rows }, version: 1, compatible: 1 });
    expect("cursor" in answer).toBe(true);
  };

  it("is accepted by the server of this version, and its values get their index rows from the first newer device that pulls them", async () => {
    const a = await open();
    const w = await world(a, []);
    const { person, note } = await w.on(a);
    const body = note.fields[1].id;
    const id = await a.repo.createItem(note, {}, "default");
    await settled(a.repo);
    const at = later();
    olderDeviceWrites([
      { item_id: id, field_id: body, value_text: link(person, w.ada), value_number: null, value_date: null, value_datetime: null, value_bool: null, value_ref: null, value_file: null, value_json: null, updated_at: at },
    ]);
    expect(server.rows("item_links")).toEqual([]);
    await settled(a.repo);
    // a has the value and made the row at the value's stamp, which went to the server.
    expect(await backlinks(a, person, w.ada)).toEqual([id]);
    expect(server.rows("item_links")).toMatchObject([{ id: `${id}/${body}`, updated_at: at, deleted_at: null }]);
    // A second newer device gets both and makes (and sends) nothing more.
    const b = await open();
    expect(await indexOf(b)).toEqual(await indexOf(a));
    expect(await queuedLinks(b)).toEqual([]);
  });

  it("renews a row the older device's edit left stale, with the value's stamp", async () => {
    const a = await open();
    const w = await world(a, []);
    const { person, note } = await w.on(a);
    const body = note.fields[1].id;
    const id = await a.repo.createItem(note, { [body]: link(person, w.ada) }, "default");
    await settled(a.repo);
    const row = server.rows("field_values").find((r) => r.item_id === id && r.field_id === body)!;
    const at = later();
    olderDeviceWrites([{ ...row, value_text: link(person, w.bob), updated_at: at }]);
    await settled(a.repo);
    expect(await backlinks(a, person, w.ada)).toEqual([]);
    expect(await backlinks(a, person, w.bob)).toEqual([id]);
    const stored = server.rows("item_links").find((r) => r.id === `${id}/${body}`)!;
    expect(stored).toMatchObject({ updated_at: at });
    expect(JSON.parse(String(stored.targets)).map((t: { item: string }) => t.item)).toEqual([w.bob]);
  });

  it("gets index rows for everything a server holds without any, on its first connection (they are sent to the server)", async () => {
    const a = await open();
    const w = await world(a, []);
    const { person, note } = await w.on(a);
    const id = await a.repo.createItem(note, { [note.fields[2].id]: w.ada }, "default");
    await settled(a.repo);
    // As if the server's data had been written by devices of the older version.
    server.tables.get("item_links")!.clear();
    const b = await open(false);
    await b.repo.sync.configure({ url: SERVER_URL, token: TOKEN, enabled: true, originals: "always" });
    await settled(b.repo);
    expect(await backlinks(b, person, w.ada)).toEqual([id]);
    expect(server.rows("item_links").map((r) => r.id)).toEqual([`${id}/${note.fields[2].id}`]);
  });

  it("is answered with the table's rows among the others, which it leaves aside (an engine reads the tables it lists)", async () => {
    const a = await open();
    const w = await world(a, []);
    const { note } = await w.on(a);
    await a.repo.createItem(note, { [note.fields[2].id]: w.ada }, "default");
    await settled(a.repo);
    const answer = server.sync({ since: 0, changes: {}, version: 1, compatible: 1 });
    expect("changes" in answer && Object.keys(answer.changes)).toContain("item_links");
  });
});
