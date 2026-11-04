// Aligning the charts of a page (views/chartAlign.tsx measures and applies): charts of one family (axis charts with
// axis charts, meters with meters, …) line up the box they draw (an axis chart's plot area, a meter's bar, a pie's
// circle) with their neighbours', instead of each filling its block its own way (a legend, a right axis or wider tick
// labels moved its box):
//  - side by side (blocks on one line of a row): their tops and bottoms;
//  - above / below (in other rows): those with the same left edge their left side, those with the same right edge too
//    their right side.
// How a chart is moved depends on how it is drawn (`mode`):
//  - "pad": it fills its frame (an axis chart, a treemap): padding inside the frame, the box drawn smaller, the frame
//    (the block) keeping its size. What is measured (`inset`: its box's distances from the frame's edges without the
//    padding) doesn't change with the padding, so the padding is worked out from what is measured, in one step.
//  - "shift": it has a height of its own (a meter, a sparkline) or is centred in its frame (a pie, a gauge, a radar, a
//    word cloud, a map): side by side only its top edge is aligned, by moving it down (`shift`, at most the room it has
//    below it); a centred one isn't padded sideways (it would move by half of it), so it has no left or right.
// Nothing here touches the DOM: it is the rule, in px.

/** A rectangle in page px. */
export interface Edges {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface AlignInput {
  id: string;
  /** Charts align only with their family's ("axis", "meter", "round", …). */
  family: string;
  mode: "pad" | "shift";
  /** The line of a row it is on, side by side with the others of it; null when it is a row of its own (or stacked). */
  line: string | null;
  /** Its frame: where it is drawn (padding included), as it would be without a shift. */
  frame: Edges;
  /** Its box's distance from each of the frame's edges, without the padding (what it draws on its own). */
  inset: Edges;
  /** "shift": how far it can move down and stay in its block. */
  room: number;
}

export interface AlignOutput {
  pad: Edges;
  /** Down, px ("shift"). */
  shift: number;
}

export const NO_ALIGN: AlignOutput = { pad: { left: 0, right: 0, top: 0, bottom: 0 }, shift: 0 };

/** Edges this close are the same (sub-pixel layout). */
const SAME = 1.5;

/** Groups of the items whose `key` values are within SAME of each other (in order of the key). */
function clusters<T>(items: T[], key: (item: T) => number): T[][] {
  const sorted = [...items].sort((a, b) => key(a) - key(b));
  const out: T[][] = [];
  for (const item of sorted) {
    const last = out[out.length - 1];
    if (last && Math.abs(key(item) - key(last[0])) <= SAME) last.push(item);
    else out.push([item]);
  }
  return out;
}

const byKey = <T>(items: T[], key: (item: T) => string): T[][] => {
  const groups = new Map<string, T[]>();
  for (const item of items) groups.set(key(item), [...(groups.get(key(item)) ?? []), item]);
  return [...groups.values()];
};

/** What each chart is padded and shifted by, so that the boxes of each group line up (charts alone: nothing). */
export function alignCharts(items: AlignInput[]): Map<string, AlignOutput> {
  const out = new Map<string, AlignOutput>(items.map((i) => [i.id, { pad: { ...NO_ALIGN.pad }, shift: 0 }]));
  const set = (id: string, f: (o: AlignOutput) => void) => f(out.get(id)!);

  // Side by side: on one line of a row, of one family.
  for (const group of byKey(items.filter((i) => i.line !== null), (i) => `${i.family}\n${i.line}`)) {
    if (group.length < 2) continue;
    const top = (i: AlignInput) => i.frame.top + i.inset.top;
    const target = Math.max(...group.map(top));
    for (const i of group) {
      if (i.mode === "shift") {
        set(i.id, (o) => (o.shift = Math.max(0, Math.min(target - top(i), i.room))));
        continue;
      }
      const bottom = (x: AlignInput) => x.frame.bottom - x.inset.bottom;
      const lowest = Math.min(...group.filter((x) => x.mode === "pad").map(bottom));
      set(i.id, (o) => {
        o.pad.top = target - top(i);
        o.pad.bottom = bottom(i) - lowest;
      });
    }
  }

  // Above / below: in other rows (or rows of their own), of one family, drawn to fill their width ("pad").
  for (const family of byKey(items.filter((i) => i.mode === "pad"), (i) => i.family)) {
    for (const lefts of clusters(family, (i) => i.frame.left)) {
      // Two on one line are side by side, not above one another: a group needs charts of two lines at least.
      if (new Set(lefts.map((i) => i.line ?? i.id)).size < 2) continue;
      const left = (i: AlignInput) => i.frame.left + i.inset.left;
      const target = Math.max(...lefts.map(left));
      for (const i of lefts) set(i.id, (o) => (o.pad.left = target - left(i)));
      for (const rights of clusters(lefts, (i) => i.frame.right)) {
        if (rights.length < 2) continue;
        const right = (i: AlignInput) => i.frame.right - i.inset.right;
        const edge = Math.min(...rights.map(right));
        for (const i of rights) set(i.id, (o) => (o.pad.right = right(i) - edge));
      }
    }
  }

  // To a tenth of a px: whole px left the edges a pixel apart (the frames themselves aren't on whole px).
  const tenth = (n: number) => Math.round(n * 10) / 10;
  for (const o of out.values()) {
    for (const k of ["left", "right", "top", "bottom"] as const) o.pad[k] = Math.max(0, tenth(o.pad[k]));
    o.shift = tenth(o.shift);
  }
  return out;
}

/** Whether two results differ by a pixel or more anywhere (less is left as it is: no redrawing for nothing). */
export function alignChanged(a: AlignOutput, b: AlignOutput): boolean {
  return Math.abs(a.shift - b.shift) >= 1 || (["left", "right", "top", "bottom"] as const).some((k) => Math.abs(a.pad[k] - b.pad[k]) >= 1);
}
