import { parserCtx } from "@milkdown/kit/core";
import { InputRule } from "@milkdown/kit/prose/inputrules";
import { Slice, type Node as ProseNode, type NodeType } from "@milkdown/kit/prose/model";
import { Plugin, type Transaction } from "@milkdown/kit/prose/state";
import { $inputRule, $node, $prose } from "@milkdown/kit/utils";

// `{{ ... }}` sections in the Markdown editor. The code in them is JavaScript, which Markdown
// would read (`a * b * c` is emphasis) and write back escaped, so the editor never sees it:
// sections are swapped for plain letters-and-digits tokens before the text is loaded, shown as
// chips (an inline atom node holding the code), and written back as they were. Clicking a chip
// edits its code; typing `{{ ... }}` makes one.

const SECTION = /\{\{([\s\S]*?)\}\}/g;
const TOKEN = /KUSEC(\d+)Z/g;
const tokenOf = (i: number) => `KUSEC${i}Z`;
const sectionText = (code: string) => `{{${code}}}`;

/**
 * The text with each section replaced by a token, and the sections' code (by token number).
 * They are added to `sections` when given: one list serves everything loaded into an editor.
 */
export function protectSections(text: string, sections: string[] = []): { text: string; sections: string[] } {
  const protectedText = text.replace(SECTION, (_, code: string) => tokenOf(sections.push(code) - 1));
  return { text: protectedText, sections };
}

/** Tokens (still in the text, e.g. inside a code block) turned back into their sections. */
export function restoreSections(text: string, sections: string[]): string {
  return text.replace(TOKEN, (token, i: string) => (sections[Number(i)] !== undefined ? sectionText(sections[Number(i)]) : token));
}

/** What a chip shows: the code on one line, cut at 28 characters. */
const chipText = (code: string) => {
  const line = code.trim().replace(/\s+/g, " ");
  return `{{ ${line.length > 28 ? `${line.slice(0, 27)}…` : line} }}`;
};

/** The chip: an inline atom holding a section's code. Written to Markdown as the section itself (raw: html nodes are not escaped). */
export const sectionNode = $node("section", () => ({
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  attrs: { code: { default: "" } },
  parseDOM: [{ tag: "span[data-section]", getAttrs: (dom) => ({ code: (dom as HTMLElement).dataset.section ?? "" }) }],
  toDOM: (node) => ["span", { class: "md-section", "data-section": node.attrs.code, title: node.attrs.code }, chipText(node.attrs.code)],
  parseMarkdown: { match: () => false, runner: () => undefined },
  toMarkdown: {
    match: (node) => node.type.name === "section",
    runner: (state, node) => {
      state.addNode("html", undefined, sectionText(node.attrs.code as string));
    },
  },
}));

/** Typing the closing `}}` of `{{ ... }}` makes it a chip (the code may hold braces, up to the first `}}`). */
export const sectionInputRule = $inputRule(
  (ctx) =>
    new InputRule(/\{\{((?:(?!\{\{)[\s\S])*?)\}\}$/, (state, match, start, end) =>
      state.tr.replaceWith(start, end, sectionNode.type(ctx).create({ code: match[1] })),
    ),
);

/** Replaces the tokens in the document (where a chip can go) by chips, in `tr`. */
function tokensToChips(tr: Transaction, type: NodeType, sections: string[]) {
  const found: { from: number; to: number; code: string }[] = [];
  tr.doc.descendants((node: ProseNode, pos: number, parent: ProseNode | null) => {
    if (!node.isText || !parent?.type.inlineContent || parent.type.spec.code) return;
    for (const m of node.text!.matchAll(TOKEN)) {
      const code = sections[Number(m[1])];
      if (code !== undefined) found.push({ from: pos + m.index!, to: pos + m.index! + m[0].length, code });
    }
  });
  for (const f of found.reverse()) tr.replaceWith(f.from, f.to, type.create({ code: f.code }));
  return found.length > 0;
}

/**
 * Turns the tokens of the loaded text into chips (once, as the editor opens; not undoable), and
 * pasted text with sections into text with chips. Tokens where a chip can't go (code blocks)
 * stay text and are restored on the way out.
 */
export function sectionTokens(sections: string[]) {
  return $prose(
    (ctx) =>
      new Plugin({
        view: (view) => {
          if (sections.length > 0) {
            queueMicrotask(() => {
              const tr = view.state.tr.setMeta("addToHistory", false);
              if (tokensToChips(tr, sectionNode.type(ctx), sections)) view.dispatch(tr);
            });
          }
          return {};
        },
        props: {
          // Pasted plain text with sections (copied from elsewhere; the editor's own copies carry
          // html with chips): parsed as Markdown with the sections held out, then made chips.
          handlePaste(view, event) {
            const data = event.clipboardData;
            const text = data?.getData("text/plain") ?? "";
            if (!text.includes("{{") || data?.types.includes("text/html")) return false;
            const doc = ctx.get(parserCtx)(protectSections(text, sections).text);
            const open = doc.childCount === 1 ? 1 : 0;
            const tr = view.state.tr.replaceSelection(new Slice(doc.content, open, open));
            tokensToChips(tr, sectionNode.type(ctx), sections);
            view.dispatch(tr.scrollIntoView().setMeta("paste", true));
            return true;
          },
        },
      }),
  );
}

/** Clicking a chip asks to edit it: its position and code. */
export function sectionClick(onEdit: (section: { pos: number; code: string }) => void) {
  return $prose(
    () =>
      new Plugin({
        props: {
          handleClickOn(_view, _pos, node, nodePos) {
            if (node.type.name !== "section") return false;
            onEdit({ pos: nodePos, code: node.attrs.code as string });
            return true;
          },
        },
      }),
  );
}
