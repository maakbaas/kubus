import { checklistProgress } from "./checklist";
import type { FieldKind, FieldValue } from "./model";

// Registry of field kinds. Adding a kind = add an item here, a column mapping
// in the schema/CHECK constraint, and an input in ui/FieldInput.tsx.

export type ValueColumn =
  | "value_text"
  | "value_number"
  | "value_date"
  | "value_datetime"
  | "value_bool"
  | "value_ref"
  | "value_file"
  | "value_json";

export interface FieldKindSpec {
  label: string;
  column: ValueColumn;
  fromDb(raw: unknown): FieldValue;
  toDb(value: FieldValue): string | number | null;
  /**
   * Plain-text rendering, also used for sorting/searching in tables.
   * Not meaningful for reference kinds (needs the referenced items; see useReferenceOptions).
   */
  format(value: FieldValue): string;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Local, sortable "YYYY-MM-DD". */
export function formatDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Local "HH:mm". */
export function formatTime(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Local, sortable "YYYY-MM-DD HH:mm". */
export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${formatDate(d)} ${formatTime(d)}`;
}

const PREVIEW_LENGTH = 120;

/** A piece of a Markdown preview: plain text, or a link (its text and target). */
/** Text, or a link (`href` "" for inline code: shown as it is, no link and no tags in it). */
export type PreviewPart = string | { text: string; href: string };

const EMPHASIS = /(\*\*|__|~~|\*|_|`)/g;
/** Marks the place of a link (by its index) while the rest of a line is stripped. */
const LINK_MARK = /\u0000(\d+)\u0000/g;
/** A bare URL (GFM autolink literal), without trailing punctuation. */
const BARE_URL = /https?:\/\/[^\s<>()[\]\u0000]*[^\s<>()[\]\u0000.,;:!?*_~'"]/g;

/**
 * Preview for table cells and cards: all lines joined, markdown syntax stripped, truncated with
 * "…"; links (`[text](url)`, `<url>`, bare URLs) stay links.
 */
export function markdownPreviewParts(md: string): PreviewPart[] {
  const links: { text: string; href: string }[] = [];
  const mark = (text: string, href: string) => `\u0000${links.push({ text: text.replace(EMPHASIS, "") || href, href }) - 1}\u0000`;
  const text = md
    .split("\n")
    .map((line) =>
      line
        .replace(/^\s*(#{1,6}|>|[-*+]|\d+\.)\s+(\[[ xX]\]\s+)?/, "") // block markers, task boxes
        .replace(/^\s*(```|~~~).*$/, "") // code fences
        .replace(/^\s*\|?(\s*:?-+:?\s*\|)+\s*:?-*:?\s*$/, "") // table delimiter rows
        .replace(/`([^`]+)`/g, (_, code: string) => mark(code, "")) // inline code
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, "") // images: no text (an alt like "photo.png" reads as noise)
        .replace(/\[([^\]]*)\]\(\s*<?([^)\s>]*)>?(?:\s+"[^"]*")?\s*\)/g, (_, t: string, href: string) => mark(t, href)) // links
        .replace(/<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^<>\s]*)>/g, (_, href: string) => mark(href, href)) // autolinks, any scheme
        .replace(BARE_URL, (href) => mark(href, href))
        .replace(/<[^>]*>/g, " ") // inline HTML, e.g. <br /> that Milkdown writes for empty lines
        .replace(/&nbsp;/g, " ")
        .replace(/\\$/, "") // backslash hard line break
        .replace(EMPHASIS, "") // emphasis, strike, inline code
        .replace(/\\([!-/:-@[-`{-~])/g, "$1") // backslash escapes (the editor writes "\#tag" at a line's start)
        .replace(/\|/g, " "), // table cell separators
    )
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  // Split at the links, then cut off after PREVIEW_LENGTH visible characters.
  const parts: PreviewPart[] = [];
  let length = 0;
  let last = 0;
  const add = (part: PreviewPart) => {
    const shown = typeof part === "string" ? part : part.text;
    if (length >= PREVIEW_LENGTH || shown === "") return;
    const room = PREVIEW_LENGTH - length;
    length += shown.length;
    if (shown.length <= room) return void parts.push(part);
    const cut = `${shown.slice(0, room - 1).trimEnd()}…`;
    parts.push(typeof part === "string" ? cut : { ...part, text: cut });
  };
  for (const m of text.matchAll(LINK_MARK)) {
    add(text.slice(last, m.index));
    add(links[Number(m[1])]);
    last = m.index + m[0].length;
  }
  add(text.slice(last));
  return parts;
}

/**
 * The text an HTML value shows (tags, scripts and styles left out, common entities decoded),
 * on one line: for table cells, cards, filters and sorting.
 */
export function htmlPlainText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|template|head)\b[\s\S]*?<\/\1\s*>/gi, " ")
    // Block-level tags separate words; inline ones (a, em, span, …) don't.
    .replace(/<\/?(p|div|br|hr|h[1-6]|li|ul|ol|dl|dt|dd|tr|td|th|table|thead|tbody|section|article|header|footer|nav|aside|main|blockquote|pre|figure|figcaption|button|label|input|select|option|textarea)\b[^>]*>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/** An HTML value's text as a preview, truncated with "…" like Markdown previews. */
export function htmlPreview(html: string): string {
  const text = htmlPlainText(html);
  return text.length > PREVIEW_LENGTH ? `${text.slice(0, PREVIEW_LENGTH - 1).trimEnd()}…` : text;
}

/** Plain-text preview for table cells: all lines joined, markdown syntax stripped, truncated with "…". */
export const markdownPreview = (md: string): string => markdownPreviewParts(md).map((p) => (typeof p === "string" ? p : p.text)).join("");

const optionalString = (raw: unknown): FieldValue => (raw == null ? null : String(raw));
const optionalStringToDb = (v: FieldValue) => (typeof v === "string" && v !== "" ? v : null);

function listFromDb(raw: unknown): FieldValue {
  if (raw == null) return null;
  try {
    const parsed: unknown = JSON.parse(String(raw));
    return Array.isArray(parsed) ? parsed.map(String) : null;
  } catch {
    return null;
  }
}
const listToDb = (v: FieldValue) => (Array.isArray(v) && v.length > 0 ? JSON.stringify(v) : null);

export const fieldKinds: Record<FieldKind, FieldKindSpec> = {
  string: {
    label: "String",
    column: "value_text",
    fromDb: optionalString,
    toDb: optionalStringToDb,
    format: (v) => (v == null ? "" : String(v)),
  },
  markdown: {
    label: "Markdown",
    column: "value_text",
    fromDb: optionalString,
    toDb: optionalStringToDb,
    format: (v) => (typeof v === "string" ? markdownPreview(v) : ""),
  },
  // Shown in a sandboxed frame on item pages (as a component's HTML output is); its text elsewhere.
  html: {
    label: "HTML",
    column: "value_text",
    fromDb: optionalString,
    toDb: optionalStringToDb,
    format: (v) => (typeof v === "string" ? htmlPreview(v) : ""),
  },
  number: {
    label: "Number",
    column: "value_number",
    fromDb: (raw) => (raw == null ? null : Number(raw)),
    toDb: (v) => (typeof v === "number" && Number.isFinite(v) ? v : null),
    // Exactly as typed (no thousands separators), so a value reads the same as in its input.
    format: (v) => (typeof v === "number" ? String(v) : ""),
  },
  date: {
    label: "Date",
    column: "value_date",
    fromDb: optionalString,
    toDb: optionalStringToDb,
    format: (v) => (typeof v === "string" ? v : ""),
  },
  datetime: {
    label: "Date & time",
    column: "value_datetime",
    fromDb: optionalString,
    toDb: optionalStringToDb,
    format: (v) => (typeof v === "string" ? formatDateTime(v) : ""),
  },
  checkbox: {
    label: "Checkbox",
    column: "value_bool",
    fromDb: (raw) => (raw == null ? null : Boolean(Number(raw))),
    toDb: (v) => (v == null ? null : v ? 1 : 0),
    format: (v) => (v === true ? "✓" : ""),
  },
  image: {
    label: "Image",
    column: "value_file",
    fromDb: optionalString,
    toDb: optionalStringToDb,
    // The file id; tables render it as a thumbnail.
    format: (v) => (typeof v === "string" ? v : ""),
  },
  item: {
    label: "Item",
    column: "value_ref",
    fromDb: optionalString,
    toDb: optionalStringToDb,
    format: (v) => (typeof v === "string" ? v : ""),
  },
  string_list: {
    label: "List of strings",
    column: "value_json",
    fromDb: listFromDb,
    toDb: listToDb,
    format: (v) => (Array.isArray(v) ? v.join(", ") : ""),
  },
  checklist: {
    label: "Checklist",
    column: "value_json",
    fromDb: listFromDb,
    toDb: listToDb,
    // Tables and cards show how far along it is.
    format: checklistProgress,
  },
  item_list: {
    label: "List of items",
    column: "value_json",
    fromDb: listFromDb,
    toDb: listToDb,
    format: (v) => (Array.isArray(v) ? v.join(", ") : ""),
  },
  // Computed by a component when items are shown (domain/components.ts); never written, so
  // its column is only nominal.
  component: {
    label: "Component",
    column: "value_text",
    fromDb: optionalString,
    toDb: () => null,
    format: (v) => (typeof v === "string" ? markdownPreview(v) : v == null ? "" : String(v)),
  },
  // A component field whose component asks AI: generated by a language model from the
  // component's rendered text (domain/ai.ts) and then stored like any value, never typed: text or
  // Markdown in value_text, a number in value_number (see the repository's assemble), with the
  // prompt it came from in value_json. Not a field type of its own in the UI: a Component field
  // with "Ask AI" on (the kind is fixed once saved, as the values are stored).
  ai: {
    label: "Component (AI)",
    column: "value_text",
    fromDb: optionalString,
    toDb: () => null,
    format: (v) => (typeof v === "string" ? markdownPreview(v) : v == null ? "" : String(v)),
  },
};

/** The field types offered for a new field: every kind but "ai" (a Component field asking AI). */
export const fieldKindList = (Object.keys(fieldKinds) as FieldKind[]).filter((k) => k !== "ai");
/** The field type a kind is chosen as: an AI field is a Component field. */
export const offeredKind = (kind: FieldKind): FieldKind => (kind === "ai" ? "component" : kind);
