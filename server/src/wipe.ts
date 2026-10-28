import type pg from "pg";
import { migrate } from "./migrations.ts";

// Wiping the server's database (POST /api/wipe, "Wipe server database" in a device's sync
// settings): every table and sequence in its schema is dropped, whatever they are (also when they
// don't match what this server expects), and the schema is created afresh (migrate: a new database
// records every migration as done). One transaction: it
// happens completely or not at all. Everything goes, the server's own settings (server_settings:
// its language model, the sources it reads, their secrets) and API tokens (api_tokens) included.

const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;

export async function wipe(pool: pg.Pool, schemaSql: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const tables = await client.query<{ name: string }>(
      "SELECT tablename AS name FROM pg_tables WHERE schemaname = current_schema()",
    );
    for (const t of tables.rows) await client.query(`DROP TABLE IF EXISTS ${quote(t.name)} CASCADE`);
    const sequences = await client.query<{ name: string }>(
      "SELECT sequence_name AS name FROM information_schema.sequences WHERE sequence_schema = current_schema()",
    );
    for (const s of sequences.rows) await client.query(`DROP SEQUENCE IF EXISTS ${quote(s.name)} CASCADE`);
    await migrate(client, schemaSql);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
