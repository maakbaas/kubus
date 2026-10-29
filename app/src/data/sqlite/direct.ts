import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import type { Db } from "../migrations";
import { SqliteEngine } from "./engine";
import type { Bind, OpenResult, SqlClient, Statement } from "./protocol";

/** What a database in this process can be given to live on (the server's headless device keeps it on disk). */
export interface DirectPersistence {
  /** A database file's bytes (as `export` made them) to start from. */
  load?: Uint8Array;
  /** Called after every write and wipe: the caller saves `export()` when it likes. */
  changed?: () => void;
}

/** The database in this process, in memory: the server's headless device (and tests) under Node. */
export class DirectSqlClient implements SqlClient {
  private constructor(
    private engine: SqliteEngine,
    private db: Db,
    private sqlite3: Db,
    readonly info: OpenResult,
    private changed?: () => void,
  ) {}

  /**
   * `before`: what the database holds before the app opens it (tests: an older version's, to migrate).
   * `persistence.load` is a database file from `export()`: it is migrated like any older one.
   */
  static async open(before?: (db: Db) => void, persistence: DirectPersistence = {}): Promise<DirectSqlClient> {
    const sqlite3 = await sqlite3InitModule();
    const db = new sqlite3.oo1.DB(":memory:", "c");
    if (persistence.load) {
      const bytes = persistence.load;
      const pointer = sqlite3.wasm.allocFromTypedArray(bytes);
      const flags = sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE | sqlite3.capi.SQLITE_DESERIALIZE_RESIZEABLE;
      db.checkRc(sqlite3.capi.sqlite3_deserialize(db.pointer!, "main", pointer, bytes.length, bytes.length, flags));
    }
    before?.(db);
    const engine = new SqliteEngine(sqlite3, db);
    return new DirectSqlClient(engine, db, sqlite3, { persistent: false, sqliteVersion: engine.version }, persistence.changed);
  }

  /** The whole database as a SQLite file's bytes (a consistent snapshot: nothing runs in between). */
  export(): Uint8Array {
    return this.sqlite3.capi.sqlite3_js_db_export(this.db.pointer);
  }

  async select<T>(sql: string, bind?: Bind): Promise<T[]> {
    return this.engine.select<T>(sql, bind);
  }

  async write(statements: Statement[]): Promise<void> {
    if (statements.length === 0) return;
    this.engine.write(statements);
    this.changed?.();
  }

  async wipe(): Promise<void> {
    this.engine.wipe();
    this.changed?.();
  }
}
