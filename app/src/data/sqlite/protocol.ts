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
  | { id: number; op: "wipe" };

export type Response = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string };

/** A connection to the SQLite database: the browser's worker (client.ts) or in-process (direct.ts). */
export interface SqlClient {
  readonly info: OpenResult;
  select<T>(sql: string, bind?: Bind): Promise<T[]>;
  /** Executes all statements in a single transaction. */
  write(statements: Statement[]): Promise<void>;
  /** Drops all data: every table empty, as in a new database. */
  wipe(): Promise<void>;
}
