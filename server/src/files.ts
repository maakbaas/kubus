import { createHash } from "node:crypto";
import type pg from "pg";

// File bytes (images), apart from the synced `files` rows that list them (server/schema.sql,
// file_bytes). Content-addressed: a file's id is the SHA-256 of its bytes, so an upload whose
// bytes don't match its id (wrong or cut off) is refused, and a stored file never changes.
//
//   PUT  /api/files/<id>   the bytes, Content-Type = their type; before the row is synced
//   HEAD /api/files/<id>   200 when the server has them (a device skips the upload)
//   GET  /api/files/<id>   the bytes

export const FILE_ID = /^[0-9a-f]{64}$/;

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
