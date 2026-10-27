import { createHash } from "node:crypto";
import type pg from "pg";
import { fileInUse, filesUsedBy } from "../../shared/files.ts";
import type { WireChanges, WireRow } from "../../shared/sync.ts";

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

// Clean-up of files no item uses any more (docs/sync.md, "Files"), inside sync requests: no timer.
//
// Each request keeps file_uses for the values it writes (as a device's triggers do) and then, for
// the files whose uses it changed (values replaced, items and fields deleted or restored), sets
// file_bytes.unused_since when no live item uses them any more and clears it when one does. A file
// uploaded before anything uses it starts out marked. Every request also deletes the files marked
// for longer than the grace period and still unused: devices sync late and out of order, and an
// undo on a device that released a file fetches it from here again.

/** The rows a sync request wrote, by table: their keys (JSON arrays of the key values). */
export type Written = Map<string, Set<string>>;

const rowKey = (row: WireRow, key: string[]) => JSON.stringify(key.map((k) => row[k] ?? null));

/**
 * After a sync request's rows are written: brings file_uses and the files' marks up to date, and
 * returns the files the pushed rows use whose bytes the server doesn't have.
 */
export async function trackUses(client: pg.PoolClient, changes: WireChanges, written: Written): Promise<string[]> {
  const values = (changes.field_values ?? []).filter((r) => written.get("field_values")?.has(rowKey(r, ["item_id", "field_id"])));
  const items = (changes.items ?? []).filter((r) => written.get("items")?.has(rowKey(r, ["id"]))).map((r) => String(r.id));
  const fields = (changes.fields ?? []).filter((r) => written.get("fields")?.has(rowKey(r, ["id"]))).map((r) => String(r.id));

  const touched = new Set<string>();
  if (values.length > 0) {
    const old = await client.query<{ file_id: string }>(
      "DELETE FROM file_uses WHERE (item_id, field_id) IN (SELECT * FROM unnest($1::text[], $2::text[])) RETURNING file_id",
      [values.map((r) => String(r.item_id)), values.map((r) => String(r.field_id))],
    );
    old.rows.forEach((r) => touched.add(r.file_id));
    const uses = values.flatMap((r) => filesUsedBy([r]).map((file) => [file, String(r.item_id), String(r.field_id)]));
    if (uses.length > 0) {
      await client.query("INSERT INTO file_uses SELECT * FROM unnest($1::text[], $2::text[], $3::text[]) ON CONFLICT DO NOTHING", [
        uses.map((u) => u[0]), uses.map((u) => u[1]), uses.map((u) => u[2]),
      ]);
      uses.forEach((u) => touched.add(u[0]));
    }
  }
  if (items.length + fields.length > 0) {
    const through = await client.query<{ file_id: string }>("SELECT DISTINCT file_id FROM file_uses WHERE item_id = ANY($1) OR field_id = ANY($2)", [items, fields]);
    through.rows.forEach((r) => touched.add(r.file_id));
  }
  if (touched.size > 0) {
    // A thumbnail goes with its original.
    await client.query(
      `UPDATE file_bytes SET unused_since = CASE WHEN ${fileInUse("file_bytes.id")} THEN NULL ELSE coalesce(unused_since, now()) END
        WHERE id = ANY($1) OR id IN (SELECT thumb_id FROM thumbnails WHERE file_id = ANY($1))`,
      [[...touched]],
    );
  }

  // What the pushed values use (written or not) that the server has no bytes for.
  const deleted = new Set((changes.items ?? []).filter((r) => r.deleted_at !== null).map((r) => String(r.id)));
  const used = filesUsedBy((changes.field_values ?? []).filter((r) => !deleted.has(String(r.item_id))));
  if (used.length === 0) return [];
  const present = await client.query<{ id: string }>("SELECT id FROM file_bytes WHERE id = ANY($1)", [used]);
  const have = new Set(present.rows.map((r) => r.id));
  return used.filter((id) => !have.has(id));
}

/**
 * Deletes the files (bytes, row, thumbnail link) unused since before `cutoff`, inside a sync
 * request. One in use after all (uploaded after the request that used it) only loses its mark.
 */
export async function sweepFiles(client: pg.PoolClient, cutoff: Date): Promise<void> {
  await client.query(`UPDATE file_bytes SET unused_since = NULL WHERE unused_since < $1 AND ${fileInUse("file_bytes.id")}`, [cutoff]);
  const deleted = await client.query<{ id: string }>("DELETE FROM file_bytes WHERE unused_since < $1 RETURNING id", [cutoff]);
  const gone = deleted.rows.map((r) => r.id);
  if (gone.length === 0) return;
  await client.query("DELETE FROM files WHERE id = ANY($1)", [gone]);
  await client.query("DELETE FROM thumbnails WHERE file_id = ANY($1)", [gone]);
}

/** Fills file_uses from the stored values when it is empty (a server from before it). */
export async function fillFileUses(pool: pg.Pool): Promise<void> {
  if ((await pool.query("SELECT 1 FROM file_uses LIMIT 1")).rowCount) return;
  const rows = await pool.query<{ item_id: string; field_id: string; value_file: string | null; value_text: string | null }>(
    "SELECT item_id, field_id, value_file, value_text FROM field_values WHERE value_file IS NOT NULL OR value_text LIKE '%files/%'",
  );
  const uses = rows.rows.flatMap((r) => filesUsedBy([r]).map((file) => [file, r.item_id, r.field_id]));
  if (uses.length === 0) return;
  await pool.query("INSERT INTO file_uses SELECT * FROM unnest($1::text[], $2::text[], $3::text[]) ON CONFLICT DO NOTHING", [
    uses.map((u) => u[0]), uses.map((u) => u[1]), uses.map((u) => u[2]),
  ]);
}
