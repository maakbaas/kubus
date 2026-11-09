// What the Markdown editor's bars, `/` menu and keys do (MarkdownToolbar, SlashMenu, markdownKeys): ProseMirror commands
// on the editor's state, no syntax of their own. Each writes ordinary GFM (plus GitHub's math), as typing it would.
// - Inline styles (bold, italic, strikethrough, code, formula) are on or off for what is typed next (`nextMarks`) or,
//   with a selection, for all of it. Turned off with only a caret, the whole styled stretch the caret is in loses it.
// - A block is turned into another kind (text, heading, quote, list, checklist) in place, its text kept.
// - Tables: rows and columns added beside the caret's, deleted (all of a selection's), a column aligned.
// - The `/` menu inserts: on an empty line in its place, else after the line (blocks) or at the caret (inline things).
import type { Mark, MarkType, Node as ProseNode, NodeType, ResolvedPos, Schema } from "@milkdown/kit/prose/model";
import { type Command, type EditorState, Selection, TextSelection, type Transaction } from "@milkdown/kit/prose/state";
import { findWrapping, liftTarget } from "@milkdown/kit/prose/transform";
import { liftListItem, sinkListItem, wrapInList } from "@milkdown/kit/prose/schema-list";
import { addColumnAfter, addColumnBefore, CellSelection, deleteColumn, deleteTable, isInTable, selectedRect, type TableRect } from "@milkdown/kit/prose/tables";

/** The inline styles the bars toggle, in their order. A link is no style (it has its own dialog). */
export const STYLE_MARKS = ["strong", "emphasis", "strike_through", "inlineCode", "math_inline"] as const;
export type StyleMark = (typeof STYLE_MARKS)[number];
/** What "Clear formatting" takes off: the styles but a formula (whose text is its source). */
const CLEARED: StyleMark[] = ["strong", "emphasis", "strike_through", "inlineCode"];

const markType = (state: EditorState, name: string): MarkType | undefined => state.schema.marks[name];

/** The marks the next typed character gets: those chosen for it (stored), else the caret's. */
export const nextMarks = (state: EditorState): readonly Mark[] => state.storedMarks ?? state.selection.$from.marks();

/** Whether a style is on: for what is typed next (a caret), or for every character of the selection. */
export function markActive(state: EditorState, name: string): boolean {
  const type = markType(state, name);
  if (!type) return false;
  const { from, to, empty } = state.selection;
  if (empty) return !!type.isInSet(nextMarks(state));
  let any = false;
  let all = true;
  state.doc.nodesBetween(from, to, (node) => {
    if (!node.isText) return true;
    any = true;
    if (!type.isInSet(node.marks)) all = false;
    return true;
  });
  return any && all;
}

/** The run of text with `type` that touches the caret (before or after it), in document positions; null when none. */
export function markStretch($pos: ResolvedPos, type: MarkType): { from: number; to: number } | null {
  const parent = $pos.parent;
  const start = $pos.start();
  const runs: { from: number; to: number; on: boolean }[] = [];
  parent.forEach((child, offset) => runs.push({ from: start + offset, to: start + offset + child.nodeSize, on: !!type.isInSet(child.marks) }));
  // The runs the caret is in or touches, joined with their neighbours that have the mark too.
  const i = runs.findIndex((r) => r.on && r.from <= $pos.pos && $pos.pos <= r.to);
  if (i < 0) return null;
  let first = i;
  let last = i;
  while (first > 0 && runs[first - 1].on) first--;
  while (last < runs.length - 1 && runs[last + 1].on) last++;
  return { from: runs[first].from, to: runs[last].to };
}

/**
 * Turns a style on or off. A selection: all of it gets the style, or loses it when it all has it. A caret: on, it is for
 * what is typed next; off, the styled stretch the caret is in loses it (all of it, as Backspace at its front does) and
 * what is typed next is plain of it.
 */
export function toggleStyle(name: StyleMark): Command {
  return (state, dispatch) => {
    const type = markType(state, name);
    if (!type || state.selection.$from.parent.type.spec.code) return false;
    const { from, to, empty, $from } = state.selection;
    let tr: Transaction;
    if (empty) {
      const marks = nextMarks(state);
      if (type.isInSet(marks)) {
        tr = state.tr;
        const stretch = markStretch($from, type);
        if (stretch) tr.removeMark(stretch.from, stretch.to, type);
        tr.setStoredMarks(type.removeFromSet(marks));
      } else tr = state.tr.setStoredMarks(type.create().addToSet(marks));
    } else tr = markActive(state, name) ? state.tr.removeMark(from, to, type) : state.tr.addMark(from, to, type.create());
    dispatch?.(tr);
    return true;
  };
}

/** Whether "Clear formatting" has anything to take off. */
export const anyStyle = (state: EditorState) => CLEARED.some((name) => markActive(state, name) || (!state.selection.empty && rangeHas(state, name)));

const rangeHas = (state: EditorState, name: string) => {
  const type = markType(state, name);
  return !!type && state.doc.rangeHasMark(state.selection.from, state.selection.to, type);
};

/** Takes every style but a formula and a link off the selection, or off the stretches the caret is in (and what is typed next). */
export const clearFormatting: Command = (state, dispatch) => {
  const { from, to, empty, $from } = state.selection;
  const types = CLEARED.map((n) => markType(state, n)).filter((t): t is MarkType => !!t);
  const tr = state.tr;
  if (empty) {
    let marks = nextMarks(state);
    for (const type of types) {
      if (!type.isInSet(marks)) continue;
      const stretch = markStretch($from, type);
      if (stretch) tr.removeMark(stretch.from, stretch.to, type);
      marks = type.removeFromSet(marks);
    }
    tr.setStoredMarks(marks);
  } else for (const type of types) tr.removeMark(from, to, type);
  dispatch?.(tr);
  return true;
};

// --- Blocks -------------------------------------------------------------------------------------

/** A block's kind as the bars name it: the text block's, and the list and quote it is in. */
export interface BlockKind {
  /** "paragraph", "heading", "code_block", "math_block", or another text block's type. */
  text: string;
  level: number;
  list: "bullet" | "ordered" | "task" | null;
  quote: boolean;
  table: boolean;
}

/** The list item the caret is in (the innermost), with its list. */
function listAt($pos: ResolvedPos): { item: ProseNode; itemDepth: number; list: ProseNode; listDepth: number } | null {
  for (let d = $pos.depth; d > 1; d--) {
    if ($pos.node(d).type.name === "list_item") return { item: $pos.node(d), itemDepth: d, list: $pos.node(d - 1), listDepth: d - 1 };
  }
  return null;
}

export function blockKind(state: EditorState): BlockKind {
  const { $from } = state.selection;
  const list = listAt($from);
  let quote = false;
  for (let d = $from.depth; d > 0; d--) if ($from.node(d).type.name === "blockquote") quote = true;
  return {
    text: $from.parent.type.name,
    level: $from.parent.type.name === "heading" ? Number($from.parent.attrs.level) : 0,
    list: !list ? null : list.list.type.name === "ordered_list" ? "ordered" : list.item.attrs.checked != null ? "task" : "bullet",
    quote,
    table: isInTable(state),
  };
}

/** Turns the selected text blocks into paragraphs (level 0) or headings of a level; a code or formula block's lines kept. */
export function setHeading(level: number): Command {
  return (state, dispatch) => {
    const { paragraph, heading } = state.schema.nodes;
    const type = level ? heading : paragraph;
    const { from, to } = state.selection;
    let can = false;
    state.doc.nodesBetween(from, to, (node, pos) => {
      if (!node.isTextblock) return true;
      if (!(node.type === type && (!level || node.attrs.level === level))) {
        const $pos = state.doc.resolve(pos);
        if ($pos.parent.canReplaceWith($pos.index(), $pos.index() + 1, type)) can = true;
      }
      return false;
    });
    if (!can) return false;
    if (dispatch) {
      const tr = state.tr;
      state.doc.nodesBetween(from, to, (node, pos) => {
        if (!node.isTextblock) return true;
        if (node.type.spec.code) {
          // A code or formula block's lines become line breaks.
          const lines = node.textContent.split("\n");
          const content = lines.flatMap((line, i) => [...(i > 0 ? [state.schema.nodes.hardbreak.create()] : []), ...(line ? [state.schema.text(line)] : [])]);
          tr.replaceWith(tr.mapping.map(pos), tr.mapping.map(pos + node.nodeSize), type.create(level ? { level } : null, content));
        } else tr.setNodeMarkup(tr.mapping.map(pos), type, level ? { level } : null);
        return false;
      });
      dispatch(tr.scrollIntoView());
    }
    return true;
  };
}

/** Puts the selected blocks in a quote, or takes them out of the one they are in. */
export const toggleQuote: Command = (state, dispatch) => {
  const { $from, $to } = state.selection;
  const quote = state.schema.nodes.blockquote;
  if (blockKind(state).quote) {
    const range = $from.blockRange($to, (node) => node.type === quote);
    const inner = range && state.doc.resolve(range.start + 1).blockRange(state.doc.resolve(range.end - 1));
    const target = inner && liftTarget(inner);
    if (!inner || target == null) return false;
    dispatch?.(state.tr.lift(inner, target).scrollIntoView());
    return true;
  }
  const range = $from.blockRange($to);
  const wrapping = range && findWrapping(range, quote);
  if (!range || !wrapping) return false;
  dispatch?.(state.tr.wrap(range, wrapping).scrollIntoView());
  return true;
};

/** The list item type's attrs for a list kind: a checklist's items have `checked`, the others none. */
function itemAttrs(item: ProseNode, kind: "bullet" | "ordered" | "task") {
  return { ...item.attrs, listType: kind === "ordered" ? "ordered" : "bullet", checked: kind === "task" ? (typeof item.attrs.checked === "boolean" ? item.attrs.checked : false) : null };
}

/**
 * Makes the selected blocks a list of a kind: out of a list of that kind (back to text), the list switched to it when
 * of another kind, else into a new one.
 */
export function setList(kind: "bullet" | "ordered" | "task"): Command {
  return (state, dispatch) => {
    const { bullet_list, ordered_list, list_item } = state.schema.nodes;
    const listType = kind === "ordered" ? ordered_list : bullet_list;
    const current = blockKind(state).list;
    const at = listAt(state.selection.$from);
    if (current === kind) return liftListItem(list_item)(state, dispatch);
    if (current && at) {
      if (dispatch) {
        const tr = state.tr;
        const listPos = state.selection.$from.before(at.listDepth);
        tr.setNodeMarkup(listPos, listType, kind === "ordered" ? { ...at.list.attrs, order: at.list.attrs.order ?? 1 } : { spread: at.list.attrs.spread });
        at.list.forEach((item, offset) => tr.setNodeMarkup(listPos + 1 + offset, undefined, itemAttrs(item, kind)));
        dispatch(tr);
      }
      return true;
    }
    return wrapInList(listType)(state, (tr) => {
      if (!dispatch) return;
      // The new list's items: of its kind (a checklist's unticked).
      const $pos = tr.selection.$from;
      const made = listAt($pos);
      if (made) {
        const listPos = $pos.before(made.listDepth);
        made.list.forEach((item, offset) => tr.setNodeMarkup(listPos + 1 + offset, undefined, itemAttrs(item, kind)));
      }
      dispatch(tr.scrollIntoView());
    });
  };
}

/** A list item one level in (under the one before it) or out. */
export const indent: Command = (state, dispatch) => sinkListItem(state.schema.nodes.list_item)(state, dispatch);
export const outdent: Command = (state, dispatch) => liftListItem(state.schema.nodes.list_item)(state, dispatch);

// --- Tables --------------------------------------------------------------------------------------

/** A GFM table's empty row like another (its cells' alignments), a header row or not. */
function emptyRow(schema: Schema, like: ProseNode, header: boolean): ProseNode {
  const n = schema.nodes;
  const cells: ProseNode[] = [];
  like.forEach((c) => cells.push((header ? n.table_header : n.table_cell).createAndFill({ alignment: c.attrs.alignment })!));
  return (header ? n.table_header_row : n.table_row).create(null, cells);
}

/** A row as a header row or a normal one, its cells kept. */
function rowAs(schema: Schema, row: ProseNode, header: boolean): ProseNode {
  const n = schema.nodes;
  const cells: ProseNode[] = [];
  row.forEach((c) => cells.push((header ? n.table_header : n.table_cell).create(c.attrs, c.content)));
  return (header ? n.table_header_row : n.table_row).create(row.attrs, cells);
}

/** The table the selection is in, rebuilt from its rows by `build`, the caret put in row `focusRow`'s first cell. */
function rebuildTable(state: EditorState, rect: TableRect, rows: ProseNode[], focusRow: number): Transaction {
  const table = rect.table.type.create(rect.table.attrs, rows);
  const pos = rect.tableStart - 1;
  const tr = state.tr.replaceWith(pos, pos + rect.table.nodeSize, table);
  let at = pos + 1;
  for (let i = 0; i < Math.min(focusRow, table.childCount - 1); i++) at += table.child(i).nodeSize;
  return tr.setSelection(TextSelection.near(tr.doc.resolve(at + 2)));
}

const rowsOf = (table: ProseNode) => {
  const rows: ProseNode[] = [];
  table.forEach((r) => rows.push(r));
  return rows;
};

/** A row above the selection's first row: above the header too (the new one is the header, the old one moves down). */
export const addRowAbove: Command = (state, dispatch) => {
  if (!isInTable(state)) return false;
  if (dispatch) {
    const rect = selectedRect(state);
    const rows = rowsOf(rect.table);
    const next =
      rect.top > 0
        ? [...rows.slice(0, rect.top), emptyRow(state.schema, rows[rect.top], false), ...rows.slice(rect.top)]
        : [emptyRow(state.schema, rows[0], true), rowAs(state.schema, rows[0], false), ...rows.slice(1)];
    dispatch(rebuildTable(state, rect, next, rect.top).scrollIntoView());
  }
  return true;
};

/** A row below the selection's last row (below the header: a normal row). */
export const addRowBelow: Command = (state, dispatch) => {
  if (!isInTable(state)) return false;
  if (dispatch) {
    const rect = selectedRect(state);
    const rows = rowsOf(rect.table);
    const next = [...rows.slice(0, rect.bottom), emptyRow(state.schema, rows[0], false), ...rows.slice(rect.bottom)];
    dispatch(rebuildTable(state, rect, next, rect.bottom).scrollIntoView());
  }
  return true;
};

export const addColumnLeft: Command = addColumnBefore;
export const addColumnRight: Command = addColumnAfter;

/**
 * Deletes the selection's rows (all of them: several selected, several go). The header too: the next row becomes the
 * header. A table keeps a row below its header (an empty one when none is left); all its rows selected, it goes.
 */
export const deleteRows: Command = (state, dispatch) => {
  if (!isInTable(state)) return false;
  const rect = selectedRect(state);
  const rows = rowsOf(rect.table);
  if (rect.top === 0 && rect.bottom >= rows.length) return deleteTable(state, dispatch);
  if (dispatch) {
    const rest = rows.filter((_, i) => i < rect.top || i >= rect.bottom);
    if (rect.top === 0) rest[0] = rowAs(state.schema, rest[0], true);
    if (rest.length === 1) rest.push(emptyRow(state.schema, rest[0], false));
    dispatch(rebuildTable(state, rect, rest, Math.max(0, rect.top - 1)).scrollIntoView());
  }
  return true;
};

/** Deletes the selection's columns (all of them); all of them selected, the table goes. */
export const deleteColumns: Command = (state, dispatch) => {
  if (!isInTable(state)) return false;
  const rect = selectedRect(state);
  if (rect.left === 0 && rect.right >= rect.map.width) return deleteTable(state, dispatch);
  return deleteColumn(state, dispatch);
};

export const removeTable: Command = deleteTable;

/** The alignment of the caret's column (its header cell's): "left", "center", "right", or null (none written). */
export function columnAlignment(state: EditorState): string | null {
  if (!isInTable(state)) return null;
  const rect = selectedRect(state);
  const cell = rect.table.nodeAt(rect.map.map[rect.left]);
  return (cell?.attrs.alignment as string | null) ?? null;
}

/** Aligns the selection's columns (every cell of them): left, center or right; the one they have already: none again. */
export function alignColumn(alignment: "left" | "center" | "right"): Command {
  return (state, dispatch) => {
    if (!isInTable(state)) return false;
    if (dispatch) {
      const rect = selectedRect(state);
      const value = columnAlignment(state) === alignment ? null : alignment;
      const tr = state.tr;
      for (let row = 0; row < rect.map.height; row++) {
        for (let col = rect.left; col < rect.right; col++) {
          const at = rect.map.map[row * rect.map.width + col];
          const cell = rect.table.nodeAt(at)!;
          tr.setNodeMarkup(rect.tableStart + at, undefined, { ...cell.attrs, alignment: value });
        }
      }
      dispatch(tr);
    }
    return true;
  };
}

/**
 * Delete or Backspace with whole rows or columns selected (a cell selection across the table) deletes them, not only
 * their text; the whole table selected, the table.
 */
export const deleteSelectedLines: Command = (state, dispatch) => {
  const sel = state.selection;
  if (!(sel instanceof CellSelection)) return false;
  const rows = sel.isRowSelection();
  const cols = sel.isColSelection();
  if (rows && cols) return deleteTable(state, dispatch);
  if (rows) return deleteRows(state, dispatch);
  if (cols) return deleteColumns(state, dispatch);
  return false;
};

// --- The `/` menu ---------------------------------------------------------------------------------

/** What the `/` menu inserts. */
export type InsertKind =
  | "h1" | "h2" | "h3" | "h4" | "h5" | "h6"
  | "quote" | "bullet" | "ordered" | "task"
  | "table" | "code" | "math" | "divider"
  | "image" | "link" | "formula" | "footnote" | "break";

/** The `/` menu's options: name, the words it is found by, the Markdown that types it, and whether it is a block. */
export interface InsertOption {
  kind: InsertKind;
  label: string;
  /** The Markdown typed for it (shown beside it: the menu teaches the syntax). */
  syntax: string;
  words: string;
  block: boolean;
  group: "Text" | "Lists" | "Insert";
}

const heading = (n: number): InsertOption => ({ kind: `h${n}` as InsertKind, label: `Heading ${n}`, syntax: `${"#".repeat(n)} `, words: `heading h${n} title`, block: true, group: "Text" });

/** In the order shown: the common ones first, the smaller headings last. */
export const INSERT_OPTIONS: InsertOption[] = [
  ...[1, 2, 3].map(heading),  { kind: "quote", label: "Quote", syntax: "> ", words: "quote blockquote citation", block: true, group: "Text" },
  { kind: "bullet", label: "Bulleted list", syntax: "- ", words: "bulleted list bullets unordered", block: true, group: "Lists" },
  { kind: "ordered", label: "Numbered list", syntax: "1. ", words: "numbered list ordered numbers", block: true, group: "Lists" },
  { kind: "task", label: "Checklist", syntax: "- [ ] ", words: "checklist task todo checkbox", block: true, group: "Lists" },
  { kind: "table", label: "Table", syntax: "|3x3|", words: "table grid columns rows", block: true, group: "Insert" },
  { kind: "code", label: "Code block", syntax: "```", words: "code block snippet program", block: true, group: "Insert" },
  { kind: "math", label: "Formula block", syntax: "$$", words: "formula block math equation latex tex", block: true, group: "Insert" },
  { kind: "divider", label: "Divider", syntax: "---", words: "divider line rule separator horizontal", block: true, group: "Insert" },
  { kind: "image", label: "Image", syntax: "Paste or drop", words: "image picture photo file upload", block: false, group: "Insert" },
  { kind: "link", label: "Link to page", syntax: "#/", words: "link page item collection view", block: false, group: "Insert" },
  { kind: "formula", label: "Formula", syntax: "$…$", words: "formula inline math equation latex tex", block: false, group: "Insert" },
  { kind: "footnote", label: "Footnote", syntax: "[^1]", words: "footnote note reference", block: false, group: "Insert" },
  { kind: "break", label: "Line break", syntax: "Shift+Enter", words: "line break newline return", block: false, group: "Insert" },
  ...[4, 5, 6].map(heading),
];

/**
 * The options a query finds: each of its words the start of one of the option's words (or name's); those whose name
 * starts with it first (`/ta`: Table before Checklist, found by "task"), else in the menu's order.
 */
export function insertOptions(query: string): InsertOption[] {
  const q = query.toLowerCase();
  const parts = q.split(/[\s-]+/).filter(Boolean);
  if (parts.length === 0) return INSERT_OPTIONS;
  const found = INSERT_OPTIONS.filter((o) => {
    const words = `${o.label} ${o.words}`.toLowerCase().split(/\s+/);
    return parts.every((p) => words.some((w) => w.startsWith(p)));
  });
  const named = (o: InsertOption) => (o.label.toLowerCase().startsWith(q) ? 0 : 1);
  return found.map((o, i) => ({ o, i })).sort((a, b) => named(a.o) - named(b.o) || a.i - b.i).map(({ o }) => o);
}

/** A new GFM table: a header row and two rows of three empty cells. */
function newTable(schema: Schema): ProseNode {
  const n = schema.nodes;
  // No alignment written (`---`), as a table typed: the schema's default is left (`:--`).
  const cells = (type: NodeType) => [0, 1, 2].map(() => type.createAndFill({ alignment: null })!);
  return n.table.create(null, [n.table_header_row.create(null, cells(n.table_header)), n.table_row.create(null, cells(n.table_cell)), n.table_row.create(null, cells(n.table_cell))]);
}

/** The next footnote label: one more than the highest number used. */
function nextFootnote(doc: ProseNode): string {
  let highest = 0;
  doc.descendants((node) => {
    if (node.type.name === "footnote_reference" || node.type.name === "footnote_definition") {
      const n = Number(node.attrs.label);
      if (Number.isInteger(n)) highest = Math.max(highest, n);
    }
  });
  return String(highest + 1);
}

/** The block a `/` option makes (empty, or with a text block's content `content`). */
function blockOf(schema: Schema, kind: InsertKind, content?: ProseNode["content"]): ProseNode | null {
  const n = schema.nodes;
  const para = () => n.paragraph.create(null, content);
  const list = (type: NodeType, task: boolean) =>
    type.create(null, n.list_item.create({ listType: type === n.ordered_list ? "ordered" : "bullet", ...(task && { checked: false }) }, para()));
  if (/^h[1-6]$/.test(kind)) return n.heading.create({ level: Number(kind[1]) }, content);
  if (kind === "quote") return n.blockquote.create(null, para());
  if (kind === "bullet") return list(n.bullet_list, false);
  if (kind === "ordered") return list(n.ordered_list, false);
  if (kind === "task") return list(n.bullet_list, true);
  if (kind === "table") return newTable(schema);
  if (kind === "code") return n.code_block.create(null, content?.size ? schema.text(content.textBetween(0, content.size, "\n")) : null);
  if (kind === "math") return n.math_block?.create(null, content?.size ? schema.text(content.textBetween(0, content.size, "\n")) : null) ?? null;
  if (kind === "divider") return n.hr.create();
  return null;
}

/**
 * Inserts what was chosen in the `/` menu in place of the `/query` typed (`from`..`to`): a block on an empty line in its
 * place, after the line holding text; an inline thing at the caret. Image is the editor's own (a file is picked first):
 * this only takes the `/query` away.
 */
export function insertChosen(state: EditorState, kind: InsertKind, from: number, to: number): Transaction | null {
  // A block going after the line: the space typed before the `/` goes too.
  const option = INSERT_OPTIONS.find((o) => o.kind === kind);
  const $slash = state.doc.resolve(from);
  if (option?.block && $slash.parentOffset > 0 && state.doc.textBetween(from - 1, from) === " ") from -= 1;
  const tr = state.tr.delete(from, to);
  const $pos = tr.doc.resolve(from);
  const { schema } = state;
  const n = schema.nodes;
  if (kind === "image") return tr;
  if (kind === "link") return tr.insertText("#/", from);
  if (kind === "break") {
    tr.insert(from, n.hardbreak.create());
    return tr.setSelection(TextSelection.create(tr.doc, from + 1));
  }
  if (kind === "formula") return schema.marks.math_inline ? tr.setStoredMarks([schema.marks.math_inline.create()]) : null;
  if (kind === "footnote") {
    if (!n.footnote_reference || !n.footnote_definition) return null;
    const label = nextFootnote(state.doc);
    tr.insert(from, n.footnote_reference.create({ label }));
    const end = tr.doc.content.size;
    tr.insert(end, n.footnote_definition.create({ label }, n.paragraph.create()));
    // Into the note, to write it.
    return tr.setSelection(TextSelection.create(tr.doc, end + 2)).scrollIntoView();
  }
  const block = $pos.parent;
  if (!block.isTextblock) return null;
  const blockPos = $pos.before();
  const empty = block.content.size === 0;
  const made = blockOf(schema, kind);
  if (!made) return null;
  let at: number;
  if (empty) {
    const $block = tr.doc.resolve(blockPos);
    if (!$block.parent.canReplaceWith($block.index(), $block.index() + 1, made.type)) return null;
    tr.replaceWith(blockPos, blockPos + block.nodeSize, made);
    at = blockPos;
  } else {
    at = blockPos + block.nodeSize;
    const $after = tr.doc.resolve(at);
    if (!$after.parent.canReplaceWith($after.index(), $after.index(), made.type)) return null;
    tr.insert(at, made);
  }
  // A divider has nowhere to type: a paragraph after it unless one follows.
  if (kind === "divider") {
    const after = at + made.nodeSize;
    if (!tr.doc.resolve(after).nodeAfter?.isTextblock) tr.insert(after, n.paragraph.create());
    return tr.setSelection(TextSelection.create(tr.doc, after + 1)).scrollIntoView();
  }
  return tr.setSelection(Selection.findFrom(tr.doc.resolve(at), 1, true) ?? Selection.near(tr.doc.resolve(at))).scrollIntoView();
}
