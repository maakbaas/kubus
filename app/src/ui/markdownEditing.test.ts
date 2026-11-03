// @vitest-environment jsdom
// The Markdown editor's syntax (CommonMark + GFM + GitHub's math, as MarkdownEditor loads it) through copy and paste, and
// the keys of markdownKeys.ts: in a real Milkdown editor on jsdom.
import { afterEach, describe, expect, test } from "vitest";
import katex from "katex";
import { Editor, defaultValueCtx, editorViewCtx, rootCtx, serializerCtx } from "@milkdown/kit/core";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import { clipboard } from "@milkdown/kit/plugin/clipboard";
import { DOMSerializer, Slice } from "@milkdown/kit/prose/model";
import { AllSelection, TextSelection } from "@milkdown/kit/prose/state";
import * as proseView from "@milkdown/kit/prose/view";
import type { EditorView } from "@milkdown/kit/prose/view";
import { markdownMath } from "./markdownMath";
import { caretInText, exitSourceBlockAtEnd, tableFromTypedRows, unstyleAtCaret } from "./markdownKeys";

/** Every syntax the editor knows, written as the editor writes it (so a round trip gives it back unchanged). */
const EVERY_SYNTAX = `# Heading 1

## Heading 2

### Heading 3

#### Heading 4

##### Heading 5

###### Heading 6

Text with **bold**, *italic*, ~~struck~~, \`code\`, a [link](https://example.com), a [titled link](https://example.com "Title"), <https://auto.example.com>, an ![image](files/abc "Image") and a formula $e^{i\\pi} + 1 = 0$ in it.\\
A line after a hard break, an escaped \\$ dollar, \\*not italic\\* and ***bold italic***.

> A quote
>
> > nested

* One
* Two
  * Nested

1. First
2. Second

* [ ] To do
* [x] Done

\`\`\`js
const a = 1;
\`\`\`

\`\`\`
plain code
\`\`\`

$$
\\int_0^1 x^2 \\, dx = \\frac{1}{3}
$$

***

| Left | Centre | Right |
| :--- | :----: | ----: |
| a    |  **b** |   $c$ |

A footnote[^1].

[^1]: The note.
`;

let editors: Editor[] = [];
afterEach(async () => {
  await Promise.all(editors.map((e) => e.destroy()));
  editors = [];
  document.body.innerHTML = "";
});

async function makeEditor(markdown: string) {
  const root = document.createElement("div");
  document.body.append(root);
  const editor = await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, root);
      ctx.set(defaultValueCtx, markdown);
    })
    .use(commonmark)
    .use(gfm)
    .use(markdownMath)
    .use(caretInText)
    .use(clipboard)
    .create();
  editors.push(editor);
  const view = editor.action((ctx) => ctx.get(editorViewCtx));
  const markdownOf = () => editor.action((ctx) => ctx.get(serializerCtx))(view.state.doc);
  return { view, markdownOf };
}

/** What a copy of the whole text puts on the clipboard: HTML (as ProseMirror writes it) and text (the clipboard plugin's Markdown). */
function copyAll(view: EditorView) {
  const slice = view.state.doc.slice(0, view.state.doc.content.size);
  const box = document.createElement("div");
  box.append(DOMSerializer.fromSchema(view.state.schema).serializeFragment(slice.content));
  let text = "";
  view.someProp("clipboardTextSerializer", (f) => {
    text = f(slice, view);
    return true;
  });
  return { html: box.innerHTML, text };
}

/** ProseMirror's own parse of pasted HTML (exported for tests, though not in its types). */
const parseFromClipboard = (proseView as unknown as {
  __parseFromClipboard(view: EditorView, text: string, html: string | null, plainText: boolean, $context: unknown): Slice | null;
}).__parseFromClipboard;

/** A paste into the editor (replacing everything), as ProseMirror and the clipboard plugin handle it. */
function paste(view: EditorView, data: { html?: string; text?: string }) {
  view.dispatch(view.state.tr.setSelection(new AllSelection(view.state.doc)));
  const clipboardData = { getData: (type: string) => (type === "text/html" ? (data.html ?? "") : type === "text/plain" ? (data.text ?? "") : "") };
  const event = { clipboardData } as unknown as ClipboardEvent;
  const slice: Slice | null = data.html ? parseFromClipboard(view, data.text ?? "", data.html, false, view.state.selection.$from) : null;
  const handled = view.someProp("handlePaste", (f) => f(view, event, slice ?? Slice.empty));
  expect(handled).toBe(true);
}

describe("copy and paste", () => {
  test("every syntax reads and writes back unchanged", async () => {
    const { markdownOf } = await makeEditor(EVERY_SYNTAX);
    expect(markdownOf()).toBe(EVERY_SYNTAX);
  });

  test("every syntax survives a copy and a paste of the editor's HTML", async () => {
    const from = await makeEditor(EVERY_SYNTAX);
    const to = await makeEditor("");
    paste(to.view, copyAll(from.view));
    expect(to.markdownOf()).toBe(EVERY_SYNTAX);
  });

  test("every syntax survives a paste of the Markdown as plain text", async () => {
    const from = await makeEditor(EVERY_SYNTAX);
    const { text } = copyAll(from.view);
    expect(text).toBe(EVERY_SYNTAX);
    const to = await makeEditor("");
    paste(to.view, { text });
    expect(to.markdownOf()).toBe(EVERY_SYNTAX);
  });

  test("formulas copied from a read-only view (rendered by KaTeX) paste as formulas", async () => {
    const inline = katex.renderToString("x^2", { throwOnError: false });
    const display = katex.renderToString("\\frac{a}{b}", { throwOnError: false, displayMode: true });
    const { view, markdownOf } = await makeEditor("");
    paste(view, { html: `<p>Area ${inline} here</p><div class="math math-display">${display}</div>`, text: "Area x^2 here" });
    expect(markdownOf()).toBe("Area $x^2$ here\n\n$$\n\\frac{a}{b}\n$$\n");
  });
});

describe("Backspace at the front of styled text makes it plain", () => {
  /** Backspace with the caret just before the first occurrence of `at` in the text. */
  async function backspaceBefore(markdown: string, at: string) {
    const { view, markdownOf } = await makeEditor(markdown);
    let pos = -1;
    view.state.doc.descendants((node, p) => {
      if (pos >= 0) return false;
      if (node.isText && node.text!.includes(at)) pos = p + node.text!.indexOf(at);
      return true;
    });
    expect(pos).toBeGreaterThanOrEqual(0);
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)));
    const tr = unstyleAtCaret(view.state);
    if (tr) view.dispatch(tr);
    return { handled: !!tr, markdown: markdownOf() };
  }

  test.each([
    ["**bold** text", "bold", "bold text\n"],
    ["a **bold** text", "bold", "a bold text\n"],
    ["a *italic* text", "italic", "a italic text\n"],
    ["a ~~struck~~ text", "struck", "a struck text\n"],
    ["a `code` text", "code", "a code text\n"],
    ["a [link](https://x.y) text", "link", "a link text\n"],
    ["a $x^2$ formula", "x^2", "a x^2 formula\n"],
    ["$x^2$", "x^2", "x^2\n"],
    ["a ***both*** text", "both", "a both text\n"],
    ["## Heading", "Heading", "Heading\n"],
    ["> quoted", "quoted", "quoted\n"],
    ["```\none\ntwo\n```", "one", "one\\\ntwo\n"],
    ["$$\nE = mc^2\n$$", "E = mc^2", "E = mc^2\n"],
    ["text\n\n$$\nE\n$$", "E", "text\n\nE\n"],
  ])("%j", async (markdown, at, expected) => {
    expect(await backspaceBefore(markdown, at)).toEqual({ handled: true, markdown: expected });
  });

  test("inside styled text, or in plain text, Backspace deletes as usual", async () => {
    expect((await backspaceBefore("a **bold** text", "old")).handled).toBe(false);
    expect((await backspaceBefore("a **bold** text", "text")).handled).toBe(false);
    expect((await backspaceBefore("plain", "lain")).handled).toBe(false);
  });
});

test("Down at the end of a formula block that ends the text makes a paragraph after it", async () => {
  const { view, markdownOf } = await makeEditor("$$\nE\n$$");
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 2)));
  const tr = exitSourceBlockAtEnd(view.state, "ArrowDown");
  expect(tr).not.toBeNull();
  view.dispatch(tr!);
  expect(view.state.selection.$from.parent.type.name).toBe("paragraph");
  view.dispatch(view.state.tr.insertText("after"));
  expect(markdownOf()).toBe("$$\nE\n$$\n\nafter\n");
});

describe("Enter after a table's header and delimiter rows typed as text makes the table", () => {
  /** Enter with the caret at the end of the text. */
  async function enterAtEnd(markdown: string) {
    const { view, markdownOf } = await makeEditor(markdown);
    view.dispatch(view.state.tr.setSelection(TextSelection.atEnd(view.state.doc)));
    const tr = tableFromTypedRows(view.state);
    if (tr) view.dispatch(tr);
    const { $from } = view.state.selection;
    return { handled: !!tr, markdown: markdownOf(), inCell: $from.parent.type.name === "paragraph" && $from.node(-1).type.name === "table_cell" };
  }

  test.each([
    // As typed: each row a paragraph, or lines of one (Shift+Enter); the editor saves typed pipes escaped.
    ["\\|a\\|b\\|\n\n\\|-\\|-\\|", "| a | b |\n| - | - |\n|   |   |\n"],
    ["intro\\\n\\| a \\| b \\|\\\n\\| :-- \\| --: \\|", "intro\n\n| a  |  b |\n| :- | -: |\n|    |    |\n"],
  ])("%j", async (markdown, expected) => {
    expect(await enterAtEnd(markdown)).toEqual({ handled: true, markdown: expected, inCell: true });
  });

  test("not without a header row of as many cells", async () => {
    expect((await enterAtEnd("\\|-\\|-\\|")).handled).toBe(false);
    expect((await enterAtEnd("\\|a\\|\n\n\\|-\\|-\\|")).handled).toBe(false);
    expect((await enterAtEnd("\\|a\\|b\\|\n\nnot a delimiter")).handled).toBe(false);
  });
});

test("a change leaving the caret where no text goes puts it in text (a new table's first cell)", async () => {
  const { view } = await makeEditor("\\|a\\|b\\|\n\n\\|-\\|-\\|");
  view.dispatch(view.state.tr.setSelection(TextSelection.atEnd(view.state.doc)));
  const tr = tableFromTypedRows(view.state)!;
  // As Milkdown's |2x2| rule does: the table's first cell, before its paragraph.
  view.dispatch(tr.setSelection(TextSelection.create(tr.doc, 3)));
  expect(view.state.selection.$from.parent.type.name).toBe("paragraph");
  expect(view.state.selection.from).toBe(4);
});
