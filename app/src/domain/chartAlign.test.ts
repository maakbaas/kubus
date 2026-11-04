import { describe, expect, it } from "vitest";
import { alignCharts, alignChanged, NO_ALIGN, type AlignInput } from "./chartAlign";

const edges = (left: number, top: number, right: number, bottom: number) => ({ left, top, right, bottom });
const chart = (id: string, over: Partial<AlignInput>): AlignInput => ({
  id,
  family: "axis",
  mode: "pad",
  line: null,
  frame: edges(0, 0, 400, 300),
  inset: edges(40, 0, 0, 30),
  room: 0,
  ...over,
});

describe("aligning charts", () => {
  it("side by side: the boxes' tops and bottoms, a legend above one or a taller axis under another made up for", () => {
    const a = chart("a", { line: "r", frame: edges(0, 0, 400, 300), inset: edges(40, 24, 0, 30) }); // a legend above
    const b = chart("b", { line: "r", frame: edges(420, 0, 820, 300), inset: edges(60, 0, 0, 50) }); // a two-line X axis
    const out = alignCharts([a, b]);
    expect(out.get("a")!.pad).toMatchObject({ top: 0, bottom: 20 });
    expect(out.get("b")!.pad).toMatchObject({ top: 24, bottom: 0 });
    // Not above one another: their left sides stay their own.
    expect(out.get("a")!.pad.left).toBe(0);
    expect(out.get("b")!.pad.left).toBe(0);
  });

  it("only within a family, and not alone", () => {
    const line = chart("line", { line: "r", inset: edges(40, 24, 0, 30) });
    const meter = chart("meter", { line: "r", family: "meter", mode: "shift", frame: edges(420, 100, 820, 160), inset: edges(0, 30, 0, 14), room: 100 });
    const out = alignCharts([line, meter]);
    expect(out.get("line")).toEqual(NO_ALIGN);
    expect(out.get("meter")).toEqual(NO_ALIGN);
  });

  it("above / below: the same left edge aligns the left side, the same right edge too the right side", () => {
    const top = chart("top", { line: "r1", frame: edges(0, 0, 400, 300), inset: edges(38, 0, 0, 30) });
    const under = chart("under", { line: "r2", frame: edges(0, 320, 400, 620), inset: edges(52, 0, 40, 30) }); // a right axis
    const narrow = chart("narrow", { frame: edges(0, 640, 300, 940), inset: edges(45, 0, 0, 30) }); // a smaller Width
    const out = alignCharts([top, under, narrow]);
    expect(out.get("top")!.pad).toMatchObject({ left: 14, right: 40 });
    expect(out.get("under")!.pad).toMatchObject({ left: 0, right: 0 });
    expect(out.get("narrow")!.pad).toMatchObject({ left: 7, right: 0 });
  });

  it("charts with a height of their own (or centred) line up their tops by a shift, within the room they have", () => {
    const a = chart("a", { line: "r", family: "meter", mode: "shift", frame: edges(0, 110, 400, 170), inset: edges(0, 30, 0, 14), room: 60 });
    const b = chart("b", { line: "r", family: "meter", mode: "shift", frame: edges(420, 100, 820, 180), inset: edges(0, 50, 0, 14), room: 5 });
    const out = alignCharts([a, b]);
    expect(out.get("a")!.shift).toBe(10);
    expect(out.get("b")!.shift).toBe(0);
    // Centred ones aren't padded sideways: they would move by half of it.
    expect(out.get("a")!.pad).toEqual(NO_ALIGN.pad);
  });

  it("a difference under a pixel isn't a change", () => {
    expect(alignChanged(NO_ALIGN, { ...NO_ALIGN, shift: 0.4 })).toBe(false);
    expect(alignChanged(NO_ALIGN, { ...NO_ALIGN, pad: { ...NO_ALIGN.pad, top: 2 } })).toBe(true);
  });
});
