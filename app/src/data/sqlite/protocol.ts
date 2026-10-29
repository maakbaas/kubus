// The database connection the repository and sync use (SqlClient), and the message protocol
// between the main thread (client.ts) and the SQLite worker.

export type Bind = (string | number | Uint8Array | null)[];
export interface Statement {
  sql: string;
  bind?: Bind;
}

export interface OpenResult {
  /** false = in-memory fallback, data is lost on reload. */
  persistent: boolean;
  sqliteVersion: string;
}

export type Request =
  | { id: number; op: "open" }
  | { id: number; op: "select"; sql: string; bind?: Bind }
  | { id: number; op: "write"; statements: Statement[] }
  /** Drops every table and creates the schema afresh (the app reloads after it). */
  | { id: number; op: "wipe" }
  /** The whole database as a SQLite file's bytes. */
  | { id: number; op: "export" }
  /** Replaces the database with a backup file's (`dryRun`: only checks it, throwing why not). */
  | { id: number; op: "import"; bytes: Uint8Array; dryRun: boolean };

export type Response = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string };

/** A connection to the SQLite database: the browser's worker (client.ts) or in-process (direct.ts). */
export interface SqlClient {
  readonly info: OpenResult;
  select<T>(sql: string, bind?: Bind): Promise<T[]>;
  /** Executes all statements in a single transaction. */
  write(statements: Statement[]): Promise<void>;
  /** Drops all data: every table empty, as in a new database. */
  wipe(): Promise<void>;
  /** The whole database as a SQLite file (a consistent snapshot, files' bytes included). */
  exportDatabase(): Promise<Uint8Array>;
  /**
   * Replaces the whole database with a backup file's (migrated if older; sync state not carried over),
   * or with `dryRun` only checks the file. Throws why a file is refused; the database is then untouched.
   */
  importDatabase(bytes: Uint8Array, dryRun?: boolean): Promise<void>;
}
