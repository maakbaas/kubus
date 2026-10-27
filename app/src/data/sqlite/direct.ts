import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { SqliteEngine } from "./engine";
import type { Bind, OpenResult, SqlClient, Statement } from "./protocol";

/** The database in this process, in memory: the server's headless device (and tests) under Node. */
export class DirectSqlClient implements SqlClient {
  private constructor(
    private engine: SqliteEngine,
    readonly info: OpenResult,
  ) {}

  static async open(): Promise<DirectSqlClient> {
    const sqlite3 = await sqlite3InitModule();
    const engine = new SqliteEngine(sqlite3, new sqlite3.oo1.DB(":memory:", "c"));
    return new DirectSqlClient(engine, { persistent: false, sqliteVersion: engine.version });
  }

  async select<T>(sql: string, bind?: Bind): Promise<T[]> {
    return this.engine.select<T>(sql, bind);
  }

  async write(statements: Statement[]): Promise<void> {
    if (statements.length > 0) this.engine.write(statements);
  }

  async wipe(): Promise<void> {
    this.engine.wipe();
  }
}
