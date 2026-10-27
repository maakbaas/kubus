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
 * field): what the device's file_uses triggers record (app/src/data/schema.sql, through its
 * file_ids() function) and what the server checks it has the bytes of (server/src/files.ts).
 */
export function filesUsedBy(rows: { value_file?: unknown; value_text?: unknown }[]): string[] {
  const ids = new Set<string>();
  for (const r of rows) {
    if (typeof r.value_file === "string") ids.add(r.value_file);
    if (typeof r.value_text === "string" && r.value_text.includes("files/")) fileIdsIn(r.value_text).forEach((id) => ids.add(id));
  }
  return [...ids];
}

