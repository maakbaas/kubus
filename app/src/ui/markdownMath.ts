// GitHub's math in the Markdown editor ($…$, $$…$$; the one addition to GFM, rendered by KaTeX in MarkdownView): the
// editor parses and writes it with remark-math, and shows a formula's source to edit (marked as math: styles.css), as
// a code span or block is. Typing `$x$` makes an inline formula, `$$` and a space a formula block; a `$` in text is
// otherwise written escaped (`\$`), so it stays a dollar.
import remarkMath from "remark-math";
import { markRule } from "@milkdown/kit/prose";
import { textblockTypeInputRule } from "@milkdown/kit/prose/inputrules";
import { $inputRule, $markSchema, $nodeSchema, $remark } from "@milkdown/kit/utils";

const remarkMathPlugin = $remark("remarkMath", () => remarkMath);

/** An inline formula ($…$): its source, as a mark over text (like inline code). */
const mathInlineSchema = $markSchema("math_inline", () => ({
  priority: 100,
  code: true,
  inclusive: false,
  parseDOM: [{ tag: "code.md-math" }],
  toDOM: () => ["code", { class: "md-math" }],
  parseMarkdown: {
    match: (node) => node.type === "inlineMath",
    runner: (state, node, markType) => {
      state.openMark(markType);
      state.addText(String(node.value ?? ""));
      state.closeMark(markType);
    },
  },
  toMarkdown: {
    match: (mark) => mark.type.name === "math_inline",
    runner: (state, mark, node) => {
      state.withMark(mark, "inlineMath", node.text || "");
      return true;
    },
  },
}));

/** A formula block ($$ … $$): its source, as a code block holds its code. */
const mathBlockSchema = $nodeSchema("math_block", () => ({
  content: "text*",
  group: "block",
  marks: "",
  defining: true,
  code: true,
  parseDOM: [{ tag: "pre.md-math-block", preserveWhitespace: "full" }],
  toDOM: () => ["pre", { class: "md-math-block" }, ["code", 0]],
  parseMarkdown: {
    match: (node) => node.type === "math",
    runner: (state, node, type) => {
      state.openNode(type);
      if (node.value) state.addText(String(node.value));
      state.closeNode();
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === "math_block",
    runner: (state, node) => {
      state.addNode("math", undefined, node.content.firstChild?.text || "");
    },
  },
}));

/** `$x$` typed: an inline formula; not with a space just inside a `$` ("$5 and $10" stays text). */
const mathInlineInputRule = $inputRule((ctx) =>
  markRule(/(?:^|[^$\\])\$(?! )([^$]*[^$ ])\$$/, mathInlineSchema.type(ctx), {
    // The character before the opening `$` (matched to rule out `$$` and `\$`) stays: the formula starts at the `$`.
    updateCaptured: ({ fullMatch, start }) => (fullMatch.startsWith("$") ? {} : { fullMatch: fullMatch.slice(1), start: start + 1 }),
  }),
);

/** `$$` and a space at the start of a paragraph: a formula block. */
const mathBlockInputRule = $inputRule((ctx) => textblockTypeInputRule(/^\$\$\s$/, mathBlockSchema.type(ctx)));

/** Everything math in the editor. */
export const markdownMath = [remarkMathPlugin, mathInlineSchema, mathBlockSchema, mathInlineInputRule, mathBlockInputRule].flat();
