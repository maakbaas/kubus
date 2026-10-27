// @vitest-environment node
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { describe, expect, it } from "vitest";
import { ensureSchema } from "./engine";

describe("the schema", () => {
  it("starts a database made with another schema afresh, and keeps one made with this one", async () => {
    const sqlite3 = await sqlite3InitModule();
    const db = new sqlite3.oo1.DB(":memory:", "c");
    db.exec("CREATE TABLE old (x); INSERT INTO old VALUES (1); PRAGMA user_version = 1");
    ensureSchema(db);
    expect(db.selectValue("SELECT count(*) FROM sqlite_master WHERE name = 'old'")).toBe(0);
    db.exec(`INSERT INTO spaces (id, name, position, created_at, updated_at) VALUES ('s', 'S', 0, 'x', 'x')`);
    ensureSchema(db);
    expect(db.selectValue("SELECT name FROM spaces")).toBe("S");
    db.close();
  });
});
