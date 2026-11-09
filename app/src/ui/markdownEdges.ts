// Where the caret is at the edge of styled text (bold, italic, strikethrough, code, a formula): inside it or outside, so
// what is typed next is clear and chosen, never guessed. The bars show it (B selected: what is typed is bold).
// - ← and → step across an edge first, without moving: at the end of **bold** → steps out (what is typed is plain), ←
//   back in. Arriving at an edge from inside, the caret is inside; from outside, outside.
// - A click (or tap) at an edge puts the caret outside of what starts or ends there.
// - Typing on inside code or a formula goes on in it (they don't stretch over a typed character by themselves).
// - iOS's own Format menu (Bold, Italic) works as the bars' buttons do.
// No syntax: only which marks the next character gets (ProseMirror's stored marks).
import type { Mark } from "@milkdown/kit/prose/model";
import { type EditorState, Plugin, TextSelection, type Transaction } from "@milkdown/kit/prose/state";
import { $prose } from "@milkdown/kit/utils";
import { STYLE_MARKS, toggleStyle } from "./markdownActions";

const STYLES = new Set<string>(STYLE_MARKS);

/** Dispatched on the editor's content for Ctrl / ⌘+K: the editor opens its link dialog. */
export const LINK_SHORTCUT = "kubus-link-shortcut";

/** The style shortcuts (by key code: Alt changes the key typed): the bars' buttons, so a caret's stretch toggles whole. */
const STYLE_KEYS: Record<string, { style: "strong" | "emphasis" | "strike_through" | "inlineCode"; alt: boolean }> = {
  KeyB: { style: "strong", alt: false },
  KeyI: { style: "emphasis", alt: false },
  KeyE: { style: "inlineCode", alt: false },
  KeyX: { style: "strike_through", alt: true },
};
const styles = (marks: readonly Mark[]) => marks.filter((m) => STYLES.has(m.type.name));
const same = (a: readonly Mark[], b: readonly Mark[]) => a.length === b.length && a.every((m) => m.isInSet(b));
/** A side's marks for what is typed there: its styles, never a link (typing beside one doesn't extend it). */
const typed = (marks: readonly Mark[] | undefined) => (marks ?? []).filter((m) => m.type.name !== "link");

/** The two sides of an edge at `pos` (in a text block, not code): the marks before and after; null when there is no edge. */
export function edgeAt(state: EditorState, pos: number): { before: readonly Mark[]; after: readonly Mark[] } | null {
  const $pos = state.doc.resolve(pos);
  if (!$pos.parent.isTextblock || $pos.parent.type.spec.code) return null;
  const before = typed($pos.nodeBefore?.isText ? $pos.nodeBefore.marks : []);
  const after = typed($pos.nodeAfter?.isText ? $pos.nodeAfter.marks : []);
  return same(styles(before), styles(after)) ? null : { before, after };
}

/** The styles of what is typed next at the caret. */
const current = (state: EditorState) => styles(state.storedMarks ?? state.selection.$from.marks());

/**
 * ← or → at or next to an edge, as described above; null when it is an ordinary move. A move of one character onto an
 * edge lands on the side it comes from; a press at an edge on one side goes to the other without moving.
 */
export function stepAtEdge(state: EditorState, key: "ArrowLeft" | "ArrowRight"): Transaction | null {
  const sel = state.selection;
  if (!(sel instanceof TextSelection) || !sel.empty) return null;
  const pos = sel.from;
  const $pos = sel.$from;
  const right = key === "ArrowRight";
  const here = edgeAt(state, pos);
  if (here) {
    const from = right ? here.before : here.after;
    const to = right ? here.after : here.before;
    if (same(current(state), styles(from))) return state.tr.setStoredMarks(to);
  }
  // One character on, onto an edge: the side it comes from.
  const next = right ? pos + 1 : pos - 1;
  const crossed = right ? $pos.nodeAfter : $pos.nodeBefore;
  if (!crossed?.isText || next < $pos.start() || next > $pos.end()) return null;
  const there = edgeAt(state, next);
  if (!there) return null;
  const tr = state.tr.setSelection(TextSelection.create(state.doc, next));
  return tr.setStoredMarks(right ? there.before : there.after);
}

/** The marks both sides of an edge share: what a click there types (outside of what starts or ends there). */
const outside = (edge: { before: readonly Mark[]; after: readonly Mark[] }) => edge.before.filter((m) => m.isInSet(edge.after));

export const markdownEdges = $prose(
  () =>
    new Plugin({
      appendTransaction(trs, old, state) {
        const sel = state.selection;
        if (!(sel instanceof TextSelection) || !sel.empty || state.storedMarks) return null;
        // A click or tap at an edge: outside.
        if (trs.some((t) => t.getMeta("pointer")) && !trs.some((t) => t.docChanged)) {
          const edge = edgeAt(state, sel.from);
          return edge ? state.tr.setStoredMarks(outside(edge)) : null;
        }
        // Typed on inside code or a formula (they don't take a character typed at their end by themselves): still in it.
        if (!trs.some((t) => t.docChanged) || !old.selection.empty) return null;
        const was = old.storedMarks ?? old.selection.$from.marks();
        const before = sel.$from.nodeBefore;
        if (!before?.isText) return null;
        const kept = before.marks.filter((m) => m.type.spec.inclusive === false && STYLES.has(m.type.name) && m.isInSet(was) && !m.isInSet(sel.$from.marks()));
        // Only right after typing (the typed text ends at the caret): not after an input rule closing a code span.
        const typedNow = trs.every((t) => t.steps.length === 1) && trs.some((t) => t.docChanged);
        return kept.length && typedNow ? state.tr.setStoredMarks(typed(before.marks)) : null;
      },
      props: {
        handleKeyDown(view, event) {
          if ((event.key !== "ArrowLeft" && event.key !== "ArrowRight") || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return false;
          const tr = stepAtEdge(view.state, event.key);
          if (!tr) return false;
          view.dispatch(tr);
          return true;
        },
        handleDOMEvents: {
          // Before the presets' keymaps (their toggles leave a caret's stretch as it is).
          keydown(view, event) {
            const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
            if (!mod || event.shiftKey) return false;
            if (event.code === "KeyK" && !event.altKey) {
              event.preventDefault();
              view.dom.dispatchEvent(new CustomEvent(LINK_SHORTCUT, { bubbles: true }));
              return true;
            }
            const key = STYLE_KEYS[event.code];
            if (!key || key.alt !== event.altKey) return false;
            event.preventDefault();
            toggleStyle(key.style)(view.state, view.dispatch);
            return true;
          },
          // iOS's Format menu over a selection (and a keyboard's own Bold / Italic): the bars' buttons.
          beforeinput(view, event) {
            const style = { formatBold: "strong", formatItalic: "emphasis", formatStrikeThrough: "strike_through" }[event.inputType] as "strong" | "emphasis" | "strike_through" | undefined;
            if (!style && event.inputType !== "formatUnderline") return false;
            event.preventDefault();
            // Underline isn't GFM: nothing.
            if (style) toggleStyle(style)(view.state, view.dispatch);
            return true;
          },
        },
      },
    }),
);
