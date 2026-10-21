// @vitest-environment node
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { describe, expect, it, vi } from "vitest";
import schema from "../schema.sql?raw";

// The worker file sets `self.onmessage` when loaded.
vi.stubGlobal("self", globalThis);
const { ensureSchema } = await import("./worker");

// What a database from before sync looked like: no outbox and triggers, and (to force a table
// rebuild, which drops that table's triggers) `objects` without its object_view_id column.
const before = schema
  .slice(0, schema.indexOf("-- Sync ("))
  .replace("  object_view_id TEXT,                  -- the object view (object_types.object_views) this object is pinned to\n", "");

describe("upgrading a database to the sync schema", () => {
  it("keeps all data and (re)creates the outbox and every trigger", async () => {
    const sqlite3 = await sqlite3InitModule();
    const db = new sqlite3.oo1.DB(":memory:", "c");
    db.exec(before);
    db.exec("PRAGMA user_version = 1");
    db.exec(`INSERT INTO object_types (id, name, plural_name, created_at, updated_at) VALUES ('t1', 'Note', 'Notes', 'x', 'x')`);
    db.exec(`INSERT INTO objects (id, type_id, created_at, updated_at) VALUES ('o1', 't1', 'x', 'x')`);
    db.exec(`INSERT INTO fields (id, type_id, name, kind, created_at, updated_at) VALUES ('f1', 't1', 'Title', 'string', 'x', 'x')`);
    db.exec(`INSERT INTO field_values (object_id, field_id, value_text, updated_at) VALUES ('o1', 'f1', 'kept', 'x')`);

    ensureSchema(sqlite3, db);

    expect(db.selectValue("SELECT value_text FROM field_values")).toBe("kept");
    expect(db.selectValue("SELECT id FROM objects")).toBe("o1");
    expect(db.selectValue("SELECT count(*) FROM pragma_table_info('objects') WHERE name = 'object_view_id'")).toBe(1);
    const expected = [...schema.matchAll(/CREATE TRIGGER (\w+)/g)].map((m) => m[1]).sort();
    expect(db.selectValues("SELECT name FROM sqlite_master WHERE type = 'trigger'").sort()).toEqual(expected);
    expect(db.selectValue("SELECT count(*) FROM sync_outbox")).toBe(0);

    // the rebuilt table's trigger works
    db.exec(`UPDATE objects SET updated_at = 'y' WHERE id = 'o1'`);
    expect(db.selectValue("SELECT pk FROM sync_outbox")).toBe("o1");

    // a second start changes nothing
    db.exec("DELETE FROM sync_outbox");
    ensureSchema(sqlite3, db);
    expect(db.selectValue("SELECT value_text FROM field_values")).toBe("kept");
    db.close();
  });
});
