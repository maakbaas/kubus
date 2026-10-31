// The SQLite database itself, independent of where it lives: the schema (created, or migrated
// from an older version's), reads, atomic writes and wiping. The browser runs it in a worker over OPFS
// (worker.ts); the server's headless device runs it in-process on node:sqlite, in a file (node.ts); tests also use sqlite-wasm in memory (direct.ts).

import { MIGRATIONS, type Db, type Migration } from "../migrations";
import { fileIds, linkTargetsFn, outboxTriggerSql, schema } from "../schema";
import type { Bind, Statement } from "./protocol";
import { errorMessage } from "../../domain/errors";

export class SqliteEngine {
  /** `sqlite3` is the initialized module, `db` an open oo1 database. Brings its schema up to date. */
  constructor(
    private sqlite3: Db,
    private db: Db,
  ) {
    // Rebuilding tables requires foreign keys off, so enable them only afterwards.
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

  /** The whole database as a SQLite file's bytes: a consistent snapshot (nothing else runs in between: one request at a time). */
  exportDatabase(): Uint8Array {
    return this.sqlite3.capi.sqlite3_js_db_export(this.db.pointer);
  }

  /**
   * Replaces everything in this database (the same file) with that of a backup file (`exportDatabase`'s).
   * Checked and migrated apart first, in memory (`openBackup`), so a refused file leaves this database
   * untouched (`dryRun` stops there); then copied in with one transaction, which a failure rolls back.
   * What the device remembers of its server (cursor, database id, outbox) is not carried over: the
   * backup is data, and sync starts afresh (docs/sync.md "Restoring a backup").
   */
  importDatabase(bytes: Uint8Array, dryRun = false, plan: SchemaPlan = CURRENT) {
    const backup = openBackup(this.sqlite3, bytes, plan);
    try {
      if (dryRun) return;
      // This device keeps its own identity.
      const own = this.db.selectValue("SELECT value FROM meta WHERE key = 'replica_id'");
      if (own !== undefined && own !== null) backup.exec({ sql: "INSERT OR REPLACE INTO meta (key, value) VALUES ('replica_id', ?1)", bind: [own] });
      const migrated: Uint8Array = this.sqlite3.capi.sqlite3_js_db_export(backup.pointer);
      this.db.exec("PRAGMA foreign_keys = OFF");
      try {
        replaceWithAttached(this.sqlite3, this.db, migrated);
      } finally {
        this.db.exec("PRAGMA foreign_keys = ON");
      }
    } finally {
      backup.close();
    }
  }

  /** Every table dropped and the schema created afresh, in the same database (file). */
  wipe() {
    this.db.exec("PRAGMA foreign_keys = OFF");
    try {
      createAfresh(this.db, CURRENT);
    } finally {
      this.db.exec("PRAGMA foreign_keys = ON");
    }
  }
}

/** What a database is brought to: the schema of a new one, and the migrations of an older one. */
export interface SchemaPlan {
  schema: string;
  /** Made afresh after migrating (they follow shared/sync.ts, not a migration). */
  triggers: string;
  migrations: Migration[];
}

const CURRENT: SchemaPlan = { schema, triggers: outboxTriggerSql, migrations: MIGRATIONS };

/** The newest version: the last migration's, or 1 (schema-v1.sql) before there is any. */
export const latestVersion = (plan: SchemaPlan) => plan.migrations.at(-1)?.version ?? 1;

/** Version numbers are below this; anything else in user_version is a pre-release schema's hash. */
const MAX_VERSION = 1_000_000;

/**
 * Brings the database to the newest schema (PRAGMA user_version is its version): a new one is
 * made from the schema, an older one migrated (migrations.ts), keeping its data. One from a newer
 * version of the app is not touched: opening it fails, so the data waits for the app's update.
 * One from before the first release (a hash of its schema in user_version) starts afresh, as
 * pre-release versions did. Foreign keys must be off (the engine turns them on afterwards).
 */
export function ensureSchema(db: Db, plan: SchemaPlan = CURRENT) {
  db.createFunction("file_ids", (_ctx: number, file: unknown, text: unknown) => fileIds(file, text), { arity: 2, deterministic: true });
  db.createFunction(
    "link_targets",
    (_ctx: number, kind: unknown, target: unknown, text: unknown, ref: unknown, json: unknown) => linkTargetsFn(kind, target, text, ref, json),
    { arity: 5, deterministic: true },
  );
  const latest = latestVersion(plan);
  const version = Number(db.selectValue("PRAGMA user_version"));
  if (version === latest) return;
  if (version > latest && version < MAX_VERSION) {
    throw new Error(`This database was made by a newer version of Kubus (schema ${version}, this one knows ${latest}): update the app`);
  }
  if (version < 1 || version >= MAX_VERSION) createAfresh(db, plan);
  else migrate(db, version, plan);
}

/** Every table dropped (their indexes and triggers go with them), the schema created. */
function createAfresh(db: Db, plan: SchemaPlan) {
  db.transaction(() => {
    const tables: string[] = db.selectValues("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'");
    for (const t of tables) db.exec(`DROP TABLE "${t}"`);
    db.exec(plan.schema);
    db.exec(`PRAGMA user_version = ${latestVersion(plan)}`);
  });
}

const foreignKeyProblems = (db: Db): number => db.selectValues("PRAGMA foreign_key_check").length;

/** The migrations after `version`, in one transaction, without queueing their changes for sync. */
function migrate(db: Db, version: number, plan: SchemaPlan) {
  db.transaction(() => {
    const problems = foreignKeyProblems(db);
    db.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('sync_applying', '1')");
    for (const m of plan.migrations) {
      if (m.version <= version) continue;
      try {
        if (typeof m.up === "string") db.exec(m.up);
        else m.up(db);
      } catch (e) {
        throw new Error(`Updating the database failed (migration ${m.version}, ${m.description}): ${errorMessage(e)}`);
      }
    }
    const triggers: string[] = db.selectValues("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'sync\\_%' ESCAPE '\\'");
    for (const t of triggers) db.exec(`DROP TRIGGER "${t}"`);
    if (plan.triggers) db.exec(plan.triggers);
    db.exec("DELETE FROM meta WHERE key = 'sync_applying'");
    if (foreignKeyProblems(db) > problems) throw new Error("Updating the database failed: a migration broke references between rows");
    db.exec(`PRAGMA user_version = ${latestVersion(plan)}`);
  });
}

/** SQLite database files begin with these 16 bytes. */
const HEADER = "SQLite format 3\0";

/** Why a file can't be restored, in words for the person who picked it. */
export class BackupRefused extends Error {}

/** `bytes` (a SQLite file) made the content of schema `name` of `db`, a copy in memory. */
export function loadBytes(sqlite3: Db, db: Db, bytes: Uint8Array, name = "main") {
  const pointer = sqlite3.wasm.allocFromTypedArray(bytes);
  const flags = sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE | sqlite3.capi.SQLITE_DESERIALIZE_RESIZEABLE;
  db.checkRc(sqlite3.capi.sqlite3_deserialize(db.pointer, name, pointer, bytes.length, bytes.length, flags));
}

/** Tables every Kubus database has; a file without them is another application's. */
const KUBUS_TABLES = ["meta", "collections", "fields", "items", "views", "components", "spaces"];

/**
 * A backup file opened in memory, checked and brought to the newest schema (migrated like any
 * older database), with the sync state of the device that made it cleared. Throws `BackupRefused`
 * for a file that isn't SQLite, isn't Kubus's, is damaged, or was made by a newer version of the app.
 * The caller closes the result.
 */
export function openBackup(sqlite3: Db, bytes: Uint8Array, plan: SchemaPlan = CURRENT): Db {
  if (bytes.length < 100 || String.fromCharCode(...bytes.subarray(0, HEADER.length)) !== HEADER) {
    throw new BackupRefused("This file is not a SQLite database, so it is not a Kubus backup.");
  }
  const db: Db = new sqlite3.oo1.DB(":memory:", "c");
  try {
    let tables: string[];
    try {
      loadBytes(sqlite3, db, bytes);
      tables = db.selectValues("SELECT name FROM sqlite_master WHERE type = 'table'");
    } catch {
      throw new BackupRefused("This file is damaged: SQLite can't read it.");
    }
    if (!KUBUS_TABLES.every((t) => tables.includes(t))) throw new BackupRefused("This is a SQLite database, but not a Kubus backup.");
    const version = Number(db.selectValue("PRAGMA user_version"));
    const latest = latestVersion(plan);
    if (version > latest && version < MAX_VERSION) {
      throw new BackupRefused(`This backup was made by a newer version of Kubus (schema ${version}; this one knows ${latest}). Update the app, then restore it.`);
    }
    if (version < 1 || version >= MAX_VERSION) throw new BackupRefused("This backup was made before Kubus counted its schema versions, so it can't be restored.");
    if (db.selectValue("PRAGMA quick_check") !== "ok") throw new BackupRefused("This file is damaged: its integrity check failed.");
    ensureSchema(db, plan);
    db.exec("DELETE FROM sync_outbox; DELETE FROM meta WHERE key IN ('sync_server', 'sync_cursor', 'sync_database', 'sync_applying')");
    return db;
  } catch (e) {
    db.close();
    throw e;
  }
}

/**
 * Makes `db` (foreign keys off) hold what the SQLite file `bytes` holds, schema and rows alike, in
 * one transaction: the file is loaded as an attached in-memory database and copied table by table
 * (the tables first, then the indexes and triggers, so no trigger fires on the copy and nothing is
 * queued for sync).
 */
function replaceWithAttached(sqlite3: Db, db: Db, bytes: Uint8Array) {
  db.exec("ATTACH DATABASE ':memory:' AS backup");
  try {
    loadBytes(sqlite3, db, bytes, "backup");
    db.transaction(() => {
      const own: string[] = db.selectValues("SELECT name FROM main.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'");
      for (const t of own) db.exec(`DROP TABLE main."${t}"`);
      const defined = (type: string): string[] =>
        db.selectValues(`SELECT sql FROM backup.sqlite_master WHERE type = '${type}' AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%'`);
      for (const sql of defined("table")) db.exec(sql);
      const tables: string[] = db.selectValues("SELECT name FROM main.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'");
      for (const t of tables) db.exec(`INSERT INTO main."${t}" SELECT * FROM backup."${t}"`);
      if (db.selectValue("SELECT count(*) FROM backup.sqlite_master WHERE name = 'sqlite_sequence'")) {
        db.exec("DELETE FROM main.sqlite_sequence; INSERT INTO main.sqlite_sequence SELECT * FROM backup.sqlite_sequence");
      }
      for (const sql of [...defined("index"), ...defined("trigger")]) db.exec(sql);
      db.exec(`PRAGMA main.user_version = ${Number(db.selectValue("PRAGMA backup.user_version"))}`);
    });
  } finally {
    db.exec("DETACH DATABASE backup");
  }
}
