import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { fileIds, schema } from "../schema";
import { acceptedStatement, editedStatement, generatedStatement } from "./generated";

const T = "2026-10-21T10:00:00.000Z";
let db: DatabaseSync;
const store = (item: string, output: "number" | "text", value: string | number | null, hash: string) => {
  const s = generatedStatement(item, "f1", output, value, hash, T);
  // node:sqlite binds numbered parameters (?1, ?2) only by name.
  db.prepare(s.sql).run(Object.fromEntries((s.bind ?? []).map((v, i) => [`?${i + 1}`, v])) as never);
};
const rows = () => db.prepare("SELECT item_id, value_text, value_number, value_json FROM field_values").all();

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.function("file_ids", { deterministic: true }, fileIds as (...args: unknown[]) => string);
  db.exec(schema);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`INSERT INTO collections (id, name, plural_name, created_at, updated_at) VALUES ('t1', 'Album', 'Albums', '${T}', '${T}')`);
  db.exec(`INSERT INTO fields (id, collection_id, name, kind, code, output, created_at, updated_at) VALUES ('f1', 't1', 'Shelf', 'ai', 'x', 'string', '${T}', '${T}')`);
  db.exec(`INSERT INTO items (id, collection_id, space_id, created_at, updated_at) VALUES ('o1', 't1', 'default', '${T}', '${T}')`);
});

describe("generatedStatement", () => {
  it("stores the value with its prompt's fingerprint, and replaces it", () => {
    store("o1", "text", "Davis", "h1");
    expect(rows()).toEqual([{ item_id: "o1", value_text: "Davis", value_number: null, value_json: '{"hash":"h1"}' }]);
    store("o1", "text", "Coltrane", "h2");
    expect(rows()).toEqual([{ item_id: "o1", value_text: "Coltrane", value_number: null, value_json: '{"hash":"h2"}' }]);
  });

  it("keeps a number in value_number", () => {
    store("o1", "number", 42, "h1");
    expect(rows()).toEqual([{ item_id: "o1", value_text: null, value_number: 42, value_json: '{"hash":"h1"}' }]);
  });

  it("stores nothing for an item that is gone", () => {
    db.exec("UPDATE items SET deleted_at = 'x' WHERE id = 'o1'");
    store("o1", "text", "Davis", "h1");
    store("nobody", "text", "Davis", "h1");
    expect(rows()).toEqual([]);
  });

  it("keeps what the user typed, marked as theirs until an item look records the prompt", () => {
    store("o1", "text", "Davis", "h1");
    const typed = editedStatement("o1", "f1", "text", "Coltrane", T);
    db.prepare(typed.sql).run(Object.fromEntries((typed.bind ?? []).map((v, i) => [`?${i + 1}`, v])) as never);
    expect(rows()).toEqual([{ item_id: "o1", value_text: "Coltrane", value_number: null, value_json: '{"hash":"","edited":true}' }]);
    const accepted = acceptedStatement("o1", "f1", "h2", T);
    db.prepare(accepted.sql).run(Object.fromEntries((accepted.bind ?? []).map((v, i) => [`?${i + 1}`, v])) as never);
    expect(rows()).toEqual([{ item_id: "o1", value_text: "Coltrane", value_number: null, value_json: '{"hash":"h2","edited":true}' }]);
  });

  it("is queued for sync like any value", () => {
    db.exec("DELETE FROM sync_outbox");
    store("o1", "text", "Davis", "h1");
    expect(db.prepare("SELECT tbl, pk FROM sync_outbox").all()).toEqual([{ tbl: "field_values", pk: '["o1","f1"]' }]);
  });
});
