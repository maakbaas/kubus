// Stored files (images) as the app and the server both see them: content-addressed by SHA-256,
// referred to from Markdown and HTML as `files/<sha256>`. No imports, erasable syntax only (see
// shared/sync.ts).

/** A file id: the SHA-256 of its bytes, in hex. */
export const FILE_ID = /^[0-9a-f]{64}$/;

const FILE_SRC_IN_TEXT = /\bfiles\/([0-9a-f]{64})\b/g;

/** File ids referenced anywhere in a text (a markdown document, a component's HTML). */
export function fileIdsIn(text: string): string[] {
  return [...new Set([...text.matchAll(FILE_SRC_IN_TEXT)].map((m) => m[1]))];
}

/**
 * The files stored values use: image values (`value_file`) and `files/<id>` in their text (of any
 * field). The one rule for a value's uses: the device's file_uses triggers (app/src/data/schema.sql,
 * through its file_ids() function) and the server's (server/src/files.ts) both apply it.
 */
export function filesUsedBy(rows: { value_file?: unknown; value_text?: unknown }[]): string[] {
  const ids = new Set<string>();
  for (const r of rows) {
    if (typeof r.value_file === "string") ids.add(r.value_file);
    if (typeof r.value_text === "string" && r.value_text.includes("files/")) fileIdsIn(r.value_text).forEach((id) => ids.add(id));
  }
  return [...ids];
}

/**
 * SQL, the same in SQLite and Postgres, true when the file `id` (an SQL expression) is in use: a
 * live item uses it through a live field (`file_uses`, kept by filesUsedBy), or it is the
 * thumbnail of such a file. Devices delete a file once it isn't; the server after a grace period.
 */
export const fileInUse = (id: string) => {
  const used = (file: string) => `EXISTS (SELECT 1 FROM file_uses u
      JOIN items o ON o.id = u.item_id AND o.deleted_at IS NULL
      JOIN fields f ON f.id = u.field_id AND f.deleted_at IS NULL
     WHERE u.file_id = ${file})`;
  return `(${used(id)} OR EXISTS (SELECT 1 FROM thumbnails t WHERE t.thumb_id = ${id} AND ${used("t.file_id")}))`;
};
