import { useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";
import { IconButton } from "@carbon/react";
import { Draggable } from "@carbon/icons-react";
import { useConfirm } from "./useConfirm";

/** `list` with the entries `start`…`end` (inclusive) moved so that they start at `to`. */
export function moveBlock<T>(list: T[], start: number, end: number, to: number): T[] {
  const rest = [...list.slice(0, start), ...list.slice(end + 1)];
  rest.splice(to, 0, ...list.slice(start, end + 1));
  return rest;
}

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const byIndex = (a: number, b: number) => a - b;
/** The selection is one connected group of rows. */
const isBlock = (ids: number[]) => ids.length > 0 && ids.every((v, i) => i === 0 || v === ids[i - 1] + 1);
/** Where a press or a Delete key belongs to the control, not to the list's selection. */
const INTERACTIVE = "input, textarea, select, button, a, label, [role=button], [role=combobox], [role=listbox], [role=checkbox], [contenteditable], .cds--list-box, .cds--popover-container";
const EDITABLE = "input, textarea, select, [contenteditable], [role=combobox]";

interface Options {
  count: number;
  /** Moves the rows `start`…`end` so that they start at `to` (see moveBlock). Called with each step of a drag. */
  onMove(start: number, end: number, to: number): void;
  /** Deletes these rows; leave out for a list whose entries can't be removed. */
  onDelete?(indices: number[]): void;
  /** False when these rows can't all go (e.g. the last one). */
  canDelete?(indices: number[]): boolean;
  /** Space with rows selected (and no control focused): e.g. to show / hide them all. */
  onSpace?(indices: number[]): void;
  /** For the confirmation: "field", "fields". */
  noun?: readonly [string, string];
}

/**
 * Selecting and reordering the rows of a list. Every row spreads `row(i)` (the rows are siblings in
 * one parent) and has a grab handle `handle(i)`; render `dialog` somewhere.
 *  - Select: click a row's blank part or its handle; Ctrl/Cmd toggles, Shift extends from the last
 *    click.
 *  - Reorder: drag a handle up or down; the rows follow the pointer, a line shows where they land,
 *    and they move when dropped. Dragging the handle of a selected, connected group moves the whole
 *    group. With the handle focused, Arrow up / down move the row or group.
 *  - Delete: with rows selected, Delete (outside a text input) asks to remove them all; Escape or a
 *    press elsewhere clears the selection.
 * Pointer events throughout, so touch screens work too.
 */
export function useReorder(options: Options) {
  const { noun = ["item", "items"] } = options;
  const group = useId();
  const [selected, setSelected] = useState<number[]>([]);
  const [dragging, setDragging] = useState<number[]>([]);
  /** While dragging: the gap (0…count) the rows would be dropped into (their own place included); null = not dragging. */
  const [dropSlot, setDropSlot] = useState<number | null>(null);
  const anchor = useRef(0);
  const { confirm, dialog } = useConfirm();
  // The latest options and selection, for handlers that outlive the render they were made in
  // (a drag is many steps; each reorders the list the page has by then).
  const latest = useRef({ ...options, selected });
  latest.current = { ...options, selected };

  // Rows added or removed: the selection no longer points at the same rows.
  useEffect(() => setSelected([]), [options.count]);

  const rowsOf = (row: Element) => [...(row.parentElement?.children ?? [])].filter((r) => r.hasAttribute("data-reorder-row"));

  const click = (index: number, mods: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) => {
    if (mods.shiftKey) {
      setSelected(range(Math.min(anchor.current, index), Math.max(anchor.current, index)));
      return;
    }
    anchor.current = index;
    if (mods.ctrlKey || mods.metaKey) setSelected((s) => (s.includes(index) ? s.filter((x) => x !== index) : [...s, index].sort(byIndex)));
    else setSelected([index]);
  };

  // While rows are selected: Escape clears, Delete removes, a press elsewhere clears.
  const any = selected.length > 0;
  useEffect(() => {
    if (!any) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        setSelected([]);
        return;
      }
      const t = e.target as HTMLElement;
      // Capture phase: a focused button (e.g. a popover's trigger) would otherwise take the Space.
      if (e.key === " " && latest.current.onSpace && !t.closest?.(".cds--modal, [data-reorder-handle]") && !t.closest?.(`[data-reorder-row] :is(${EDITABLE}, [role=checkbox], label)`)) {
        e.preventDefault();
        e.stopPropagation();
        latest.current.onSpace(latest.current.selected);
        return;
      }
      if ((e.key !== "Delete" && e.key !== "Backspace") || (e.target as HTMLElement).closest?.(EDITABLE) || (e.target as HTMLElement).closest?.(".cds--modal")) return;
      const { selected: ids, onDelete, canDelete } = latest.current;
      if (!onDelete || (canDelete && !canDelete(ids))) return;
      e.preventDefault();
      confirm({
        title: `Delete ${ids.length} ${ids.length === 1 ? noun[0] : noun[1]}?`,
        body: `The selected ${ids.length === 1 ? noun[0] : noun[1]} will be removed.`,
      }).then((ok) => {
        if (!ok) return;
        onDelete(ids);
        setSelected([]);
      });
    };
    const onPress = (e: globalThis.PointerEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest?.(".cds--modal")) return;
      const row = target.closest?.("[data-reorder-row]");
      // On a row's blank part or handle of this list: that is selecting.
      if (row?.getAttribute("data-reorder-group") === group && (!target.closest(INTERACTIVE) || target.closest("[data-reorder-handle]"))) return;
      setSelected([]);
    };
    // A button acts on Space's keyup: swallow that too after handling the keydown.
    const onKeyUp = (e: globalThis.KeyboardEvent) => {
      if (e.key === " " && latest.current.onSpace && !(e.target as HTMLElement).closest?.(".cds--modal, [data-reorder-handle], [data-reorder-row] :is(input, textarea, select, [contenteditable], [role=checkbox], label)")) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("keyup", onKeyUp, true);
    document.addEventListener("pointerdown", onPress, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("keyup", onKeyUp, true);
      document.removeEventListener("pointerdown", onPress, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [any, group]);

  /** A press on a row's blank part selects it (Ctrl/Cmd toggles, Shift extends). */
  const rowDown = (index: number, e: PointerEvent<HTMLElement>) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest(INTERACTIVE)) return;
    click(index, e);
  };

  const row = (index: number) => ({
    "data-reorder-row": "",
    "data-reorder-group": group,
    "data-selected": selected.includes(index) ? "" : undefined,
    "data-dragging": dragging.includes(index) ? "" : undefined,
    // The line sits on a row that isn't itself being dragged (those move with the pointer).
    "data-drop-before": dropSlot === index && !dragging.includes(index) ? "" : undefined,
    "data-drop-after": dropSlot !== null && index === dropSlot - 1 && !dragging.includes(index) && (dropSlot === options.count || dragging.includes(dropSlot)) ? "" : undefined,
    onPointerDown: (e: PointerEvent<HTMLElement>) => rowDown(index, e),
  });

  /** The rows a handle moves: the selected group when the row is in one, else just the row. */
  const blockOf = (index: number): [number, number] => {
    const ids = latest.current.selected;
    return ids.includes(index) && isBlock(ids) ? [ids[0], ids[ids.length - 1]] : [index, index];
  };

  /**
   * Dragging a handle: the rows (the group, when the row is in a selected one) follow the pointer
   * and a line shows where they would land; they move once, when dropped. Nothing is reordered
   * meanwhile, so the rows' positions measured at the start hold for the whole drag.
   */
  const start = (index: number) => (e: PointerEvent<HTMLElement>) => {
    const first = e.currentTarget.closest("[data-reorder-row]");
    if (e.button !== 0 || !first) return;
    e.preventDefault();
    const mods = { ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey };
    const modified = mods.ctrlKey || mods.metaKey || mods.shiftKey;
    const [from, last] = blockOf(index);
    const size = last - from + 1;
    const y0 = e.clientY;
    let moved = false;
    let rows: HTMLElement[] = [];
    let boxes: DOMRect[] = [];
    let to = from;
    const { cursor, userSelect } = document.body.style;
    const lift = (dy: number) => {
      for (const r of rows.slice(from, last + 1)) r.style.transform = `translateY(${dy}px)`;
    };
    // On the window: the pointer leaves the small handle as soon as the rows follow it.
    const onMovePointer = (ev: globalThis.PointerEvent) => {
      if (modified) return;
      if (!moved && Math.abs(ev.clientY - y0) < 4) return;
      if (!moved) {
        moved = true;
        rows = rowsOf(first) as HTMLElement[];
        boxes = rows.map((r) => r.getBoundingClientRect());
        document.body.style.cursor = "grabbing";
        document.body.dataset.reordering = "";
        document.body.style.userSelect = "none";
        setDragging(range(from, last));
      }
      lift(ev.clientY - y0);
      // The slot between rows the pointer is at: after as many rows as it is past the middle of.
      const slot = boxes.filter((box) => ev.clientY > box.top + box.height / 2).length;
      to = slot >= from && slot <= last + 1 ? from : slot > last ? slot - size : slot;
      // Where they are now is a slot too: the gap above the group (below it at the top of the list).
      setDropSlot(to === from ? (from > 0 ? from : last + 1) : slot);
    };
    const end = (ev: globalThis.PointerEvent) => {
      window.removeEventListener("pointermove", onMovePointer);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      document.body.style.cursor = cursor;
      delete document.body.dataset.reordering;
      document.body.style.userSelect = userSelect;
      lift(0);
      for (const r of rows) r.style.transform = "";
      setDragging([]);
      setDropSlot(null);
      if (!moved) click(index, mods);
      else if (ev.type === "pointerup" && to !== from) {
        latest.current.onMove(from, last, to);
        setSelected(range(to, to + size - 1));
      } else setSelected(range(from, last));
    };
    window.addEventListener("pointermove", onMovePointer);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  };

  const key = (index: number) => (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === " " && latest.current.onSpace && latest.current.selected.length > 0) {
      e.preventDefault();
      latest.current.onSpace(latest.current.selected);
      return;
    }
    const dir = e.key === "ArrowUp" ? -1 : e.key === "ArrowDown" ? 1 : 0;
    if (!dir) return;
    const [from, last] = blockOf(index);
    const size = last - from + 1;
    const to = from + dir;
    e.preventDefault();
    if (to < 0 || to + size > latest.current.count) return;
    const rows = rowsOf(e.currentTarget.closest("[data-reorder-row]")!);
    latest.current.onMove(from, last, to);
    if (latest.current.selected.includes(index)) setSelected(range(to, to + size - 1));
    // The handle that was focused is now on another row (or gone): focus this row's new handle.
    requestAnimationFrame(() => rowsOf(rows[0])[index + dir]?.querySelector<HTMLElement>("[data-reorder-handle]")?.focus());
  };

  const handle = (index: number) => (
    <IconButton
      autoAlign
      kind="ghost"
      size="sm"
      align="top"
      label="Drag to reorder. Click to select"
      className="reorder-handle"
      data-reorder-handle=""
      onPointerDown={start(index)}
      onKeyDown={key(index)}
      onMouseDown={(e: MouseEvent) => e.preventDefault()}
      // Space / Enter (no pointer, so no detail): toggles the row in the selection.
      onClick={(e: MouseEvent) => e.detail === 0 && click(index, { ctrlKey: true, metaKey: false, shiftKey: false })}
    >
      <Draggable />
    </IconButton>
  );

  return { row, handle, dialog };
}
