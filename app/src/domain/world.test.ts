import { describe, expect, it, vi } from "vitest";
import type { Component } from "./components";
import { bookmarkPath } from "./bookmarks";
import { fileIdFromSrc, fileSrc, fileIdsIn, filesUsedBy, IMAGE_TYPES } from "./files";
import { blankField, type Collection, type Item, type ItemLabel } from "./model";
import { computeItems, loadWorld } from "./world";

describe("loadWorld", () => {
  it("reads the collections, components and spaces the repository holds", async () => {
    const repo = {
      listCollections: vi.fn(async () => [{ id: "c" } as Collection]),
      listComponents: vi.fn(async () => [{ id: "k" } as Component]),
      listSpaces: vi.fn(async () => [{ id: "s", name: "S", icon: null, position: 0 }]),
    };
    expect(await loadWorld(repo)).toEqual({ collections: [{ id: "c" }], components: [{ id: "k" }], spaces: [{ id: "s", name: "S", icon: null, position: 0 }] });
  });
});

describe("computeItems", () => {
  const authors: Collection = { id: "author", name: "Author", pluralName: "Authors", icon: null, description: "", itemViews: [], spaceIds: null, createdAt: "", updatedAt: "", fields: [blankField("aname", "Name", "string")] };
  const books: Collection = {
    id: "book", name: "Book", pluralName: "Books", icon: null, description: "", itemViews: [], spaceIds: null, createdAt: "", updatedAt: "",
    fields: [
      blankField("btitle", "Title", "string"),
      blankField("bauthor", "Author", "item", { targetCollectionId: "author" }),
      blankField("bline", "Line", "component", { code: "{{ $item.Title }} by {{ $item.Author }}", output: "markdown" }),
    ],
  };
  const book: Item = { id: "b1", collectionId: "book", spaceId: "s", values: { btitle: "Dune", bauthor: "a1" }, createdAt: "", updatedAt: "" };
  const world = { collections: [authors, books], components: [] as Component[], spaces: [] };

  it("works out component fields, reading referenced items by their labels", async () => {
    const repo = {
      listItems: vi.fn(async () => []),
      listLabels: vi.fn(async (c: Collection): Promise<ItemLabel[]> => (c.id === "author" ? [{ id: "a1", label: "Frank", spaceId: "s" }] : [])),
    };
    const [computed] = await computeItems(repo, world, books, [book], "s");
    expect(computed.values.bline).toBe("Dune by Frank");
    expect(book.values.bline).toBeUndefined(); // the stored item is not changed
  });

  it("shares the labels it read between calls", async () => {
    const repo = { listItems: vi.fn(async () => []), listLabels: vi.fn(async (): Promise<ItemLabel[]> => [{ id: "a1", label: "Frank", spaceId: "s" }]) };
    const labels = new Map<string, ItemLabel[]>();
    await computeItems(repo, world, books, [book], "s", labels);
    await computeItems(repo, world, books, [book], "s", labels);
    expect(repo.listLabels).toHaveBeenCalledTimes(1);
  });
});

describe("bookmarks", () => {
  it("lead to a view of the collection or to the item", () => {
    expect(bookmarkPath({ kind: "view", collectionId: "c", targetId: "v" })).toBe("/collections/c/items?view=v");
    expect(bookmarkPath({ kind: "item", collectionId: "c", targetId: "i" })).toBe("/collections/c/items/i");
    expect(bookmarkPath({ kind: "dashboard", collectionId: null, dashboardId: "d", targetId: "t" })).toBe("/dashboards/d?view=t");
  });
});

describe("files", () => {
  const id = "a".repeat(64);

  it("refers to a stored file by a relative URL, and reads the id back", () => {
    expect(fileSrc(id)).toBe(`files/${id}`);
    expect(fileIdFromSrc(`files/${id}`)).toBe(id);
  });

  it("recognizes nothing else as a stored file", () => {
    for (const src of ["", "files/abc", `files/${id}.png`, `x/files/${id}`, `https://x.org/files/${id}`, `files/${"A".repeat(64)}`]) {
      expect(fileIdFromSrc(src)).toBeNull();
    }
  });

  it("lists the image types the app shows", () => {
    expect(IMAGE_TYPES).toContain("image/svg+xml");
    expect(IMAGE_TYPES).toContain("image/webp");
  });

  it("finds the files a text uses, once each", () => {
    const other = "b".repeat(64);
    expect(fileIdsIn(`![](files/${id}) and files/${other} and again files/${id}`)).toEqual([id, other]);
    expect(fileIdsIn("no files/short here")).toEqual([]);
  });

  it("finds the files stored values use: image values and files in text", () => {
    const other = "b".repeat(64);
    expect(filesUsedBy([{ value_file: id }, { value_text: `![](files/${other})` }, { value_text: "plain" }, { value_file: null, value_text: null }, {}])).toEqual([id, other]);
  });
});
