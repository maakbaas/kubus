// @vitest-environment node
// The local migrations: a database of the first release, migrated, is the schema a new database
// gets (schema.sql), table by table, column by column. Fails when schema.sql changes without a
// migration, or a migration without schema.sql.
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { describe, expect, it } from "vitest";
import firstRelease from "./schema-v1.sql?raw";
import { MIGRATIONS, type Db } from "./migrations";
import { ensureSchema, FIRST_RELEASE_HASH, latestVersion } from "./sqlite/engine";
import { outboxTriggerSql, schema } from "./schema";

/** 32-bit FNV-1a hash of the schema text, as a signed int: what pre-release versions kept in user_version. */
function schemaHash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return h | 0;
}

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

  it("start from the first release's schema, which databases made before them are recognized by", () => {
    expect(schemaHash(firstRelease)).toBe(FIRST_RELEASE_HASH);
  });

  it("bring a database of the first release to exactly the schema of a new one", async () => {
    const sqlite3 = await sqlite3InitModule();
    const migrated = new sqlite3.oo1.DB(":memory:", "c");
    migrated.exec(firstRelease);
    migrated.exec("PRAGMA user_version = 1");
    ensureSchema(migrated);
    const made = new sqlite3.oo1.DB(":memory:", "c");
    ensureSchema(made);
    const plan = { schema, triggers: outboxTriggerSql, migrations: MIGRATIONS };
    expect(migrated.selectValue("PRAGMA user_version")).toBe(latestVersion(plan));
    expect(made.selectValue("PRAGMA user_version")).toBe(latestVersion(plan));
    expect(shape(migrated)).toEqual(shape(made));
    migrated.close();
    made.close();
  });
});
