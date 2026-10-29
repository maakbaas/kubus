// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { blankField, type Collection } from "../domain/model";
import { newBlock } from "../domain/views";

// The block types' components (Carbon, charts, maps) are not what is tested here: the registry's
// normalization is, so each type is a stand-in that marks the options it normalized.
const stub = (kind: string) => ({ kind, normalizeOptions: (o: unknown) => ((o as { kind?: string } | null)?.kind === kind ? o : { kind, normalized: o }) });
vi.mock("./CardsView", () => ({ cardsView: stub("cards") }));
vi.mock("./ChartBlock", () => ({ chartBlock: stub("chart") }));
vi.mock("./ComponentBlock", () => ({ componentBlock: stub("component") }));
vi.mock("./MapView", () => ({ mapView: stub("map") }));
vi.mock("./MarkdownBlock", () => ({ markdownBlock: stub("markdown") }));
vi.mock("./TableView", () => ({ tableView: stub("table") }));

const { BLOCK_TYPES, blockType, normalizeBlock, normalizeView } = await import("./index");

const collection = {
  id: "c", name: "Book", pluralName: "Books", icon: null, description: "", itemViews: [], spaceIds: null, createdAt: "", updatedAt: "",
  fields: [blankField("a", "A", "string"), blankField("b", "B", "number")],
} as Collection;

describe("block types", () => {
  it("lists the types in the order of the Show as menu", () => {
    expect(BLOCK_TYPES.map((t) => t.kind)).toEqual(["table", "cards", "chart", "map", "markdown", "component"]);
  });

  it("falls back to the table for an unknown kind", () => {
    expect(blockType("map").kind).toBe("map");
    expect(blockType("removed").kind).toBe("table");
  });
});

describe("normalizeBlock", () => {
  const block = (extra = {}) => ({ ...newBlock("cards", { x: 1 }, "blk"), ...extra });

  it("drops fields that no longer exist, in the layout and among the hidden labels, keeping created and updated", () => {
    const b = block({ layout: { fields: ["a", "gone", "$created"], editable: false, hiddenLabels: ["gone", "b"], hideEmpty: true } });
    const n = normalizeBlock(collection, b);
    expect(n.layout).toEqual({ fields: ["a", "$created"], editable: false, hiddenLabels: ["b"], hideEmpty: true });
  });

  it("keeps null (all fields) as it is", () => {
    expect(normalizeBlock(collection, block()).layout.fields).toBeNull();
  });

  it("lets the block's type normalize its options, and an unknown kind becomes a table", () => {
    expect(normalizeBlock(collection, block()).options).toEqual({ kind: "cards", normalized: { x: 1 } });
    const n = normalizeBlock(collection, block({ kind: "removed" }));
    expect(n.kind).toBe("table");
    expect(n.options).toEqual({ kind: "table", normalized: { x: 1 } });
  });

  it("writes keys in a fixed order, so a stored block equals the same block shown", () => {
    const n = normalizeBlock(collection, block({ hideHeader: true, limit: 5, groupOrder: "count" }));
    expect(Object.keys(n)).toEqual(["id", "title", "kind", "filters", "sort", "groupBy", "layout", "collectionId", "options", "hideHeader", "limit", "groupOrder"]);
    expect(JSON.stringify(normalizeBlock(collection, n))).toBe(JSON.stringify(n));
  });

  it("keeps a date grouping before the group order", () => {
    const n = normalizeBlock(collection, block({ groupDate: "month", groupOrder: "desc" }));
    expect(Object.keys(n).slice(-2)).toEqual(["groupDate", "groupOrder"]);
    expect(n.groupDate).toBe("month");
    expect(normalizeBlock(collection, block())).not.toHaveProperty("groupDate");
  });

  it("leaves out what is absent: no hideHeader, limit or groupOrder keys", () => {
    const n = normalizeBlock(collection, block());
    expect(n).not.toHaveProperty("hideHeader");
    expect(n).not.toHaveProperty("limit");
    expect(n).not.toHaveProperty("groupOrder");
  });

  it("keeps a limit of 0 (all)", () => {
    expect(normalizeBlock(collection, block({ limit: 0 })).limit).toBe(0);
  });
});

describe("normalizeView", () => {
  it("always has a block: a view without any gets the main table, the same every time", () => {
    const view = { filters: [], blocks: [], editable: true };
    const a = normalizeView(collection, view);
    const b = normalizeView(collection, view);
    expect(a.blocks).toHaveLength(1);
    expect(a.blocks[0]).toMatchObject({ id: "main", kind: "table" });
    expect(a).toEqual(b);
  });

  it("normalizes every block and keeps the view's filters and editable flag", () => {
    const filters = [{ id: "r", fieldId: "a", operator: "is", value: "x" }] as never;
    const blocks = [newBlock("map", null, "m"), newBlock("chart", null, "c")];
    const n = normalizeView(collection, { filters, blocks, editable: false });
    expect(n.filters).toBe(filters);
    expect(n.editable).toBe(false);
    expect(n.blocks.map((b) => [b.id, b.kind])).toEqual([["m", "map"], ["c", "chart"]]);
  });
});
