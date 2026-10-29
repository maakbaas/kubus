import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { Db } from "../migrations";
import { SqliteEngine } from "./engine";
import type { Bind, OpenResult, SqlClient, Statement } from "./protocol";

// The database in a real file, under Node 24's built-in SQLite (`node:sqlite`): the server's
// headless device keeps its database this way (headless/index.ts, docs/sync.md "Persistence"). It is
// the same SqliteEngine as in the browser's worker, so schema creation, migrations, reads, change
// sets and wiping behave the same: `NodeDb` only gives `node:sqlite` the few methods of
// sqlite-wasm's `oo1.DB` the engine (and the migrations / tests that open a database first) use.

/** Integers are bound as INTEGER like sqlite-wasm does (node:sqlite binds every JS number as REAL, which json_array() shows as 1.0). */
const bound = (v: unknown): unknown => (typeof v === "number" && Number.isInteger(v) && Math.abs(v) < 2 ** 63 ? BigInt(v) : v === undefined ? null : v);

/** Integers come back as numbers, or as BigInt when beyond 2^53 (as in sqlite-wasm). */
const read = (v: unknown): unknown => (typeof v === "bigint" && v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v);
const plain = (row: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(row)) out[k] = read(row[k]);
  return out;
};

const STATEMENTS = 256;

interface ExecOptions {
  sql: string;
  bind?: Bind;
  rowMode?: "object" | "array";
  returnValue?: "resultRows";
}

/** The part of sqlite-wasm's `oo1.DB` that SqliteEngine, the migrations and the tests use, over a `node:sqlite` database. */
export class NodeDb {
  private statements = new Map<string, StatementSync>();

  constructor(readonly raw: DatabaseSync) {}

  private prepare(sql: string): StatementSync {
    let s = this.statements.get(sql);
    if (!s) {
      if (this.statements.size >= STATEMENTS) this.statements.delete(this.statements.keys().next().value!);
      s = this.raw.prepare(sql);
      s.setReadBigInts(true);
      this.statements.set(sql, s);
    }
    return s;
  }

  /** Runs SQL (several statements without `bind`; one with it); `returnValue: "resultRows"` returns the rows. */
  exec(arg: string | ExecOptions): unknown {
    if (typeof arg === "string") {
      this.raw.exec(arg);
      return this;
    }
    const { sql, bind, rowMode, returnValue } = arg;
    if (!bind?.length && !returnValue) {
      this.raw.exec(sql);
      return this;
    }
    const statement = this.prepare(sql);
    const values = (bind ?? []).map(bound);
    if (!returnValue) {
      statement.run(...(values as never[]));
      return this;
    }
    const rows = statement.all(...(values as never[])) as Record<string, unknown>[];
    return rowMode === "array" ? rows.map((r) => Object.values(plain(r))) : rows.map(plain);
  }

  selectValues(sql: string, bind?: Bind): unknown[] {
    const rows = this.exec({ sql, bind, returnValue: "resultRows", rowMode: "array" }) as unknown[][];
    return rows.map((r) => r[0]);
  }

  selectValue(sql: string, bind?: Bind): unknown {
    return this.selectValues(sql, bind)[0];
  }

  /** `fn(ctx, ...args)` as sqlite-wasm calls a function (ctx is unused here). */
  createFunction(name: string, fn: (ctx: number, ...args: never[]) => unknown, options: { arity?: number; deterministic?: boolean } = {}) {
    this.raw.function(name, { deterministic: options.deterministic ?? false, varargs: true }, ((...args: never[]) => fn(0, ...args)) as never);
  }

  /** All or nothing: BEGIN IMMEDIATE (the write lock at once), COMMIT, or ROLLBACK when `fn` throws. */
  transaction<T>(fn: () => T): T {
    this.raw.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.raw.exec("COMMIT");
      return result;
    } catch (e) {
      try {
        this.raw.exec("ROLLBACK");
      } catch {
        // SQLite already rolled back (some errors do)
      }
      throw e;
    }
  }

  close() {
    this.statements.clear();
    this.raw.close();
  }
}

/**
 * The database in this process under `node:sqlite`: a file (`path`), or in memory (":memory:", also
 * the default). A file is in WAL mode with `synchronous = NORMAL`: a commit survives the process
 * dying (kill -9, a crash) and the file is never corrupted, only the last commits before a power
 * loss or kernel crash can be lost, which a device that syncs (and so fetches them again) does not
 * mind; FULL would fsync every commit for nothing a sync cannot repair. `busy_timeout` makes a
 * second connection (a backup tool, `sqlite3`) wait for the write lock instead of failing.
 */
export class NodeSqlClient implements SqlClient {
  private closed = false;

  private constructor(
    private engine: SqliteEngine,
    private db: NodeDb,
    private file: boolean,
    readonly info: OpenResult,
  ) {}

  /**
   * `before`: what the database holds before the app opens it (tests: an older version's, to migrate).
   * Fails (and lets go of the file) for a file that isn't a database and for one made by a newer version.
   */
  static async open(path = ":memory:", before?: (db: Db) => void): Promise<NodeSqlClient> {
    const file = path !== ":memory:" && path !== "";
    // Foreign keys stay off while the schema is brought up to date (the engine turns them on afterwards).
    const db = new NodeDb(new DatabaseSync(path, { enableForeignKeyConstraints: false }));
    try {
      db.exec("PRAGMA busy_timeout = 5000");
      if (file) db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL");
      before?.(db);
      const sqliteVersion = String(db.selectValue("SELECT sqlite_version()"));
      const engine = new SqliteEngine({ version: { libVersion: sqliteVersion } }, db);
      return new NodeSqlClient(engine, db, file, { persistent: file, sqliteVersion });
    } catch (e) {
      try {
        db.close();
      } catch {
        // nothing more to let go of
      }
      throw e;
    }
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

  /** Backups are a device's (Settings → Backup, on sqlite-wasm); the headless device's file is only a cache of the server's data. */
  async exportDatabase(): Promise<Uint8Array> {
    throw new Error("The headless device makes no backups: its database is a cache of the server's.");
  }

  async importDatabase(): Promise<void> {
    throw new Error("The headless device restores no backups: its database is a cache of the server's.");
  }

  /** Folds the write-ahead log into the file (so it is one file again) and closes the database. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.file) {
      try {
        this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      } catch {
        // busy: the log stays beside the file and is folded in at the next open
      }
    }
    this.db.close();
  }
}
