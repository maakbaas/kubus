// @vitest-environment node
import { beforeAll, describe, expect, it } from "vitest";
import { bareDatabases, openTestClient } from "../../test/engine";
import type { Db } from "../migrations";
import { ensureSchema, type SchemaPlan } from "./engine";

// The engine under test: sqlite-wasm, or node:sqlite with KUBUS_TEST_ENGINE=node (test/engine.ts).
let open: () => Db;
beforeAll(async () => {
  open = await bareDatabases();
});
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

  it("starts a pre-release database of another schema afresh", () => {
    const db = open();
    db.exec("CREATE TABLE old (x); INSERT INTO old VALUES (1); PRAGMA user_version = 123456789");
    ensureSchema(db, plan);
    expect(db.selectValue("SELECT count(*) FROM sqlite_master WHERE name = 'old'")).toBe(0);
    expect(version(db)).toBe(3);
  });
});

describe("migrations that break references", () => {
  const V1_REFS = `${V1} CREATE TABLE tag (id TEXT PRIMARY KEY, note TEXT REFERENCES notes (id));`;
  const refs = (up: string): SchemaPlan => ({
    schema: V1_REFS,
    triggers: trigger("name"),
    migrations: [{ version: 2, description: "tag a note", up }],
  });
  const old = (): Db => {
    const db = open();
    db.exec(`${V1_REFS} PRAGMA user_version = 1; INSERT INTO notes VALUES ('n1', 'Milk', NULL); INSERT INTO tag VALUES ('t1', 'n1');`);
    return db;
  };

  it("are refused, and leave the database as it was", () => {
    const db = old();
    expect(() => ensureSchema(db, refs("INSERT INTO tag VALUES ('t2', 'missing')"))).toThrow(/broke references between rows/);
    expect(version(db)).toBe(1);
    expect(rows(db, "SELECT id FROM tag")).toEqual([{ id: "t1" }]);
  });

  it("pass when they only keep the references they found", () => {
    const db = old();
    ensureSchema(db, refs("INSERT INTO tag VALUES ('t2', 'n1')"));
    expect(version(db)).toBe(2);
    expect(rows(db, "SELECT id FROM tag ORDER BY id")).toEqual([{ id: "t1" }, { id: "t2" }]);
  });
});

describe("the engine", () => {
  it("commits a change set whole or not at all, and answers reads as objects", async () => {
    const client = await openTestClient();
    await expect(
      client.write([
        { sql: "INSERT INTO meta (key, value) VALUES (?1, ?2)", bind: ["a", "1"] },
        { sql: "INSERT INTO meta (key, value) VALUES (?1, ?2)", bind: ["a", "2"] }, // the key is taken
      ]),
    ).rejects.toThrow();
    expect(await client.select("SELECT * FROM meta WHERE key = 'a'")).toEqual([]);
    await client.write([{ sql: "INSERT INTO meta (key, value) VALUES (?1, ?2)", bind: ["a", "1"] }]);
    expect(await client.select("SELECT key, value FROM meta WHERE key = ?1", ["a"])).toEqual([{ key: "a", value: "1" }]);
  });

  it("enforces foreign keys once its schema is in place", async () => {
    const client = await openTestClient();
    await expect(client.write([{ sql: "INSERT INTO items (id, collection_id, space_id, created_at, updated_at) VALUES ('i', 'nowhere', 'default', 't', 't')" }])).rejects.toThrow(/FOREIGN KEY/);
  });

  it("wipes to a new database: every table empty, the schema in place, foreign keys back on", async () => {
    const client = await openTestClient();
    await client.write([
      { sql: "INSERT INTO collections (id, name, plural_name, created_at, updated_at) VALUES ('c', 'C', 'Cs', 't', 't')" },
      { sql: "INSERT INTO items (id, collection_id, space_id, created_at, updated_at) VALUES ('i', 'c', 'default', 't', 't')" },
    ]);
    expect(await client.select("SELECT count(*) AS n FROM sync_outbox")).not.toEqual([{ n: 0 }]);
    await client.wipe();
    for (const table of ["collections", "items", "sync_outbox", "meta"]) expect(await client.select(`SELECT * FROM ${table}`), table).toEqual([]);
    await client.write([{ sql: "INSERT INTO collections (id, name, plural_name, created_at, updated_at) VALUES ('c2', 'C', 'Cs', 't', 't')" }]);
    expect(await client.select("SELECT sql FROM sqlite_master WHERE name = 'sync_collections_insert'")).toHaveLength(1);
    await expect(client.write([{ sql: "INSERT INTO items (id, collection_id, space_id, created_at, updated_at) VALUES ('i2', 'nowhere', 'default', 't', 't')" }])).rejects.toThrow(/FOREIGN KEY/);
  });
});

