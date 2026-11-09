// Keys of the Markdown editor that add behaviour, never syntax: Backspace at the start of a heading, code or quote makes it text,
// the arrow keys leave a code block or formula block that ends the text, and Enter after a GFM table's header and
// delimiter rows typed as text makes them that table (`tableFromTypedRows`). Also: the caret is put in text when a
// change leaves it between blocks (`caretInText`: Milkdown's `|2x2|` rule put it in a table cell before its paragraph).
import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import { type EditorState, Plugin, Selection, TextSelection, type Transaction } from "@milkdown/kit/prose/state";
import { liftTarget } from "@milkdown/kit/prose/transform";
import { $prose } from "@milkdown/kit/utils";
import { deleteSelectedLines } from "./markdownActions";

/** Blocks whose text is source (code, a formula): made plain, their lines stay lines (hard breaks in a paragraph). */
const SOURCE_BLOCKS = new Set(["code_block", "math_block"]);

/** A paragraph of a source block's text, its lines kept as hard breaks. */
function plainParagraph(state: EditorState, block: ProseNode) {
  const { paragraph, hardbreak } = state.schema.nodes;
  const lines = block.textContent.split("\n");
  const content = lines.flatMap((line, i) => [...(i > 0 && hardbreak ? [hardbreak.create()] : []), ...(line ? [state.schema.text(line)] : [])]);
  return paragraph.create(null, content);
}

/**
 * What Backspace at a block's start does to make it plain, or null when it is an ordinary Backspace: a heading of any
 * level or a code or formula block becomes a paragraph (a block's lines kept as line breaks, a formula as its source), a
 * paragraph in a quote comes out of it. Inside a line Backspace always deletes the character before the caret, styled or
 * not (a style is taken off with the format bar or its shortcut; at a style's edge the caret is inside or outside it,
 * markdownEdges.ts).
 */
export function unstyleAtCaret(state: EditorState): Transaction | null {
  const { $from, empty } = state.selection;
  if (!empty || !$from.parent.isTextblock) return null;
  const block = $from.parent;

  if ($from.parentOffset !== 0) return null;
  if (block.type.name === "heading") return state.tr.setBlockType($from.pos, $from.pos, state.schema.nodes.paragraph);
  if (SOURCE_BLOCKS.has(block.type.name)) {
    const at = $from.before();
    const tr = state.tr.replaceWith(at, at + block.nodeSize, plainParagraph(state, block));
    return tr.setSelection(TextSelection.create(tr.doc, at + 1));
  }
  if ($from.depth >= 2 && $from.node(-1).type.name === "blockquote") {
    const range = $from.blockRange();
    const target = range && liftTarget(range);
    if (range && target != null) return state.tr.lift(range, target);
  }
  return null;
}

/**
 * Down or Right at the end of a code or formula block that ends the text adds an empty paragraph after it and moves there:
 * otherwise there is no place after it to type in (or to Backspace it away from).
 */
export function exitSourceBlockAtEnd(state: EditorState, key: string): Transaction | null {
  const { $from, empty } = state.selection;
  if (!empty || (key !== "ArrowDown" && key !== "ArrowRight")) return null;
  if (!SOURCE_BLOCKS.has($from.parent.type.name) || $from.parentOffset !== $from.parent.content.size) return null;
  if ($from.depth !== 1 || $from.after() !== state.doc.content.size) return null;
  const at = $from.after();
  const tr = state.tr.insert(at, state.schema.nodes.paragraph.create());
  return tr.setSelection(TextSelection.create(tr.doc, at + 1));
}

/** A GFM table row's cells: split on pipes that aren't escaped, the outer pipes optional, each cell trimmed. */
function rowCells(line: string): string[] | null {
  const text = line.trim();
  if (!text.includes("|")) return null;
  const inner = text.replace(/^\|/, "").replace(/(?<!\\)\|$/, "");
  return inner.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

/** A delimiter row's alignments (`---`, `:--`, `:-:`, `--:`), or null when the line isn't one. */
function delimiterRow(line: string): (string | null)[] | null {
  const cells = rowCells(line);
  if (!cells || !cells.every((c) => /^:?-+:?$/.test(c))) return null;
  return cells.map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : null));
}

/** A paragraph's lines (split by its hard breaks): their text and where each starts (after its break) and ends. */
function linesOf(block: ProseNode, start: number): { text: string; from: number; to: number }[] {
  const lines = [{ text: "", from: start, to: start }];
  block.forEach((child, offset) => {
    const at = start + offset;
    const line = lines[lines.length - 1];
    if (child.type.name === "hardbreak") lines.push({ text: "", from: at + child.nodeSize, to: at + child.nodeSize });
    else {
      line.text += child.isText ? child.text : "";
      line.to = at + child.nodeSize;
    }
  });
  return lines;
}

/**
 * Enter at the end of a GFM table's delimiter row typed as text (`|-|-|`, right below its header row `|a|b|`, on the line
 * before or in the paragraph before, with as many cells) makes them that table, with an empty row to type in: typed,
 * pipes are only text (saved escaped, `\|`). Lines before the header stay where they are.
 */
export function tableFromTypedRows(state: EditorState): Transaction | null {
  const { $from, empty } = state.selection;
  const { table, table_header_row, table_header, table_row, table_cell, paragraph } = state.schema.nodes;
  if (!empty || !table || $from.parent.type !== paragraph || $from.parentOffset !== $from.parent.content.size) return null;
  const lines = linesOf($from.parent, $from.start());
  const aligns = delimiterRow(lines[lines.length - 1].text);
  if (!aligns) return null;
  // The header: the line before, or the last line of the paragraph just before.
  let header: { text: string; from: number; to: number } | undefined = lines[lines.length - 2];
  let headerBlock = { node: $from.parent, before: $from.before(), start: $from.start() };
  if (!header) {
    const index = $from.index(-1);
    const prev = index > 0 ? $from.node(-1).child(index - 1) : null;
    if (prev?.type !== paragraph) return null;
    const before = $from.before() - prev.nodeSize;
    headerBlock = { node: prev, before, start: before + 1 };
    header = linesOf(prev, before + 1).at(-1);
  }
  const names = header && rowCells(header.text);
  if (!header || !names || names.length !== aligns.length) return null;
  const $at = state.doc.resolve(headerBlock.before);
  if (!$at.parent.canReplaceWith($at.index(), $at.index() + 1, table)) return null;

  const cell = (type: typeof table_cell, align: string | null, text: string) =>
    type.create({ alignment: align }, paragraph.create(null, text ? state.schema.text(text) : null));
  const made = table.create(null, [
    table_header_row.create(null, names.map((n, i) => cell(table_header, aligns[i], n))),
    table_row.create(null, aligns.map((a) => cell(table_cell, a, ""))),
  ]);
  // From the header line on (and the break before it) to the end of the delimiter row goes; what is left of the header's
  // paragraph stays, the table after it (or in its place when nothing is left).
  const cutFrom = header.from === headerBlock.start ? headerBlock.start : header.from - 1;
  const tr = state.tr.delete(cutFrom, $from.pos);
  const kept = tr.doc.nodeAt(headerBlock.before)!;
  const at = kept.content.size === 0 ? headerBlock.before : headerBlock.before + kept.nodeSize;
  if (kept.content.size === 0) tr.replaceWith(at, at + kept.nodeSize, made);
  else tr.insert(at, made);
  // Into the empty row's first cell: table, header row, row, cell, paragraph.
  return tr.setSelection(TextSelection.create(tr.doc, at + 1 + made.child(0).nodeSize + 3));
}

/**
 * The caret put in text when a change leaves it where no text goes (a table cell before its paragraph: Milkdown's `|2x2|`
 * table rule): there it isn't drawn, and typing went nowhere visible.
 */
export const caretInText = $prose(
  () =>
    new Plugin({
      appendTransaction(trs, _old, state) {
        const sel = state.selection;
        if (!trs.some((t) => t.docChanged) || !(sel instanceof TextSelection) || !sel.empty || sel.$from.parent.inlineContent) return null;
        const near = Selection.findFrom(sel.$from, 1, true) ?? Selection.near(sel.$from);
        return near.eq(sel) ? null : state.tr.setSelection(near);
      },
    }),
);

/**
 * The keys above. A DOM keydown handler, so it runs before the presets' keymaps (the heading one steps down a level per
 * Backspace).
 */
export const markdownKeys = $prose(
  () =>
    new Plugin({
      props: {
        handleDOMEvents: {
          keydown(view, event) {
            // Whole rows or columns selected: Delete or Backspace deletes them (the whole table: the table).
            if ((event.key === "Backspace" || event.key === "Delete") && !event.ctrlKey && !event.metaKey && !event.altKey && deleteSelectedLines(view.state, view.dispatch)) {
              event.preventDefault();
              return true;
            }
            if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return false;
            const tr =
              event.key === "Backspace" ? unstyleAtCaret(view.state) : event.key === "Enter" ? tableFromTypedRows(view.state) : exitSourceBlockAtEnd(view.state, event.key);
            if (!tr) return false;
            event.preventDefault();
            view.dispatch(tr.scrollIntoView());
            return true;
          },
        },
      },
    }),
);
