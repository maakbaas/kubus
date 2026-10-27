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
