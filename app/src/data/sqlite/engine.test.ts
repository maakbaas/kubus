// @vitest-environment node
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { beforeAll, describe, expect, it } from "vitest";
import firstRelease from "../schema-v1.sql?raw";
import { MIGRATIONS, type Db } from "../migrations";
import { ensureSchema, FIRST_RELEASE_HASHES, latestVersion, type SchemaPlan } from "./engine";

let sqlite3: Db;
beforeAll(async () => {
  sqlite3 = await sqlite3InitModule();
});
const open = (): Db => new sqlite3.oo1.DB(":memory:", "c");
const version = (db: Db) => db.selectValue("PRAGMA user_version");
const rows = (db: Db, sql: string) => db.exec({ sql, rowMode: "object", returnValue: "resultRows" });

// A small schema of its own, in three versions, with the outbox and its trigger as the real one has.
const V1 = `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE sync_outbox (id INTEGER PRIMARY KEY, tbl TEXT NOT NULL, pk TEXT NOT NULL);
  CREATE TABLE notes (id TEXT PRIMARY KEY, title TEXT NOT NULL, done TEXT);
`;
const trigger = (columns: string) =>
  `CREATE TRIGGER sync_notes_update AFTER UPDATE OF ${columns} ON notes WHEN NOT EXISTS (SELECT 1 FROM meta WHERE key = 'sync_applying')
   BEGIN INSERT INTO sync_outbox (tbl, pk) VALUES ('notes', NEW.id); END;`;
const plan: SchemaPlan = {
  schema: `${V1.replace("title TEXT NOT NULL, done TEXT", "name TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0, tags TEXT")}${trigger("name")}`,
  triggers: trigger("name"),
  migrations: [
    { version: 2, description: "title becomes name", up: "ALTER TABLE notes RENAME COLUMN title TO name; ALTER TABLE notes ADD COLUMN tags TEXT" },
    {
      version: 3,
      description: "done: 'yes' / 'no' becomes 1 / 0 (a rebuilt table)",
      up: (db: Db) => {
        db.exec(`CREATE TABLE notes_new (id TEXT PRIMARY KEY, name TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0, tags TEXT);
                 INSERT INTO notes_new SELECT id, name, done = 'yes', tags FROM notes;
                 DROP TABLE notes; ALTER TABLE notes_new RENAME TO notes;`);
      },
    },
  ],
};
/** A database of version 1 of that schema, with a note. */
function first(): Db {
  const db = open();
  db.exec(`${V1}${trigger("title")} PRAGMA user_version = 1;`);
  db.exec("INSERT INTO notes VALUES ('n1', 'Milk', 'yes'), ('n2', 'Eggs', 'no')");
  return db;
}

describe("the schema", () => {
  it("makes a new database at the newest version", () => {
    const db = open();
    ensureSchema(db, plan);
    expect(version(db)).toBe(3);
    expect(rows(db, "SELECT name FROM pragma_table_info('notes') ORDER BY cid").map((r: { name: string }) => r.name)).toEqual(["id", "name", "done", "tags"]);
  });

  it("migrates an older database in order, keeping its data, without queueing it for sync", () => {
    const db = first();
    ensureSchema(db, plan);
    expect(version(db)).toBe(3);
    expect(rows(db, "SELECT id, name, done FROM notes ORDER BY id")).toEqual([
      { id: "n1", name: "Milk", done: 1 },
      { id: "n2", name: "Eggs", done: 0 },
    ]);
    expect(rows(db, "SELECT * FROM sync_outbox")).toEqual([]);
    expect(rows(db, "SELECT * FROM meta")).toEqual([]);
    // The outbox trigger is made afresh, for the new table.
    db.exec("UPDATE notes SET name = 'Oat milk' WHERE id = 'n1'");
    expect(rows(db, "SELECT tbl, pk FROM sync_outbox")).toEqual([{ tbl: "notes", pk: "n1" }]);
    ensureSchema(db, plan);
    expect(rows(db, "SELECT count(*) AS n FROM notes")).toEqual([{ n: 2 }]);
  });

  it("leaves the database as it was when a migration fails", () => {
    const db = first();
    const broken: SchemaPlan = { ...plan, migrations: [plan.migrations[0], { version: 3, description: "broken", up: "UPDATE nowhere SET x = 1" }] };
    expect(() => ensureSchema(db, broken)).toThrow(/migration 3, broken/);
    expect(version(db)).toBe(1);
    expect(rows(db, "SELECT id, title, done FROM notes ORDER BY id")).toEqual([
      { id: "n1", title: "Milk", done: "yes" },
      { id: "n2", title: "Eggs", done: "no" },
    ]);
  });

  it("doesn't touch a database of a newer version", () => {
    const db = first();
    db.exec("PRAGMA user_version = 7");
    expect(() => ensureSchema(db, plan)).toThrow(/newer version of Kubus/);
    expect(version(db)).toBe(7);
    expect(rows(db, "SELECT count(*) AS n FROM notes")).toEqual([{ n: 2 }]);
  });

  it.each(FIRST_RELEASE_HASHES)("takes a database made before versions with the first release's schema as version 1 (hash %i)", (hash) => {
    const db = open();
    db.exec(firstRelease);
    db.exec(`PRAGMA user_version = ${hash}`);
    db.exec("INSERT INTO spaces (id, name, position, created_at, updated_at) VALUES ('s', 'S', 0, 'x', 'x')");
    ensureSchema(db);
    expect(version(db)).toBe(latestVersion({ schema: "", triggers: "", migrations: MIGRATIONS }));
    expect(db.selectValue("SELECT name FROM spaces")).toBe("S");
  });

  it("starts a pre-release database of another schema afresh", () => {
    const db = open();
    db.exec("CREATE TABLE old (x); INSERT INTO old VALUES (1); PRAGMA user_version = 123456789");
    ensureSchema(db, plan);
    expect(db.selectValue("SELECT count(*) FROM sqlite_master WHERE name = 'old'")).toBe(0);
    expect(version(db)).toBe(3);
  });
});
