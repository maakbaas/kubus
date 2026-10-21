// Carries "where the user was" in a read-only value into its editor: the click point,
// and any text selected by dragging, so editing starts with the caret / selection there.

export interface Point {
  x: number;
  y: number;
}

export interface EditStart {
  /** Where the value was clicked (viewport coordinates). */
  point: Point;
  /** Text selected in the view: viewport points just inside its start and end. */
  selection?: { from: Point; to: Point };
  /** Selection, or the clicked caret position, as character offsets in the displayed text. */
  range?: { start: number; end: number };
  /** Height of the whole read-only field, so the editor can hold it while it renders. */
  fieldHeight?: number;
  /** The clicked text wrapped onto several lines: a one-line text value then edits in a box that
   *  wraps the same way, in place of the text (table cells), so nothing moves. */
  wrapped?: boolean;
}

/** Character offset of (node, offset) within the text of `container`. */
function textOffset(container: HTMLElement, node: Node, offset: number): number {
  const r = document.createRange();
  r.selectNodeContents(container);
  r.setEnd(node, offset);
  return r.toString().length;
}

/** Caret range at a viewport point (standard API first, then Chromium/WebKit's). */
function caretRangeAt(x: number, y: number): Range | null {
  const doc = document as Document & {
    caretPositionFromPoint?(x: number, y: number): { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?(x: number, y: number): Range | null;
  };
  const pos = doc.caretPositionFromPoint?.(x, y);
  if (pos) {
    const r = document.createRange();
    r.setStart(pos.offsetNode, pos.offset);
    return r;
  }
  return doc.caretRangeFromPoint?.(x, y) ?? null;
}

/** Reads the click and the current text selection inside `container`. */
export function captureEditStart(container: HTMLElement, e: { clientX: number; clientY: number }): EditStart {
  const start: EditStart = {
    point: { x: e.clientX, y: e.clientY },
    fieldHeight: (container.closest(".view-field") ?? container).getBoundingClientRect().height,
  };
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed && sel.rangeCount > 0) {
    const range = sel.getRangeAt(0);
    if (container.contains(range.startContainer) && container.contains(range.endContainer)) {
      const rects = range.getClientRects();
      const first = rects[0];
      const last = rects[rects.length - 1];
      if (first && last) {
        start.selection = {
          from: { x: first.left + 1, y: first.top + first.height / 2 },
          to: { x: last.right - 1, y: last.top + last.height / 2 },
        };
      }
      start.range = {
        start: textOffset(container, range.startContainer, range.startOffset),
        end: textOffset(container, range.endContainer, range.endOffset),
      };
      return start;
    }
  }
  const caret = caretRangeAt(e.clientX, e.clientY);
  if (caret && container.contains(caret.startContainer)) {
    const at = textOffset(container, caret.startContainer, caret.startOffset);
    start.range = { start: at, end: at };
  }
  return start;
}

/**
 * Where a click in a table cell puts the caret (or which text it had selected), for the cell's
 * editor. A cell keeps no field height to hold: its editor is laid over the cell.
 */
export function cellEditStart(cell: HTMLElement, e: { clientX: number; clientY: number }): EditStart {
  const text = document.createRange();
  text.selectNodeContents(cell);
  const lines = new Set([...text.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top)));
  const start = { ...captureEditStart(cell, e), fieldHeight: undefined };
  return { ...start, wrapped: lines.size > 1 };
}
