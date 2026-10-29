import { Fragment, useLayoutEffect, useRef, useState, type CSSProperties, type DragEvent, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { blockRows, canBeside, moveDivider, placeBlock, rowHeightPx, rowOf, rowShares, rowStart, setBeside, setRowSettings, setRowShares, SHARE_STEP, type RowSettings, type RowZone } from "../domain/blockRows";
import { withBlockCollapsed, type Collapsed, type ViewBlock } from "../domain/views";

// A page's blocks in rows (domain/blockRows.ts): a row's blocks side by side, where the row is wide enough (a container
// query, styles.css .block-row: so the narrow column of a page without "Full width" too), all as tall as the row: its
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

/**
 * A row collapses as one, not a block: any block's caret collapses or expands all its blocks, stored as its first block's
 * (so a row of one is collapsed as that block was). `store` keeps the page's collapse state.
 */
export function rowCollapse(order: string[], blocks: ViewBlock[], state: Collapsed, block: ViewBlock, store: (next: Collapsed) => void) {
  const first = rowStart(order, blocks, block.id)?.id ?? block.id;
  const collapsed = state.blocks.includes(first);
  return { collapsed, onToggle: () => store(withBlockCollapsed(state, first, !collapsed)) };
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
  render(entry: T, placed: PlacedBlock): ReactNode;
  /** A block dropped on another (absent: blocks aren't dragged here). */
  onPlace?(dragId: string, targetId: string, zone: RowZone): void;
  /** A row's shares changed by its divider (absent: not resizable). */
  onShares?(row: string[], shares: number[]): void;
}

/** The rows shown: entries grouped by their blocks' `beside`. */
export function shownRows<T extends { id: string }>(entries: T[], blockOf: (entry: T) => ViewBlock | undefined): T[][] {
  return blockRows(entries, blockOf);
}

/**
 * Which drop zone the pointer is in: a block dragged over a row standing side by side, the outer quarters beside the block;
 * else above or below it.
 */
export function zoneAt(e: DragEvent, cell: HTMLElement): RowZone {
  const r = cell.getBoundingClientRect();
  const cells = cell.parentElement;
  const sideBySide = e.dataTransfer.types.includes(BLOCK_MIME) && !!cells && getComputedStyle(cells).flexDirection === "row";
  if (sideBySide) {
    const x = (e.clientX - r.left) / r.width;
    if (x < 0.25) return "left";
    if (x > 0.75) return "right";
  }
  return e.clientY - r.top < r.height / 2 ? "top" : "bottom";
}

export function BlockRows<T extends { id: string }>({ entries, blockOf, render, onPlace, onShares }: Props<T>) {
  const [drop, setDrop] = useState<{ id: string; zone: RowZone } | null>(null);
  const rows = shownRows(entries, blockOf);
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
            // Above or below a block of the row: a line across the whole row (it gets a row of its own there).
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
                {/* Beside it: a line at its edge (nothing is split: it joins the row). */}
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

/** One row: its blocks, with a divider between each two (a line; side by side, it changes their shares). */
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
  const cells = useRef<HTMLDivElement>(null);
  const startResize = (i: number) => (e: PointerEvent<HTMLDivElement>) => {
    if (!onShares || e.button !== 0) return;
    e.preventDefault();
    const box = cells.current;
    if (!box) return;
    // The width the shares divide: the row's without its dividers.
    const dividers = [...box.querySelectorAll<HTMLElement>(":scope > .block-row__divider")].reduce((n, d) => n + d.offsetWidth, 0);
    const width = box.clientWidth - dividers;
    if (width <= 0) return;
    const x0 = e.clientX;
    let next = stored;
    const move = (ev: globalThis.PointerEvent) => {
      next = moveDivider(stored, i, ((ev.clientX - x0) / width) * 100);
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
    if (!onShares || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
    e.preventDefault();
    onShares(ids, moveDivider(stored, i, e.key === "ArrowLeft" ? -SHARE_STEP : SHARE_STEP));
  };
  // Several blocks: the row's height, measured from those with a height of their own (not those filling it), in px.
  const several = entries.length > 1;
  const [bodyPx, setBodyPx] = useState<number | null>(null);
  const fit = settings.rowFit ?? "tallest";
  const limit = settings.rowHeight;
  useLayoutEffect(() => {
    const box = cells.current;
    if (!several || !box) return setBodyPx(null);
    const measure = () => {
      const contents = [...box.querySelectorAll<HTMLElement>(":scope > .block-cell > .block:not(.block--fills) > .block__body > .block__content")];
      const heights = contents.map((c) => c.offsetHeight).filter((h) => h > 0);
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      const px = Math.round(rowHeightPx({ ...(fit === "shortest" && { rowFit: "shortest" }), ...(limit !== undefined && { rowHeight: limit }) }, heights, rem));
      setBodyPx((old) => (old === px ? old : px));
    };
    const sizes = new ResizeObserver(measure);
    const watch = () => {
      sizes.disconnect();
      for (const c of box.querySelectorAll(":scope > .block-cell > .block > .block__body > .block__content")) sizes.observe(c);
      measure();
    };
    // Blocks come and go (their items loading, collapsed, a search leaving one out): watched anew.
    const tree = new MutationObserver(watch);
    tree.observe(box, { childList: true, subtree: true });
    watch();
    return () => {
      sizes.disconnect();
      tree.disconnect();
    };
  }, [several, fit, limit]);
  // One block: its own height, at most or at least the limit.
  const one = !several && limit !== undefined ? (fit === "shortest" ? "block-row--min" : "block-row--max") : null;
  const className = ["block-row", several && bodyPx !== null && "block-row--fit", one, onShares && "block-row--resizable"].filter(Boolean).join(" ");
  const style = several && bodyPx !== null ? { "--row-body": `${bodyPx}px` } : one ? { "--row-limit": `${limit}rem` } : undefined;
  return (
    <div className={className} style={style as CSSProperties | undefined} onDragEnd={onDragEnd}>
      {dropLine && <div className={`block-drop block-drop--${dropLine}`} aria-hidden="true" />}
      <div className="block-row__cells" ref={cells}>
        {entries.map((e, i) => (
          <Fragment key={e.id}>
            {i > 0 && (
              // Side by side it is a handle (role separator, its value the share before it); stacked, only the line between.
              <div
                className="block-row__divider"
                role={onShares ? "separator" : undefined}
                aria-orientation={onShares ? "vertical" : undefined}
                aria-label={onShares ? "Resize blocks" : undefined}
                aria-valuenow={onShares ? Math.round(shares[i - 1]) : undefined}
                aria-valuemin={onShares ? 0 : undefined}
                aria-valuemax={onShares ? 100 : undefined}
                tabIndex={onShares ? 0 : undefined}
                onPointerDown={startResize(i)}
                onKeyDown={keyResize(i)}
              />
            )}
            {cell(e, shares[i])}
          </Fragment>
        ))}
      </div>
    </div>
  );
}
