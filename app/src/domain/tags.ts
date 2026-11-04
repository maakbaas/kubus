/**
 * Tags: `#name` anywhere in text (Obsidian style). They are not Markdown syntax (a value stays
 * plain GFM, `#tag` is text in it): every place that shows text renders them as a tag, and
 * clicking one searches for it (`tagSearchPath`).
 *
 * A tag starts with `#` where a word doesn't continue (not in `a#b`, `&#123;`, `##`, a URL's
 * `/#x`), and is letters, digits, `_`, `-` and `/` (nested tags, `#books/to-read`), with at least
 * one letter or `_` (`#1` is a number) and not ending in `-` or `/`.
 */
export const TAG_SOURCE = String.raw`(?<![\p{L}\p{N}_&#/\\])#(?=[\p{L}\p{N}_/-]*[\p{L}_])[\p{L}\p{N}_](?:[\p{L}\p{N}_/-]*[\p{L}\p{N}_])?`;

/** Every tag in a text (global: use with matchAll / replace). */
export const tagPattern = () => new RegExp(TAG_SOURCE, "gu");

/** Whether `text` is exactly one tag (`#books`), e.g. a search for a tag. */
export const isTag = (text: string) => new RegExp(`^${TAG_SOURCE}$`, "u").test(text);

/** Splits `text` into alternating [plain, tag, plain, tag, …] parts (a tag with its `#`). */
export function splitTags(text: string): string[] {
  const parts: string[] = [];
  let last = 0;
  if (!text.includes("#")) return [text];
  for (const m of text.matchAll(tagPattern())) {
    parts.push(text.slice(last, m.index), m[0]);
    last = m.index + m[0].length;
  }
  parts.push(text.slice(last));
  return parts;
}

/** The tags in a text, lower case, each once. */
export const tagsIn = (text: string) => [...new Set([...text.matchAll(tagPattern())].map((m) => m[0].toLowerCase()))];

/**
 * The search page for a tag (an app route; `#…` in an href): `tag=1` searches for exactly that
 * tag. A search typed in the box is for text, so `#books` typed there also finds `#bookshelf`.
 */
export const tagSearchPath = (tag: string) => `/search?q=${encodeURIComponent(tag)}&tag=1`;

/** Whether a stored link (`#/search?…`) is a tag's search page (a bookmark of it), e.g. to show it as "Tag". */
export function isTagSearchLink(link: string): boolean {
  const path = link.startsWith("#") ? link.slice(1) : link;
  if (!path.startsWith("/search?")) return false;
  const params = new URLSearchParams(path.slice("/search?".length));
  return params.get("tag") === "1" && isTag(params.get("q") ?? "");
}

/**
 * Whether `text` contains `query`, case-insensitively. With `exactTag` a tag query (`#books`)
 * matches only that tag: not `#bookshelf` (but `#books/to-read`, a tag nested in it).
 */
export function containsQuery(text: string, query: string, exactTag = false): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return false;
  if (!exactTag || !isTag(q)) return text.toLowerCase().includes(q);
  return tagsIn(text).some((t) => t === q || t.startsWith(`${q}/`));
}

/** The end of a tag query's match: no further tag characters but a nested tag's `/`. */
export const TAG_QUERY_END = String.raw`(?![\p{L}\p{N}_-])`;

/**
 * Carbon's tag colours, in the order tags get them (neighbours far apart; no grey ones but the beige warm grey: grey is a new tag's). A tag's colour is its place among the tags in use A to Z
 * (`TagIndex`) cycling through these: every tag the same colour everywhere, the tags around it others.
 */
export const TAG_COLORS = ["blue", "magenta", "green", "purple", "teal", "red", "cyan", "warm-gray"] as const;
/** A tag not in the index yet (being typed): grey, which no indexed tag gets. */
export const NEW_TAG_COLOR = "gray";
export type TagColor = (typeof TAG_COLORS)[number] | typeof NEW_TAG_COLOR;

/** Each tag in use (lower case, with its `#`) and its place among them A to Z (app/tagIndex.tsx): its colour. */
export type TagIndex = Record<string, number>;

/** A tag's colour: its place's, cycling through TAG_COLORS; grey while it isn't in use yet (being typed, or only in a remote source). */
export function tagColor(index: TagIndex, tag: string): TagColor {
  const n = index[tag.toLowerCase()];
  return n === undefined ? NEW_TAG_COLOR : TAG_COLORS[n % TAG_COLORS.length];
}

/** A tag being typed at the end of `before` (the text before the caret): `#` where a tag can start, then what a tag may hold. */
const TAG_BEGIN = /(?<![\p{L}\p{N}_&#/\\])#(?:[\p{L}\p{N}_][\p{L}\p{N}_/-]*)?$/u;
export const tagBeingTyped = (before: string): string | null => TAG_BEGIN.exec(before)?.[0] ?? null;

/** The most tags offered at once. */
const MAX_TAGS = 30;

/**
 * The tags in use that fit what is typed (`#boo`), in their order (A to Z): those starting with it first, then those
 * containing it. `#` alone offers them all.
 */
export function matchingTags(used: { tag: string; count: number }[], query: string): { tag: string; count: number }[] {
  const q = query.toLowerCase();
  const starting = used.filter((t) => t.tag.startsWith(q));
  const containing = q.length > 1 ? used.filter((t) => !t.tag.startsWith(q) && t.tag.includes(q.slice(1))) : [];
  return [...starting, ...containing].slice(0, MAX_TAGS);
}

