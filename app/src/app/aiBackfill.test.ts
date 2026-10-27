import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Repository } from "../data";
import type { Collection, FieldDef, Item, ItemLabel } from "../domain/model";
import type { AiJob, AiService } from "./ai";
import { AiBackfill } from "./aiBackfill";

const field = (id: string, collectionId: string, name: string, kind: FieldDef["kind"], extra: Partial<FieldDef> = {}): FieldDef => ({
  id, collectionId, name, kind, targetCollectionId: null, componentId: null, componentArgs: {}, choiceFilter: [], toggleIcon: null, strikeThrough: false,
  aiPrompt: null, aiOutput: null, position: 0, ...extra,
});
const collection = (id: string, name: string, fields: FieldDef[]): Collection => ({
  id, name, pluralName: `${name}s`, icon: null, description: "", itemViews: [], spaceIds: null, fields, createdAt: "", updatedAt: "",
});

const author = collection("author", "Author", [field("aname", "author", "Name", "string")]);
const book = collection("book", "Book", [
  field("btitle", "book", "Title", "string"),
  field("bauthor", "book", "Author", "item", { targetCollectionId: "author" }),
  field("bbio", "book", "Bio", "ai", { aiPrompt: "By {{ $item.Author }}", aiOutput: "string" }),
]);
const item = (id: string, collectionId: string, values: Item["values"]): Item => ({ id, collectionId, spaceId: "default", values, createdAt: "", updatedAt: "" });

/** A stand-in database: the author is stored with the given name; the book points at it. */
function setup(authorName: string) {
  const listItems = vi.fn(async (c: Collection) => (c.id === "author" ? [item("a1", "author", { aname: authorName })] : [item("b1", "book", { btitle: "T", bauthor: "a1" })]));
  const listLabels = vi.fn(async (c: Collection): Promise<ItemLabel[]> => (c.id === "author" ? [{ id: "a1", label: authorName, spaceId: "default" }] : []));
  const offered: AiJob[] = [];
  const ai = { configured: true, offerBackground: (jobs: AiJob[]) => offered.push(...jobs), adopt: vi.fn(), offerOverrides: vi.fn() } as unknown as AiService;
  const world = { collections: [author, book], components: [], spaces: [{ id: "default", name: "Space", icon: null, position: 0 }] as never };
  const backfill = new AiBackfill({ listItems, listLabels } as unknown as Repository, ai, () => world);
  return { backfill, offered, listItems };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("AiBackfill", () => {
  it("reads a referenced item by its stored label", async () => {
    const { backfill, offered, listItems } = setup("Jane Doe");
    backfill.request(undefined, 0);
    await vi.advanceTimersByTimeAsync(10);
    expect(offered.map((j) => j.request.prompt)).toEqual(["By Jane Doe"]);
    // Plain labels need no look at the author's items.
    expect(listItems).not.toHaveBeenCalledWith(author, "default");
  });

  it("reads braces in a label as text: item values are data, never code", async () => {
    const { backfill, offered, listItems } = setup("Jane {{ 1 + 2 }}");
    backfill.request(undefined, 0);
    await vi.advanceTimersByTimeAsync(10);
    expect(offered.map((j) => j.request.prompt)).toEqual(["By Jane {{ 1 + 2 }}"]);
    expect(listItems).not.toHaveBeenCalledWith(author, "default");
  });
});
