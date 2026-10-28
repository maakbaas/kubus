// Remote sources: databases (or other systems) the server connects to read-only, whose tables
// and queries the app shows as collections (docs/sync.md "Remote sources"). This is what the app
// and the server say to each other about them: nothing in it is specific to one kind of database.
// The server answers with a connector per source (server/src/connectors/: Postgres, MySQL / MariaDB, n8n's data tables, InfluxDB 2,
// Cloudflare D1, Actual Budget, ICS calendars, JSON and CSV over HTTP); the
// app never knows which. Types only (no imports, no enums), so the server runs it directly with
// Node, like shared/sync.ts.
//
// The app asks in Kubus terms: a source's tables, a table's (or query's) columns as Kubus field
// types, a page of rows for a filter / sort / grouping (a view's query with its values already
// worked out: no code, no "this week", only plain values), and one row by its key.

/** The field types a source column is read as (the app may show a text column as Markdown or HTML). */
export type SourceKind = "string" | "number" | "checkbox" | "date" | "datetime" | "string_list";

/** One source the server offers (GET /api/sources). */
export interface SourceInfo {
  /** Its name, from the server's settings (Settings → Connections), e.g. "CRM". */
  name: string;
  /** Names it had before (renamed): requests by one still reach it, and collections take its new name. */
  formerNames?: string[];
  /** Which connector reads it, e.g. "postgres": for people only (the app treats all alike). */
  connector: string;
  /** Why it can't be read now (unreachable, wrong password), or absent. */
  problem?: string;
}

/** A table (or a view of one) of a source. `schema` is null where a source has none. */
export interface SourceTable {
  schema: string | null;
  name: string;
  /** "table", "view" or "measurement", for people. */
  type: string;
}

/** What a collection reads: one of a source's tables, or a query in the source's language. */
export type SourceTarget = { table: { schema: string | null; name: string } } | { query: string };

/** One column, as the app reads it. */
export interface SourceColumn {
  name: string;
  /** The source's own type, for people (e.g. "integer", "jsonb"). */
  type: string;
  kind: SourceKind;
  /**
   * Compared only as text (contains, is empty), never sorted or grouped: values whose text doesn't
   * sort sensibly (intervals, ranges, JSON).
   */
  plain?: boolean;
  /** Noise more often than not (JSON, XML): not shown in a new collection's view. */
  hidden?: boolean;
}

/** What POST /api/sources/<name>/describe answers. */
export interface SourceDescription {
  columns: SourceColumn[];
  /** The primary key's columns (empty when there is none, e.g. a query): the default key. */
  key: string[];
  /** Columns that aren't read (binary data, search indexes, internals), for people. */
  dropped: { name: string; type: string }[];
}

/** The filter operators a source understands: the app's (domain/query.ts), "between" taking yyyy-mm-dd..yyyy-mm-dd. */
export type SourceOperator =
  | "contains" | "notContains" | "is" | "isNot" | "gt" | "lt" | "before" | "after" | "between"
  | "isChecked" | "isNotChecked" | "isEmpty" | "isNotEmpty";

export interface SourceFilter {
  column: string;
  operator: SourceOperator;
  /** Plain value: text, a number, true / false, yyyy-mm-dd, or yyyy-mm-dd..yyyy-mm-dd (between). */
  value: string;
}

/**
 * What rows a query keeps: a column's rule, or all (`and`) / any (`or`) of several, nested as deep
 * as the app's filters make them (a view's or item page's filter with a block's on top; the app
 * works out the order: app/src/domain/filterTree.ts). `{ and: [] }` keeps every row, `{ or: [] }` none.
 */
export type SourceCondition = SourceFilter | { and: SourceCondition[] } | { or: SourceCondition[] };

/** How deep a condition may nest (the app's are a few levels; this bounds a malformed request). */
const MAX_CONDITION_DEPTH = 32;

/** Whether a request's filter is a condition tree (checked by the server before any connector sees it). */
export function isSourceCondition(x: unknown, depth = 0): x is SourceCondition {
  if (!x || typeof x !== "object" || depth > MAX_CONDITION_DEPTH) return false;
  const o = x as Record<string, unknown>;
  if (Array.isArray(o.and)) return o.and.every((c) => isSourceCondition(c, depth + 1));
  if (Array.isArray(o.or)) return o.or.every((c) => isSourceCondition(c, depth + 1));
  return typeof o.column === "string" && typeof o.operator === "string" && typeof o.value === "string";
}

/** A condition in a connector's own language: each rule as `rule` writes it (bracketed, whatever it holds), joined by its words. */
export function conditionText(c: SourceCondition, rule: (filter: SourceFilter) => string, words: { and: string; or: string; all: string; none: string }): string {
  if ("and" in c) return c.and.length === 0 ? words.all : `(${c.and.map((x) => conditionText(x, rule, words)).join(` ${words.and} `)})`;
  if ("or" in c) return c.or.length === 0 ? words.none : `(${c.or.map((x) => conditionText(x, rule, words)).join(` ${words.or} `)})`;
  return `(${rule(c)})`;
}

/** The title: the first of these columns with a value that isn't blank (the app's labelField), else `untitled`. */
export const TITLE_COLUMN = "$title";

export interface SourceSort {
  /** A column, or TITLE_COLUMN. */
  column: string;
  direction: "asc" | "desc";
}

/** What a source reads a row of, and how its title and key are made. */
export interface SourceShape {
  target: SourceTarget;
  /** The column that identifies a row (its item page, links to it); assumed unique. */
  key: string;
  /** The columns to read, in order (the row's `values`). */
  columns: string[];
  /** Columns the title is taken from, in order (text fields). */
  title: string[];
  /** The title of a row without one (the collection's name). */
  untitled: string;
}

/** POST /api/sources/<name>/query: a page of rows. */
export interface SourceQuery extends SourceShape {
  filter: SourceCondition;
  /** Free text, looked for in every text column (case-insensitive). */
  search: string;
  /** Empty values last in both directions; the key breaks ties, so pages never overlap. */
  sort: SourceSort[];
  /** A column to group by, or null; rows are then ordered by group first. */
  groupBy: string | null;
  /** By the groups' values, either way, or the largest first; the empty group always last. */
  groupOrder: "asc" | "desc" | "count";
  /** The IANA time zone dates and times are compared and grouped in (the device's: its days). */
  timeZone: string;
  offset: number;
  limit: number;
  /** Also count: the total and each group's size (asked with the first page). */
  counts: boolean;
}

/** A value as the app stores it (domain/model.ts FieldValue): datetimes as ISO 8601 UTC, dates yyyy-mm-dd. */
export type SourceValue = string | number | boolean | string[] | null;

export interface SourceRow {
  /** The key column's value as text. */
  key: string;
  /** In the order of the request's `columns`. */
  values: SourceValue[];
  /** When grouped: the group it is listed in (a list column lists a row once per value). */
  group?: string;
}

export interface SourceResult {
  rows: SourceRow[];
  /** More rows follow this page. */
  more: boolean;
  /** With `counts`: rows matching (each once). */
  total?: number;
  /** With `counts` when grouped: every group's key and size, in order (keys as SourceRow.group). */
  groups?: { key: string; count: number }[];
}

/** POST /api/sources/<name>/row: one row by its key (null when there is none). */
export interface SourceRowRequest extends SourceShape {
  keyValue: string;
}

/**
 * The most rows one page may ask for, and the page a block that loads every row asks (a chart, a map
 * without a Limit). Large enough that a request's own cost (its round trip, the source planning the query)
 * is a small part of a page: 180,000 rows are 18 requests, not 360. Small enough that a page stays a few MB
 * of JSON, well inside a source's time limit, and is made into items in about a tenth of a second (the page
 * doesn't freeze while it comes in).
 */
export const MAX_SOURCE_PAGE = 10_000;
/** The most groups a grouped query lists (the rest are left out). */
export const MAX_SOURCE_GROUPS = 1000;
