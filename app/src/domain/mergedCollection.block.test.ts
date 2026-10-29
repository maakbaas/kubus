import { describe, expect, it } from "vitest";
import { normalizeBlock } from "../views";
import { COL, invoices, MERGES, shopSales, world } from "../test/mergedWorld";
import { listedCollection, newBlock, parseBlock, parseViewConfig } from "./views";

describe("a block listing several collections", () => {
  const block = { ...newBlock("table", null, "b1"), collectionIds: ["sales", "invoices"], merges: MERGES };

  it("is stored with the view: its collections and hand merges survive a round trip, and are dropped when only one collection is left", () => {
    const view = parseViewConfig(JSON.stringify({ filters: [], blocks: [block], editable: true }));
    expect(view.blocks[0]).toMatchObject({ collectionIds: ["sales", "invoices"], merges: MERGES });
    expect(parseBlock({ ...block, collectionIds: ["sales"] })).not.toHaveProperty("collectionIds");
    expect(parseBlock({ ...block, collectionIds: ["sales", 3] })).not.toHaveProperty("collectionIds");
    expect(parseBlock({ ...block, collectionIds: undefined })).not.toHaveProperty("merges");
    expect(parseBlock({ ...block, merges: [{ id: 1 }, MERGES[0]] })!.merges).toEqual(MERGES);
  });

  it("is read as the merged collection, its own when it lists one", () => {
    expect(listedCollection(invoices, newBlock("table", null, "x"), world)).toEqual({ collection: invoices, problems: [] });
    const { collection } = listedCollection(shopSales, block, world);
    expect(collection.fields.map((f) => f.id)).toContain(COL.amount);
  });

  it("keeps the merged columns in its layout when it is normalized, and drops those that are gone", () => {
    const shown = { ...block, layout: { ...block.layout, fields: [COL.collection, COL.amount, "merged:name:gone", COL.date] } };
    expect(normalizeBlock(shopSales, shown, world).layout.fields).toEqual([COL.collection, COL.amount, COL.date]);
    // Without the collections to read it by, only the one collection's own fields are known.
    expect(normalizeBlock(shopSales, shown).layout.fields).toEqual([]);
    expect(normalizeBlock(shopSales, shown, world)).toMatchObject({ collectionIds: ["sales", "invoices"], merges: MERGES });
  });
});
