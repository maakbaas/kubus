/// <reference lib="webworker" />
// Owns the single SQLite connection. Runs in a dedicated worker because the
// OPFS SAH-pool VFS needs synchronous file handles, which only exist in workers.

import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import schema from "../schema.sql?raw";
import type { OpenResult, Request, Response, Statement } from "./protocol";

const DB_FILE = "/kubus.sqlite3";
const POOL_NAME = "kubus-sahpool";
const POOL_DIR = `.${POOL_NAME}`; // the SAH pool's default directory for this name

// The oo1 API's TypeScript overloads are very strict; we only use a small, stable subset.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;
let db: Db | null = null;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Exclusive lock on the database for this worker's whole lifetime. A reloading
 * page's previous worker may still hold it for a moment; we wait for it. A
 * second tab waits up to `timeoutMs`, then gives up without touching the files.
 */
function acquireDbLock(timeoutMs = 10_000): Promise<void> {
  if (!("locks" in navigator)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    navigator.locks
      .request("kubus-db", { signal: controller.signal }, () => {
        clearTimeout(timer);
        resolve();
        return new Promise<void>(() => {}); // held until the worker terminates
      })
      .catch(() => reject(new Error("Kubus is open in another tab or window. Close it there and reload.")));
  });
}

/** True when every file of the SAH pool can be opened, i.e. no other worker still holds one. */
async function poolFilesFree(): Promise<boolean> {
  let dir: FileSystemDirectoryHandle;
  try {
    dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(POOL_DIR);
  } catch {
    return true; // no pool yet
  }
  const probe = async (d: FileSystemDirectoryHandle): Promise<boolean> => {
    for await (const handle of (d as unknown as { values(): AsyncIterable<FileSystemHandle> }).values()) {
      if (handle.kind === "directory") {
        if (!(await probe(handle as FileSystemDirectoryHandle))) return false;
        continue;
      }
      try {
        const access = await (handle as FileSystemFileHandle).createSyncAccessHandle();
        access.close();
      } catch {
        return false;
      }
    }
    return true;
  };
  return probe(dir);
}

async function open(): Promise<OpenResult> {
  const sqlite3 = await sqlite3InitModule();
  let persistent = false;
  if ("storage" in navigator && "getDirectory" in navigator.storage) {
    // DANGER: if installOpfsSAHPoolVfs() cannot open a pool file (because another
    // worker still holds it), its error handling deletes the pool directory, i.e.
    // the database. So only install once we hold the lock AND every file is free.
    await acquireDbLock();
    let free = false;
    for (let attempt = 0; attempt < 50 && !free; attempt++) {
      free = await poolFilesFree();
      if (!free) await sleep(100);
    }
    if (!free) throw new Error("The database is still in use by another Kubus window. Close it and reload.");
    const pool = await sqlite3.installOpfsSAHPoolVfs({ name: POOL_NAME });
    db = new pool.OpfsSAHPoolDb(DB_FILE);
    persistent = true;
  } else {
    db = new sqlite3.oo1.DB(":memory:", "c");
  }
  // Dropping tables requires foreign keys off, so enable them only afterwards.
  ensureSchema(sqlite3, db);
  db.exec("PRAGMA foreign_keys = ON");
  return { persistent, sqliteVersion: sqlite3.version.libVersion };
}

/** 32-bit FNV-1a hash of the schema text, as a signed int (fits PRAGMA user_version). */
function schemaHash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return h | 0;
}

/**
 * PRE-ALPHA: no migration scripts. If schema.sql changed since the database was created, the
 * database is upgraded in place when the data fits the new schema (new tables, indexes and
 * nullable or defaulted columns; removed columns; changed constraints such as a CHECK): see
 * upgradeInPlace. Only otherwise (a retyped column, a new NOT NULL column without a default) is
 * everything dropped and recreated (local data is lost).
 */
/**
 * Renames done in the schema, applied to an existing database before it is compared with
 * schema.sql (which only knows the new names), so nothing is lost: tables and columns are renamed
 * in place, and stored values that name them are updated. Each step applies only when the old
 * name is still there. (Pre-alpha: kept until no database with the old names exists.)
 */
const RENAMES: ({ table: string; to: string } | { table: string; column: string; to: string })[] = [
  { table: "expressions", to: "templates" },
  { table: "fields", column: "expression_id", to: "template_id" },
  { table: "fields", column: "expression_args", to: "template_args" },
  { table: "object_types", column: "entry_views", to: "object_views" },
  { table: "objects", column: "entry_view_id", to: "object_view_id" },
];
const RENAMED_VALUES = [
  { table: "fields", sql: "UPDATE fields SET kind = 'template' WHERE kind = 'expression'" },
  { table: "bookmarks", sql: "UPDATE bookmarks SET kind = 'object' WHERE kind = 'entry'" },
  { table: "templates", sql: "UPDATE templates SET code = REPLACE(code, '$entry', '$object') WHERE code LIKE '%$entry%'" },
];

function applyRenames(db: Db) {
  const hasTable = (name: string) => db.selectValue("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", [name]) === 1;
  const hasColumn = (table: string, column: string) =>
    db.selectValue(`SELECT 1 FROM pragma_table_info('${table}') WHERE name = ?`, [column]) === 1;
  for (const r of RENAMES) {
    if ("column" in r) {
      if (hasTable(r.table) && hasColumn(r.table, r.column)) db.exec(`ALTER TABLE "${r.table}" RENAME COLUMN "${r.column}" TO "${r.to}"`);
    } else if (hasTable(r.table) && !hasTable(r.to)) {
      db.exec(`ALTER TABLE "${r.table}" RENAME TO "${r.to}"`);
    }
  }
  for (const r of RENAMED_VALUES) if (hasTable(r.table)) db.exec(r.sql);
}

export function ensureSchema(sqlite3: Db, db: Db) {
  const expected = schemaHash(schema);
  if (Number(db.selectValue("PRAGMA user_version")) === expected) return;
  // Renamed values may break the old CHECKs until the tables are rebuilt with the new ones.
  db.exec("PRAGMA ignore_check_constraints = ON");
  try {
  db.transaction(() => {
    applyRenames(db);
    if (!upgradeInPlace(sqlite3, db)) {
      const tables: string[] = db.selectValues("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'");
      for (const t of tables) db.exec(`DROP TABLE "${t}"`);
      db.exec(schema);
    }
    db.exec(`PRAGMA user_version = ${expected}`);
  });
  } finally {
    db.exec("PRAGMA ignore_check_constraints = OFF");
  }
}

interface SchemaObject {
  type: "table" | "index" | "trigger";
  name: string;
  tbl_name: string;
  sql: string;
}
interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

/** A CREATE statement without comments, quotes, case and whitespace differences, for comparing. */
function normalizeSql(sql: string): string {
  return sql.replace(/--.*$/gm, "").replace(/"/g, "").replace(/\s+/g, " ").replace(/\s*([(),])\s*/g, "$1").trim().toLowerCase();
}

/**
 * Brings an existing database up to schema.sql while keeping its data. Missing tables and
 * indexes (and triggers) are created. A table whose definition changed is rebuilt (SQLite's documented
 * procedure, run while foreign keys are off): created anew from schema.sql, its rows copied
 * over by column name, the old table dropped and the new one renamed, its indexes recreated.
 * Returns false (nothing changed) when the rows can't be carried over (a column changed type
 * or became required, a new required column has no default) or there is nothing to keep.
 */
function upgradeInPlace(sqlite3: Db, db: Db): boolean {
  const objects = (d: Db): SchemaObject[] =>
    d.exec({
      sql: "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE type IN ('table', 'index', 'trigger') AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%'",
      rowMode: "object",
      returnValue: "resultRows",
    });
  const columns = (d: Db, table: string): ColumnInfo[] =>
    d.exec({ sql: `PRAGMA table_info("${table}")`, rowMode: "object", returnValue: "resultRows" });

  const have = new Map(objects(db).map((o) => [o.name, o]));
  if (have.size === 0) return false; // a new database: just create it

  const ref = new sqlite3.oo1.DB(":memory:", "c"); // the target schema, to compare against
  try {
    ref.exec(schema);
    const target = objects(ref);
    const statements: string[] = [];
    const rebuilt = new Set<string>();
    for (const t of target.filter((o) => o.type === "table")) {
      const current = have.get(t.name);
      if (!current) {
        statements.push(t.sql);
        continue;
      }
      if (normalizeSql(current.sql) === normalizeSql(t.sql)) continue;
      const old = new Map(columns(db, t.name).map((c) => [c.name, c]));
      const wanted = columns(ref, t.name);
      for (const c of wanted) {
        const prev = old.get(c.name);
        if (prev ? prev.type !== c.type || prev.pk !== c.pk || (c.notnull && !prev.notnull) : c.pk || (c.notnull && c.dflt_value === null)) {
          return false; // existing rows wouldn't fit
        }
      }
      const kept = wanted.filter((c) => old.has(c.name)).map((c) => `"${c.name}"`).join(", ");
      const temp = `__new_${t.name}`;
      statements.push(
        t.sql.replace(/^CREATE TABLE\s+("?)[\w]+\1/i, `CREATE TABLE "${temp}"`),
        `INSERT INTO "${temp}" (${kept}) SELECT ${kept} FROM "${t.name}"`,
        `DROP TABLE "${t.name}"`,
        `ALTER TABLE "${temp}" RENAME TO "${t.name}"`,
      );
      rebuilt.add(t.name);
    }
    // Indexes: missing ones, and all of a rebuilt table's (they were dropped with it).
    for (const i of target.filter((o) => o.type === "index")) {
      if (!have.has(i.name) || rebuilt.has(i.tbl_name)) statements.push(i.sql);
    }
    // Triggers: new or changed ones are (re)created; a rebuilt table's were dropped with it.
    for (const g of target.filter((o) => o.type === "trigger")) {
      const current = have.get(g.name);
      if (current && !rebuilt.has(g.tbl_name) && normalizeSql(current.sql) === normalizeSql(g.sql)) continue;
      statements.push(`DROP TRIGGER IF EXISTS "${g.name}"`, g.sql);
    }
    for (const sql of statements) db.exec(sql);
    return true;
  } finally {
    ref.close();
  }
}

function select(sql: string, bind?: Statement["bind"]) {
  return db.exec({ sql, bind, rowMode: "object", returnValue: "resultRows" });
}

/** All statements commit atomically or not at all. */
function write(statements: Statement[]) {
  db.transaction(() => {
    for (const s of statements) db.exec({ sql: s.sql, bind: s.bind });
  });
  return null;
}

self.onmessage = async (event: MessageEvent<Request>) => {
  const req = event.data;
  let res: Response;
  try {
    if (req.op === "open") {
      res = { id: req.id, ok: true, result: db ? null : await open() };
    } else if (!db) {
      throw new Error("Database not open");
    } else if (req.op === "select") {
      res = { id: req.id, ok: true, result: select(req.sql, req.bind) };
    } else {
      res = { id: req.id, ok: true, result: write(req.statements) };
    }
  } catch (e) {
    res = { id: req.id, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  self.postMessage(res);
};
