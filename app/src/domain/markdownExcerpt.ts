import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import type { List, Node, Nodes, RootContent } from "mdast";
import { containsQuery } from "./tags";

// Search excerpts for markdown fields. Rules:
//  1. The document is split into top-level blocks by the GFM parser (headings,
//     paragraphs, lists, tables, code blocks, quotes…), so nothing is cut in half.
//  2. Every block whose *visible* text contains the query is shown, up to MAX_BLOCKS;
//     the rest is counted. Syntax never matches: not URLs, image file ids or HTML.
//  3. A heading is a block of its own: a match in a heading shows just that heading.
//  4. A match in any other block shows that block, preceded by its section heading
//     (the nearest heading above it) unless that heading is already shown.
//  5. For lists only the matching items are shown (nested items included).

const MAX_BLOCKS = 3;

/** The GFM parser, made on first use (a module that only imports this file, like the database worker, never builds it). */
let parser: ReturnType<typeof makeParser> | undefined;
const makeParser = () => unified().use(remarkParse).use(remarkGfm);
const parse = (source: string) => (parser ??= makeParser()).parse(source);

/** Inline containers whose children run together; other containers get spaces between children. */
const PHRASING = new Set(["paragraph", "heading", "emphasis", "strong", "delete", "link", "linkReference", "tableCell"]);

/** The text a reader sees: text and code values and image alt text, no URLs or HTML. */
function visibleText(node: Nodes): string {
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
    return (node.children as Nodes[]).map(visibleText).join(PHRASING.has(node.type) ? "" : " ");
  }
  return "";
}

/**
 * Plain texts by source: searching and sorting ask for the same documents over and over (a view's search
 * each keystroke, over every value). The least recently used go first, and there is room for a large
 * collection's values: a pass over more than the cache holds would find none of them in it.
 */
const plainTexts = new Map<string, string>();
const PLAIN_TEXTS_MAX = 20_000;

/** Visible text of a whole markdown document, for matching (e.g. table search). */
export function markdownPlainText(source: string): string {
  let text = plainTexts.get(source);
  if (text === undefined) {
    text = visibleText(parse(source));
    if (plainTexts.size >= PLAIN_TEXTS_MAX) plainTexts.delete(plainTexts.keys().next().value!);
  } else plainTexts.delete(source);
  plainTexts.set(source, text);
  return text;
}

export interface MarkdownExcerpt {
  /** Markdown to render: the selected blocks, separated by blank lines. */
  markdown: string;
  /** Matching blocks left out because of the cap. */
  more: number;
}

export function markdownExcerpt(source: string, query: string, exactTag = false): MarkdownExcerpt {
  const slice = (n: Node) => source.slice(n.position?.start.offset ?? 0, n.position?.end.offset ?? 0);
  const matches = (n: Node) => containsQuery(visibleText(n as Nodes), query, exactTag);
  /** A list reduced to its matching items, as source text. */
  const matchingItems = (list: List) =>
    list.children
      .filter(matches)
      .map(slice)
      .join(list.spread ? "\n\n" : "\n");

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
    parts.push(node.type === "list" ? matchingItems(node) : slice(node));
    shown++;
  }

  return { markdown: parts.join("\n\n"), more };
}
