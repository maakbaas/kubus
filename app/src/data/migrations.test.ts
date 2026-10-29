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
});
