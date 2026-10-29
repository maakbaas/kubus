import { Fragment, useRef, useState, type CSSProperties, type DragEvent, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { blockRows, canBeside, moveDivider, placeBlock, rowShares, rowStart, setBeside, setRowMaxHeight, setRowShares, SHARE_STEP, type RowZone } from "../domain/blockRows";
import type { ViewBlock } from "../domain/views";

// A page's blocks in rows (domain/blockRows.ts): a row's blocks side by side, where the row is wide enough (a container
// query, styles.css .block-row), as tall as each other, each at most the row's max height (then scrolling inside); where it
// isn't (a phone, a narrow pane) or "Full width" is off, stacked as they always were, their heights their own. A block is
// dragged by its name onto another: beside it (its left or right quarter, side by side only) or in a row of its own above or
// below that block's row. The divider between two blocks in a row changes their shares (drag it, or its arrow keys).

/** A block's place in its row, as Block settings edits it. */
export interface RowControls {
  /** It is beside the block above it (in its row). */
  beside: boolean;
  /** It can be: a block is right above it, and that row has room. */
  canBeside: boolean;
  onBeside(on: boolean): void;
  /** Its row's max height (rem), undefined: none. */
  maxHeight: number | undefined;
  onMaxHeight(rem: number | undefined): void;
}

/** What a row is made of, as shown (held as it was while a toolbar panel is open: nothing moves under the pointer). */
export type RowShape = Pick<ViewBlock, "beside" | "width" | "rowMaxHeight">;
export const rowShape = (blocks: ViewBlock[]): Record<string, RowShape> =>
  Object.fromEntries(blocks.map((b) => [b.id, { beside: b.beside, width: b.width, rowMaxHeight: b.rowMaxHeight }]));

/**
 * Arranging the rows of a page whose blocks are its order (a collection view, a dashboard tab): Block settings' row
 * controls, a drop, a divider. `arrange` applies a change to the blocks (the shown ones and the stored ones alike).
 */
export function listRowActions(blocks: ViewBlock[], arrange: (change: (blocks: ViewBlock[]) => ViewBlock[]) => void) {
  const ids = (list: ViewBlock[]) => list.map((b) => b.id);
  return {
    controls: (block: ViewBlock): RowControls => ({
      beside: !!block.beside,
      canBeside: canBeside(ids(blocks), blocks, block.id),
      onBeside: (on) => arrange((list) => setBeside(ids(list), list, block.id, on)),
      maxHeight: rowStart(ids(blocks), blocks, block.id)?.rowMaxHeight,
      onMaxHeight: (rem) => arrange((list) => setRowMaxHeight(ids(list), list, block.id, rem)),
    }),
    place: (dragId: string, targetId: string, zone: RowZone) =>
      arrange((list) => {
        const r = placeBlock(ids(list), list, dragId, targetId, zone);
        return r.order.map((id) => r.blocks.find((b) => b.id === id)!);
      }),
    shares: (row: string[], shares: number[]) => arrange((list) => setRowShares(list, row, shares)),
  };
}

const BLOCK_MIME = "application/x-kubus-block";

/** What the page gives a block it renders in a row. */
export interface PlacedBlock {
  /** Starts dragging it by its name (absent: it can't be moved here). */
  onDragStart?(e: DragEvent): void;
}

interface Props<T extends { id: string }> {
  entries: T[];
  /** The block an entry is (absent: a field of an item page, a row of its own). */
  blockOf(entry: T): ViewBlock | undefined;
  /** Rows at all ("Full width" on); off, every block stands alone, as before rows. */
  wide: boolean;
  /** Rows as shown (held while a panel is open); a block not in it, its own. */
  shape?: Record<string, RowShape>;
  render(entry: T, placed: PlacedBlock): ReactNode;
  /** A block dropped on another (absent: blocks aren't dragged here). */
  onPlace?(dragId: string, targetId: string, zone: RowZone): void;
  /** A row's shares changed by its divider (absent: not resizable). */
  onShares?(row: string[], shares: number[]): void;
}

/** The rows shown: entries grouped by their (held) shape where "Full width" is on, else each alone. */
export function shownRows<T extends { id: string }>(entries: T[], blockOf: (entry: T) => ViewBlock | undefined, wide: boolean, shape?: Record<string, RowShape>): T[][] {
  return wide ? blockRows(entries, (e) => shapeOf(blockOf(e), shape)) : entries.map((e) => [e]);
}
const shapeOf = (block: ViewBlock | undefined, shape?: Record<string, RowShape>): RowShape | undefined => block && (shape?.[block.id] ?? block);

/** Which drop zone the pointer is in: the outer quarters beside the block where the row stands side by side, else above or below. */
function zoneAt(e: DragEvent, cell: HTMLElement): RowZone {
  const r = cell.getBoundingClientRect();
  const cells = cell.parentElement;
  const sideBySide = !!cells && getComputedStyle(cells).flexDirection === "row";
  if (sideBySide) {
    const x = (e.clientX - r.left) / r.width;
    if (x < 0.25) return "left";
    if (x > 0.75) return "right";
  }
  return e.clientY - r.top < r.height / 2 ? "top" : "bottom";
}

export function BlockRows<T extends { id: string }>({ entries, blockOf, wide, shape, render, onPlace, onShares }: Props<T>) {
  const [drop, setDrop] = useState<{ id: string; zone: RowZone } | null>(null);
  const shaped = (e: T) => shapeOf(blockOf(e), shape);
  const rows = shownRows(entries, blockOf, wide, shape);
  const dragStart = (id: string) => (e: DragEvent) => {
    e.dataTransfer.setData(BLOCK_MIME, id);
    e.dataTransfer.effectAllowed = "move";
  };
  const isBlockDrag = (e: DragEvent) => e.dataTransfer.types.includes(BLOCK_MIME);
  return (
    <>
      {rows.map((row) => {
        const first = row[0];
        if (!blockOf(first)) return <Fragment key={first.id}>{render(first, {})}</Fragment>;
        const max = wide ? shaped(first)?.rowMaxHeight : undefined;
        return (
          <Row
            key={first.id}
            ids={row.map((e) => e.id)}
            shares={rowShares(row.map((e) => shaped(e) ?? {}))}
            wide={wide}
            maxHeight={max}
            onShares={onShares}
            cell={(e: T, share: number) => (
              <div
                className="block-cell"
                style={{ "--share": share } as CSSProperties}
                onDragOver={(ev) => {
                  if (!onPlace || !isBlockDrag(ev)) return;
                  ev.preventDefault();
                  ev.dataTransfer.dropEffect = "move";
                  const zone = zoneAt(ev, ev.currentTarget);
                  if (drop?.id !== e.id || drop.zone !== zone) setDrop({ id: e.id, zone });
                }}
                onDragLeave={(ev) => !ev.currentTarget.contains(ev.relatedTarget as Node) && setDrop((d) => (d?.id === e.id ? null : d))}
                onDrop={(ev) => {
                  if (!onPlace || !isBlockDrag(ev)) return;
                  ev.preventDefault();
                  const dragId = ev.dataTransfer.getData(BLOCK_MIME);
                  setDrop(null);
                  if (dragId) onPlace(dragId, e.id, zoneAt(ev, ev.currentTarget));
                }}
              >
                {render(e, onPlace ? { onDragStart: dragStart(e.id) } : {})}
                {drop?.id === e.id && <div className={`ws-drop ws-drop--${drop.zone}`} aria-hidden="true" />}
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
  wide,
  maxHeight,
  onShares,
  cell,
  onDragEnd,
}: {
  ids: string[];
  entries: T[];
  shares: number[];
  wide: boolean;
  maxHeight: number | undefined;
  onShares?(row: string[], shares: number[]): void;
  cell(entry: T, share: number): ReactNode;
  onDragEnd(): void;
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
  const className = ["block-row", wide && "block-row--wide", wide && maxHeight !== undefined && "block-row--capped", onShares && "block-row--resizable"].filter(Boolean).join(" ");
  return (
    <div className={className} style={maxHeight !== undefined ? ({ "--row-max": `${maxHeight}rem` } as CSSProperties) : undefined} onDragEnd={onDragEnd}>
      <div className="block-row__cells" ref={cells}>
        {entries.map((e, i) => (
          <Fragment key={e.id}>
            {i > 0 && (
              // Side by side it is a handle (role separator, its value the share before it); stacked, only the line between.
              <div
                className="block-row__divider"
                role={onShares && wide ? "separator" : undefined}
                aria-orientation={onShares && wide ? "vertical" : undefined}
                aria-label={onShares && wide ? "Resize blocks" : undefined}
                aria-valuenow={onShares && wide ? Math.round(shares[i - 1]) : undefined}
                aria-valuemin={onShares && wide ? 0 : undefined}
                aria-valuemax={onShares && wide ? 100 : undefined}
                tabIndex={onShares && wide ? 0 : undefined}
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
