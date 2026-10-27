import type pg from "pg";
import { sha256 } from "./files.ts";
import { SYNC_TABLES, type ColumnType, type DatabaseInfo, type SyncMismatch, type SyncRequest, type SyncResponse, type SyncTable, type WireRow, type WireValue } from "../../shared/sync.ts";

// Server side of the sync protocol (see shared/sync.ts and CLAUDE.md, "Sync").
//
// One request pushes the device's changed rows and pulls everything changed since its cursor.
// Each row that is written gets the next `sync_seq` value, so "seq > cursor" finds exactly what a
// device hasn't seen. The whole request runs under an advisory lock: sequence order is then
// commit order, and a cursor can never skip a row that commits late.
// A pushed row only replaces the stored one when its updated_at is newer (last writer wins).

const LOCK_ID = 7_236_001;

const PG_TYPE: Record<ColumnType, string> = {
  text: "text", number: "double precision", int: "integer", bool: "boolean",
  json: "jsonb", date: "date", timestamp: "timestamptz",
};

function toDb(type: ColumnType, v: WireValue): unknown {
  if (v === null) return null;
  if (type === "bool") return v === 1;
  return v;
}

function fromDb(type: ColumnType, v: unknown): WireValue {
  if (v === null || v === undefined) return null;
  if (type === "bool") return v ? 1 : 0;
  if (type === "json") return JSON.stringify(v);
  return v as WireValue;
}

const upserts = new Map<string, string>();
function upsertSql(t: SyncTable): string {
  let sql = upserts.get(t.name);
  if (sql) return sql;
  const cols = Object.entries(t.columns);
  const values = cols.map(([, type], i) => `$${i + 1}::${PG_TYPE[type]}`);
  sql = `INSERT INTO ${t.name} AS t (${cols.map(([c]) => c).join(", ")}, seq)
         VALUES (${values.join(", ")}, nextval('sync_seq'))
         ON CONFLICT (${t.key.join(", ")}) `;
  if (t.version) {
    const set = cols.filter(([c]) => !t.key.includes(c)).map(([c]) => `${c} = EXCLUDED.${c}`);
    sql += `DO UPDATE SET ${set.join(", ")}, seq = EXCLUDED.seq
            WHERE t.${t.version} IS NULL OR t.${t.version} < EXCLUDED.${t.version}`;
  } else {
    sql += "DO NOTHING";
  }
  upserts.set(t.name, sql);
  return sql;
}

export async function handleSync(pool: pg.Pool, req: SyncRequest): Promise<(SyncResponse & { wrote: boolean }) | { mismatch: SyncMismatch }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [LOCK_ID]);

    // A device that synced with another database (this one was wiped or replaced since) writes
    // nothing: its outbox holds only what changed since then, which would land here as fragments.
    const meta = await client.query<{ key: string; value: string }>("SELECT key, value FROM server_meta");
    const get = (key: string) => meta.rows.find((r) => r.key === key)?.value ?? "";
    const database: DatabaseInfo = { id: get("database_id"), createdAt: get("created_at") };
    if (req.database && req.database !== database.id) {
      const seq = await client.query<{ is_called: boolean }>("SELECT is_called FROM sync_seq");
      await client.query("ROLLBACK");
      return { mismatch: { error: "The server's database was wiped or replaced", database, empty: !seq.rows[0].is_called } };
    }

    let wrote = false;
    for (const t of SYNC_TABLES) {
      for (const row of req.changes[t.name] ?? []) {
        const params = Object.entries(t.columns).map(([c, type]) => toDb(type, row[c] ?? null));
        const result = await client.query(upsertSql(t), params);
        if ((result.rowCount ?? 0) > 0) wrote = true;
        // An app from before /api/files sends a file's bytes in the row (base64): kept as uploaded.
        if (t.name === "files" && typeof row.data === "string") {
          const data = Buffer.from(row.data, "base64");
          if (sha256(data) === row.id) {
            await client.query("INSERT INTO file_bytes (id, mime, data) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING", [
              row.id, row.mime ?? "application/octet-stream", data,
            ]);
          }
        }
      }
    }

    const seq = await client.query<{ last_value: string; is_called: boolean }>("SELECT last_value, is_called FROM sync_seq");
    const cursor = seq.rows[0].is_called ? Number(seq.rows[0].last_value) : 0;
    // A device ahead of the server (the database was reset) starts over.
    const since = req.since > cursor ? 0 : req.since;

    const changes: Record<string, WireRow[]> = {};
    for (const t of SYNC_TABLES) {
      const cols = Object.keys(t.columns);
      const result = await client.query(`SELECT ${cols.join(", ")} FROM ${t.name} WHERE seq > $1 ORDER BY seq`, [since]);
      if (result.rows.length === 0) continue;
      changes[t.name] = result.rows.map((r) => Object.fromEntries(cols.map((c) => [c, fromDb(t.columns[c], r[c])])));
    }
    await client.query("COMMIT");
    return { cursor, changes, database, wrote };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
