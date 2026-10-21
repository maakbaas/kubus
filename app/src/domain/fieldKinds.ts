import { checklistProgress } from "./checklist";
import type { FieldKind, FieldValue } from "./model";

// Registry of field kinds. Adding a kind = add an object here, a column mapping
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
   * Not meaningful for reference kinds (needs the referenced objects; see useReferenceOptions).
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

/** Plain-text preview for table cells: all lines joined, markdown syntax stripped, truncated with "…". */
function markdownPreview(md: string): string {
  const text = md
    .split("\n")
    .map((line) =>
      line
        .replace(/^\s*(#{1,6}|>|[-*+]|\d+\.)\s+(\[[ xX]\]\s+)?/, "") // block markers, task boxes
        .replace(/^\s*(```|~~~).*$/, "") // code fences
        .replace(/^\s*\|?(\s*:?-+:?\s*\|)+\s*:?-*:?\s*$/, "") // table delimiter rows
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, "") // images: no text (an alt like "photo.png" reads as noise)
        .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // links → text
        .replace(/<[^>]*>/g, " ") // inline HTML, e.g. <br /> that Milkdown writes for empty lines
        .replace(/&nbsp;/g, " ")
        .replace(/\\$/, "") // backslash hard line break
        .replace(/(\*\*|__|~~|\*|_|`)/g, "") // emphasis, strike, inline code
        .replace(/\|/g, " "), // table cell separators
    )
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > PREVIEW_LENGTH ? `${text.slice(0, PREVIEW_LENGTH - 1).trimEnd()}…` : text;
}

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
  number: {
    label: "Number",
    column: "value_number",
    fromDb: (raw) => (raw == null ? null : Number(raw)),
    toDb: (v) => (typeof v === "number" && Number.isFinite(v) ? v : null),
    // Exactly as typed (no thousands separators), so a value reads the same as in its input.
    // A value with {{ }} sections is stored as text (see valueStatement); shown it is its result.
    format: (v) => (typeof v === "number" ? String(v) : typeof v === "string" ? v : ""),
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
  object: {
    label: "Object",
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
  object_list: {
    label: "List of objects",
    column: "value_json",
    fromDb: listFromDb,
    toDb: listToDb,
    format: (v) => (Array.isArray(v) ? v.join(", ") : ""),
  },
  // Computed by a template when objects are shown (domain/templates.ts); never written, so
  // its column is only nominal.
  template: {
    label: "Template",
    column: "value_text",
    fromDb: optionalString,
    toDb: () => null,
    format: (v) => (typeof v === "string" ? markdownPreview(v) : v == null ? "" : String(v)),
  },
};

export const fieldKindList = Object.keys(fieldKinds) as FieldKind[];
