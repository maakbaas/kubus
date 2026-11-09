// @vitest-environment jsdom
// What the Markdown editor's bars, `/` menu and keys do (markdownActions.ts, markdownEdges.ts), asserted on the Markdown
// written: in a real Milkdown editor on jsdom, as MarkdownEditor loads it.
import { afterEach, describe, expect, test } from "vitest";
import { Editor, defaultValueCtx, editorViewCtx, rootCtx, serializerCtx } from "@milkdown/kit/core";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import { history } from "@milkdown/kit/plugin/history";
import { TextSelection, type Command } from "@milkdown/kit/prose/state";
import { CellSelection } from "@milkdown/kit/prose/tables";
import type { EditorView } from "@milkdown/kit/prose/view";
import { markdownMath } from "./markdownMath";
import { caretInText } from "./markdownKeys";
import { markdownEdges, stepAtEdge } from "./markdownEdges";
import {
  addRowAbove,
  addRowBelow,
  alignColumn,
  blockKind,
  clearFormatting,
  deleteColumns,
  deleteRows,
  deleteSelectedLines,
  insertChosen,
  insertOptions,
  markActive,
  setHeading,
  setList,
  toggleQuote,
  toggleStyle,
} from "./markdownActions";

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
    .use(markdownEdges)
    .use(history)
    .create();
  editors.push(editor);
  const view: EditorView = editor.action((ctx) => ctx.get(editorViewCtx));
  const markdown$ = () => editor.action((ctx) => ctx.get(serializerCtx))(view.state.doc);
  /** The document position of the `offset`th character of the first occurrence of `text`. */
  const at = (text: string, offset = 0) => {
    let pos = -1;
    view.state.doc.descendants((node, p) => {
      if (pos >= 0) return false;
      if (node.isText && node.text!.includes(text)) pos = p + node.text!.indexOf(text) + offset;
      return true;
    });
    expect(pos).toBeGreaterThanOrEqual(0);
    return pos;
  };
  const caret = (pos: number, to = pos) => view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos, to)));
  const run = (command: Command) => command(view.state, view.dispatch);
  const type = (text: string) => view.dispatch(view.state.tr.insertText(text));
  return { view, markdown: markdown$, at, caret, run, type };
}

describe("inline styles", () => {
  test("off with a caret: the whole stretch loses it, and what is typed next is plain", async () => {
    const e = await makeEditor("a **bold words** b");
    e.caret(e.at("bold", 2));
    expect(markActive(e.view.state, "strong")).toBe(true);
    e.run(toggleStyle("strong"));
    expect(markActive(e.view.state, "strong")).toBe(false);
    e.type("X");
    expect(e.markdown()).toBe("a boXld words b\n");
  });

  test("on with a caret: for what is typed next", async () => {
    const e = await makeEditor("plain");
    e.caret(e.at("plain", 5));
    e.run(toggleStyle("emphasis"));
    expect(markActive(e.view.state, "emphasis")).toBe(true);
    e.type("it");
    expect(e.markdown()).toBe("plain*it*\n");
  });

  test("a selection: all of it gets the style, or loses it when it all has it", async () => {
    const e = await makeEditor("one two");
    e.caret(e.at("two"), e.at("two", 3));
    e.run(toggleStyle("strike_through"));
    expect(e.markdown()).toBe("one ~~two~~\n");
    e.run(toggleStyle("strike_through"));
    expect(e.markdown()).toBe("one two\n");
  });

  test("code typed on goes on in it (it doesn't stretch over a character by itself)", async () => {
    const e = await makeEditor("x");
    e.caret(e.at("x", 1));
    e.run(toggleStyle("inlineCode"));
    e.type("a");
    e.type("b");
    expect(e.markdown()).toBe("x`ab`\n");
  });

  test("Clear formatting takes every style but a link and a formula off", async () => {
    const e = await makeEditor("**bold** *it* [link](https://x.y) $x$");
    e.caret(1, e.view.state.doc.content.size - 1);
    e.run(clearFormatting);
    expect(e.markdown()).toBe("bold it [link](https://x.y) $x$\n");
  });
});

describe("the caret at a style's edge", () => {
  test("→ at the end of bold steps out without moving, ← back in; a character on lands on the side it comes from", async () => {
    const e = await makeEditor("a **bold** b");
    const end = e.at("bold", 4);
    e.caret(e.at("bold", 3));
    e.view.dispatch(stepAtEdge(e.view.state, "ArrowRight")!);
    expect(e.view.state.selection.from).toBe(end);
    expect(markActive(e.view.state, "strong")).toBe(true);
    e.view.dispatch(stepAtEdge(e.view.state, "ArrowRight")!);
    expect(e.view.state.selection.from).toBe(end);
    expect(markActive(e.view.state, "strong")).toBe(false);
    e.view.dispatch(stepAtEdge(e.view.state, "ArrowLeft")!);
    expect(markActive(e.view.state, "strong")).toBe(true);
    // From the plain side, one character back onto the edge: outside.
    e.caret(end + 1);
    e.view.dispatch(stepAtEdge(e.view.state, "ArrowLeft")!);
    expect(e.view.state.selection.from).toBe(end);
    expect(markActive(e.view.state, "strong")).toBe(false);
    e.type("X");
    expect(e.markdown()).toBe("a **bold**X b\n");
  });

  test("a click at an edge is outside", async () => {
    const e = await makeEditor("a **bold** b");
    e.view.dispatch(e.view.state.tr.setSelection(TextSelection.create(e.view.state.doc, e.at("bold", 4))).setMeta("pointer", true));
    expect(markActive(e.view.state, "strong")).toBe(false);
  });

  test("no edge: an ordinary move", async () => {
    const e = await makeEditor("plain text");
    e.caret(e.at("plain", 2));
    expect(stepAtEdge(e.view.state, "ArrowRight")).toBeNull();
  });
});

describe("blocks", () => {
  test("text to a heading and back, its text kept", async () => {
    const e = await makeEditor("Title");
    e.caret(e.at("Title", 1));
    e.run(setHeading(2));
    expect(e.markdown()).toBe("## Title\n");
    expect(blockKind(e.view.state)).toMatchObject({ text: "heading", level: 2 });
    e.run(setHeading(0));
    expect(e.markdown()).toBe("Title\n");
  });

  test("a quote on and off", async () => {
    const e = await makeEditor("Said");
    e.caret(e.at("Said", 1));
    e.run(toggleQuote);
    expect(e.markdown()).toBe("> Said\n");
    expect(blockKind(e.view.state).quote).toBe(true);
    e.run(toggleQuote);
    expect(e.markdown()).toBe("Said\n");
  });

  test("a list made, switched between kinds and back to text", async () => {
    const e = await makeEditor("one");
    e.caret(e.at("one", 1));
    e.run(setList("bullet"));
    expect(e.markdown()).toBe("* one\n");
    e.run(setList("task"));
    expect(e.markdown()).toBe("* [ ] one\n");
    expect(blockKind(e.view.state).list).toBe("task");
    e.run(setList("ordered"));
    expect(e.markdown()).toBe("1. one\n");
    e.run(setList("ordered"));
    expect(e.markdown()).toBe("one\n");
  });
});

describe("tables", () => {
  const TABLE = "| a | b | c |\n| - | - | - |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |\n";
  /** A cell selection from the cell holding `from` to the one holding `to`. */
  const cells = (e: Awaited<ReturnType<typeof makeEditor>>, from: string, to: string) => {
    const $a = e.view.state.doc.resolve(e.at(from) - 2);
    const $b = e.view.state.doc.resolve(e.at(to) - 2);
    e.view.dispatch(e.view.state.tr.setSelection(new CellSelection($a, $b)));
  };

  test("several rows selected: all of them deleted; the header too (the next row becomes it)", async () => {
    const e = await makeEditor(TABLE);
    cells(e, "1", "6");
    e.run(deleteRows);
    expect(e.markdown()).toBe("| a | b | c |\n| - | - | - |\n|   |   |   |\n");
    const f = await makeEditor(TABLE);
    cells(f, "a", "3");
    f.run(deleteRows);
    expect(f.markdown()).toBe("| 4 | 5 | 6 |\n| - | - | - |\n|   |   |   |\n");
  });

  test("every column selected, or Delete over the whole table: the table goes", async () => {
    const e = await makeEditor(`${TABLE}\nafter`);
    cells(e, "a", "c");
    e.run(deleteColumns);
    expect(e.markdown()).toBe("after\n");
    const f = await makeEditor(`${TABLE}\nafter`);
    cells(f, "a", "6");
    expect(f.run(deleteSelectedLines)).toBe(true);
    expect(f.markdown()).toBe("after\n");
  });

  test("Delete over whole columns deletes them; over some cells only it leaves them to the table's own keys", async () => {
    const e = await makeEditor(TABLE);
    cells(e, "b", "6");
    e.run(deleteSelectedLines);
    expect(e.markdown()).toBe("| a |\n| - |\n| 1 |\n| 4 |\n");
    const f = await makeEditor(TABLE);
    cells(f, "1", "2");
    expect(f.run(deleteSelectedLines)).toBe(false);
  });

  test("rows added above the header and below, a column aligned", async () => {
    const e = await makeEditor("| a | b |\n| - | - |\n| 1 | 2 |\n");
    e.caret(e.at("a"));
    e.run(addRowAbove);
    expect(e.markdown()).toBe("|   |   |\n| - | - |\n| a | b |\n| 1 | 2 |\n");
    e.caret(e.at("2"));
    e.run(addRowBelow);
    e.caret(e.at("b"));
    e.run(alignColumn("right"));
    expect(e.markdown()).toBe("|   |    |\n| - | -: |\n| a |  b |\n| 1 |  2 |\n|   |    |\n");
  });
});

describe("the / menu", () => {
  test("finds by a word's start; a name starting with the query first", () => {
    expect(insertOptions("ta").map((o) => o.kind)).toEqual(["table", "task"]);
    expect(insertOptions("head").map((o) => o.kind)).toEqual(["h1", "h2", "h3", "h4", "h5", "h6"]);
    expect(insertOptions("")[0].kind).toBe("h1");
    expect(insertOptions("nothing here")).toEqual([]);
  });

  /** Types ` /x` at the end (a `/` after a space opens the menu) and picks `kind`. */
  async function pick(markdown: string, kind: Parameters<typeof insertChosen>[1]) {
    const e = await makeEditor(markdown);
    e.caret(e.view.state.doc.content.size - 1);
    e.type(" ");
    const from = e.view.state.selection.from;
    e.type("/x");
    e.view.dispatch(insertChosen(e.view.state, kind, from, from + 2)!);
    return e;
  }

  test("on an empty line a block takes its place; after text it goes after the line", async () => {
    const e = await makeEditor("");
    e.type("/x");
    e.view.dispatch(insertChosen(e.view.state, "h2", 1, 3)!);
    e.type("Title");
    expect(e.markdown()).toBe("## Title\n");
    const f = await pick("text", "quote");
    f.type("quoted");
    expect(f.markdown()).toBe("text\n\n> quoted\n");
    const g = await pick("text", "table");
    g.type("x");
    expect(g.markdown()).toBe("text\n\n| x |   |   |\n| - | - | - |\n|   |   |   |\n|   |   |   |\n");
  });

  test("inline things at the caret: a footnote with its note to write, a link to a page begun", async () => {
    const e = await pick("See", "footnote");
    e.type("The note");
    expect(e.markdown()).toBe("See [^1]\n\n[^1]: The note\n");
    const f = await pick("See ", "link");
    expect(f.markdown()).toBe("See #/\n");
  });
});
