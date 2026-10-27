import type pg from "pg";
import { sha256, sweepFiles, trackUses, type Written } from "./files.ts";
import { PG_TYPE } from "./schema.ts";
import { SYNC_TABLES, type ColumnType, type DatabaseInfo, type SyncMismatch, type SyncRequest, type SyncResponse, type SyncTable, type WireRow, type WireValue } from "../../shared/sync.ts";

// Server side of the sync protocol (see shared/sync.ts and CLAUDE.md, "Sync").
//
// One request pushes the device's changed rows (a statement per table and BATCH rows) and pulls
// everything else changed since its cursor (not the rows it pushed: the device has them).
// Each row that is written gets the next `sync_seq` value, so "seq > cursor" finds exactly what a
// device hasn't seen. The whole request runs under an advisory lock: sequence order is then
// commit order, and a cursor can never skip a row that commits late.
// A pushed row only replaces the stored one when its updated_at is newer (last writer wins).

/** Serializes sync requests. */
export const LOCK_ID = 7_236_001;

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

/** Rows per upsert statement. */
const BATCH = 1000;

const upserts = new Map<string, string>();
/**
 * One statement that upserts a batch of rows, given as a JSON array ($1) of objects with every
 * column as text (cast to its type here: a JSON value as text is how a device sends it). Returns
 * the keys of the rows it wrote.
 */
function upsertSql(t: SyncTable): string {
  let sql = upserts.get(t.name);
  if (sql) return sql;
  const cols = Object.entries(t.columns);
  sql = `INSERT INTO ${t.name} AS t (${cols.map(([c]) => c).join(", ")}, seq)
         SELECT ${cols.map(([c, type]) => `r.${c}::${PG_TYPE[type]}`).join(", ")}, nextval('sync_seq')
           FROM jsonb_to_recordset($1::jsonb) AS r(${cols.map(([c]) => `${c} text`).join(", ")})
         ON CONFLICT (${t.key.join(", ")}) `;
  if (t.version) {
    const set = cols.filter(([c]) => !t.key.includes(c)).map(([c]) => `${c} = EXCLUDED.${c}`);
    sql += `DO UPDATE SET ${set.join(", ")}, seq = EXCLUDED.seq
            WHERE t.${t.version} IS NULL OR t.${t.version} < EXCLUDED.${t.version}`;
  } else {
    sql += "DO NOTHING";
  }
  sql += ` RETURNING ${t.key.join(", ")}`;
  upserts.set(t.name, sql);
  return sql;
}

/** A pushed row as the upsert takes it: every column as text (or null), keyed by name. */
function toRecord(t: SyncTable, row: WireRow): Record<string, string | null> {
  return Object.fromEntries(
    Object.entries(t.columns).map(([c, type]) => {
      const v = toDb(type, row[c] ?? null);
      return [c, v === null ? null : String(v)];
    }),
  );
}

/** The pushed rows of a table, one per key (an upsert can't touch a row twice): the last one sent. */
function unique(t: SyncTable, rows: WireRow[]): WireRow[] {
  const byKey = new Map<string, WireRow>();
  for (const row of rows) byKey.set(JSON.stringify(t.key.map((k) => row[k] ?? null)), row);
  return [...byKey.values()];
}

/** The server's latest sequence number (0: nothing written since the database was made). */
export async function currentCursor(client: pg.Pool | pg.PoolClient): Promise<number> {
  const seq = await client.query<{ last_value: string; is_called: boolean }>("SELECT last_value, is_called FROM sync_seq");
  return seq.rows[0].is_called ? Number(seq.rows[0].last_value) : 0;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** `unusedFileDays`: how long a file no item uses is kept (devices sync late; an undo brings it back). */
export async function handleSync(
  pool: pg.Pool,
  req: SyncRequest,
  { unusedFileDays }: { unusedFileDays: number },
): Promise<(SyncResponse & { wrote: boolean }) | { mismatch: SyncMismatch }> {
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

    // Everything below `before` is someone else's; what this request writes comes after it (the
    // lock keeps other requests from taking sequence numbers meanwhile).
    const before = await currentCursor(client);
    const written: Written = new Map();
    for (const t of SYNC_TABLES) {
      const rows = unique(t, req.changes[t.name] ?? []);
      const keys = new Set<string>();
      for (let i = 0; i < rows.length; i += BATCH) {
        const batch = rows.slice(i, i + BATCH).map((row) => toRecord(t, row));
        const result = await client.query<Record<string, WireValue>>(upsertSql(t), [JSON.stringify(batch)]);
        for (const r of result.rows) keys.add(JSON.stringify(t.key.map((k) => r[k])));
      }
      written.set(t.name, keys);
      // An app from before /api/files sends a file's bytes in the row (base64): kept as uploaded.
      if (t.name === "files") {
        for (const row of rows) {
          if (typeof row.data !== "string") continue;
          const data = Buffer.from(row.data, "base64");
          if (sha256(data) === row.id) {
            await client.query("INSERT INTO file_bytes (id, mime, data) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING", [
              row.id, row.mime ?? "application/octet-stream", data,
            ]);
          }
        }
      }
    }

    const wrote = [...written.values()].some((keys) => keys.size > 0);
    const missingFiles = await trackUses(client, req.changes, written);
    await sweepFiles(client, new Date(Date.now() - unusedFileDays * DAY_MS));

    const cursor = await currentCursor(client);
    // A device ahead of the server (the database was reset) starts over.
    const since = req.since > cursor ? 0 : req.since;

    // What changed after `since`, but for the rows this request wrote (after `before`): the device
    // has them, and the cursor covers them.
    const changes: Record<string, WireRow[]> = {};
    for (const t of SYNC_TABLES) {
      const cols = Object.keys(t.columns);
      const result = await client.query(`SELECT ${cols.join(", ")} FROM ${t.name} WHERE seq > $1 AND seq <= $2 ORDER BY seq`, [since, before]);
      if (result.rows.length === 0) continue;
      changes[t.name] = result.rows.map((r) => Object.fromEntries(cols.map((c) => [c, fromDb(t.columns[c], r[c])])));
    }
    await client.query("COMMIT");
    return { cursor, changes, database, wrote, ...(missingFiles.length > 0 && { missingFiles }) };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
