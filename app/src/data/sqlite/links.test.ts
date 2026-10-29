// @vitest-environment node
// The item links index (item_links, docs/data-model.md "Item links"): kept by triggers with every local write
// of a value, read as backlinks, rebuilt identically from the values, healed where an older app wrote a value.
import { beforeEach, describe, expect, it } from "vitest";
import { healLinks } from "../schema";
import { collectionDraft, newId, type Collection, type FieldDef, type FieldKind } from "../../domain/model";
import { parseTargets } from "../../domain/backlinks";
import { memoryEnvironment } from "../sync/environment";
import { DirectSqlClient } from "./direct";
import { SqliteRepository } from "./SqliteRepository";

let client: DirectSqlClient;
let repo: SqliteRepository;

beforeEach(async () => {
  client = await DirectSqlClient.open();
  repo = await SqliteRepository.open(client, memoryEnvironment());
});

const field = (name: string, kind: FieldKind = "string", over: Partial<FieldDef> = {}): FieldDef => ({
  id: newId(), collectionId: "", name, kind, targetCollectionId: null, componentId: null, code: null, output: null,
  frameRatio: null, choiceFilter: [], toggleIcon: null, strikeThrough: false, position: 0, ...over,
});

async function collection(name: string, fields: FieldDef[]): Promise<Collection> {
  const id = newId();
  await repo.saveCollection({ id, name, pluralName: `${name}s`, icon: null, description: "", spaceIds: null, fields: fields.map((f, i) => ({ ...f, position: i })) }, "default");
  return (await repo.listCollections()).find((c) => c.id === id)!;
}

interface Row { id: string; source_item_id: string; source_field_id: string; targets: string; updated_at: string; deleted_at: string | null }
const rows = (where = "1") => client.select<Row>(`SELECT * FROM item_links WHERE ${where} ORDER BY id`);
const live = async () => (await rows("deleted_at IS NULL")).map(({ id, targets, updated_at }) => ({ id, targets, updated_at }));
const targetsOf = (r: Row) => parseTargets(r.targets);
const queued = async () => (await client.select<{ pk: string }>("SELECT DISTINCT pk FROM sync_outbox WHERE tbl = 'item_links' ORDER BY pk")).map((r) => r.pk);
const stampOf = async (itemId: string, fieldId: string) =>
  (await client.select<{ updated_at: string }>("SELECT updated_at FROM field_values WHERE item_id = ?1 AND field_id = ?2", [itemId, fieldId]))[0].updated_at;
const link = (c: string, i: string, anchor = "") => `[x](#/collections/${c}/items/${i}${anchor})`;
const sync = (db: DirectSqlClient, on: boolean) =>
  db.write([{ sql: on ? "INSERT OR REPLACE INTO meta (key, value) VALUES ('sync_applying', '1')" : "DELETE FROM meta WHERE key = 'sync_applying'" }]);

/** People, and notes with a Markdown body, a reference, a list of references and an HTML field. */
async function world() {
  const person = await collection("Person", [field("Name"), field("Bio", "markdown")]);
  const note = await collection("Note", [
    field("Title"), field("Body", "markdown"), field("About", "item", { targetCollectionId: person.id }),
    field("Others", "item_list", { targetCollectionId: person.id }), field("Page", "html"),
  ]);
  const [title, body, about, others, page] = note.fields.map((f) => f.id);
  const ada = await repo.createItem(person, { [person.fields[0].id]: "Ada" }, "default");
  const bob = await repo.createItem(person, { [person.fields[0].id]: "Bob" }, "default");
  return { person, note, title, body, about, others, page, ada, bob };
}

describe("item_links, written with the values", () => {
  it("has a row for each value that points at items: reference fields and the links in Markdown and HTML", async () => {
    const w = await world();
    const id = await repo.createItem(
      w.note,
      {
        [w.title]: "Plan",
        [w.body]: `Talk to ${link(w.person.id, w.ada)} about ${link(w.note.id, "other", "?field=x")}`,
        [w.about]: w.bob,
        [w.others]: [w.ada, w.bob],
        [w.page]: `<a href="#/collections/${w.person.id}/items/${w.bob}">Bob</a>`,
      },
      "default",
    );
    const made = await rows();
    expect(made.map((r) => r.source_field_id).sort()).toEqual([w.body, w.about, w.others, w.page].sort());
    const by = (fieldId: string) => made.find((r) => r.source_field_id === fieldId)!;
    expect(by(w.body)).toMatchObject({ id: `${id}/${w.body}`, source_item_id: id, deleted_at: null });
    expect(targetsOf(by(w.body))).toEqual([
      { item: "other", collection: w.note.id },
      { item: w.ada, collection: w.person.id },
    ].sort((a, b) => (a.collection < b.collection ? -1 : 1)));
    expect(targetsOf(by(w.about))).toEqual([{ item: w.bob, collection: w.person.id }]);
    expect(targetsOf(by(w.others)).map((t) => t.item).sort()).toEqual([w.ada, w.bob].sort());
    expect(targetsOf(by(w.page))).toEqual([{ item: w.bob, collection: w.person.id }]);
  });

  it("gives each row exactly its value's updated_at, and a later edit of the value the new one", async () => {
    const w = await world();
    const id = await repo.createItem(w.note, { [w.body]: link(w.person.id, w.ada) }, "default");
    expect((await rows())[0].updated_at).toBe(await stampOf(id, w.body));
    await repo.updateItem(w.note, id, { [w.body]: `${link(w.person.id, w.ada)} and ${link(w.person.id, w.bob)}` });
    const [row] = await rows();
    expect(row.updated_at).toBe(await stampOf(id, w.body));
    expect(targetsOf(row).map((t) => t.item).sort()).toEqual([w.ada, w.bob].sort());
  });

  it("makes no row for a value without links, and leaves a row alone when other fields of the item change", async () => {
    const w = await world();
    const id = await repo.createItem(w.note, { [w.title]: "Plain", [w.body]: "no links", [w.about]: null }, "default");
    expect(await rows()).toEqual([]);
    await repo.updateItem(w.note, id, { [w.body]: "still none" });
    expect(await rows()).toEqual([]);
    await repo.updateItem(w.note, id, { [w.about]: w.ada });
    const [before] = await rows();
    await repo.updateItem(w.note, id, { [w.title]: "Renamed" });
    expect(await rows()).toEqual([before]);
  });

  it("marks the row deleted (at the value's stamp) when the value stops pointing anywhere, and revives it when it does again", async () => {
    const w = await world();
    const id = await repo.createItem(w.note, { [w.about]: w.ada, [w.body]: link(w.person.id, w.bob) }, "default");
    await repo.updateItem(w.note, id, { [w.about]: null, [w.body]: "gone" });
    for (const f of [w.about, w.body]) {
      const [row] = await rows(`source_field_id = '${f}'`);
      expect(row).toMatchObject({ targets: "[]", deleted_at: await stampOf(id, f), updated_at: await stampOf(id, f) });
    }
    expect(await live()).toEqual([]);
    expect(await repo.listBacklinks(w.person.id, w.ada, "default")).toEqual([]);
    await repo.updateItem(w.note, id, { [w.about]: w.bob });
    expect((await rows(`source_field_id = '${w.about}'`))[0]).toMatchObject({ deleted_at: null });
    expect(targetsOf((await rows(`source_field_id = '${w.about}'`))[0])).toEqual([{ item: w.bob, collection: w.person.id }]);
  });

  it("follows every way of writing a value: many items at once, a generated AI value, a field removed from the collection", async () => {
    const w = await world();
    const ai = field("Summary", "ai", { code: "Summarize {{ $item.Title }}", output: "markdown" });
    const withAi = await collection("Memo", [field("Title"), ai]);
    const [a, b] = await repo.createItems([
      { collection: w.note, values: { [w.body]: link(w.person.id, w.ada) }, spaceId: "default" },
      { collection: w.note, values: { [w.about]: w.ada }, spaceId: "default" },
    ]);
    const memo = await repo.createItem(withAi, { [withAi.fields[0].id]: "M" }, "default");
    expect((await rows()).map((r) => r.source_item_id).sort()).toEqual([a, b].sort());
    await repo.setGenerated(withAi, memo, withAi.fields[1], `See ${link(w.person.id, w.bob)}`, "hash");
    expect(await rows(`source_item_id = '${memo}'`)).toHaveLength(1);
    // Generating again without the link ends it.
    await repo.setGenerated(withAi, memo, withAi.fields[1], "Nothing", "hash2");
    expect((await rows(`source_item_id = '${memo}'`))[0].deleted_at).not.toBeNull();
    // Removing a field keeps the row (it is hidden when read).
    await repo.saveCollection(collectionDraft({ ...w.note, fields: w.note.fields.filter((f) => f.id !== w.about) }), "default");
    expect(await rows(`source_field_id = '${w.about}'`)).toHaveLength(1);
    expect((await repo.listBacklinks(w.person.id, w.ada, "default")).map((l) => l.sourceItemId)).toEqual([a]);
  });

  it("queues each row it writes for sync", async () => {
    const w = await world();
    await client.write([{ sql: "DELETE FROM sync_outbox" }]);
    const id = await repo.createItem(w.note, { [w.about]: w.ada }, "default");
    expect(await queued()).toEqual([`${id}/${w.about}`]);
  });

  it("does not write rows while sync applies values (they come with their own, or are healed after)", async () => {
    const w = await world();
    const id = await repo.createItem(w.note, { [w.title]: "T" }, "default");
    await sync(client, true);
    await client.write([
      {
        sql: "INSERT INTO field_values (item_id, field_id, value_text, updated_at) VALUES (?1, ?2, ?3, '2999-01-01T00:00:00.000Z')",
        bind: [id, w.body, link(w.person.id, w.ada)],
      },
    ]);
    await sync(client, false);
    expect(await rows()).toEqual([]);
  });
});

describe("backlinks", () => {
  it("lists the live items of the space that link to an item, one row per linking field, most recently changed first", async () => {
    const w = await world();
    const a = await repo.createItem(w.note, { [w.body]: link(w.person.id, w.ada, "?field=x") }, "default");
    const b = await repo.createItem(w.note, { [w.about]: w.ada, [w.others]: [w.ada, w.bob] }, "default");
    const c = await repo.createItem(w.note, { [w.body]: link(w.person.id, w.bob) }, "default");
    const links = await repo.listBacklinks(w.person.id, w.ada, "default");
    expect(links.map((l) => [l.sourceItemId, l.fieldId, l.sourceCollectionId])).toEqual([
      [b, w.about, w.note.id],
      [b, w.others, w.note.id],
      [a, w.body, w.note.id],
    ]);
    expect(links[0]).toMatchObject({ itemCreatedAt: expect.any(String), itemUpdatedAt: expect.any(String) });
    expect((await repo.listBacklinks(w.person.id, w.bob, "default")).map((l) => l.sourceItemId).sort()).toEqual([b, c].sort());
    // The same id in another collection is another item.
    expect(await repo.listBacklinks(w.note.id, w.ada, "default")).toEqual([]);
  });

  it("leaves out deleted items, deleted fields, links from the item to itself and items of other spaces, and brings them back", async () => {
    const w = await world();
    await repo.saveSpace({ id: "work", name: "Work", icon: null });
    const a = await repo.createItem(w.note, { [w.about]: w.ada }, "default");
    const b = await repo.createItem(w.note, { [w.body]: link(w.person.id, w.ada) }, "default");
    const away = await repo.createItem(w.note, { [w.about]: w.ada }, "work");
    const ids = async (space = "default") => (await repo.listBacklinks(w.person.id, w.ada, space)).map((l) => l.sourceItemId).sort();
    expect(await ids()).toEqual([a, b].sort());
    expect(await ids("work")).toEqual([away]);
    // Deleted: gone from the list, back with the row untouched when it is undeleted (as an edit elsewhere would).
    await repo.deleteItem(a);
    expect(await ids()).toEqual([b]);
    await client.write([{ sql: "UPDATE items SET deleted_at = NULL WHERE id = ?1", bind: [a] }]);
    expect(await ids()).toEqual([a, b].sort());
    // Moved to another space.
    await repo.moveItem(b, "work");
    expect(await ids()).toEqual([a]);
    expect(await ids("work")).toEqual([away, b].sort());
    // A person linking to themselves: not a backlink of themselves.
    await repo.updateItem(w.person, w.ada, { [w.person.fields[1].id]: link(w.person.id, w.ada) });
    expect(await rows(`source_item_id = '${w.ada}'`)).toHaveLength(1);
    expect(await repo.listBacklinks(w.person.id, w.ada, "default")).toHaveLength(1);
  });

  it("finds links to a remote collection's row by its item id, and links from several collections", async () => {
    const w = await world();
    const crm = "remote-crm";
    const row = "cm93OjE"; // a row's item id (domain/sources.ts rowItemId)
    const a = await repo.createItem(w.note, { [w.body]: link(crm, row) }, "default");
    const memo = await collection("Memo", [field("Text", "markdown")]);
    const m = await repo.createItem(memo, { [memo.fields[0].id]: `${link(crm, row, "?view=v")} ${link(crm, "other")}` }, "default");
    const links = await repo.listBacklinks(crm, row, "default");
    expect(links.map((l) => [l.sourceCollectionId, l.sourceItemId]).sort()).toEqual([[memo.id, m], [w.note.id, a]].sort());
    expect(await repo.listBacklinks(crm, "other", "default")).toHaveLength(1);
  });
});

describe("rebuilding and healing", () => {
  async function busyWorld() {
    const w = await world();
    const a = await repo.createItem(w.note, { [w.body]: link(w.person.id, w.ada), [w.about]: w.bob, [w.others]: [w.ada] }, "default");
    const b = await repo.createItem(w.note, { [w.page]: `<a href="#/collections/${w.note.id}/items/${a}">a</a>` }, "default");
    await repo.updateItem(w.note, a, { [w.body]: `${link(w.person.id, w.bob)} ${link(w.note.id, b)}`, [w.others]: null });
    await repo.deleteItem(b);
    return { ...w, a, b };
  }

  it("makes the same rows as were written along the way, from the values alone", async () => {
    await busyWorld();
    const incremental = await live();
    expect(incremental.length).toBeGreaterThan(2);
    await client.write([{ sql: "DELETE FROM item_links" }]);
    await repo.rebuildLinks();
    expect(await live()).toEqual(incremental);
  });

  it("is idempotent: rebuilding again changes and queues nothing", async () => {
    await busyWorld();
    await repo.rebuildLinks();
    await client.write([{ sql: "DELETE FROM sync_outbox" }]);
    const before = await rows();
    await repo.rebuildLinks();
    expect(await rows()).toEqual(before);
    expect(await queued()).toEqual([]);
  });

  it("repairs a row that holds other targets than its value gives, keeping the stamp", async () => {
    const w = await world();
    const id = await repo.createItem(w.note, { [w.about]: w.ada }, "default");
    await client.write([{ sql: "UPDATE item_links SET targets = '[]' , deleted_at = NULL" }]);
    await repo.rebuildLinks();
    expect(targetsOf((await rows())[0])).toEqual([{ item: w.ada, collection: w.person.id }]);
    expect((await rows())[0].updated_at).toBe(await stampOf(id, w.about));
  });

  it("makes missing rows and renews stale ones for values an older app wrote, queued for sync (the heal after a sync)", async () => {
    const w = await world();
    const id = await repo.createItem(w.note, { [w.body]: link(w.person.id, w.ada), [w.about]: w.ada }, "default");
    await client.write([{ sql: "DELETE FROM sync_outbox" }]);
    // An older device wrote both values anew (and the pull applied them: no triggers, no index rows).
    const later = "2999-01-01T00:00:00.000Z";
    await sync(client, true);
    await client.write([
      { sql: "UPDATE field_values SET value_text = ?3, updated_at = ?4 WHERE item_id = ?1 AND field_id = ?2", bind: [id, w.body, link(w.person.id, w.bob), later] },
      { sql: "UPDATE field_values SET value_ref = ?3, updated_at = ?4 WHERE item_id = ?1 AND field_id = ?2", bind: [id, w.about, w.bob, later] },
      { sql: "DELETE FROM item_links WHERE source_field_id = ?1", bind: [w.about] }, // this one has no row at all
    ]);
    await sync(client, false);
    expect(await queued()).toEqual([]);
    expect((await repo.listBacklinks(w.person.id, w.bob, "default")).map((l) => l.fieldId)).toEqual([]);

    await client.write([healLinks([[id, w.body], [id, w.about]])]);
    const healed = await rows();
    expect(healed.map((r) => [r.source_field_id, r.updated_at, parseTargets(r.targets)[0].item]).sort()).toEqual(
      [[w.body, later, w.bob], [w.about, later, w.bob]].sort(),
    );
    expect(await queued()).toEqual([`${id}/${w.about}`, `${id}/${w.body}`].sort());
    expect((await repo.listBacklinks(w.person.id, w.bob, "default")).map((l) => l.fieldId).sort()).toEqual([w.body, w.about].sort());

    // A value no older than its row is left as it is.
    await client.write([{ sql: "DELETE FROM sync_outbox" }]);
    await client.write([healLinks([[id, w.body], [id, w.about]])]);
    expect(await queued()).toEqual([]);
  });

  it("leaves a row newer than its value alone", async () => {
    const w = await world();
    const id = await repo.createItem(w.note, { [w.about]: w.ada }, "default");
    const stamp = await stampOf(id, w.about);
    await client.write([{ sql: "UPDATE item_links SET updated_at = '2999-01-01T00:00:00.000Z', targets = '[]', deleted_at = '2999-01-01T00:00:00.000Z'" }]);
    await client.write([healLinks(null)]);
    expect((await rows())[0]).toMatchObject({ targets: "[]", updated_at: "2999-01-01T00:00:00.000Z" });
    expect(stamp < "2999").toBe(true);
  });

  it("ends the row of a value that stopped linking, when only the value was written by an older app", async () => {
    const w = await world();
    const id = await repo.createItem(w.note, { [w.about]: w.ada }, "default");
    await sync(client, true);
    await client.write([{ sql: "UPDATE field_values SET value_ref = NULL, updated_at = '2999-01-01T00:00:00.000Z' WHERE item_id = ?1", bind: [id] }]);
    await sync(client, false);
    await client.write([healLinks([[id, w.about]])]);
    expect((await rows())[0]).toMatchObject({ targets: "[]", deleted_at: "2999-01-01T00:00:00.000Z", updated_at: "2999-01-01T00:00:00.000Z" });
    expect(await repo.listBacklinks(w.person.id, w.ada, "default")).toEqual([]);
  });
});
