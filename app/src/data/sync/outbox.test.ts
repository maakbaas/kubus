import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import schema from "../schema.sql?raw";
import { SYNC_TABLES, type WireRow } from "../../../../shared/sync";
import { applyStatement, keyOf } from "./SyncEngine";

const T1 = "2026-10-21T10:00:00.000Z";
const T2 = "2026-10-21T10:05:00.000Z";

let db: DatabaseSync;
const outbox = () => db.prepare("SELECT tbl, pk FROM sync_outbox ORDER BY id").all() as { tbl: string; pk: string }[];
const apply = (table: string, row: WireRow) => {
  const s = applyStatement(SYNC_TABLES.find((t) => t.name === table)!, row);
  db.prepare(s.sql).run(...(s.bind as never[]));
};

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(schema);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`INSERT INTO object_types (id, name, plural_name, created_at, updated_at) VALUES ('t1', 'Note', 'Notes', '${T1}', '${T1}')`);
  db.exec("DELETE FROM sync_outbox");
});

describe("outbox triggers", () => {
  it("queue inserted and updated rows, with the key columns of field values", () => {
    db.exec(`INSERT INTO objects (id, type_id, created_at, updated_at) VALUES ('o1', 't1', '${T1}', '${T1}')`);
    db.exec(`INSERT INTO fields (id, type_id, name, kind, created_at, updated_at) VALUES ('f1', 't1', 'Title', 'string', '${T1}', '${T1}')`);
    db.exec(`INSERT INTO field_values (object_id, field_id, value_text, updated_at) VALUES ('o1', 'f1', 'a', '${T1}')`);
    db.exec(`UPDATE field_values SET value_text = 'b' WHERE object_id = 'o1'`);
    expect(outbox()).toEqual([
      { tbl: "objects", pk: "o1" },
      { tbl: "fields", pk: "f1" },
      { tbl: "field_values", pk: '["o1","f1"]' },
      { tbl: "field_values", pk: '["o1","f1"]' },
    ]);
    // the same key expression seeds the outbox with existing rows
    const seeded = db.prepare(`SELECT ${keyOf(SYNC_TABLES.find((t) => t.name === "field_values")!)} AS pk FROM field_values`).get();
    expect(seeded).toEqual({ pk: '["o1","f1"]' });
  });
});

describe("applying rows from the server", () => {
  const object = (updated_at: string, deleted_at: string | null = null): WireRow => ({
    id: "o1", type_id: "t1", object_view_id: null, created_at: T1, updated_at, deleted_at,
  });

  it("does not queue them while sync_applying is set", () => {
    db.exec("INSERT INTO meta (key, value) VALUES ('sync_applying', '1')");
    apply("objects", object(T1));
    db.exec("DELETE FROM meta WHERE key = 'sync_applying'");
    expect(outbox()).toEqual([]);
    expect(db.prepare("SELECT count(*) AS n FROM objects").get()).toEqual({ n: 1 });
  });

  it("replaces a row only with a newer one", () => {
    apply("objects", object(T1));
    apply("objects", object(T2, T2));
    expect(db.prepare("SELECT deleted_at FROM objects").get()).toEqual({ deleted_at: T2 });
    apply("objects", object(T1, null)); // older: ignored
    expect(db.prepare("SELECT deleted_at FROM objects").get()).toEqual({ deleted_at: T2 });
  });

  it("keeps files as they are and stores their bytes", () => {
    const file = { id: "abc", mime: "image/png", size: 3, data: btoa("\u0001\u0002\u0003"), created_at: T1 };
    apply("files", file);
    apply("files", { ...file, mime: "other" });
    const row = db.prepare("SELECT mime, data FROM files").get() as { mime: string; data: Uint8Array };
    expect(row.mime).toBe("image/png");
    expect([...row.data]).toEqual([1, 2, 3]);
  });
});
