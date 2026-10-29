import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import type { Db } from "../migrations";
import { SqliteEngine } from "./engine";
import type { Bind, OpenResult, SqlClient, Statement } from "./protocol";

/** The database in this process, in memory, on sqlite-wasm (as the browser's worker runs it): the app's tests. The server's headless device uses `NodeSqlClient` (node.ts). */
export class DirectSqlClient implements SqlClient {
  private constructor(
    private engine: SqliteEngine,
    readonly info: OpenResult,
  ) {}

  /** `before`: what the database holds before the app opens it (tests: an older version's, to migrate). */
  static async open(before?: (db: Db) => void): Promise<DirectSqlClient> {
    const sqlite3 = await sqlite3InitModule();
    const db = new sqlite3.oo1.DB(":memory:", "c");
    before?.(db);
    const engine = new SqliteEngine(sqlite3, db);
    return new DirectSqlClient(engine, { persistent: false, sqliteVersion: engine.version });
  }

  async select<T>(sql: string, bind?: Bind): Promise<T[]> {
    return this.engine.select<T>(sql, bind);
  }

  async write(statements: Statement[]): Promise<void> {
    if (statements.length > 0) this.engine.write(statements);
  }

  async exportDatabase(): Promise<Uint8Array> {
    return this.engine.exportDatabase();
  }

  async importDatabase(bytes: Uint8Array, dryRun = false): Promise<void> {
    this.engine.importDatabase(bytes, dryRun);
  }

  async wipe(): Promise<void> {
    this.engine.wipe();
  }
}
