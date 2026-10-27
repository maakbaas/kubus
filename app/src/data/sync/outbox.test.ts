import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { fileIds, schema } from "../schema";
import { SYNC_TABLES, type SyncTable, type WireRow } from "../../../../shared/sync";
import { applyStatement, keyOf } from "./SyncEngine";

const T1 = "2026-10-21T10:00:00.000Z";
const T2 = "2026-10-21T10:05:00.000Z";

let db: DatabaseSync;
const outbox = () => db.prepare("SELECT tbl, pk FROM sync_outbox ORDER BY id").all() as { tbl: string; pk: string }[];
const apply = (table: string | SyncTable, row: WireRow) => {
  const s = applyStatement(typeof table === "string" ? SYNC_TABLES.find((t) => t.name === table)! : table, row);
  // node:sqlite binds numbered parameters (?1, ?2) only by name.
  db.prepare(s.sql).run(Object.fromEntries((s.bind ?? []).map((v, i) => [`?${i + 1}`, v])) as never);
};

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.function("file_ids", { deterministic: true }, fileIds as (...args: unknown[]) => string);
  db.exec(schema);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`INSERT INTO collections (id, name, plural_name, created_at, updated_at) VALUES ('t1', 'Note', 'Notes', '${T1}', '${T1}')`);
  db.exec("DELETE FROM sync_outbox");
});

describe("outbox triggers", () => {
  it("queue inserted and updated rows, with the key columns of field values", () => {
    db.exec(`INSERT INTO items (id, collection_id, space_id, created_at, updated_at) VALUES ('o1', 't1', 'default', '${T1}', '${T1}')`);
    db.exec(`INSERT INTO fields (id, collection_id, name, kind, created_at, updated_at) VALUES ('f1', 't1', 'Title', 'string', '${T1}', '${T1}')`);
    db.exec(`INSERT INTO field_values (item_id, field_id, value_text, updated_at) VALUES ('o1', 'f1', 'a', '${T1}')`);
    db.exec(`UPDATE field_values SET value_text = 'b' WHERE item_id = 'o1'`);
    expect(outbox()).toEqual([
      { tbl: "items", pk: "o1" },
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
  const item = (updated_at: string, deleted_at: string | null = null): WireRow => ({
    id: "o1", collection_id: "t1", space_id: "default", item_view_id: null, created_at: T1, updated_at, deleted_at,
  });

  it("does not queue them while sync_applying is set", () => {
    db.exec("INSERT INTO meta (key, value) VALUES ('sync_applying', '1')");
    apply("items", item(T1));
    db.exec("DELETE FROM meta WHERE key = 'sync_applying'");
    expect(outbox()).toEqual([]);
    expect(db.prepare("SELECT count(*) AS n FROM items").get()).toEqual({ n: 1 });
  });

  it("replaces a row only with a newer one", () => {
    apply("items", item(T1));
    apply("items", item(T2, T2));
    expect(db.prepare("SELECT deleted_at FROM items").get()).toEqual({ deleted_at: T2 });
    apply("items", item(T1, null)); // older: ignored
    expect(db.prepare("SELECT deleted_at FROM items").get()).toEqual({ deleted_at: T2 });
  });

  it("keeps files as they are, and their bytes (which aren't synced as rows)", () => {
    const file = { id: "abc", mime: "image/png", size: 3, created_at: T1 };
    apply("files", file);
    expect(db.prepare("SELECT data FROM files").get()).toEqual({ data: null }); // known, not downloaded
    db.prepare("UPDATE files SET data = x'010203'").run();
    apply("files", { ...file, mime: "other" });
    const row = db.prepare("SELECT mime, data FROM files").get() as { mime: string; data: Uint8Array };
    expect(row.mime).toBe("image/png");
    expect([...row.data]).toEqual([1, 2, 3]);
  });

  it("writes only the columns a row has (an older server's), and leaves out the ones this device doesn't know", () => {
    apply("items", { ...item(T1), item_view_id: "v1" });
    const { item_view_id: _, ...older } = item(T2, T2);
    apply("items", { ...older, mood: "newer server's column" });
    expect(db.prepare("SELECT item_view_id, deleted_at FROM items").get()).toEqual({ item_view_id: "v1", deleted_at: T2 });
  });

  it("gives a row written before a column the list's default for it", () => {
    const items = { ...SYNC_TABLES.find((t) => t.name === "items")!, defaults: { item_view_id: "standard" } };
    apply(items, item(T1));
    expect(db.prepare("SELECT item_view_id FROM items").get()).toEqual({ item_view_id: "standard" });
    apply(items, { ...item(T2), item_view_id: "v2" });
    expect(db.prepare("SELECT item_view_id FROM items").get()).toEqual({ item_view_id: "v2" });
  });
});
