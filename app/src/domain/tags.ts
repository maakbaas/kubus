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
