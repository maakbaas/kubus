// The SQLite database itself, independent of where it lives: the schema (created, or migrated
// from an older version's), reads, atomic writes and wiping. The browser runs it in a worker over OPFS
// (worker.ts); the server's headless device runs it in-process, in memory (direct.ts).

import { MIGRATIONS, type Db, type Migration } from "../migrations";
import { fileIds, outboxTriggerSql, schema } from "../schema";
import type { Bind, Statement } from "./protocol";

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

/**
 * PRAGMA user_version of a database made before versions were counted: a hash of the schema it was
 * made with. This one is the hash of the first release's schema (schema-v1.sql), i.e. version 1.
 */
export const FIRST_RELEASE_HASH = -1610800982;
/** Version numbers are below this; anything else in user_version is a pre-release schema's hash. */
const MAX_VERSION = 1_000_000;

/**
 * Brings the database to the newest schema (PRAGMA user_version is its version): a new one is
 * made from the schema, an older one migrated (migrations.ts), keeping its data. One from a newer
 * version of the app is not touched: opening it fails, so the data waits for the app's update.
 * One from before the first release with another schema (a hash in user_version) starts afresh,
 * as pre-release versions did. Foreign keys must be off (the engine turns them on afterwards).
 */
export function ensureSchema(db: Db, plan: SchemaPlan = CURRENT) {
  db.createFunction("file_ids", (_ctx: number, file: unknown, text: unknown) => fileIds(file, text), { arity: 2, deterministic: true });
  const latest = latestVersion(plan);
  let version = Number(db.selectValue("PRAGMA user_version"));
  if (version === latest) return;
  if (version === FIRST_RELEASE_HASH) version = 1;
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
        throw new Error(`Updating the database failed (migration ${m.version}, ${m.description}): ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const triggers: string[] = db.selectValues("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'sync\\_%' ESCAPE '\\'");
    for (const t of triggers) db.exec(`DROP TRIGGER "${t}"`);
    db.exec(plan.triggers);
    db.exec("DELETE FROM meta WHERE key = 'sync_applying'");
    if (foreignKeyProblems(db) > problems) throw new Error("Updating the database failed: a migration broke references between rows");
    db.exec(`PRAGMA user_version = ${latestVersion(plan)}`);
  });
}
