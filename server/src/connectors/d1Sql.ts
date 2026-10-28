import { conditionText, keepsOnlyValues, MAX_SOURCE_GROUPS, MAX_SOURCE_PAGE, TITLE_COLUMN, type SourceColumn, type SourceFilter, type SourceQuery, type SourceShape, type SourceTarget } from "../../../shared/sources.ts";
import { SourceError } from "./connector.ts";

// The Cloudflare D1 connector's SQL (SQLite): how a column is read, and the statements a query
// (shared/sources.ts) becomes. Pure (no connection), so it is tested without a database
// (app/src/data/remote/d1Sql.test.ts). Every value goes in as a numbered parameter (?1, ?2, …)
// and every name is quoted; a query written by the user is the one exception (it is the query),
// wrapped as a subquery and refused when it holds more than one statement (D1 runs several).
//
// What a filter means follows the app's (applyQuery in app/src/domain/query.ts), as Postgres's
// does. SQLite has no column types of its own, only declared ones (and none for a query's
// columns), so a column's field type comes from its declared type, else from the values it holds;
// a date or a date & time may be stored as text or as a Unix time (seconds or milliseconds), and
// is read through one expression whatever the row holds. SQLite knows no time zones: a date &
// time's day in the device's zone is worked out from the zone's offsets (`zoneOffsets`).

/** How a column's values are read: decides its value, text, sort and group expressions. */
export type D1Reader = "text" | "number" | "bool" | "date" | "datetime";

export interface D1Column extends SourceColumn {
  read: D1Reader;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;

/**
 * How a column is read, from its declared type (a table's) or, without one, the values it holds
 * (a sample of rows as D1 gives them: numbers, text, byte arrays, null); null when it isn't (blobs).
 */
export function d1Column(name: string, declared: string | null, samples: unknown[]): D1Column | null {
  const t = (declared ?? "").toUpperCase();
  const base = { name, type: declared?.trim() || "any" };
  if (t) {
    if (t.includes("BLOB")) return null;
    if (t.includes("BOOL")) return { ...base, kind: "checkbox", read: "bool" };
    if (t.includes("DATETIME") || t.includes("TIMESTAMP")) return { ...base, kind: "datetime", read: "datetime" };
    if (t.includes("DATE")) return { ...base, kind: "date", read: "date" };
    if (t.includes("JSON")) return { ...base, kind: "string", read: "text", plain: true, hidden: true };
    if (t.includes("CHAR") || t.includes("CLOB") || t.includes("TEXT") || t.includes("TIME")) return { ...base, kind: "string", read: "text" };
    if (/INT|REAL|FLOA|DOUB|NUM|DEC/.test(t)) return { ...base, kind: "number", read: "number" };
    return { ...base, kind: "string", read: "text" };
  }
  const values = samples.filter((v) => v !== null && v !== undefined);
  if (values.some((v) => typeof v === "object")) return null; // a blob (bytes)
  if (values.length && values.every((v) => typeof v === "number")) return { ...base, kind: "number", read: "number" };
  if (values.length && values.every((v) => typeof v === "string")) {
    const strings = values as string[];
    if (strings.every((v) => DAY.test(v))) return { ...base, kind: "date", read: "date" };
    if (strings.every((v) => DATETIME.test(v))) return { ...base, kind: "datetime", read: "datetime" };
  }
  return { ...base, kind: "string", read: "text" };
}

/** A quoted identifier. */
export const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** The parameters of one statement, numbered as they are added. */
export class Params {
  readonly values: (string | number)[] = [];
  add(value: string | number): string {
    this.values.push(value);
    return `?${this.values.length}`;
  }
}

/**
 * A user's query as one statement: trailing semicolons dropped, any other semicolon outside a
 * string, quoted name or comment refused (D1 runs every statement it is given).
 */
export function cleanQuery(query: string): string {
  const text = query.trim().replace(/;+\s*$/, "").trim();
  if (!text) throw new SourceError("The query is empty");
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const close = ch === "'" ? "'" : ch === '"' ? '"' : ch === "`" ? "`" : ch === "[" ? "]" : null;
    if (close) {
      // A quote is escaped by doubling it, which this reads as a string ending and another starting.
      const end = text.indexOf(close, i + 1);
      i = end < 0 ? text.length : end;
    } else if (ch === "-" && text[i + 1] === "-") {
      const end = text.indexOf("\n", i);
      i = end < 0 ? text.length : end;
    } else if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 1;
    } else if (ch === ";") {
      throw new SourceError("A query is one statement (no ; between statements)");
    }
  }
  return text;
}

/** What the target reads from, aliased q (a written query on lines of its own: a trailing -- comment ends there). */
export function fromSql(target: SourceTarget): string {
  if ("table" in target) return `${ident(target.table.name)} AS q`;
  return `(\n${cleanQuery(target.query)}\n) AS q`;
}

const ref = (c: D1Column) => `q.${ident(c.name)}`;
const isNumber = (r: string) => `typeof(${r}) IN ('integer', 'real')`;

/** A date & time as Unix seconds (text in any form SQLite reads, or a Unix time in seconds or milliseconds). */
function unixSql(r: string): string {
  return `(CASE WHEN ${isNumber(r)} THEN (CASE WHEN abs(${r}) >= 100000000000 THEN ${r} / 1000.0 ELSE ${r} END) ELSE (julianday(${r}) - 2440587.5) * 86400 END)`;
}

/** A date as yyyy-mm-dd (text, or a Unix time). */
function dateSql(r: string): string {
  return `(CASE WHEN ${isNumber(r)} THEN date(${unixSql(r)}, 'unixepoch') ELSE date(${r}) END)`;
}

/** A number (empty text is none). */
function numberSql(r: string): string {
  return `(CASE WHEN ${isNumber(r)} THEN ${r} WHEN trim(${r}) = '' THEN NULL ELSE CAST(${r} AS REAL) END)`;
}

/** A checkbox as 1 / 0 (null for none): 1, true, yes, on and the like are checked. */
function boolSql(r: string): string {
  return `(CASE WHEN ${r} IS NULL THEN NULL WHEN lower(CAST(${r} AS TEXT)) IN ('1', 'true', 't', 'yes', 'y', 'on') THEN 1 ELSE 0 END)`;
}

/** The value as the app stores it (FieldValue), but checkboxes as 1 / 0 (made true / false by the connector). */
export function valueSql(c: D1Column): string {
  const r = ref(c);
  switch (c.read) {
    case "text":
      return `CAST(${r} AS TEXT)`;
    case "number":
      return numberSql(r);
    case "bool":
      return boolSql(r);
    case "date":
      return dateSql(r);
    case "datetime":
      return `strftime('%Y-%m-%dT%H:%M:%fZ', ${unixSql(r)}, 'unixepoch')`;
  }
}

/** The value's text, as filters compare it ("" for none). */
const textSql = (c: D1Column) => `COALESCE(CAST(${ref(c)} AS TEXT), '')`;

/** A LIKE pattern finding `text` anywhere (its own % _ \ taken literally). */
const containing = (text: string) => `%${text.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
const like = (p: Params, text: string) => `LIKE ${p.add(containing(text))} ESCAPE '\\'`;

/** The offset (minutes) of a time zone at an instant (ms). */
function offsetAt(format: Intl.DateTimeFormat, at: number): number {
  const parts = Object.fromEntries(format.formatToParts(at).map((x) => [x.type, x.value]));
  const local = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour) % 24, Number(parts.minute));
  return Math.round((local - Math.floor(at / 60_000) * 60_000) / 60_000);
}

const FIRST_YEAR = 1990;
const LAST_YEAR = 2060;
const zones = new Map<string, { from: number; minutes: number }[]>();

/**
 * A time zone's offsets from 1990 to 2060: each from when (Unix seconds) and how many minutes
 * (outside those years the nearest applies). Unknown zones are refused.
 */
export function zoneOffsets(tz: string): { from: number; minutes: number }[] {
  const known = zones.get(tz);
  if (known) return known;
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" });
  } catch {
    throw new SourceError(`Unknown time zone “${tz}”`);
  }
  const week = 7 * 86_400_000;
  let at = Date.UTC(FIRST_YEAR, 0, 1);
  const end = Date.UTC(LAST_YEAR, 0, 1);
  const offsets = [{ from: -Infinity, minutes: offsetAt(format, at) }];
  for (; at < end; at += week) {
    const next = offsetAt(format, at + week);
    if (next === offsets[offsets.length - 1].minutes) continue;
    // The change is within the week: found to the minute.
    let [lo, hi] = [at, at + week];
    while (hi - lo > 60_000) {
      const mid = lo + Math.floor((hi - lo) / 120_000) * 60_000;
      if (offsetAt(format, mid) === next) hi = mid;
      else lo = mid;
    }
    offsets.push({ from: hi / 1000, minutes: next });
  }
  zones.set(tz, offsets);
  return offsets;
}

/** The day (yyyy-mm-dd) a date & time is on in the time zone. */
function daySql(c: D1Column, tz: string): string {
  const unix = unixSql(ref(c));
  const [first, ...changes] = zoneOffsets(tz);
  const offset = changes.length
    ? `(CASE ${changes.map((o, i) => `WHEN ${unix} < ${o.from} THEN ${(i ? changes[i - 1] : first).minutes}`).join(" ")} ELSE ${changes[changes.length - 1].minutes} END)`
    : `${first.minutes}`;
  return `date(${unix} + ${offset} * 60, 'unixepoch')`;
}

/** The start of a day (yyyy-mm-dd) in the time zone as Unix seconds: `days` later than it. */
export function dayStart(day: string, tz: string, days = 0): number {
  const [y, m, d] = day.split("-").map(Number);
  const midnight = Date.UTC(y, m - 1, d + days) / 1000; // as if UTC; then less the zone's offset there
  const offsets = zoneOffsets(tz);
  const offsetOf = (at: number) => offsets.filter((o) => o.from <= at).pop()!.minutes;
  const guess = midnight - offsetOf(midnight) * 60;
  return midnight - offsetOf(guess) * 60;
}

/** One filter rule as a condition. A value that can't be compared matches nothing (as in the app). */
export function filterSql(c: D1Column, rule: SourceFilter, p: Params, tz: string): string {
  const r = ref(c);
  const value = rule.value.trim();
  const op = rule.operator;
  const refuse = () => {
    throw new SourceError(`“${c.name}” can't be filtered with ${op}`);
  };
  if (c.kind === "string") {
    const empty = `(${r} IS NULL OR CAST(${r} AS TEXT) = '')`;
    switch (op) {
      case "contains":
        return `${textSql(c)} ${like(p, value)}`;
      case "notContains":
        return `NOT (${textSql(c)} ${like(p, value)})`;
      case "isEmpty":
        return empty;
      case "isNotEmpty":
        return `NOT ${empty}`;
      case "is":
      case "isNot":
        if (c.plain) return refuse();
        return `lower(${textSql(c)}) ${op === "is" ? "=" : "<>"} lower(${p.add(value)})`;
      default:
        return refuse();
    }
  }
  if (c.kind === "number") {
    const v = numberSql(r);
    if (op === "isEmpty") return `${v} IS NULL`;
    if (op === "isNotEmpty") return `${v} IS NOT NULL`;
    const n = Number(value);
    if (value === "" || !Number.isFinite(n)) return "FALSE";
    switch (op) {
      case "is":
        return `${v} = ${p.add(n)}`;
      case "isNot":
        return `${v} IS NOT ${p.add(n)}`;
      case "gt":
        return `${v} > ${p.add(n)}`;
      case "lt":
        return `${v} < ${p.add(n)}`;
      default:
        return refuse();
    }
  }
  if (c.kind === "checkbox") {
    const v = boolSql(r);
    switch (op) {
      case "isChecked":
        return `${v} = 1`;
      case "isNotChecked":
        return `${v} IS NOT 1`;
      case "is":
        if (!/^(true|false)$/i.test(value)) return "FALSE";
        return value.toLowerCase() === "true" ? `${v} = 1` : `${v} IS NOT 1`;
      default:
        return refuse();
    }
  }
  // Dates, and dates & times by the day they are on in the device's time zone.
  const v = c.kind === "date" ? dateSql(r) : unixSql(r);
  if (op === "isEmpty") return `${v} IS NULL`;
  if (op === "isNotEmpty") return `${v} IS NOT NULL`;
  let from: string;
  let to: string;
  if (op === "between") {
    const [start, end] = value.split("..");
    if (!DAY.test(start ?? "") || !DAY.test(end ?? "")) return "FALSE";
    [from, to] = [start, end];
  } else {
    if (!DAY.test(value)) return "FALSE";
    [from, to] = [value, value];
  }
  if (c.kind === "date") {
    switch (op) {
      case "is":
        return `${v} = ${p.add(from)}`;
      case "before":
        return `${v} < ${p.add(from)}`;
      case "after":
        return `${v} > ${p.add(from)}`;
      case "between":
        return `${v} BETWEEN ${p.add(from)} AND ${p.add(to)}`;
      default:
        return refuse();
    }
  }
  switch (op) {
    case "is":
    case "between":
      return `(${v} >= ${p.add(dayStart(from, tz))} AND ${v} < ${p.add(dayStart(to, tz, 1))})`;
    case "before":
      return `${v} < ${p.add(dayStart(from, tz))}`;
    case "after":
      return `${v} >= ${p.add(dayStart(from, tz, 1))}`;
    default:
      return refuse();
  }
}

/** A sort key: comparable, null for none (sorted last). */
function sortSql(c: D1Column): string {
  if (c.plain) throw new SourceError(`“${c.name}” can't be sorted`);
  const r = ref(c);
  switch (c.read) {
    case "text":
      return `NULLIF(lower(CAST(${r} AS TEXT)), '')`;
    case "number":
      return numberSql(r);
    case "bool":
      return `COALESCE(${boolSql(r)}, 0)`; // unchecked is a value, not empty
    case "date":
      return dateSql(r);
    case "datetime":
      return unixSql(r);
  }
}

/** The title (the app's itemLabel): the first non-blank of the title columns, else the untitled name. */
function titleSql(shape: SourceShape, columns: Map<string, D1Column>, p: Params): string {
  const parts = shape.title.map((name) => {
    const r = ref(column(columns, name));
    return `CASE WHEN trim(CAST(${r} AS TEXT)) <> '' THEN CAST(${r} AS TEXT) END`;
  });
  return `COALESCE(${[...parts, p.add(shape.untitled)].join(", ")})`;
}

/** The group a row is in, as text (null for none). */
function groupKeySql(c: D1Column, tz: string): string {
  if (c.plain) throw new SourceError(`“${c.name}” can't be grouped`);
  const r = ref(c);
  switch (c.read) {
    case "bool":
      return `(CASE WHEN ${boolSql(r)} = 1 THEN 'yes' ELSE 'no' END)`;
    case "number": {
      const v = numberSql(r);
      return `(CASE WHEN ${v} = CAST(${v} AS INTEGER) THEN CAST(CAST(${v} AS INTEGER) AS TEXT) ELSE CAST(${v} AS TEXT) END)`;
    }
    case "date":
      return dateSql(r);
    case "datetime":
      return daySql(c, tz);
    default:
      return `CAST(${r} AS TEXT)`;
  }
}

/** The group column added to what a grouped query reads. */
const G = ident("$kubus_group");

/** What a grouped query reads from: the target with each row's group, aliased q. */
function groupedFromSql(target: SourceTarget, c: D1Column, tz: string): string {
  return `(SELECT q.*, COALESCE(${groupKeySql(c, tz)}, '') AS ${G} FROM ${fromSql(target)}) AS q`;
}

/** Groups in order: the empty one last, then by size (largest first) or by value either way. */
function groupOrderSql(c: D1Column, order: SourceQuery["groupOrder"], count: string): string[] {
  const g = `q.${G}`;
  const value = c.kind === "number" ? `CAST(NULLIF(${g}, '') AS REAL)` : c.kind === "checkbox" ? `(CASE ${g} WHEN 'yes' THEN 0 ELSE 1 END)` : g;
  const direction = order === "desc" ? "DESC" : "ASC";
  return [`(${g} = '')`, ...(order === "count" ? [`${count} DESC`] : []), `${value} ${direction}`];
}

function column(columns: Map<string, D1Column>, name: string): D1Column {
  const c = columns.get(name);
  if (!c) throw new SourceError(`There is no column “${name}” (refresh the collection's columns)`);
  return c;
}

/** The SELECT list of a row: its key as text, then the asked columns' values. */
function selectSql(shape: SourceShape, columns: Map<string, D1Column>): string {
  return [`CAST(${ref(column(columns, shape.key))} AS TEXT) AS "$key"`, ...shape.columns.map((name, i) => `${valueSql(column(columns, name))} AS "v${i}"`)].join(", ");
}

/** The conditions of a query (its filter's and / or tree, and search), "TRUE" for none. */
function whereSql(query: SourceQuery, columns: Map<string, D1Column>, p: Params): string {
  const filter = conditionText(query.filter, (rule) => filterSql(column(columns, rule.column), rule, p, query.timeZone), { and: "AND", or: "OR", all: "TRUE", none: "FALSE" });
  const conditions = filter === "TRUE" ? [] : [filter];
  const needle = query.search.trim();
  if (needle) {
    const pattern = p.add(containing(needle));
    const searched = query.columns.map((name) => `${textSql(column(columns, name))} LIKE ${pattern} ESCAPE '\\'`);
    conditions.push(searched.length ? `(${searched.join(" OR ")})` : "FALSE");
  }
  return conditions.length ? conditions.join(" AND ") : "TRUE";
}

export interface Statement {
  sql: string;
  params: (string | number)[];
}

/** The statements of a query: its page of rows, and (with `counts`) its total and groups. */
export function querySql(query: SourceQuery, columns: Map<string, D1Column>): { rows: Statement; total?: Statement; groups?: Statement } {
  if (!Number.isInteger(query.offset) || query.offset < 0) throw new SourceError("offset must be a whole number");
  if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > MAX_SOURCE_PAGE) throw new SourceError(`limit must be 1 to ${MAX_SOURCE_PAGE}`);
  const group = query.groupBy ? column(columns, query.groupBy) : null;
  const from = group ? groupedFromSql(query.target, group, query.timeZone) : fromSql(query.target);

  const p = new Params();
  const select = selectSql(query, columns);
  const where = whereSql(query, columns, p);
  const order = [
    ...(group ? groupOrderSql(group, query.groupOrder, `count(*) OVER (PARTITION BY q.${G})`) : []),
    ...query.sort.map((s) => {
      const key = s.column === TITLE_COLUMN ? `lower(${titleSql(query, columns, p)})` : sortSql(column(columns, s.column));
      // Empty values last, unless the filter keeps none (then an index on the column can be read in order).
      return `${key} ${s.direction === "desc" ? "DESC" : "ASC"}${keepsOnlyValues(query.filter, s.column) ? "" : " NULLS LAST"}`;
    }),
    `${ref(column(columns, query.key))} ASC`,
  ];
  const rows: Statement = {
    sql: `SELECT ${select}${group ? `, q.${G} AS "$group"` : ""} FROM ${from} WHERE ${where} ORDER BY ${order.join(", ")} LIMIT ${p.add(query.limit + 1)} OFFSET ${p.add(query.offset)}`,
    params: p.values,
  };
  if (!query.counts) return { rows };

  const tp = new Params();
  const total: Statement = { sql: `SELECT count(*) AS n FROM ${fromSql(query.target)} WHERE ${whereSql(query, columns, tp)}`, params: tp.values };
  if (!group) return { rows, total };
  const gp = new Params();
  const gWhere = whereSql(query, columns, gp);
  const groups: Statement = {
    sql: `SELECT q.${G} AS g, count(*) AS n FROM ${from} WHERE ${gWhere} GROUP BY q.${G} ORDER BY ${groupOrderSql(group, query.groupOrder, "count(*)").join(", ")} LIMIT ${MAX_SOURCE_GROUPS}`,
    params: gp.values,
  };
  return { rows, total, groups };
}

/** One row by its key: a table's column compared as itself (its index), a query's as text. */
export function rowSql(shape: SourceShape & { keyValue: string }, columns: Map<string, D1Column>): Statement {
  const p = new Params();
  const r = ref(column(columns, shape.key));
  const key = "table" in shape.target ? r : `CAST(${r} AS TEXT)`;
  return { sql: `SELECT ${selectSql(shape, columns)} FROM ${fromSql(shape.target)} WHERE ${key} = ${p.add(shape.keyValue)} LIMIT 1`, params: p.values };
}
