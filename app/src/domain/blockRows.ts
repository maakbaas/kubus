// Blocks side by side: a page's blocks are a flat list (its reading order), and a block marked `beside` joins the row
// of the block before it. Where the page is wide enough (a container query on the row, styles.css `.block-row`) a row's
// blocks stand side by side, all as tall as the row: its tallest or its shortest block (`rowFit`), at most or at least
// `rowHeight` (rem); what is taller scrolls inside, and a chart, map or HTML component fills it (its own Height and Aspect
// ratio set aside). Narrower (a phone, a narrow pane) they stack as single blocks always did, their heights their own.
// A row's settings (`rowFit`, `rowHeight`) are on its first block; widths are shares in percent (`width`, absent: equal).
// On an item page fields lie between blocks: a row is blocks next to each other.

import type { ViewBlock } from "./views";

/** At most this many blocks in a row. */
export const ROW_MAX_BLOCKS = 4;
/** A row's height limit (rem: its max height, or with `rowFit` "shortest" its min height): the range offered. */
export const ROW_HEIGHT = { min: 8, max: 96 };
/** A row's height with nothing to measure (only charts, maps, HTML components) and no height set, in rem. */
export const ROW_HEIGHT_DEFAULT = 24;
/** A block's least share of its row (percent) and the step a divider moves by. */
export const MIN_SHARE = 10;
export const SHARE_STEP = 5;

/** A stored row height made valid: whole rem within ROW_HEIGHT. */
export const normalizeRowHeight = (rem: number): number => Math.min(ROW_HEIGHT.max, Math.max(ROW_HEIGHT.min, Math.round(rem)));

/** A row's settings, on its first block. */
export type RowSettings = Pick<ViewBlock, "rowFit" | "rowHeight">;
const rowSettingsOf = (b: ViewBlock): RowSettings => ({ ...(b.rowFit && { rowFit: b.rowFit }), ...(b.rowHeight !== undefined && { rowHeight: b.rowHeight }) });
const withoutRowSettings = (b: ViewBlock): ViewBlock => {
  const { rowFit: _fit, rowHeight: _height, ...rest } = b;
  return rest;
};

/**
 * The height of a row of blocks side by side, in px: its tallest or (`rowFit` "shortest") its shortest block (`heights`:
 * each block's own), at most or at least its `rowHeight`; with nothing measured, its `rowHeight`, else ROW_HEIGHT_DEFAULT.
 * Never less than a block that can't scroll or shrink (`floors`: a stat, a meter, a compact chart). `rem` is the px of a rem.
 */
export function rowHeightPx(settings: RowSettings, heights: number[], rem: number, floors: number[] = []): number {
  const limit = settings.rowHeight === undefined ? undefined : settings.rowHeight * rem;
  const fitted =
    heights.length === 0
      ? (limit ?? ROW_HEIGHT_DEFAULT * rem)
      : settings.rowFit === "shortest"
        ? Math.max(Math.min(...heights), limit ?? 0)
        : Math.min(Math.max(...heights), limit ?? Infinity);
  return Math.max(fitted, ...floors);
}

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
  const { beside: _beside, width: _width, ...rest } = b;
  return withoutRowSettings(rest);
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
  /** Takes a block (or an item page's field) out of the order: the block after it in its row starts the row instead (with its settings). */
  detach(id: string) {
    const block = this.byId.get(id);
    if (!block) {
      this.order = this.order.filter((o) => o !== id);
      return;
    }
    const row = this.rowOf(id) ?? [id];
    const at = row.indexOf(id);
    const next = row[at + 1];
    if (at === 0 && next) {
      this.set(next, (b) => {
        const { beside: _beside, ...rest } = b;
        return { ...rest, ...rowSettingsOf(block) };
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
 * A block moved next to another (dragged by its header); on an item page a field too, by its name. `order` is the page's
 * order of ids (blocks; on an item page fields too); the result's blocks are in the order given (the caller orders them by
 * `order` where that is their order). Beside (left, right) is for a block on a block; a field goes above or below what it
 * is dropped on (a block's: its whole row). Unchanged when a full row would take one more, or it is dropped on itself.
 */
export function placeBlock(order: string[], blocks: ViewBlock[], dragId: string, targetId: string, zone: RowZone): { order: string[]; blocks: ViewBlock[] } {
  const a = new Arrangement(order, blocks);
  if (dragId === targetId || !order.includes(dragId) || !order.includes(targetId)) return { order, blocks };
  if ((zone === "left" || zone === "right") && (!a.byId.has(dragId) || !a.byId.has(targetId))) return { order, blocks };
  const sameRow = a.rowOf(targetId)?.includes(dragId);
  if ((zone === "left" || zone === "right") && !sameRow && (a.rowOf(targetId)?.length ?? 0) >= ROW_MAX_BLOCKS) return { order, blocks };
  a.detach(dragId);
  const row = a.rowOf(targetId)!;
  const insert = (index: number) => a.order.splice(index, 0, dragId);
  if (zone === "left") {
    const target = a.byId.get(targetId)!;
    insert(a.order.indexOf(targetId));
    // It takes the target's place: the row's first, with the row's settings, when the target was.
    a.set(dragId, (b) => ({ ...b, ...(target.beside && { beside: true as const }), ...rowSettingsOf(target) }));
    a.set(targetId, (b) => ({ ...withoutRowSettings(b), beside: true }));
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
    a.set(id, (b) => ({ ...withoutRowSettings(b), beside: true }));
  } else {
    a.evenRow(id);
    const first = a.byId.get(a.rowOf(id)![0]);
    a.set(id, (b) => {
      const { beside: _beside, ...rest } = b;
      return { ...rest, ...(first && rowSettingsOf(first)) };
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

/** The ids of the row a block is in. */
export function rowOf(order: string[], blocks: ViewBlock[], id: string): string[] {
  return new Arrangement(order, blocks).rowOf(id) ?? [id];
}

/** The first block of the row a block is in (holding the row's settings). */
export function rowStart(order: string[], blocks: ViewBlock[], id: string): ViewBlock | undefined {
  const a = new Arrangement(order, blocks);
  const first = a.rowOf(id)?.[0];
  return first === undefined ? undefined : a.byId.get(first);
}

/** The row of a block given these settings (on its first block): a fit ("tallest" is the default, stored as none) and a height (undefined: none). */
export function setRowSettings(order: string[], blocks: ViewBlock[], id: string, settings: { fit: "tallest" | "shortest"; height: number | undefined }): ViewBlock[] {
  const first = rowStart(order, blocks, id);
  if (!first) return blocks;
  return blocks.map((b) =>
    b.id !== first.id
      ? b
      : { ...withoutRowSettings(b), ...(settings.fit === "shortest" && { rowFit: "shortest" as const }), ...(settings.height !== undefined && { rowHeight: normalizeRowHeight(settings.height) }) },
  );
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

/**
 * The blocks with a copy of one (Duplicate block): the same block (type, options, filter, sort, fields, name) under `id`,
 * in a row of its own right after the original's row. In the order given (a view's blocks are its order).
 */
export function withCopy(blocks: ViewBlock[], originalId: string, id: string): ViewBlock[] {
  const original = blocks.find((b) => b.id === originalId);
  if (!original) return blocks;
  const order = blocks.map((b) => b.id);
  const row = rowOf(order, blocks, originalId);
  const at = order.indexOf(row[row.length - 1]) + 1;
  const copy = loose({ ...structuredClone(original), id });
  return [...blocks.slice(0, at), copy, ...blocks.slice(at)];
}
