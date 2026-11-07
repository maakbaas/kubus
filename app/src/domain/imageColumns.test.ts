import { describe, expect, it } from "vitest";
import { cssName, imageColumns } from "./imageColumns";
import { blankField, type Item } from "./model";

const photo = blankField("photo", "Photo", "image");
const title = blankField("title", "Title", "string");
const item = (id: string, photoId: string | null): Item => ({ id, collectionId: "c", spaceId: "default", values: { photo: photoId, title: id }, createdAt: "", updatedAt: "" }) as Item;

describe("imageColumns", () => {
  it("makes a column as wide as its widest image, between square and 3:1", () => {
    const shapes = new Map<string, number>([["a", 1], ["b", 1.5], ["c", 0.5], ["d", 5], ["e", NaN]]);
    const of = (id: string) => shapes.get(id);
    expect(imageColumns([title, photo], [item("1", "a"), item("2", "b"), item("3", null)], of)).toEqual({ shapes: { photo: 1.5 }, waiting: false });
    expect(imageColumns([photo], [item("1", "c")], of).shapes).toEqual({ photo: 1 });
    expect(imageColumns([photo], [item("1", "d")], of).shapes).toEqual({ photo: 3 });
    // One that couldn't be loaded counts as known, but not for the width.
    expect(imageColumns([photo], [item("1", "e")], of)).toEqual({ shapes: {}, waiting: false });
  });

  it("waits for images whose shape isn't known yet", () => {
    expect(imageColumns([photo], [item("1", "a"), item("2", "x")], (id) => (id === "a" ? 2 : undefined))).toEqual({ shapes: { photo: 2 }, waiting: true });
  });

  it("names a field in a custom property", () => {
    expect(cssName("1f0c-ab.$x")).toBe("1f0c-ab__x");
  });
});
