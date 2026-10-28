// @vitest-environment node
// The server's migrations and its side of syncing between versions, against a real database
// (KUBUS_TEST_POSTGRES: ./postgres.ts).
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate, MIGRATIONS, type ServerMigration } from "../src/migrations.ts";
import { loadSchema } from "../src/schema.ts";
import { handleSync } from "../src/sync.ts";
import { wipe } from "../src/wipe.ts";
import { ADMIN, createDatabase, dropDatabase } from "./postgres.ts";
import { SYNC_VERSION, type SyncRequest, type WireRow } from "../../shared/sync.ts";

const DB = "kubus_migrations_test";

describe.skipIf(!ADMIN)("the server's database", () => {
  let pool: pg.Pool;
  let schemaSql: string;

  /** Runs migrate (with these migrations) in a transaction, as the server's start does. */
  async function start(migrations: ServerMigration[] = []) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await migrate(client, schemaSql, migrations);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }
  const applied = async () => (await pool.query<{ version: number }>("SELECT version FROM schema_migrations ORDER BY version")).rows.map((r) => r.version);
  const sync = (changes: Record<string, WireRow[]>, over: Partial<SyncRequest> = {}) =>
    handleSync(pool, { since: 0, changes, version: SYNC_VERSION, compatible: SYNC_VERSION, ...over });

  beforeAll(async () => {
    schemaSql = await loadSchema();
    pool = new pg.Pool({ connectionString: await createDatabase(DB) });
  });

  afterAll(async () => {
    await pool?.end();
    await dropDatabase(DB);
  });

  beforeEach(async () => {
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
  });

  const failing: ServerMigration = { version: 1, description: "would fail if run", up: "SELECT 1 / 0" };

  it("makes a new database at the newest version: its migrations recorded, not run", async () => {
    await start([failing]);
    expect(await applied()).toEqual([1]);
    expect((await pool.query("SELECT count(*)::int AS n FROM server_meta")).rows).toEqual([{ n: 2 }]);
  });

  it("migrates a database made before migrations, once, then applies the schema", async () => {
    await pool.query(schemaSql); // as servers before migrations left it
    await pool.query("INSERT INTO spaces (id, name, position) VALUES ('s1', 'Work', 0)");
    const rename: ServerMigration = { version: 1, description: "a rename", up: "ALTER TABLE spaces RENAME COLUMN name TO title" };
    const back: ServerMigration = { version: 2, description: "and back", up: "ALTER TABLE spaces RENAME COLUMN title TO name; UPDATE spaces SET name = name || '!'" };
    await start([rename, back]);
    await start([rename, back]);
    expect(await applied()).toEqual([1, 2]);
    expect((await pool.query("SELECT name FROM spaces")).rows).toEqual([{ name: "Work!" }]);
  });

  it("leaves the database as it was when a migration fails", async () => {
    await pool.query(schemaSql);
    await pool.query("INSERT INTO spaces (id, name, position) VALUES ('s1', 'Work', 0)");
    await expect(start([{ version: 1, description: "drops", up: "DELETE FROM spaces" }, { ...failing, version: 2 }])).rejects.toThrow(/division by zero/);
    expect((await pool.query("SELECT name FROM spaces")).rows).toEqual([{ name: "Work" }]);
    expect((await pool.query("SELECT to_regclass('schema_migrations') AS t")).rows).toEqual([{ t: null }]);
  });

  it("doesn't touch a database migrated by a newer server", async () => {
    await start([failing]);
    await expect(start([])).rejects.toThrow(/newer Kubus server/);
  });

  it("adds a synced column it doesn't have, and refuses one of another type", async () => {
    await start();
    await pool.query("ALTER TABLE spaces DROP COLUMN icon");
    await start();
    expect((await pool.query("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'spaces' AND column_name = 'icon'")).rows).toEqual([{ n: 1 }]);
    await pool.query("ALTER TABLE spaces ALTER COLUMN position TYPE text");
    await expect(start()).rejects.toThrow(/spaces.position is text, not integer/);
  });

  it("keeps a column an older device's row leaves out, and refuses devices of incompatible versions", async () => {
    await start();
    const row = { id: "s1", name: "Work", icon: "Briefcase", position: 0, created_at: "2026-10-01T00:00:00.000Z", updated_at: "2026-10-01T00:00:00.000Z", deleted_at: null };
    await sync({ spaces: [row] });
    const { icon: _, ...older } = { ...row, name: "Office", updated_at: "2026-10-02T00:00:00.000Z" };
    await sync({ spaces: [older] });
    expect((await pool.query("SELECT name, icon FROM spaces")).rows).toEqual([{ name: "Office", icon: "Briefcase" }]);

    expect(await sync({ spaces: [{ ...row, name: "Old" }] }, { version: 0, compatible: 0 })).toMatchObject({ outdated: { update: "app" } });
    expect(await sync({}, { compatible: SYNC_VERSION + 1 })).toMatchObject({ outdated: { update: "server" } });
    expect(await sync({ spaces: [{ ...row, color: "teal" }] })).toMatchObject({ outdated: { update: "server" } });
    expect((await pool.query("SELECT name FROM spaces")).rows).toEqual([{ name: "Office" }]);
  });

  it("records every migration again after a wipe, dropping the server's settings and API tokens", async () => {
    await pool.query(schemaSql);
    await pool.query("INSERT INTO api_tokens (id, name, access, token_sha256) VALUES ('t1', 'Scripts', 'read', 'abc')");
    await pool.query(`INSERT INTO server_settings (key, value) VALUES ('ai', '{}')`);
    await wipe(pool, schemaSql);
    expect(await applied()).toEqual(MIGRATIONS.map((m) => m.version));
    expect((await pool.query("SELECT count(*)::int AS n FROM server_meta")).rows).toEqual([{ n: 2 }]);
    expect((await pool.query("SELECT id FROM api_tokens")).rows).toEqual([]);
    expect((await pool.query("SELECT key FROM server_settings")).rows).toEqual([]);
  });
});
