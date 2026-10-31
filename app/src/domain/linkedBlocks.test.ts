import { describe, expect, it } from "vitest";
import { blockLinkKey, findLinkedBlock, linkProblem, MAX_LINK_DEPTH, parseBlockLink } from "./linkedBlocks";
import type { ViewBlock } from "./views";

const block = (id: string) => ({ id, title: "", kind: "table" }) as ViewBlock;

describe("linked blocks", () => {
  it("reads the block a stored link names, on a view, an item's page or a dashboard", () => {
    expect(parseBlockLink("#/collections/c1/items?view=v1&block=b1")).toEqual({ place: "collection", collectionId: "c1", viewId: "v1", blockId: "b1" });
    expect(parseBlockLink("#/collections/c1/items?block=b1")).toEqual({ place: "collection", collectionId: "c1", viewId: null, blockId: "b1" });
    expect(parseBlockLink(" #/collections/c1/items/i1?block=b2 ")).toEqual({ place: "item", collectionId: "c1", itemId: "i1", viewId: null, blockId: "b2" });
    expect(parseBlockLink("#/dashboards/d1?view=t1&block=b3")).toEqual({ place: "dashboard", dashboardId: "d1", viewId: "t1", blockId: "b3" });
  });

  it("reads an item's field, whichever item view the link names", () => {
    const field = { place: "field", collectionId: "c1", itemId: "i1", fieldId: "f1" };
    expect(parseBlockLink("#/collections/c1/items/i1?field=f1")).toEqual(field);
    expect(parseBlockLink("#/collections/c1/items/i1?view=iv2&field=f1")).toEqual(field);
    expect(blockLinkKey(parseBlockLink("#/collections/c1/items/i1?field=f1")!)).not.toBe(blockLinkKey(parseBlockLink("#/collections/c1/items/i1?block=f1")!));
  });

  it("names nothing for any other link", () => {
    for (const href of ["", "#/collections/c1/items", "#/collections/c1/items?field=f1", "#/dashboards/d1", "#/dashboards", "books/reading-list#chart", "https://example.com?block=b1"]) {
      expect(parseBlockLink(href)).toBeNull();
    }
  });

  it("is the same block whichever view a link names", () => {
    const a = parseBlockLink("#/collections/c1/items?view=v1&block=b1")!;
    const b = parseBlockLink("#/collections/c1/items?block=b1")!;
    expect(blockLinkKey(a)).toBe(blockLinkKey(b));
    expect(blockLinkKey(parseBlockLink("#/collections/c1/items/i1?block=b1")!)).not.toBe(blockLinkKey(a));
  });

  it("finds the block in the view named, else the default one, else any (a block moved keeps its id)", () => {
    const views = [{ id: "v1", blocks: [block("b1")] }, { id: "v2", blocks: [block("b2"), block("b1")] }];
    const blocks = (v: (typeof views)[number]) => v.blocks;
    expect(findLinkedBlock(views, blocks, views[1], views[0], "b1")?.view.id).toBe("v2");
    expect(findLinkedBlock(views, blocks, undefined, views[0], "b1")?.view.id).toBe("v1");
    expect(findLinkedBlock(views, blocks, views[0], views[0], "b2")?.view.id).toBe("v2");
    expect(findLinkedBlock(views, blocks, views[0], views[0], "gone")).toBeNull();
  });

  it("stops at a block shown inside itself, or too deep, and says why", () => {
    const href = "#/collections/c1/items?block=b1";
    const link = parseBlockLink(href);
    expect(linkProblem(link, href, [])).toBeNull();
    expect(linkProblem(link, href, [blockLinkKey(link!)])).toMatch(/itself/);
    expect(linkProblem(link, href, Array.from({ length: MAX_LINK_DEPTH }, (_, i) => `x${i}`))).toMatch(/Too many/);
    expect(linkProblem(null, "", [])).toMatch(/No block linked/);
    expect(linkProblem(null, "#/collections/c1/items", [])).toMatch(/doesn't name a block/);
  });
});
