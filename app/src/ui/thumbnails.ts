// Thumbnails: a small version of a stored image, shown where images are small (table cells and
// cards), so a list of large photos doesn't decode megapixels per row. Made in the browser when an
// image is stored, or the first time an image without one is shown small (images stored before
// thumbnails existed, or through the API: the server can't draw). Stored with putThumbnail, which
// syncs it like any file.

/** The thumbnail's shortest side, in pixels; the longest is capped (panoramas). */
const SHORT_SIDE = 512;
const LONG_SIDE_MAX = 2048;
/** Smaller files are shown as they are. */
const MIN_BYTES = 100 * 1024;

/**
 * A small version of an image, or null when it needs none: already small, a vector (SVG), a GIF
 * (it may be animated) or not decodable here. WebP where the browser can encode it, else JPEG, or
 * PNG when the image has transparency.
 */
export async function makeThumbnail(data: Uint8Array, mime: string): Promise<{ data: Uint8Array; mime: string } | null> {
  if (data.byteLength <= MIN_BYTES || mime === "image/svg+xml" || mime === "image/gif") return null;
  if (typeof createImageBitmap === "undefined" || typeof OffscreenCanvas === "undefined") return null;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(new Blob([data as Uint8Array<ArrayBuffer>], { type: mime }));
  } catch {
    return null; // a format this browser can't decode
  }
  try {
    const { width, height } = bitmap;
    const scale = Math.min(SHORT_SIDE / Math.min(width, height), LONG_SIDE_MAX / Math.max(width, height));
    if (scale >= 1) return null;
    const canvas = new OffscreenCanvas(Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)));
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.imageSmoothingQuality = "high";
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    let blob = await canvas.convertToBlob({ type: "image/webp", quality: 0.8 });
    // Safari encodes no WebP (it gives a PNG): JPEG then, unless something is see-through.
    if (blob.type !== "image/webp") blob = await canvas.convertToBlob(hasAlpha(context, canvas) ? { type: "image/png" } : { type: "image/jpeg", quality: 0.82 });
    if (blob.size >= data.byteLength) return null;
    return { data: new Uint8Array(await blob.arrayBuffer()), mime: blob.type };
  } finally {
    bitmap.close();
  }
}

function hasAlpha(context: OffscreenCanvasRenderingContext2D, canvas: OffscreenCanvas): boolean {
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  for (let i = 3; i < pixels.length; i += 4) if (pixels[i] < 255) return true;
  return false;
}
