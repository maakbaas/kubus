import { createContext, Fragment, useLayoutEffect, useRef, useState, type CSSProperties, type DragEvent, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { blockRows, blockWidths, canBeside, MIN_COLUMN_REM, moveDivider, rowLines, placeBlock, rowHeightPx, rowOf, rowShares, rowStart, setBeside, setRowSettings, setRowShares, SHARE_STEP, type RowSettings, type RowZone } from "../domain/blockRows";
import { type Collapsed, type ViewBlock } from "../domain/views";

// A page's blocks in rows (domain/blockRows.ts): a row's blocks side by side, on lines by their widths (`rowLines`: each
// its share of the row, 15rem at least; a line takes them while they fit; measured here, so the narrow column of a page
// without "Full width" too, and `.block-row--side`), all as tall as the row: its
// tallest or shortest block's height (measured here, `rowHeightPx`), at most or at least its height setting; what is taller
// scrolls inside, a chart, map or HTML component fills it. A row of one block keeps its height, only limited (at most or at
// least). Where it isn't wide enough (a phone, a narrow pane) the blocks stack as they always were, their heights their own.
// A block is
// dragged by its name onto another: beside it (its left or right quarter, side by side only) or in a row of its own above or
// below that block's row. The divider between two blocks in a row changes their shares (drag it, or its arrow keys).

/** A block's place in its row, as Block settings edits it. */
export interface RowControls {
  /** It is beside the block above it (in its row). */
  beside: boolean;
  /** It can be: a block is right above it, and that row has room. */
  canBeside: boolean;
  onBeside(on: boolean): void;
  /** Its row has more blocks than it: side by side its Height and Aspect ratio are set aside (it fills the row). */
  inRow: boolean;
  /** Its row's height: as its tallest or shortest block, and the limit (rem; undefined: none): at most, or at least. */
  fit: "tallest" | "shortest";
  height: number | undefined;
  onRowSettings(settings: { fit: "tallest" | "shortest"; height: number | undefined }): void;
}

/** A block's collapse: its own, and its row's (side by side a row collapses as one). */
export interface RowCollapse {
  own: { collapsed: boolean; onToggle(): void };
  row: { collapsed: boolean; onToggle(): void };
}

/** Whether the blocks rendered within are side by side in a row of several (a row collapses as one then), set by Row. */
export const RowSideBySide = createContext(false);

/**
 * Collapsing is stored per block (`state.blocks`), so on a phone, where a row's blocks stack, each collapses on its own,
 * and a block dragged out of its row keeps its own state. Side by side a row is collapsed while any of its blocks is: its
 * caret then expands them all; on an expanded row it collapses the block whose caret it is (and so the row). Which of
 * the two a block follows is up to where it is shown (`RowSideBySide`, BlockView). `store` keeps the page's state.
 */
export function rowCollapse(order: string[], blocks: ViewBlock[], state: Collapsed, block: ViewBlock, store: (next: Collapsed) => void): RowCollapse {
  const row = rowOf(order, blocks, block.id);
  const ids = row.length > 0 ? row : [block.id];
  const own = state.blocks.includes(block.id);
  const rowCollapsed = ids.some((id) => state.blocks.includes(id));
  const without = (gone: string[]) => state.blocks.filter((id) => !gone.includes(id));
  return {
    own: { collapsed: own, onToggle: () => store({ ...state, blocks: own ? without([block.id]) : [...state.blocks, block.id] }) },
    row: { collapsed: rowCollapsed, onToggle: () => store({ ...state, blocks: rowCollapsed ? without(ids) : [...state.blocks, block.id] }) },
  };
}

/** A block's row controls from the page's order of ids and its blocks; `arrange` applies a change to the blocks. */
export function rowControls(order: string[], blocks: ViewBlock[], block: ViewBlock, arrange: (change: (blocks: ViewBlock[], order: string[]) => ViewBlock[]) => void): RowControls {
  const first = rowStart(order, blocks, block.id);
  return {
    beside: !!block.beside,
    canBeside: canBeside(order, blocks, block.id),
    onBeside: (on) => arrange((list, ids) => setBeside(ids, list, block.id, on)),
    inRow: rowOf(order, blocks, block.id).length > 1,
    fit: first?.rowFit ?? "tallest",
    height: first?.rowHeight,
    onRowSettings: (settings) => arrange((list, ids) => setRowSettings(ids, list, block.id, settings)),
  };
}


/**
 * Arranging the rows of a page whose blocks are its order (a collection view, a dashboard tab): Block settings' row
 * controls, a drop, a divider. `arrange` applies a change to the blocks (the shown ones and the stored ones alike).
 */
export function listRowActions(blocks: ViewBlock[], arrange: (change: (blocks: ViewBlock[]) => ViewBlock[]) => void) {
  const ids = (list: ViewBlock[]) => list.map((b) => b.id);
  return {
    controls: (block: ViewBlock): RowControls => rowControls(ids(blocks), blocks, block, (change) => arrange((list) => change(list, ids(list)))),
    place: (dragId: string, targetId: string, zone: RowZone) =>
      arrange((list) => {
        const r = placeBlock(ids(list), list, dragId, targetId, zone);
        return r.order.map((id) => r.blocks.find((b) => b.id === id)!);
      }),
    shares: (row: string[], shares: number[]) => arrange((list) => setRowShares(list, row, shares)),
  };
}

// What is dragged: a block (it can go beside another) or an item page's field (above or below only).
const BLOCK_MIME = "application/x-kubus-block";
const FIELD_MIME = "application/x-kubus-field";

/** Starts dragging a block or an item page's field (by its name). */
export const dragStart = (id: string, kind: "block" | "field") => (e: DragEvent) => {
  e.dataTransfer.setData(kind === "block" ? BLOCK_MIME : FIELD_MIME, id);
  e.dataTransfer.effectAllowed = "move";
};
/** Whether a drag is of a block or a field of the page (dropped here), and which. */
export const isEntryDrag = (e: DragEvent) => e.dataTransfer.types.includes(BLOCK_MIME) || e.dataTransfer.types.includes(FIELD_MIME);
export const draggedEntry = (e: DragEvent) => e.dataTransfer.getData(BLOCK_MIME) || e.dataTransfer.getData(FIELD_MIME);

/** What the page gives a block it renders in a row. */
export interface PlacedBlock {
  /** Starts dragging it by its name (absent: it can't be moved here). */
  onDragStart?(e: DragEvent): void;
}

interface Props<T extends { id: string }> {
  entries: T[];
  /** The block an entry is (absent: a field of an item page, a row of its own). */
  blockOf(entry: T): ViewBlock | undefined;
  /**
   * Which blocks are beside the block above them, as shown: held while a toolbar panel is open (`heldBeside`), so a block
   * put beside another in its Block settings doesn't jump away with its open panel; absent: the blocks' own.
   */
  beside?: Record<string, boolean>;
  render(entry: T, placed: PlacedBlock): ReactNode;
  /** A block dropped on another (absent: blocks aren't dragged here). */
  onPlace?(dragId: string, targetId: string, zone: RowZone): void;
  /** A row's shares changed by its divider (absent: not resizable). */
  onShares?(row: string[], shares: number[]): void;
}

/** Each block's `beside`, to hold while a panel is open (`usePanelsOpen().hold`). */
export const besideOf = (blocks: ViewBlock[]): Record<string, boolean> => Object.fromEntries(blocks.map((b) => [b.id, !!b.beside]));

/** The rows shown: entries grouped by their blocks' `beside` (or the held ones). */
export function shownRows<T extends { id: string }>(entries: T[], blockOf: (entry: T) => ViewBlock | undefined, beside?: Record<string, boolean>): T[][] {
  return blockRows(entries, (e) => {
    const block = blockOf(e);
    return block && { beside: (beside?.[block.id] ?? block.beside) ? true : undefined };
  });
}

/**
 * Which drop zone the pointer is in: a block dragged over a row standing side by side, the outer quarters beside the block;
 * else above or below it.
 */
export function zoneAt(e: DragEvent, cell: HTMLElement): RowZone {
  const r = cell.getBoundingClientRect();
  const cells = cell.parentElement;
  const besideZones = e.dataTransfer.types.includes(BLOCK_MIME) && !!cells && getComputedStyle(cells).flexDirection === "row";
  if (besideZones) {
    const x = (e.clientX - r.left) / r.width;
    if (x < 0.25) return "left";
    if (x > 0.75) return "right";
  }
  return e.clientY - r.top < r.height / 2 ? "top" : "bottom";
}

export function BlockRows<T extends { id: string }>({ entries, blockOf, beside, render, onPlace, onShares }: Props<T>) {
  const [drop, setDrop] = useState<{ id: string; zone: RowZone } | null>(null);
  const rows = shownRows(entries, blockOf, beside);
  return (
    <>
      {rows.map((row) => {
        const first = row[0];
        if (!blockOf(first)) return <Fragment key={first.id}>{render(first, {})}</Fragment>;
        const head = blockOf(first)!;
        return (
          <Row
            key={first.id}
            ids={row.map((e) => e.id)}
            shares={rowShares(row.map((e) => blockOf(e) ?? {}))}
            settings={{ ...(head.rowFit && { rowFit: head.rowFit }), ...(head.rowHeight !== undefined && { rowHeight: head.rowHeight }) }}
            onShares={onShares}
            // Above or below a block of the row: the half of the whole row (it gets a row of its own there).
            dropLine={drop && row.some((e) => e.id === drop.id) && (drop.zone === "top" || drop.zone === "bottom") ? drop.zone : null}
            cell={(e: T, share: number) => (
              <div
                className="block-cell"
                style={{ "--share": share } as CSSProperties}
                onDragOver={(ev) => {
                  if (!onPlace || !isEntryDrag(ev)) return;
                  ev.preventDefault();
                  ev.dataTransfer.dropEffect = "move";
                  const zone = zoneAt(ev, ev.currentTarget);
                  if (drop?.id !== e.id || drop.zone !== zone) setDrop({ id: e.id, zone });
                }}
                onDragLeave={(ev) => !ev.currentTarget.contains(ev.relatedTarget as Node) && setDrop((d) => (d?.id === e.id ? null : d))}
                onDrop={(ev) => {
                  if (!onPlace || !isEntryDrag(ev)) return;
                  ev.preventDefault();
                  const dragId = draggedEntry(ev);
                  setDrop(null);
                  if (dragId) onPlace(dragId, e.id, zoneAt(ev, ev.currentTarget));
                }}
              >
                {render(e, onPlace ? { onDragStart: dragStart(e.id, "block") } : {})}
                {/* Beside it: the half of it the block lands next to (it joins the row). */}
                {drop?.id === e.id && (drop.zone === "left" || drop.zone === "right") && <div className={`block-drop block-drop--${drop.zone}`} aria-hidden="true" />}
              </div>
            )}
            entries={row}
            onDragEnd={() => setDrop(null)}
          />
        );
      })}
    </>
  );
}

/**
 * One row: its blocks, with a divider between each two (a line; side by side on one line, it changes their shares). Where
 * its blocks don't all fit side by side at their widths (each its share, MIN_COLUMN_REM at least), on lines of those that
 * do, in order (`rowLines`), every line the row's height as if unbroken, its blocks splitting it by those widths
 * (dividers only resize a row on one line); narrower than a row can be, stacked as on a phone.
 */
function Row<T extends { id: string }>({
  ids,
  entries,
  shares: stored,
  settings,
  onShares,
  cell,
  onDragEnd,
  dropLine,
}: {
  ids: string[];
  entries: T[];
  shares: number[];
  settings: RowSettings;
  onShares?(row: string[], shares: number[]): void;
  cell(entry: T, share: number): ReactNode;
  onDragEnd(): void;
  dropLine: "top" | "bottom" | null;
}) {
  // While a divider is dragged: the shares shown (stored when it is let go).
  const [moving, setMoving] = useState<number[] | null>(null);
  const shares = moving ?? stored;
  const rowEl = useRef<HTMLDivElement>(null);
  const count = entries.length;
  // Its lines (the blocks' indices; null: stacked) and the blocks' widths (rem) splitting a line, by the row's width.
  const [layout, setLayout] = useState<{ lines: number[][] | null; widths: number[] }>({ lines: null, widths: [] });
  const sharesKey = stored.join(",");
  useLayoutEffect(() => {
    const el = rowEl.current;
    if (!el) return;
    const update = () => {
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      const shares = sharesKey.split(",").map(Number);
      const lines = rowLines(shares, el.clientWidth, rem);
      const widths = blockWidths(shares, el.clientWidth, rem);
      setLayout((old) => (JSON.stringify(old) === JSON.stringify({ lines, widths }) ? old : { lines, widths }));
    };
    const sizes = new ResizeObserver(update);
    sizes.observe(el);
    update();
    return () => sizes.disconnect();
  }, [sharesKey]);
  // Wide enough for rows: its lines (even of one block each) all the row's height; a row of one, its height limit.
  const side = !!layout.lines;
  const lines = layout.lines && side ? layout.lines.map((l) => l.map((i) => entries[i]).filter(Boolean)) : [entries];
  const resizable = !!onShares && side && lines.length === 1 && count > 1;
  /** The first line's blocks container (the one resized: a row on one line), and the width its shares divide. */
  const lineWidth = () => {
    const box = rowEl.current?.querySelector<HTMLElement>(":scope > .block-row__cells");
    if (!box) return 0;
    const dividers = [...box.querySelectorAll<HTMLElement>(":scope > .block-row__divider")].reduce((n, d) => n + d.offsetWidth, 0);
    return box.clientWidth - dividers;
  };
  /** A block's least share of the row (percent): MIN_COLUMN_REM of its width. */
  const leastShare = (width: number) => ((MIN_COLUMN_REM * (parseFloat(getComputedStyle(document.documentElement).fontSize) || 16)) / width) * 100;
  const startResize = (i: number) => (e: PointerEvent<HTMLDivElement>) => {
    if (!resizable || !onShares || e.button !== 0) return;
    e.preventDefault();
    const width = lineWidth();
    if (width <= 0) return;
    const x0 = e.clientX;
    let next = stored;
    const move = (ev: globalThis.PointerEvent) => {
      next = moveDivider(stored, i, ((ev.clientX - x0) / width) * 100, leastShare(width));
      setMoving(next);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setMoving(null);
      if (next !== stored) onShares(ids, next);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const keyResize = (i: number) => (e: KeyboardEvent<HTMLDivElement>) => {
    if (!resizable || !onShares || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
    e.preventDefault();
    const width = lineWidth();
    onShares(ids, moveDivider(stored, i, e.key === "ArrowLeft" ? -SHARE_STEP : SHARE_STEP, width > 0 ? leastShare(width) : undefined));
  };
  // Several blocks: the row's height, measured from each block's own (what a table, cards or text take, overhang too; a
  // chart's, map's or HTML component's Height, `.block__own`, which then fills the row), in px. Over all its lines.
  const several = count > 1;
  const [bodyPx, setBodyPx] = useState<number | null>(null);
  const fit = settings.rowFit ?? "tallest";
  const limit = settings.rowHeight;
  useLayoutEffect(() => {
    const box = rowEl.current;
    if (!several || !box) return setBodyPx(null);
    const CELL = ":scope > .block-row__cells > .block-cell";
    const measure = () => {
      const contents = [...box.querySelectorAll<HTMLElement>(`${CELL} > .block:not(.block--fills) > .block__body > .block__content`)];
      // Collapsed blocks have no body: not counted.
      const boxes = [...box.querySelectorAll<HTMLElement>(`${CELL} > .block--fills:has(> .block__body) > .block__own > div`)];
      const heights = [...contents.map((c) => c.scrollHeight), ...boxes.map((b) => b.offsetHeight)].filter((h) => h > 0);
      // A stat, a meter, a compact chart: never cut or scrolled, the row at least as tall.
      const floors = [
        ...[...box.querySelectorAll<HTMLElement>(`${CELL} > .block--fixed > .block__body > .block__content`)].map((c) => c.scrollHeight),
        // A block filling the row that can't be less tall than this (a stat: its text and a 4rem sparkline).
        ...[...box.querySelectorAll<HTMLElement>(`${CELL} > .block--fills > .block__body [data-row-min]`)].map((el) => Number(el.dataset.rowMin) || 0),
      ];
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      const px = Math.round(rowHeightPx({ ...(fit === "shortest" && { rowFit: "shortest" }), ...(limit !== undefined && { rowHeight: limit }) }, heights, rem, floors));
      setBodyPx((old) => (old === px ? old : px));
    };
    const sizes = new ResizeObserver(measure);
    const watch = () => {
      sizes.disconnect();
      for (const c of box.querySelectorAll(`${CELL} > .block > .block__body > .block__content, ${CELL} > .block > .block__own > div`)) sizes.observe(c);
      measure();
    };
    // Blocks come and go (their items loading, collapsed, a search leaving one out, onto another line): watched anew.
    const tree = new MutationObserver(watch);
    tree.observe(box, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-row-min"] });
    watch();
    return () => {
      sizes.disconnect();
      tree.disconnect();
    };
  }, [several, fit, limit]);
  // One block: its own height, at most or at least the limit.
  const one = !several && limit !== undefined ? (fit === "shortest" ? "block-row--min" : "block-row--max") : null;
  const className = ["block-row", side && "block-row--side", several && bodyPx !== null && "block-row--fit", one, resizable && "block-row--resizable"].filter(Boolean).join(" ");
  const style = several && bodyPx !== null ? { "--row-body": `${bodyPx}px` } : one ? { "--row-limit": `${limit}rem` } : undefined;
  let at = 0;
  return (
    <RowSideBySide.Provider value={side && several}>
    <div ref={rowEl} className={className} style={style as CSSProperties | undefined} onDragEnd={onDragEnd}>
      {dropLine && <div className={`block-drop block-drop--${dropLine}`} aria-hidden="true" />}
      {lines.map((line, l) => {
        const first = at;
        at += line.length;
        // On one line, the blocks' shares (the divider moving them); wrapped, a line split by its blocks' widths.
        const part = (i: number) => (lines.length === 1 ? shares[i] : (layout.widths[i] ?? shares[i]));
        const sum = line.reduce((n, _, k) => n + part(first + k), 0) || 1;
        return (
          <Fragment key={l}>
            {l > 0 && <div className="block-row__break" aria-hidden="true" />}
            <div className="block-row__cells">
              {line.map((e, k) => {
                const i = first + k;
                return (
                  <Fragment key={e.id}>
                    {k > 0 && (
                      // On one line side by side it is a handle (role separator, its value the share before it); else only the line between.
                      <div
                        className="block-row__divider"
                        role={resizable ? "separator" : undefined}
                        aria-orientation={resizable ? "vertical" : undefined}
                        aria-label={resizable ? "Resize blocks" : undefined}
                        aria-valuenow={resizable ? Math.round(shares[i - 1]) : undefined}
                        aria-valuemin={resizable ? 0 : undefined}
                        aria-valuemax={resizable ? 100 : undefined}
                        tabIndex={resizable ? 0 : undefined}
                        onPointerDown={startResize(i)}
                        onKeyDown={keyResize(i)}
                      />
                    )}
                    {cell(e, (part(i) * 100) / sum)}
                  </Fragment>
                );
              })}
            </div>
          </Fragment>
        );
      })}
    </div>
    </RowSideBySide.Provider>
  );
}
