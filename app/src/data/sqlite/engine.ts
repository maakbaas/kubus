// The SQLite database itself, independent of where it lives: the schema (created, or made afresh
// when it changed), reads, atomic writes and wiping. The browser runs it in a worker over OPFS (worker.ts);
// the server's headless device runs it in-process, in memory (direct.ts).

import { fileIds, schema } from "../schema";
import type { Bind, Statement } from "./protocol";

// The oo1 API's TypeScript overloads are very strict; we only use a small, stable subset.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

export class SqliteEngine {
  /** `sqlite3` is the initialized module, `db` an open oo1 database. Brings its schema up to date. */
  constructor(
    private sqlite3: Db,
    private db: Db,
  ) {
    // Dropping tables requires foreign keys off, so enable them only afterwards.
    ensureSchema(db);
    db.exec("PRAGMA foreign_keys = ON");
  }

  get version(): string {
    return this.sqlite3.version.libVersion;
  }

  select<T>(sql: string, bind?: Bind): T[] {
    return this.db.exec({ sql, bind, rowMode: "object", returnValue: "resultRows" });
  }

  /** All statements commit atomically or not at all. */
  write(statements: Statement[]) {
    this.db.transaction(() => {
      for (const s of statements) this.db.exec({ sql: s.sql, bind: s.bind });
    });
  }

  /** Every table dropped and the schema created afresh, in the same database (file). */
  wipe() {
    this.db.exec("PRAGMA foreign_keys = OFF");
    try {
      this.db.exec("PRAGMA user_version = 0");
      ensureSchema(this.db);
    } finally {
      this.db.exec("PRAGMA foreign_keys = ON");
    }
  }
}

/** 32-bit FNV-1a hash of the schema text, as a signed int (fits PRAGMA user_version). */
function schemaHash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return h | 0;
}

/**
 * Pre-alpha: no migrations. A database made with another schema (schema.sql's hash is kept in
 * PRAGMA user_version) starts afresh: every table dropped, the schema created. A synced device
 * then downloads everything again.
 */
export function ensureSchema(db: Db) {
  db.createFunction("file_ids", (_ctx: number, file: unknown, text: unknown) => fileIds(file, text), { arity: 2, deterministic: true });
  const expected = schemaHash(schema);
  if (Number(db.selectValue("PRAGMA user_version")) === expected) return;
  db.transaction(() => {
    const tables: string[] = db.selectValues("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'");
    for (const t of tables) db.exec(`DROP TABLE "${t}"`);
    db.exec(schema);
    db.exec(`PRAGMA user_version = ${expected}`);
  });
}
