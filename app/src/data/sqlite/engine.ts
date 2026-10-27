// The SQLite database itself, independent of where it lives: the schema (created, or upgraded in
// place), reads, atomic writes and wiping. The browser runs it in a worker over OPFS (worker.ts);
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
    ensureSchema(sqlite3, db);
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
    const db = this.db;
    db.exec("PRAGMA foreign_keys = OFF");
    try {
      db.transaction(() => {
        const tables: string[] = db.selectValues("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'");
        for (const t of tables) db.exec(`DROP TABLE "${t}"`);
        db.exec("PRAGMA user_version = 0");
      });
      ensureSchema(this.sqlite3, db);
    } finally {
      db.exec("PRAGMA foreign_keys = ON");
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
const RENAMES: ({ table: string; to: string } | { table: string; column: string; to: string })[] = [];
/** Statements updating stored values that name renamed things, run after RENAMES. */
const RENAMED_VALUES: { table: string; sql: string }[] = [];
/** Derived tables: how one created in an existing database is filled from what is there. */
const FILLS: Record<string, string> = {
  file_uses: `INSERT OR IGNORE INTO file_uses (file_id, item_id, field_id)
                SELECT j.value, fv.item_id, fv.field_id FROM field_values fv, json_each(file_ids(fv.value_file, fv.value_text)) j
                 WHERE fv.value_file IS NOT NULL OR instr(fv.value_text, 'files/') > 0`,
};

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

/** Brings the database to the schema; first defines the functions the schema calls (on every open). */
export function ensureSchema(sqlite3: Db, db: Db) {
  db.createFunction("file_ids", (_ctx: number, file: unknown, text: unknown) => fileIds(file, text), { arity: 2, deterministic: true });
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
 * indexes (and triggers) are created, removed ones dropped. A table whose definition changed is rebuilt (SQLite's documented
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
    const fills: string[] = [];
    const rebuilt = new Set<string>();
    for (const t of target.filter((o) => o.type === "table")) {
      const current = have.get(t.name);
      if (!current) {
        statements.push(t.sql);
        if (FILLS[t.name]) fills.push(FILLS[t.name]);
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
    // Tables, indexes and triggers schema.sql no longer has go (a removed table with its rows).
    const wanted = new Set(target.map((o) => o.name));
    for (const o of have.values()) {
      if (wanted.has(o.name)) continue;
      if (o.type === "table") statements.push(`DROP TABLE IF EXISTS "${o.name}"`);
      else statements.unshift(`DROP ${o.type.toUpperCase()} IF EXISTS "${o.name}"`);
    }
    for (const sql of [...statements, ...fills]) db.exec(sql);
    return true;
  } finally {
    ref.close();
  }
}
