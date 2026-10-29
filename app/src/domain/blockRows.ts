// Blocks side by side: a page's blocks are a flat list (its reading order), and a block marked `beside` joins the row
// of the block before it. Where the page is wide enough (a container query on the row, styles.css `.block-row`) a row's
// blocks stand side by side, as tall as each other (the tallest's height, at most the row's max height: beyond it they
// scroll inside); narrower (a phone, a narrow pane) they stack as single blocks always did, their heights their own.
// A row's settings (`rowMaxHeight`) are on its first block; widths are shares in percent (`width`, absent: equal).
// On an item page fields lie between blocks: a row is blocks next to each other.

import type { ViewBlock } from "./views";

/** At most this many blocks in a row. */
export const ROW_MAX_BLOCKS = 4;
/** A row's max height (rem): the range offered. */
export const ROW_MAX_HEIGHT = { min: 8, max: 96 };
/** A block's least share of its row (percent) and the step a divider moves by. */
export const MIN_SHARE = 10;
export const SHARE_STEP = 5;

/** A stored row max height made valid: whole rem within ROW_MAX_HEIGHT. */
export const normalizeRowMaxHeight = (rem: number): number => Math.min(ROW_MAX_HEIGHT.max, Math.max(ROW_MAX_HEIGHT.min, Math.round(rem)));

/**
 * Entries (blocks, on an item page fields too) in rows: a block marked `beside` joins the row of the block just before it
 * (a field in between, or a full row, starts a new one). An entry that is not a block is a row of its own.
 */
export function blockRows<T extends { id: string }>(entries: T[], blockOf: (entry: T) => Pick<ViewBlock, "beside"> | undefined): T[][] {
  const rows: T[][] = [];
  let lastIsBlock = false;
  for (const entry of entries) {
    const block = blockOf(entry);
    const row = rows[rows.length - 1];
    if (block?.beside && lastIsBlock && row.length < ROW_MAX_BLOCKS) row.push(entry);
    else rows.push([entry]);
    lastIsBlock = !!block;
  }
  return rows;
}

/** The shares of a row's blocks in percent, summing to 100 (absent widths: an equal share). */
export function rowShares(row: Pick<ViewBlock, "width">[]): number[] {
  const raw = row.map((b) => b.width ?? 100 / row.length);
  const sum = raw.reduce((a, b) => a + b, 0) || 1;
  return raw.map((w) => (w * 100) / sum);
}

/** A block without its place in a row (beside, width, the row's settings). */
const loose = (b: ViewBlock): ViewBlock => {
  const { beside: _beside, width: _width, rowMaxHeight: _max, ...rest } = b;
  return rest;
};
const withoutWidth = (b: ViewBlock): ViewBlock => {
  const { width: _width, ...rest } = b;
  return rest;
};

/**
 * Applies a change to the blocks of `order` (ids of blocks, and on an item page of fields), keeping rows sound: a row's
 * first block holds its settings (handed on when it leaves), and a row whose blocks changed gets equal shares again.
 */
class Arrangement {
  byId: Map<string, ViewBlock>;
  constructor(
    public order: string[],
    blocks: ViewBlock[],
  ) {
    this.byId = new Map(blocks.map((b) => [b.id, b]));
  }
  rows(): string[][] {
    return blockRows(
      this.order.map((id) => ({ id })),
      (e) => this.byId.get(e.id),
    ).map((r) => r.map((e) => e.id));
  }
  rowOf(id: string): string[] | undefined {
    return this.rows().find((r) => r.includes(id));
  }
  set(id: string, f: (b: ViewBlock) => ViewBlock) {
    const b = this.byId.get(id);
    if (b) this.byId.set(id, f(b));
  }
  /** Equal shares in the row of `id`. */
  evenRow(id: string) {
    for (const other of this.rowOf(id) ?? []) this.set(other, withoutWidth);
  }
  /** Takes a block out of the order: the block after it in its row starts the row instead (with its settings). */
  detach(id: string) {
    const row = this.rowOf(id) ?? [id];
    const block = this.byId.get(id)!;
    const at = row.indexOf(id);
    const next = row[at + 1];
    if (at === 0 && next) {
      this.set(next, (b) => {
        const { beside: _beside, ...rest } = b;
        return { ...rest, ...(block.rowMaxHeight !== undefined && { rowMaxHeight: block.rowMaxHeight }) };
      });
    }
    for (const other of row) if (other !== id) this.set(other, withoutWidth);
    this.order = this.order.filter((o) => o !== id);
    this.byId.set(id, loose(block));
  }
  result(blocks: ViewBlock[]): { order: string[]; blocks: ViewBlock[] } {
    return { order: this.order, blocks: blocks.map((b) => this.byId.get(b.id) ?? b) };
  }
}

/** Where a block is dropped on another: beside it (left, right) in its row, or in a row of its own above or below that row. */
export type RowZone = "left" | "right" | "top" | "bottom";

/**
 * A block moved next to another (dragged by its header). `order` is the page's order of ids (blocks; on an item page
 * fields too); the result's blocks are in the order given (the caller orders them by `order` where that is their order).
 * Unchanged when a full row would take one more, or a block is dropped on itself.
 */
export function placeBlock(order: string[], blocks: ViewBlock[], dragId: string, targetId: string, zone: RowZone): { order: string[]; blocks: ViewBlock[] } {
  const a = new Arrangement(order, blocks);
  if (dragId === targetId || !a.byId.has(dragId) || !a.byId.has(targetId)) return { order, blocks };
  const sameRow = a.rowOf(targetId)?.includes(dragId);
  if ((zone === "left" || zone === "right") && !sameRow && (a.rowOf(targetId)?.length ?? 0) >= ROW_MAX_BLOCKS) return { order, blocks };
  a.detach(dragId);
  const row = a.rowOf(targetId)!;
  const insert = (index: number) => a.order.splice(index, 0, dragId);
  if (zone === "left") {
    const target = a.byId.get(targetId)!;
    insert(a.order.indexOf(targetId));
    // It takes the target's place: the row's first, with the row's settings, when the target was.
    a.set(dragId, (b) => ({ ...b, ...(target.beside && { beside: true as const }), ...(target.rowMaxHeight !== undefined && { rowMaxHeight: target.rowMaxHeight }) }));
    a.set(targetId, (b) => {
      const { rowMaxHeight: _max, ...rest } = b;
      return { ...rest, beside: true };
    });
  } else if (zone === "right") {
    insert(a.order.indexOf(targetId) + 1);
    a.set(dragId, (b) => ({ ...b, beside: true }));
  } else if (zone === "top") {
    insert(a.order.indexOf(row[0]));
  } else {
    insert(a.order.indexOf(row[row.length - 1]) + 1);
  }
  a.evenRow(dragId);
  return a.result(blocks);
}

/**
 * A block put beside the block above it (joining its row), or on a row of its own again (the blocks after it in its row
 * staying with it). Unchanged when there is no block right above it, or that row is full.
 */
export function setBeside(order: string[], blocks: ViewBlock[], id: string, on: boolean): ViewBlock[] {
  const a = new Arrangement(order, blocks);
  const block = a.byId.get(id);
  if (!block || !!block.beside === on) return blocks;
  if (on) {
    if (!canBeside(order, blocks, id)) return blocks;
    a.evenRow(a.order[a.order.indexOf(id) - 1]);
    a.evenRow(id);
    a.set(id, (b) => {
      const { rowMaxHeight: _max, ...rest } = b;
      return { ...rest, beside: true };
    });
  } else {
    a.evenRow(id);
    const max = a.byId.get(a.rowOf(id)![0])?.rowMaxHeight;
    a.set(id, (b) => {
      const { beside: _beside, ...rest } = b;
      return { ...rest, ...(max !== undefined && { rowMaxHeight: max }) };
    });
    a.evenRow(id);
  }
  return a.result(blocks).blocks;
}

/** Whether a block can be put beside the block above it: one is right above it (no field between) and its row has room. */
export function canBeside(order: string[], blocks: ViewBlock[], id: string): boolean {
  const a = new Arrangement(order, blocks);
  const above = a.order[a.order.indexOf(id) - 1];
  if (!above || !a.byId.has(above)) return false;
  const own = a.rowOf(id) ?? [id];
  return a.byId.get(id)?.beside ? true : a.rowOf(above)!.length + own.length <= ROW_MAX_BLOCKS;
}

/** The first block of the row a block is in (holding the row's settings). */
export function rowStart(order: string[], blocks: ViewBlock[], id: string): ViewBlock | undefined {
  const a = new Arrangement(order, blocks);
  const first = a.rowOf(id)?.[0];
  return first === undefined ? undefined : a.byId.get(first);
}

/** The row of a block given its max height (rem; undefined: none), set on the row's first block. */
export function setRowMaxHeight(order: string[], blocks: ViewBlock[], id: string, rem: number | undefined): ViewBlock[] {
  const first = rowStart(order, blocks, id);
  if (!first) return blocks;
  return blocks.map((b) => {
    if (b.id !== first.id) return b;
    const { rowMaxHeight: _max, ...rest } = b;
    return rem === undefined ? rest : { ...rest, rowMaxHeight: normalizeRowMaxHeight(rem) };
  });
}

/** A row's blocks given these shares (percent, in the row's order): stored as whole numbers. */
export function setRowShares(blocks: ViewBlock[], row: string[], shares: number[]): ViewBlock[] {
  return blocks.map((b) => {
    const at = row.indexOf(b.id);
    return at < 0 ? b : { ...b, width: Math.round(shares[at]) };
  });
}

/**
 * The shares of a row with the divider before block `i` moved by `delta` percent: between blocks i-1 and i, each kept
 * at MIN_SHARE at least, snapped to SHARE_STEP.
 */
export function moveDivider(shares: number[], i: number, delta: number): number[] {
  const pair = shares[i - 1] + shares[i];
  const before = Math.min(pair - MIN_SHARE, Math.max(MIN_SHARE, Math.round((shares[i - 1] + delta) / SHARE_STEP) * SHARE_STEP));
  return shares.map((s, k) => (k === i - 1 ? before : k === i ? pair - before : s));
}

/** The blocks without one (removed): the block after it in its row starts the row instead, with the row's settings. */
export function withoutBlock(order: string[], blocks: ViewBlock[], id: string): ViewBlock[] {
  const a = new Arrangement(order, blocks);
  if (!a.byId.has(id)) return blocks;
  a.detach(id);
  return a.result(blocks).blocks.filter((b) => b.id !== id);
}

/**
 * Blocks reordered (the block list in settings; an item page's Fields list): a block stays beside the block above only if
 * that is still the one above it (`before` and `after`: the page's order of ids, blocks and on an item page fields);
 * otherwise it starts a row of its own (and every row gets equal shares again).
 */
export function reordered(before: string[], after: string[], blocks: ViewBlock[]): ViewBlock[] {
  const above = (order: string[], id: string) => order[order.indexOf(id) - 1];
  const moved = new Set(blocks.filter((b) => b.beside && above(before, b.id) !== above(after, b.id)).map((b) => b.id));
  if (moved.size === 0) return blocks;
  return blocks.map((b) => (moved.has(b.id) ? loose(b) : b.width !== undefined ? withoutWidth(b) : b));
}
