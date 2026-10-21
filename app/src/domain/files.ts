// Stored files (images) are content-addressed by SHA-256. Markdown refers to
// them with a plain relative URL, `files/<sha256>`, which stays valid GFM and
// can later be served as-is by a sync server or service worker.

const FILE_SRC = /^files\/([0-9a-f]{64})$/;
const FILE_SRC_IN_TEXT = /\bfiles\/([0-9a-f]{64})\b/g;

export const fileSrc = (fileId: string) => `files/${fileId}`;

export function fileIdFromSrc(src: string): string | null {
  return FILE_SRC.exec(src)?.[1] ?? null;
}

/** File ids referenced anywhere in a text (a markdown document, a template's HTML). */
export function fileIdsIn(markdown: string): string[] {
  return [...new Set([...markdown.matchAll(FILE_SRC_IN_TEXT)].map((m) => m[1]))];
}
