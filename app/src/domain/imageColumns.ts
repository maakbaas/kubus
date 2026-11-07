import { fieldValue, type FieldDef, type Item } from "./model";

// A table's image columns are as wide as their widest image (at the row's height): a column of square images is
// square, not the 3:1 box every image used to get. Images' shapes are known only once their thumbnails loaded
// (ui/images.tsx imageShape), so a table waits for those of the images it shows the first time (TableView).

/** The narrowest and widest an image column gets, as width / height: square, and the box every image had before (3:1). */
export const IMAGE_SHAPES = { min: 1, max: 3 };

export interface ImageColumns {
  /** Each image column's shape (width / height, within IMAGE_SHAPES), by field id; absent while none of its images is known. */
  shapes: Record<string, number>;
  /** Some image shown has no known shape yet (it is loading, or will never load). */
  waiting: boolean;
}

/** The shapes of the image columns among `fields` for the `items` shown, from what is known of each file's (`shapeOf`; NaN: none). */
export function imageColumns(fields: FieldDef[], items: Item[], shapeOf: (fileId: string) => number | undefined): ImageColumns {
  const shapes: Record<string, number> = {};
  let waiting = false;
  for (const f of fields) {
    if (f.kind !== "image") continue;
    let widest: number | undefined;
    for (const item of items) {
      const v = fieldValue(item, f);
      if (typeof v !== "string" || !v) continue;
      const shape = shapeOf(v);
      if (shape === undefined) waiting = true;
      else if (Number.isFinite(shape) && shape > 0) widest = Math.max(widest ?? 0, shape);
    }
    if (widest !== undefined) shapes[f.id] = Math.min(IMAGE_SHAPES.max, Math.max(IMAGE_SHAPES.min, widest));
  }
  return { shapes, waiting };
}

/** A field id as part of a CSS custom property's name (`--image-shape-<…>`). */
export const cssName = (id: string) => id.replace(/[^A-Za-z0-9_-]/g, "_");
