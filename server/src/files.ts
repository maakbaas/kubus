import { createHash } from "node:crypto";
import type pg from "pg";
import { filesUsedBy } from "../../shared/files.ts";
import type { WireChanges } from "../../shared/sync.ts";

// File bytes (images), apart from the synced `files` rows that list them (server/schema.sql,
// file_bytes). Content-addressed: a file's id is the SHA-256 of its bytes, so an upload whose
// bytes don't match its id (wrong or cut off) is refused, and a stored file never changes.
//
//   PUT  /api/files/<id>   the bytes, Content-Type = their type; before the row is synced
//   HEAD /api/files/<id>   200 when the server has them (a device skips the upload)
//   GET  /api/files/<id>   the bytes

export const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");

export async function hasFile(pool: pg.Pool, id: string): Promise<boolean> {
  return (await pool.query("SELECT 1 FROM file_bytes WHERE id = $1", [id])).rowCount === 1;
}

export async function getFile(pool: pg.Pool, id: string): Promise<{ mime: string; data: Buffer } | null> {
  const result = await pool.query<{ mime: string; data: Buffer }>("SELECT mime, data FROM file_bytes WHERE id = $1", [id]);
  return result.rows[0] ?? null;
}

/** Stores the bytes under `id`; false when they aren't the bytes `id` names. */
export async function putFile(pool: pg.Pool, id: string, mime: string, data: Buffer): Promise<boolean> {
  if (sha256(data) !== id) return false;
  await pool.query("INSERT INTO file_bytes (id, mime, data) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING", [id, mime, data]);
  return true;
}

// Clean-up of files no item uses any more (docs/sync.md, "Files").
//
// Tracking: every sync request marks the files whose use it removes (an image value replaced, an
// image taken out of Markdown, an item or field deleted): file_bytes.unused_since. A file used
// again is unmarked; a file uploaded before anything uses it starts out marked. These marks are
// only candidates: the headless device, which holds every row, decides with the app's own rule
// (Repository.unusedFiles) before anything is deleted, and only marks older than the grace period
// count (devices sync late and out of order; an undo puts a use back).

/**
 * Inside a sync request, before its rows are written: marks the files the pushed rows stop using,
 * unmarks the ones they use, and returns the used ones whose bytes the server doesn't have.
 */
export async function trackUses(client: pg.PoolClient, changes: WireChanges): Promise<string[]> {
  const values = changes.field_values ?? [];
  const deletedItems = (changes.items ?? []).filter((r) => r.deleted_at !== null).map((r) => String(r.id));
  const deletedFields = (changes.fields ?? []).filter((r) => r.deleted_at !== null).map((r) => String(r.id));
  const before = await client.query<{ value_file: string | null; value_text: string | null }>(
    `SELECT value_file, value_text FROM field_values
      WHERE (value_file IS NOT NULL OR value_text LIKE '%files/%')
        AND ((item_id, field_id) IN (SELECT * FROM unnest($1::text[], $2::text[])) OR item_id = ANY($3) OR field_id = ANY($4))`,
    [values.map((r) => String(r.item_id)), values.map((r) => String(r.field_id)), deletedItems, deletedFields],
  );
  const gone = new Set(deletedItems);
  const live = values.filter((r) => !gone.has(String(r.item_id)));
  const used = filesUsedBy(live);
  const freed = filesUsedBy(before.rows).filter((id) => !used.includes(id));
  // A thumbnail goes with its original.
  const withThumbnails = "id = ANY($1) OR id IN (SELECT thumb_id FROM thumbnails WHERE file_id = ANY($1))";
  if (freed.length > 0) await client.query(`UPDATE file_bytes SET unused_since = now() WHERE unused_since IS NULL AND (${withThumbnails})`, [freed]);
  if (used.length === 0) return [];
  await client.query(`UPDATE file_bytes SET unused_since = NULL WHERE unused_since IS NOT NULL AND (${withThumbnails})`, [used]);
  const present = await client.query<{ id: string }>("SELECT id FROM file_bytes WHERE id = ANY($1)", [used]);
  const have = new Set(present.rows.map((r) => r.id));
  return used.filter((id) => !have.has(id));
}

/** Files marked unused since before `cutoff`. */
export async function markedFiles(pool: pg.Pool, cutoff: Date): Promise<string[]> {
  const result = await pool.query<{ id: string }>("SELECT id FROM file_bytes WHERE unused_since < $1", [cutoff]);
  return result.rows.map((r) => r.id);
}

/** Clears the marks of files found in use after all. */
export async function unmarkFiles(pool: pg.Pool, ids: string[]): Promise<void> {
  if (ids.length > 0) await pool.query("UPDATE file_bytes SET unused_since = NULL WHERE id = ANY($1)", [ids]);
}

/**
 * Deletes files (bytes, row and thumbnail link) that are still marked since before `cutoff`, under
 * the sync lock: a request that uses one again meanwhile has unmarked it. Returns the deleted ids.
 */
export async function deleteUnusedFiles(pool: pg.Pool, ids: string[], cutoff: Date, lockId: number): Promise<string[]> {
  if (ids.length === 0) return [];
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [lockId]);
    const deleted = await client.query<{ id: string }>("DELETE FROM file_bytes WHERE id = ANY($1) AND unused_since < $2 RETURNING id", [ids, cutoff]);
    const gone = deleted.rows.map((r) => r.id);
    await client.query("DELETE FROM files WHERE id = ANY($1)", [gone]);
    await client.query("DELETE FROM thumbnails WHERE file_id = ANY($1)", [gone]);
    await client.query("COMMIT");
    return gone;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
