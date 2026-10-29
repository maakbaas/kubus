// Which SQLite the tests run the storage contract on. By default sqlite-wasm in memory (what the
// browser's worker runs and `DirectSqlClient` is); with KUBUS_TEST_ENGINE=node (the vitest project
// `nodesqlite`) Node's built-in `node:sqlite` on a real file in a temporary directory (what the
// server's headless device runs, `NodeSqlClient`). Tests open their databases through these, so one
// body of tests proves both engines.
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Db } from "../data/migrations";
import { DirectSqlClient } from "../data/sqlite/direct";
import { NodeDb, NodeSqlClient } from "../data/sqlite/node";
import type { SqlClient } from "../data/sqlite/protocol";

export const nodeEngine = process.env.KUBUS_TEST_ENGINE === "node";

let dir: string | null = null;
let count = 0;
/** A new database file in this process's temporary directory (removed when the process ends). */
export function tempDatabase(): string {
  if (!dir) {
    dir = mkdtempSync(join(tmpdir(), "kubus-test-db-"));
    process.on("exit", () => rmSync(dir!, { recursive: true, force: true }));
  }
  return join(dir, `${++count}.db`);
}

/** A new database as the app opens it (schema created or migrated); `before` runs on it first. */
export const openTestClient = (before?: (db: Db) => void): Promise<SqlClient> =>
  nodeEngine ? NodeSqlClient.open(tempDatabase(), before) : DirectSqlClient.open(before);

/** Makes bare in-memory databases (no schema) with sqlite-wasm's `oo1.DB` methods. */
export async function bareDatabases(): Promise<() => Db> {
  if (nodeEngine) return () => new NodeDb(new DatabaseSync(":memory:", { enableForeignKeyConstraints: false }));
  const sqlite3 = await sqlite3InitModule();
  return () => new sqlite3.oo1.DB(":memory:", "c");
}
