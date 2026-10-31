import { describe, expect, it } from "vitest";
import { NOTHING_COLLAPSED, type Collapsed, type ViewBlock } from "../domain/views";
import { rowCollapse } from "./BlockRows";

const block = (id: string, beside = false) => ({ id, kind: "table", beside }) as unknown as ViewBlock;
// a and b side by side, c in a row of its own.
const blocks = [block("a"), block("b", true), block("c")];
const order = blocks.map((b) => b.id);
const of = (state: Collapsed, id: string) => {
  let stored: Collapsed | null = null;
  const c = rowCollapse(order, blocks, state, blocks.find((b) => b.id === id)!, (next) => (stored = next));
  return { ...c, toggled: (which: "own" | "row") => (c[which].onToggle(), stored!.blocks) };
};

describe("rowCollapse", () => {
  it("stores collapse per block; side by side a row is collapsed while any of its blocks is", () => {
    const one = { ...NOTHING_COLLAPSED, blocks: ["b"] };
    expect([of(one, "a").own.collapsed, of(one, "a").row.collapsed, of(one, "c").row.collapsed]).toEqual([false, true, false]);
    // The row's caret expands all of it; on an expanded row it collapses the block it belongs to.
    expect(of(one, "a").toggled("row")).toEqual([]);
    expect(of(NOTHING_COLLAPSED, "b").toggled("row")).toEqual(["b"]);
    // Stacked, a block collapses on its own.
    expect(of(one, "a").toggled("own")).toEqual(["b", "a"]);
    expect(of(one, "b").toggled("own")).toEqual([]);
  });
});
