import { Fragment } from "react";
import { Link } from "@carbon/react";
import { splitWarnings } from "../domain/components";
import { openExternal } from "../platform/openExternal";
import { isTag, splitTags, TAG_QUERY_END } from "../domain/tags";
import { ComponentWarning } from "./ComponentWarning";
import { TagChip } from "./TagChip";

export const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Case-insensitive regex for all occurrences of `query`, or null for an empty query. With
 * `exactTag` a tag (`#books`) matches only that tag (and the tags nested in it), not `#bookshelf`.
 */
export function matcher(query: string, exactTag = false): RegExp | null {
  const q = query.trim();
  if (!q) return null;
  return exactTag && isTag(q) ? new RegExp(escapeRegExp(q) + TAG_QUERY_END, "giu") : new RegExp(escapeRegExp(q), "gi");
}

/** Splits `text` into alternating [plain, match, plain, match, …] parts. */
export function splitMatches(text: string, re: RegExp): string[] {
  const parts: string[] = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    parts.push(text.slice(last, m.index), m[0]);
    last = m.index + m[0].length;
  }
  parts.push(text.slice(last));
  return parts;
}

/** Web addresses in plain text (http and https), without the punctuation that ends a sentence around them. */
const URL_IN_TEXT = /\bhttps?:\/\/[^\s<>"]*[^\s<>"'.,;:!?)\]}]/gi;

/** Splits `text` into alternating [plain, url, plain, url, …] parts. */
export const splitUrls = (text: string): string[] => splitMatches(text, new RegExp(URL_IN_TEXT));

/**
 * Renders `text` with every case-insensitive occurrence of `query` marked, the warnings of
 * failing component sections in it shown as warnings and its `#tags` as tags (TagChip): every
 * plain text the app shows goes through here. With `links`, its web addresses are links too.
 */
export function Highlight({
  text,
  query,
  exactTag,
  tags = true,
  links = false,
}: {
  text: string;
  query: string;
  /** See matcher. */
  exactTag?: boolean;
  /** False where `#` is no tag: code, a link's text. */
  tags?: boolean;
  /**
   * Web addresses in it are links (opened outside the app): in values (text, list entries, AI and
   * component text), never in a title, which is a link to its item itself or is edited by a click.
   */
  links?: boolean;
}) {
  const parts = splitWarnings(text);
  if (parts.length > 1) {
    return (
      <span>
        {parts.map((part, i) =>
          i % 2 === 1 ? <ComponentWarning key={i}>{part}</ComponentWarning> : <Highlight key={i} text={part} query={query} exactTag={exactTag} tags={tags} links={links} />,
        )}
      </span>
    );
  }
  const urlParts = links ? splitUrls(text) : [text];
  if (urlParts.length > 1) {
    return (
      <span>
        {urlParts.map((part, i) =>
          i % 2 === 1 ? (
            <Link
              key={i}
              href={part}
              target="_blank"
              rel="noopener noreferrer"
              // Opens the address only: not also the item (a card, a row) or the value's editor.
              data-own-click
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                openExternal(part);
              }}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <Marked text={part} query={query} exactTag={exactTag} />
            </Link>
          ) : (
            <Highlight key={i} text={part} query={query} exactTag={exactTag} tags={tags} />
          ),
        )}
      </span>
    );
  }
  const tagParts = tags ? splitTags(text) : [text];
  if (tagParts.length > 1) {
    return (
      <span>
        {tagParts.map((part, i) =>
          i % 2 === 1 ? (
            <TagChip key={i} tag={part}>
              <Marked text={part} query={query} exactTag={exactTag} />
            </TagChip>
          ) : (
            <Marked key={i} text={part} query={query} exactTag={exactTag} />
          ),
        )}
      </span>
    );
  }
  return <Marked text={text} query={query} exactTag={exactTag} />;
}

function Marked({ text, query, exactTag }: { text: string; query: string; exactTag?: boolean }) {
  const re = matcher(query, exactTag);
  if (!re) return <>{text}</>;
  // One inline span: in a flex container (cells, links) loose text + <mark> would become
  // separate flex items, which drops the spaces at their edges.
  return (
    <span>
      {splitMatches(text, re).map((part, i) =>
        i % 2 === 1 ? (
          <mark key={i} className="search-mark">
            {part}
          </mark>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
    </span>
  );
}
