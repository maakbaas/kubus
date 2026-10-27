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
//   DELETE /api/files/<id> a device let go of it (unused long enough)

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

/**
 * Deletes a file's bytes: a device found it unused for long enough (devices decide, docs/sync.md,
 * "Files"). Its `files` row stays, as on the devices that haven't let go of it yet.
 */
export async function deleteFile(pool: pg.Pool, id: string): Promise<void> {
  await pool.query("DELETE FROM file_bytes WHERE id = $1", [id]);
}

/** The files the pushed values use (of items not deleted) whose bytes the server doesn't have. */
export async function missingFiles(client: pg.PoolClient, changes: WireChanges): Promise<string[]> {
  const deleted = new Set((changes.items ?? []).filter((r) => r.deleted_at !== null).map((r) => String(r.id)));
  const used = filesUsedBy((changes.field_values ?? []).filter((r) => !deleted.has(String(r.item_id))));
  if (used.length === 0) return [];
  const present = await client.query<{ id: string }>("SELECT id FROM file_bytes WHERE id = ANY($1)", [used]);
  const have = new Set(present.rows.map((r) => r.id));
  return used.filter((id) => !have.has(id));
}
