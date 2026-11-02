// Keys of the Markdown editor that add behaviour, never syntax: Backspace at the front of styled text makes it plain,
// and the arrow keys leave a code block or formula block that ends the text.
import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import { type EditorState, Plugin, TextSelection, type Transaction } from "@milkdown/kit/prose/state";
import { liftTarget } from "@milkdown/kit/prose/transform";
import { $prose } from "@milkdown/kit/utils";

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
 * What Backspace at the caret does to make styled text plain, or null when it is an ordinary Backspace. At the front of
 * something styled its Markdown goes and its text stays, in one press:
 * - inline: bold, italic, strikethrough, code, a formula or a link that starts at the caret loses that style (all of it,
 *   to where it ends; a second press then deletes as usual);
 * - a block at its start: a heading of any level or a code or formula block becomes a paragraph (a block's lines kept as
 *   line breaks, a formula as its source), a paragraph in a quote comes out of it.
 */
export function unstyleAtCaret(state: EditorState): Transaction | null {
  const { $from, empty } = state.selection;
  if (!empty || !$from.parent.isTextblock) return null;
  const block = $from.parent;

  if (!block.type.spec.code) {
    const after = $from.nodeAfter;
    const before = $from.nodeBefore;
    const starting = (after?.marks ?? []).filter((m) => !before || !m.isInSet(before.marks));
    if (after?.isText && starting.length > 0) {
      const tr = state.tr;
      for (const mark of starting) {
        // The run of text with this mark from the caret on.
        let end = $from.pos;
        for (let i = $from.index(); i < block.childCount && mark.isInSet(block.child(i).marks); i++) end += block.child(i).nodeSize;
        tr.removeMark($from.pos, end, mark);
      }
      return tr.setStoredMarks(before?.marks ?? []);
    }
  }

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
            if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return false;
            const tr = event.key === "Backspace" ? unstyleAtCaret(view.state) : exitSourceBlockAtEnd(view.state, event.key);
            if (!tr) return false;
            event.preventDefault();
            view.dispatch(tr.scrollIntoView());
            return true;
          },
        },
      },
    }),
);
