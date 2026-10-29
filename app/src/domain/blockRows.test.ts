import { describe, expect, it } from "vitest";
import { blockRows, canBeside, moveDivider, placeBlock, reordered, rowShares, rowStart, setBeside, setRowMaxHeight, setRowShares, withoutBlock } from "./blockRows";
import { newBlock, parseBlock, type ViewBlock } from "./views";

const block = (id: string, extra: Partial<ViewBlock> = {}): ViewBlock => ({ ...newBlock("table", null, id), ...extra });
const ids = (blocks: ViewBlock[]) => blocks.map((b) => b.id);
const rowsOf = (blocks: ViewBlock[], order = ids(blocks)) => {
  const byId = new Map(blocks.map((b) => [b.id, b]));
  return blockRows(order.map((id) => ({ id })), (e) => byId.get(e.id)).map((r) => r.map((e) => e.id).join(""));
};
/** Blocks in the order a placement gives (a view's blocks are its order). */
const placed = (blocks: ViewBlock[], drag: string, target: string, zone: Parameters<typeof placeBlock>[4]) => {
  const r = placeBlock(ids(blocks), blocks, drag, target, zone);
  return r.order.map((id) => r.blocks.find((b) => b.id === id)!);
};

describe("block rows", () => {
  it("joins a block marked beside to the row before it, at most four, a field in between starting a new row", () => {
    expect(rowsOf([block("a"), block("b", { beside: true }), block("c"), block("d", { beside: true }), block("e", { beside: true })])).toEqual(["ab", "cde"]);
    expect(rowsOf([block("a", { beside: true }), block("b")])).toEqual(["a", "b"]);
    const five = ["a", "b", "c", "d", "e"].map((id, i) => block(id, i > 0 ? { beside: true } : {}));
    expect(rowsOf(five)).toEqual(["abcd", "e"]);
    // A field (not a block) between two blocks.
    const byId = new Map([block("a"), block("b", { beside: true })].map((b) => [b.id, b]));
    expect(blockRows([{ id: "a" }, { id: "f" }, { id: "b" }], (e) => byId.get(e.id)).map((r) => r.map((e) => e.id).join(""))).toEqual(["a", "f", "b"]);
  });

  it("shares a row's width equally unless set, always summing to 100", () => {
    expect(rowShares([{}, {}])).toEqual([50, 50]);
    expect(rowShares([{ width: 70 }, { width: 30 }])).toEqual([70, 30]);
    expect(rowShares([{ width: 60 }, {}]).reduce((a, b) => a + b)).toBeCloseTo(100);
  });

  it("places a dragged block beside another, or in a row of its own above or below its row", () => {
    const blocks = [block("a"), block("b"), block("c")];
    expect(rowsOf(placed(blocks, "c", "a", "right"))).toEqual(["ac", "b"]);
    expect(rowsOf(placed(blocks, "c", "a", "left"))).toEqual(["ca", "b"]);
    const row = placed(blocks, "c", "a", "right");
    expect(rowsOf(placed(row, "b", "c", "top"))).toEqual(["b", "ac"]);
    expect(rowsOf(placed(row, "b", "a", "bottom"))).toEqual(["ac", "b"]);
    // Out of a row again: the rest of the row keeps together.
    expect(rowsOf(placed(row, "a", "b", "bottom"))).toEqual(["c", "b", "a"]);
  });

  it("hands a row's settings on to the block that becomes its first, and evens the shares of a changed row", () => {
    const blocks = [block("a", { rowMaxHeight: 20, width: 70 }), block("b", { beside: true, width: 30 }), block("c")];
    const left = placed(blocks, "c", "a", "left");
    expect(rowsOf(left)).toEqual(["cab"]);
    expect(left.find((b) => b.id === "c")?.rowMaxHeight).toBe(20);
    expect(left.find((b) => b.id === "a")?.rowMaxHeight).toBeUndefined();
    expect(left.every((b) => b.width === undefined)).toBe(true);
    const out = placed(blocks, "a", "c", "bottom");
    expect(rowsOf(out)).toEqual(["b", "c", "a"]);
    expect(out.find((b) => b.id === "b")).toMatchObject({ rowMaxHeight: 20 });
    expect(out.find((b) => b.id === "b")?.beside).toBeUndefined();
    expect(out.find((b) => b.id === "a")?.rowMaxHeight).toBeUndefined();
  });

  it("refuses a fifth block in a row and a drop on itself", () => {
    const full = ["a", "b", "c", "d"].map((id, i) => block(id, i > 0 ? { beside: true } : {}));
    const blocks = [...full, block("e")];
    expect(placed(blocks, "e", "b", "right")).toEqual(blocks);
    expect(placed(blocks, "a", "a", "left")).toEqual(blocks);
    // Moving within the full row is fine.
    expect(rowsOf(placed(blocks, "d", "a", "left"))).toEqual(["dabc", "e"]);
  });

  it("puts a block beside the one above it and back on a row of its own", () => {
    const blocks = [block("a"), block("b", { rowMaxHeight: 12 }), block("c", { beside: true })];
    expect(canBeside(ids(blocks), blocks, "a")).toBe(false);
    expect(canBeside(ids(blocks), blocks, "b")).toBe(true);
    const joined = setBeside(ids(blocks), blocks, "b", true);
    expect(rowsOf(joined)).toEqual(["abc"]);
    expect(joined.find((b) => b.id === "b")?.rowMaxHeight).toBeUndefined();
    const split = setBeside(ids(joined), joined, "b", false);
    expect(rowsOf(split)).toEqual(["a", "bc"]);
    // A field above it: no block to be beside.
    expect(canBeside(["a", "f", "b"], blocks, "b")).toBe(false);
  });

  it("keeps a row's max height on its first block, and its shares as whole percents", () => {
    const blocks = [block("a"), block("b", { beside: true })];
    const capped = setRowMaxHeight(ids(blocks), blocks, "b", 20.4);
    expect(capped[0].rowMaxHeight).toBe(20);
    expect(rowStart(ids(capped), capped, "b")?.id).toBe("a");
    expect(setRowMaxHeight(ids(capped), capped, "a", undefined)[0].rowMaxHeight).toBeUndefined();
    expect(setRowMaxHeight(ids(blocks), blocks, "a", 500)[0].rowMaxHeight).toBe(96);
    expect(setRowShares(blocks, ["a", "b"], [66.6, 33.4]).map((b) => b.width)).toEqual([67, 33]);
  });

  it("moves a divider in steps, each side keeping its least share", () => {
    expect(moveDivider([50, 50], 1, 12)).toEqual([60, 40]);
    expect(moveDivider([50, 50], 1, 80)).toEqual([90, 10]);
    expect(moveDivider([30, 30, 40], 2, -50)).toEqual([30, 10, 60]);
  });

  it("reads and checks the stored row keys of a block", () => {
    expect(parseBlock({ ...block("a"), beside: true, width: 40, rowMaxHeight: 3 })).toMatchObject({ beside: true, width: 40, rowMaxHeight: 8 });
    const plain = parseBlock({ ...block("a"), beside: "yes", width: 400, rowMaxHeight: "x" })!;
    expect([plain.beside, plain.width, plain.rowMaxHeight]).toEqual([undefined, undefined, undefined]);
  });
});

describe("block rows kept sound", () => {
  it("lets the next block of a row start it when its first is removed", () => {
    const blocks = [block("a"), block("b", { rowMaxHeight: 12 }), block("c", { beside: true })];
    const left = withoutBlock(ids(blocks), blocks, "b");
    expect(rowsOf(left)).toEqual(["a", "c"]);
    expect(left.find((b) => b.id === "c")).toMatchObject({ rowMaxHeight: 12 });
  });

  it("takes a block out of a row when the list reorders what is above it", () => {
    const blocks = [block("a"), block("b", { beside: true, width: 30 }), block("c")];
    const order = ids(blocks);
    const reorder = (list: ViewBlock[]) => reordered(order, ids(list), list);
    expect(reorder(blocks)).toEqual(blocks);
    const moved = reorder([blocks[2], blocks[0], blocks[1]]);
    expect(rowsOf(moved)).toEqual(["c", "ab"]);
    const apart = reorder([blocks[1], blocks[0], blocks[2]]);
    expect(rowsOf(apart)).toEqual(["b", "a", "c"]);
    expect(apart.every((b) => b.width === undefined)).toBe(true);
    // On an item page a field moved between them takes it out of the row.
    expect(reordered(["a", "b", "f"], ["a", "f", "b"], blocks).find((b) => b.id === "b")?.beside).toBeUndefined();
  });
});

describe("an item page's fields among its blocks", () => {
  const blocks = [block("a"), block("b", { beside: true }), block("c")];
  const order = ["f1", "a", "b", "f2", "c"];
  const place = (drag: string, target: string, zone: Parameters<typeof placeBlock>[4]) => placeBlock(order, blocks, drag, target, zone);

  it("moves a field above or below what it is dropped on, a block's whole row", () => {
    expect(place("f1", "f2", "bottom").order).toEqual(["a", "b", "f2", "f1", "c"]);
    expect(place("f2", "b", "top").order).toEqual(["f1", "f2", "a", "b", "c"]);
    expect(place("f1", "a", "bottom").order).toEqual(["a", "b", "f1", "f2", "c"]);
  });

  it("puts a block above or below a field, never beside one; a field never beside a block", () => {
    expect(place("c", "f1", "top").order).toEqual(["c", "f1", "a", "b", "f2"]);
    expect(place("c", "f1", "right").order).toEqual(order);
    expect(place("f2", "a", "left").order).toEqual(order);
  });
});
