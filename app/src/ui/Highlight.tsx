import { Fragment } from "react";
import { splitWarnings } from "../domain/components";
import { ComponentWarning } from "./ComponentWarning";

export const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Case-insensitive regex for all occurrences of `query`, or null for an empty query. */
export function matcher(query: string): RegExp | null {
  const q = query.trim();
  return q ? new RegExp(escapeRegExp(q), "gi") : null;
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

/**
 * Renders `text` with every case-insensitive occurrence of `query` marked, and the warnings of
 * failing component sections in it shown as warnings.
 */
export function Highlight({ text, query }: { text: string; query: string }) {
  const parts = splitWarnings(text);
  if (parts.length > 1) {
    return (
      <span>
        {parts.map((part, i) =>
          i % 2 === 1 ? <ComponentWarning key={i}>{part}</ComponentWarning> : <Highlight key={i} text={part} query={query} />,
        )}
      </span>
    );
  }
  const re = matcher(query);
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
