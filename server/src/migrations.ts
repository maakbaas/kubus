import type pg from "pg";
import { PG_TYPE } from "./schema.ts";
import { SYNC_TABLES } from "../../shared/sync.ts";

// The server database's migrations: what changes its stored tables beyond adding a table or a
// column (which the schema does by itself: server/src/schema.ts). A rename, another type, values
// converted for a new format (with SYNC_COMPATIBLE raised in shared/sync.ts: each side converts its
// own copy, the devices theirs in app/src/data/migrations.ts) or a change to the server's own
// tables (schema.sql). See docs/migrations.md.
//
// At every start (and after a wipe), in one transaction: the migrations this database hasn't had
// run in order (recorded in schema_migrations), then the schema is applied (idempotent), then the
// synced columns' types are checked. A new database runs none: the schema is already the newest,
// so they're only recorded. Migrations are never edited or removed once released; a database
// migrated by a newer server isn't touched (the server then refuses to sync until it is updated).

export interface ServerMigration {
  /** 1, 2, 3, … in order, never reused. */
  version: number;
  /** What it changes, for people (kept in schema_migrations). */
  description: string;
  /** SQL, or code for what SQL can't say; runs inside the start's transaction. */
  up: string | ((client: pg.PoolClient) => Promise<void>);
}

export const MIGRATIONS: ServerMigration[] = [
  {
    version: 1,
    description: "API tokens (api_tokens)",
    up: `CREATE TABLE IF NOT EXISTS api_tokens (
      id             text NOT NULL,
      name           text NOT NULL,
      access         text NOT NULL,
      token_sha256   text NOT NULL UNIQUE,
      created_at     timestamptz NOT NULL DEFAULT now(),
      last_used_at   timestamptz,
      PRIMARY KEY (id)
    )`,
  },
];

/** Serializes servers starting on the same database. */
const LOCK_ID = 7_236_002;

/**
 * Brings the database to this server's schema; inside a transaction (`client` has begun one).
 * Throws when the database is newer than this server or its columns don't fit the schema.
 */
export async function migrate(client: pg.PoolClient, schemaSql: string, migrations: ServerMigration[] = MIGRATIONS): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock($1)", [LOCK_ID]);
  const fresh = (await client.query<{ fresh: boolean }>("SELECT to_regclass('server_meta') IS NULL AS fresh")).rows[0].fresh;
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version     integer NOT NULL PRIMARY KEY,
    description text NOT NULL,
    applied_at  timestamptz NOT NULL DEFAULT now()
  )`);
  const applied = new Set((await client.query<{ version: number }>("SELECT version FROM schema_migrations")).rows.map((r) => r.version));
  const known = new Set(migrations.map((m) => m.version));
  const unknown = [...applied].filter((v) => !known.has(v));
  if (unknown.length > 0) {
    throw new Error(`The database was migrated by a newer Kubus server (migration ${Math.max(...unknown)}): run that version or a newer one`);
  }
  for (const m of migrations) {
    if (applied.has(m.version)) continue;
    if (!fresh) {
      if (typeof m.up === "string") await client.query(m.up);
      else await m.up(client);
    }
    await client.query("INSERT INTO schema_migrations (version, description) VALUES ($1, $2)", [m.version, m.description]);
  }
  await client.query(schemaSql);
  await checkColumns(client);
}

/** Runs `migrate` in a transaction of its own (the server's start). */
export async function applySchema(pool: pg.Pool, schemaSql: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await migrate(client, schemaSql);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Every synced column has its type (the schema adds missing columns, it doesn't change one). */
async function checkColumns(client: pg.PoolClient) {
  const expected = await client.query<{ name: string; type: string }>(
    "SELECT name, name::regtype::text AS type FROM unnest($1::text[]) AS name",
    [[...new Set(Object.values(PG_TYPE))]],
  );
  const typeName = new Map(expected.rows.map((r) => [r.name, r.type]));
  const actual = await client.query<{ tbl: string; col: string; type: string }>(
    `SELECT c.relname AS tbl, a.attname AS col, format_type(a.atttypid, a.atttypmod) AS type
       FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
      WHERE c.oid = ANY($1::regclass[]) AND a.attnum > 0 AND NOT a.attisdropped`,
    [SYNC_TABLES.map((t) => t.name)],
  );
  const wrong: string[] = [];
  for (const t of SYNC_TABLES) {
    for (const [c, type] of Object.entries(t.columns)) {
      const found = actual.rows.find((r) => r.tbl === t.name && r.col === c)?.type;
      const want = typeName.get(PG_TYPE[type]);
      if (found !== want) wrong.push(`${t.name}.${c} is ${found}, not ${want}`);
    }
  }
  if (wrong.length > 0) throw new Error(`${wrong.join("; ")}: a changed column needs a migration (server/src/migrations.ts)`);
}
