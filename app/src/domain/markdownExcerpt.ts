import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import type { List, Node, Nodes, Paragraph, PhrasingContent, RootContent, Table } from "mdast";
import { containsQuery } from "./tags";
import { memoText } from "./memoText";

// Search excerpts for markdown fields. Rules:
//  1. The document is split into top-level blocks by the GFM parser (headings,
//     paragraphs, lists, tables, code blocks, quotes…), so nothing is cut in half.
//  2. Every block whose *visible* text contains the query is shown, up to MAX_BLOCKS;
//     the rest is counted. Syntax never matches: not URLs, image file ids or HTML.
//  3. A heading is a block of its own: a match in a heading shows just that heading.
//  4. A match in any other block shows that block, preceded by its section heading
//     (the nearest heading above it) unless that heading is already shown.
//  5. For lists only the matching items are shown (nested items included); for tables
//     the header and the matching rows (a long table would fill the excerpt with rows
//     around the match, or leave the match below its cut-off).
//  6. A paragraph is shown without its images and without the line breaks they leave at
//     its start or end (an image after Shift+Enter is part of the paragraph above it, but
//     reads as a block of its own: in a result it was a tall line, or blank space while
//     not loaded). A paragraph with nothing else left is not shown.
//  7. A long paragraph (over MAX_PARAGRAPH characters of visible text) is cut to the sentences around its first
//     match (`aroundMatch`), with "…" where text was left out: the match is always in what is shown, however
//     narrow the result, and no sentence is cut in half. Cuts are only between sentences in plain text, never
//     inside a link, emphasis or code, so the Markdown stays whole.

const MAX_BLOCKS = 3;
/** A paragraph longer than this (visible characters) is cut to the sentences around its match. */
const MAX_PARAGRAPH = 240;

/**
 * A long paragraph's Markdown (`text`, one paragraph) cut to the sentences around its first match: from the start of
 * the sentence holding it, on while the excerpt stays within MAX_PARAGRAPH characters (at least to that sentence's
 * end). Cuts are made only after a sentence's end (". ", "! ", "? ") inside the paragraph's plain text, so no syntax
 * is cut through; "…" marks text left out. Text that is short enough, or has no match, is returned as it is.
 */
export function aroundMatch(text: string, query: string, exactTag = false): string {
  const tree = parse(text).children[0];
  if (!tree || tree.type !== "paragraph" || visibleText(tree).length <= MAX_PARAGRAPH) return text;
  const children = tree.children;
  const at = (n: Node, end = false) => (end ? n.position?.end.offset : n.position?.start.offset) ?? 0;
  const hit = children.find((c) => containsQuery(visibleText(c as Nodes), query, exactTag));
  if (!hit) return text;
  // Where the match is in the source: its place in a plain text, else the whole of the node holding it.
  let matchFrom = at(hit);
  let matchTo = at(hit, true);
  if (hit.type === "text") {
    const i = hit.value.toLowerCase().indexOf(query.trim().toLowerCase());
    if (i >= 0) {
      matchFrom = at(hit) + i;
      matchTo = matchFrom + query.trim().length;
    }
  }
  // Safe cuts: right after a sentence's end and the space after it, in plain text.
  const cuts: number[] = [];
  for (const c of children) {
    if (c.type !== "text") continue;
    const source = text.slice(at(c), at(c, true));
    for (const m of source.matchAll(/[.!?…]["')\]]*\s+/g)) cuts.push(at(c) + m.index + m[0].length);
  }
  const start = Math.max(0, ...cuts.filter((p) => p <= matchFrom));
  const after = cuts.filter((p) => p >= matchTo).sort((a, b) => a - b);
  let end = after[0] ?? text.length;
  for (const p of after.slice(1)) {
    if (p - start > MAX_PARAGRAPH) break;
    end = p;
  }
  if (start === 0 && end >= text.length) return text;
  return `${start > 0 ? "… " : ""}${text.slice(start, end).trim()}${end < text.length ? " …" : ""}`;
}

/** The GFM parser, made on first use (a module that only imports this file, like the database worker, never builds it). */
let parser: ReturnType<typeof makeParser> | undefined;
const makeParser = () => unified().use(remarkParse).use(remarkGfm);
const parse = (source: string) => (parser ??= makeParser()).parse(source);

/** Inline containers whose children run together; other containers get spaces between children. */
const PHRASING = new Set(["paragraph", "heading", "emphasis", "strong", "delete", "link", "linkReference", "tableCell"]);

/**
 * The text a reader sees: text and code values and image alt text, no URLs or HTML. `seen`: texts already worked out,
 * by node (an excerpt asks for a list's and then each of its items', a table's and then each row's).
 */
function visibleText(node: Nodes, seen?: WeakMap<Node, string>): string {
  const known = seen?.get(node);
  if (known !== undefined) return known;
  const text = textOf(node, seen);
  seen?.set(node, text);
  return text;
}

function textOf(node: Nodes, seen?: WeakMap<Node, string>): string {
  switch (node.type) {
    case "text":
    case "inlineCode":
    case "code":
      return node.value;
    case "image":
    case "imageReference":
      return node.alt ?? "";
    case "html":
      return "";
  }
  if ("children" in node) {
    return (node.children as Nodes[]).map((child) => visibleText(child, seen)).join(PHRASING.has(node.type) ? "" : " ");
  }
  return "";
}

/** Visible text of a whole markdown document, for matching (e.g. table search); remembered by source (memoText). */
export const markdownPlainText = memoText((source) => visibleText(parse(source)));

export interface MarkdownExcerpt {
  /** Markdown to render: the selected blocks, separated by blank lines. */
  markdown: string;
  /** Matching blocks left out because of the cap. */
  more: number;
}

export function markdownExcerpt(source: string, query: string, exactTag = false): MarkdownExcerpt {
  const slice = (n: Node) => source.slice(n.position?.start.offset ?? 0, n.position?.end.offset ?? 0);
  const seen = new WeakMap<Node, string>();
  const matches = (n: Node) => containsQuery(visibleText(n as Nodes, seen), query, exactTag);
  /** A list reduced to its matching items, as source text. */
  const matchingItems = (list: List) =>
    list.children
      .filter(matches)
      .map(slice)
      .join(list.spread ? "\n\n" : "\n");
  /** A table reduced to its header (with the delimiter row under it) and its matching rows, as source text. */
  const matchingRows = (table: Table) => {
    const [header, ...rows] = table.children;
    const delimiter = slice(table).split("\n")[1] ?? "";
    return [slice(header), delimiter, ...rows.filter(matches).map(slice)].join("\n");
  };

  /** A paragraph without its images (and the editor's `<br />` lines), its outer and doubled line breaks dropped, as source text. */
  const withoutImages = (paragraph: Paragraph) => {
    const isBreak = (n: PhrasingContent) => n.type === "break" || (n.type === "html" && /^<br\s*\/?>$/i.test(n.value.trim()));
    const blank = (n: PhrasingContent) => isBreak(n) || (n.type === "text" && !n.value.trim());
    const kept: PhrasingContent[] = [];
    for (const n of paragraph.children) {
      if (n.type === "image" || n.type === "imageReference" || (n.type === "html" && !isBreak(n))) continue;
      const last = kept[kept.length - 1];
      if (isBreak(n) && last && isBreak(last)) continue;
      kept.push(n);
    }
    while (kept.length && blank(kept[0])) kept.shift();
    while (kept.length && blank(kept[kept.length - 1])) kept.pop();
    if (kept.length === paragraph.children.length) return slice(paragraph);
    return kept.map((n) => (isBreak(n) ? "\\\n" : slice(n))).join("").trim();
  };

  const parts: string[] = [];
  let shown = 0;
  let more = 0;
  let section: RootContent | null = null;
  let sectionShown = false;

  for (const node of parse(source).children) {
    if (node.type === "heading") {
      section = node;
      sectionShown = false;
    }
    if (!matches(node)) continue;
    const text = node.type === "list" ? matchingItems(node) : node.type === "table" ? matchingRows(node) : node.type === "paragraph" ? aroundMatch(withoutImages(node), query, exactTag) : slice(node);
    if (!text) continue;
    if (shown >= MAX_BLOCKS) {
      more++;
      continue;
    }
    if (node.type === "heading") {
      sectionShown = true;
    } else if (section && !sectionShown) {
      parts.push(slice(section));
      sectionShown = true;
    }
    parts.push(text);
    shown++;
  }

  return { markdown: parts.join("\n\n"), more };
}
