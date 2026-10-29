// @vitest-environment node
// The local migrations: a database of the first release, migrated, is the schema a new database
// gets (schema.sql), table by table, column by column. Fails when schema.sql changes without a
// migration, or a migration without schema.sql.
import { describe, expect, it } from "vitest";
import { bareDatabases, openTestClient } from "../test/engine";
import firstRelease from "./schema-v1.sql?raw";
import firstReleaseData from "./fixture-v1.sql?raw";
import { SqliteRepository } from "./sqlite/SqliteRepository";
import { memoryEnvironment } from "./sync/environment";
import { MIGRATIONS, type Db } from "./migrations";
import { ensureSchema, latestVersion } from "./sqlite/engine";
import { fileIds, outboxTriggerSql, schema } from "./schema";

/** Everything about a database's schema that the app relies on, independent of how it was written. */
function shape(db: Db) {
  const names = (type: string): string[] =>
    db.selectValues(`SELECT name FROM sqlite_master WHERE type = '${type}' AND name NOT LIKE 'sqlite_%' ORDER BY name`);
  const pragma = (sql: string) => db.exec({ sql, rowMode: "object", returnValue: "resultRows" }) as Record<string, unknown>[];
  const byName = (rows: Record<string, unknown>[]) => rows.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return {
    tables: Object.fromEntries(
      names("table").map((t) => [
        t,
        {
          columns: byName(pragma(`PRAGMA table_info("${t}")`).map(({ cid: _, ...c }) => c)),
          foreignKeys: pragma(`PRAGMA foreign_key_list("${t}")`).map(({ id: _, seq: __, ...k }) => k),
          // CHECK constraints live only in the table's SQL: compared without comments and spacing.
          checks: [...(String(db.selectValue(`SELECT sql FROM sqlite_master WHERE name = '${t}'`)).replace(/--[^\n]*/g, "").replace(/\s+/g, " ").matchAll(/CHECK \(.*?\)\)?(?=,|\s*\)$)/g))].map((m) => m[0]).sort(),
        },
      ]),
    ),
    indexes: Object.fromEntries(
      names("index").map((i) => [i, { sql: String(db.selectValue(`SELECT sql FROM sqlite_master WHERE name = '${i}'`)).replace(/\s+/g, " "), columns: pragma(`PRAGMA index_info("${i}")`).map((c) => c.name) }]),
    ),
    triggers: Object.fromEntries(names("trigger").map((t) => [t, String(db.selectValue(`SELECT sql FROM sqlite_master WHERE name = '${t}'`)).replace(/\s+/g, " ")])),
  };
}

describe("migrations", () => {
  it("are numbered 2, 3, 4, … in order", () => {
    expect(MIGRATIONS.map((m) => m.version)).toEqual(MIGRATIONS.map((_, i) => i + 2));
  });

  it("bring a database of the first release to exactly the schema of a new one", async () => {
    const open = await bareDatabases();
    const migrated = open();
    migrated.exec(firstRelease);
    migrated.exec("PRAGMA user_version = 1");
    ensureSchema(migrated);
    const made = open();
    ensureSchema(made);
    const plan = { schema, triggers: outboxTriggerSql, migrations: MIGRATIONS };
    expect(migrated.selectValue("PRAGMA user_version")).toBe(latestVersion(plan));
    expect(made.selectValue("PRAGMA user_version")).toBe(latestVersion(plan));
    expect(shape(migrated)).toEqual(shape(made));
    migrated.close();
    made.close();
  });

  it("keep every row of a first-release database, which the app then reads as it was", async () => {
    const counts = (rows: { name: string; n: number }[]) => Object.fromEntries(rows.map((r) => [r.name, r.n]));
    const countSql = (db: Db) =>
      (db.selectValues("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'sync_outbox'") as string[])
        .map((t) => `SELECT '${t}' AS name, count(*) AS n FROM "${t}"`)
        .join(" UNION ALL ");
    let before: Record<string, number> = {};
    // Opened as the app opens it: the engine migrates it.
    const client = await openTestClient((db) => {
      db.createFunction("file_ids", (_ctx: number, file: unknown, text: unknown) => fileIds(file, text), { arity: 2, deterministic: true });
      db.exec(firstRelease);
      db.exec(firstReleaseData);
      db.exec("PRAGMA user_version = 1");
      before = counts(db.exec({ sql: countSql(db), rowMode: "object", returnValue: "resultRows" }));
    });
    expect(before.field_values).toBeGreaterThan(10);
    // A migration that moves rows to another table says so here.
    const after = counts(await client.select(`SELECT name, n FROM (${Object.keys(before).map((t) => `SELECT '${t}' AS name, count(*) AS n FROM "${t}"`).join(" UNION ALL ")})`));
    expect(after).toEqual(before);

    const repo = await SqliteRepository.open(client, memoryEnvironment());
    expect((await repo.listSpaces()).map((s) => [s.id, s.name, s.icon])).toEqual([["default", "Space", null], ["space-work", "Work", "Briefcase"]]);
    const collections = await repo.listCollections();
    const book = collections.find((c) => c.id === "collection-book")!;
    expect(book).toMatchObject({ name: "Book", pluralName: "Books", icon: "Book", spaceIds: ["default", "space-work"] });
    expect(book.fields.map((f) => f.kind)).toEqual(["string", "markdown", "number", "date", "datetime", "checkbox", "image", "item", "string_list", "checklist", "item_list", "component", "component", "ai", "html"]);
    expect(book.fields.find((f) => f.id === "field-author")?.choiceFilter).toEqual([{ id: "rule-writers", fieldId: "field-name", operator: "contains", value: "Herbert" }]);
    expect(book.itemViews.map((v) => v.name)).toEqual(["Compact"]);
    const cover = "e06cc5dc61902f1ec01216ae3298216b218ad494ca253a85557ed4e44a23994b";
    const dune = await repo.getItem(book, "item-dune");
    expect(dune).toMatchObject({
      spaceId: "default",
      itemViewId: "itemview-compact",
      aiInputs: { "field-summary": "hash-1" },
      values: {
        "field-title": "Dune", "field-notes": `# Notes\n\nA *desert* planet. ![](files/${cover})`, "field-pages": 412.5, "field-published": "1965-08-01",
        "field-finished": "2026-03-01T10:00:00.000Z", "field-read": true, "field-cover": cover, "field-author": "item-herbert", "field-tags": ["sf", "classic"],
        "field-todo": ["[x] read", "[ ] reread"], "field-also": ["item-emma"], "field-summary": "A desert epic", "field-html": "<b>bold</b>",
      },
    });
    expect((await repo.listItems(book, "space-work")).map((i) => i.values["field-title"])).toEqual(["Emma"]);
    expect((await repo.listItems(book, "default")).map((i) => i.id)).toEqual(["item-dune"]); // the deleted one stays deleted
    expect(await repo.getFile(cover)).toEqual({ data: new TextEncoder().encode("cover bytes"), mime: "image/png" });
    expect(await repo.getFile(cover, { small: true })).toMatchObject({ mime: "image/webp", small: true });
    expect((await repo.listViews(book.id, "default")).map((v) => [v.name, v.isDefault, v.filters.length])).toEqual([["All", false, 0], ["Unread", true, 1]]);
    expect((await repo.listBookmarks("default")).map((b) => b.label)).toEqual(["Dune", "Unread books"]);
    expect((await repo.listComponents()).map((c) => [c.name, c.ai])).toEqual([["Badge", false], ["Summary", true]]);
  });

  it("build the item links of the values already there (migration 2), queued for the server, and keep them as the app does after", async () => {
    // The first release's data plus a Markdown note linking to two items, one with a block anchor.
    const note = "See [Frank](#/collections/collection-person/items/item-herbert) and [a block](#/collections/collection-book/items/item-emma?block=b)";
    const client = await openTestClient((db: Db) => {
      db.createFunction("file_ids", (_ctx: number, file: unknown, text: unknown) => fileIds(file, text), { arity: 2, deterministic: true });
      db.exec(firstRelease);
      db.exec(firstReleaseData);
      db.exec(`INSERT INTO field_values (item_id, field_id, value_text, updated_at) VALUES ('item-emma', 'field-notes', '${note}', '2026-10-28T10:00:00.000Z')`);
      db.exec("PRAGMA user_version = 1");
    });
    const rows = await client.select<{ id: string; targets: string; updated_at: string; deleted_at: string | null }>("SELECT id, targets, updated_at, deleted_at FROM item_links ORDER BY id");
    const stamp = (id: string) => (id === "item-emma/field-notes" ? "2026-10-28T10:00:00.000Z" : "2026-10-27T20:13:00.396Z");
    expect(rows.map((r) => r.id)).toEqual(["item-dune/field-also", "item-dune/field-author", "item-emma/field-notes"]);
    expect(rows.every((r) => r.deleted_at === null && r.updated_at === stamp(r.id))).toBe(true);
    expect(rows.map((r) => JSON.parse(r.targets))).toEqual([
      [{ item: "item-emma", collection: "collection-book" }],
      [{ item: "item-herbert", collection: "collection-person" }],
      [{ item: "item-emma", collection: "collection-book" }, { item: "item-herbert", collection: "collection-person" }],
    ]);
    // Queued for the server (a migration queues nothing by itself).
    expect((await client.select<{ pk: string }>("SELECT DISTINCT pk FROM sync_outbox WHERE tbl = 'item_links' ORDER BY pk")).map((r) => r.pk)).toEqual(rows.map((r) => r.id));
    const repo = await SqliteRepository.open(client, memoryEnvironment());
    expect((await repo.listBacklinks("collection-person", "item-herbert", "default")).map((l) => [l.sourceItemId, l.fieldId])).toEqual([["item-dune", "field-author"]]);
    // From then on the triggers keep it: rebuilding from the values changes nothing.
    await repo.rebuildLinks();
    expect(await client.select("SELECT id, targets, updated_at, deleted_at FROM item_links ORDER BY id")).toEqual(rows);
  });

  it("rebuild the bookmarks for dashboards (migration 3), keeping theirs, queueing none, and the outbox triggers work after", async () => {
    let queued: number[] = [];
    const client = await openTestClient((db: Db) => {
      db.createFunction("file_ids", (_ctx: number, file: unknown, text: unknown) => fileIds(file, text), { arity: 2, deterministic: true });
      db.exec(firstRelease);
      db.exec(firstReleaseData);
      db.exec("PRAGMA user_version = 1");
      queued = db.selectValues("SELECT id FROM sync_outbox ORDER BY id");
    });
    const marks = await client.select<{ kind: string; collection_id: string | null; dashboard_id: string | null }>("SELECT kind, collection_id, dashboard_id FROM bookmarks ORDER BY id");
    expect(marks.length).toBeGreaterThan(0);
    expect(marks.every((b) => b.collection_id !== null && b.dashboard_id === null)).toBe(true);
    // What the first release had queued (its own writes), and nothing more (migration 2 queues item links).
    expect((await client.select<{ id: number }>("SELECT id FROM sync_outbox WHERE tbl <> 'item_links' ORDER BY id")).map((r) => r.id)).toEqual(queued);
    const repo = await SqliteRepository.open(client, memoryEnvironment());
    await repo.saveDashboard({ id: "dash", name: "Home", icon: null, description: "", spaceIds: ["default"] }, "default");
    const [tab] = await repo.listDashboardViews("dash", "default");
    await repo.addBookmark("dashboard", "dash", tab.id, "Home / Dashboard", "default");
    expect((await repo.listBookmarks("default")).map((b) => b.label)).toEqual(["Dune", "Unread books", "Home / Dashboard"]);
    // Foreign keys hold: a dashboard bookmark names a dashboard, not a collection.
    await expect(client.write([{ sql: "INSERT INTO bookmarks (id, kind, space_id, target_id, label, created_at, updated_at, dashboard_id) VALUES ('x', 'dashboard', 'default', 't', 'x', 'n', 'n', 'nope')" }])).rejects.toThrow(/FOREIGN KEY/);
    const after = await client.select<{ tbl: string }>("SELECT DISTINCT tbl FROM sync_outbox WHERE id > ?1 AND tbl <> 'item_links' ORDER BY tbl", [Math.max(0, ...queued)]);
    expect(after.map((r) => r.tbl)).toEqual(["bookmarks", "dashboard_views", "dashboards"]);
  });

  it("record the files the blocks already there use (migration 4), of live views and collections only", async () => {
    const [a, b, c] = ["a", "b", "c"].map((x) => x.repeat(64));
    const client = await openTestClient((db: Db) => {
      db.createFunction("file_ids", (_ctx: number, file: unknown, text: unknown) => fileIds(file, text), { arity: 2, deterministic: true });
      db.exec(firstRelease);
      db.exec(firstReleaseData);
      const config = (file: string) => JSON.stringify({ filters: [], blocks: [{ id: "m", kind: "markdown", options: { text: `![](files/${file})` } }] });
      db.exec(`INSERT INTO views (id, collection_id, space_id, name, config, created_at, updated_at) VALUES ('view-images', 'collection-book', 'default', 'Images', '${config(a)}', '2026-10-28T10:00:00.000Z', '2026-10-28T10:00:00.000Z')`);
      db.exec(`INSERT INTO views (id, collection_id, space_id, name, config, created_at, updated_at, deleted_at) VALUES ('view-gone', 'collection-book', 'default', 'Gone', '${config(b)}', '2026-10-28T10:00:00.000Z', '2026-10-28T10:00:00.000Z', '2026-10-28T10:00:00.000Z')`);
      db.exec(`UPDATE collections SET item_views = '${JSON.stringify([{ id: "v", name: "Default", isDefault: true, layout: { blocks: [{ id: "m", kind: "chart", options: { regions: { file: `files/${c}` } } }] } }])}' WHERE id = 'collection-book'`);
      db.exec("PRAGMA user_version = 1");
    });
    expect(await client.select("SELECT file_id, owner_id FROM block_file_uses ORDER BY file_id")).toEqual([
      { file_id: a, owner_id: "view-images" },
      { file_id: c, owner_id: "collection-book" },
    ]);
    // A dashboard tab's blocks count too (its triggers came with the migration).
    const repo = await SqliteRepository.open(client, memoryEnvironment());
    await repo.saveDashboard({ id: "dash", name: "Home", icon: null, description: "", spaceIds: ["default"] }, "default");
    const [tab] = await repo.listDashboardViews("dash", "default");
    await repo.saveDashboardView({ ...tab, blocks: [{ id: "m", kind: "markdown", options: { text: `![](files/${b})` } }] } as typeof tab);
    expect(await client.select("SELECT file_id FROM block_file_uses WHERE owner_id = ?1", [tab.id])).toEqual([{ file_id: b }]);
  });
});
