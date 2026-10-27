// Stored files (images) are content-addressed by SHA-256. Markdown refers to
// them with a plain relative URL, `files/<sha256>`, which stays valid GFM and
// can later be served as-is by a sync server or service worker.

export { fileIdsIn } from "../../../shared/files";

const FILE_SRC = /^files\/([0-9a-f]{64})$/;

export const fileSrc = (fileId: string) => `files/${fileId}`;

export function fileIdFromSrc(src: string): string | null {
  return FILE_SRC.exec(src)?.[1] ?? null;
}
