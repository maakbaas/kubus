import { betweenBounds, conditionText, MAX_SOURCE_GROUPS, MAX_SOURCE_PAGE, TITLE_COLUMN, type SourceColumn, type SourceFilter, type SourceQuery, type SourceShape, type SourceTarget } from "../../../shared/sources.ts";
import { SourceError } from "./connector.ts";
import { dayStart } from "./d1Sql.ts";

// The PostHog connector's HogQL (PostHog's SQL over ClickHouse): how a column is read, and the
// statements a query (shared/sources.ts) becomes. Pure (no requests), so it is tested without
// PostHog (server/test/connectors/posthogHogql.test.ts). PostHog's query API takes one HogQL
// statement as text, so values are written in as literals (`str`: quoted and escaped, numbers only when
// finite) and every name is quoted (`ident`); nothing the user typed goes in as HogQL. Only tables are
// read (no written queries yet).
//
// What a filter means follows the app's (applyQuery in app/src/domain/query.ts), as Postgres's does:
// text case-insensitive (ILIKE, lower), empty values last both ways, a date & time on its day in the
// device's time zone (its bounds worked out here as UTC instants, `dayStart`, so the column itself is
// compared: ClickHouse then reads only the parts of `events` in the period). A column is read by its
// ClickHouse type (the answer's `types`), else by the HogQL schema's (`DatabaseSchemaQuery`), so an
// expression field (sessions' `$is_bounce`, `$channel_type`) is read like any other.

/** How a column's values are read: decides its value, text, sort and group expressions. */
export type PhReader = "text" | "number" | "bool" | "date" | "datetime" | "list";

export interface PhColumn extends SourceColumn {
  read: PhReader;
}

/** A ClickHouse type without its wrappers: Nullable(LowCardinality(String)) is String. */
export function bareType(type: string): string {
  let t = type.trim();
  for (let m; (m = /^(?:Nullable|LowCardinality)\((.*)\)$/s.exec(t)); ) t = m[1].trim();
  return t;
}

const NUMBER = /^(U?Int\d+|Float\d+|Decimal(\d+)?(\(.*\))?)$/;
const TEXT = /^(String|FixedString\(\d+\)|UUID|IPv4|IPv6|Enum(8|16)?\(.*\)|Nothing)$/s;

/**
 * How a column is read: from its ClickHouse type (`chType`, from a probe's answer) or, without one, the
 * HogQL schema's field type (`schemaType`: string, integer, float, boolean, date, datetime, array, json, …);
 * null when it isn't read (maps, tuples, arrays of those). The schema's "json" or "boolean" wins over the
 * ClickHouse type (JSON is stored as a String, a HogQL boolean may be a UInt8).
 */
export function phColumn(name: string, chType: string | null, schemaType: string | null = null): PhColumn | null {
  const schema = (schemaType ?? "").toLowerCase();
  const t = chType ? bareType(chType) : "";
  const base = { name, type: chType?.trim() || schemaType || "unknown" };
  if (schema === "json" || name === "properties" || /^\$?(group_\d+_)?properties$/.test(name)) return { ...base, kind: "string", read: "text", plain: true, hidden: true };
  if (schema === "boolean" || t === "Bool") return { ...base, kind: "checkbox", read: "bool" };
  if (t) {
    if (NUMBER.test(t)) return { ...base, kind: "number", read: "number" };
    if (/^Date(32)?$/.test(t)) return { ...base, kind: "date", read: "date" };
    if (/^DateTime(64)?(\(.*\))?$/s.test(t)) return { ...base, kind: "datetime", read: "datetime" };
    if (TEXT.test(t)) return { ...base, kind: "string", read: "text", ...(name === "elements_chain" && { hidden: true }) };
    const inner = /^Array\((.*)\)$/s.exec(t)?.[1];
    if (inner !== undefined) {
      const it = bareType(inner);
      return TEXT.test(it) || NUMBER.test(it) ? { ...base, kind: "string_list", read: "list" } : null;
    }
    return null; // Map, Tuple, JSON, Object, Array(Array(…)), …
  }
  switch (schema) {
    case "integer":
    case "float":
    case "decimal":
      return { ...base, kind: "number", read: "number" };
    case "date":
      return { ...base, kind: "date", read: "date" };
    case "datetime":
      return { ...base, kind: "datetime", read: "datetime" };
    case "array":
      return { ...base, kind: "string_list", read: "list" };
    case "string":
    case "string_array":
    case "expression":
    case "unknown":
    case "":
      return { ...base, kind: "string", read: "text" };
    default:
      return null;
  }
}

/** A quoted name (backticks; its own backtick and backslash escaped). */
export const ident = (name: string) => `\`${name.replace(/[\\`]/g, (ch) => `\\${ch}`)}\``;

/** A table's name: dotted parts (a data warehouse table: `stripe.customers`) quoted one by one. */
export const tableName = (name: string) => name.split(".").map(ident).join(".");

/** A string literal, escaped as HogQL reads one. */
export function str(text: string): string {
  const escaped = text.replace(/[\\'\n\r\t\0]/g, (ch) => ({ "\\": "\\\\", "'": "\\'", "\n": "\\n", "\r": "\\r", "\t": "\\t", "\0": "\\0" })[ch]!);
  return `'${escaped}'`;
}

/** A number literal (only a finite one). */
function num(n: number): string {
  if (!Number.isFinite(n)) throw new SourceError("Not a number");
  return String(n);
}

/** What a query reads from: a table (no written queries yet). */
export function fromSql(target: SourceTarget): string {
  if ("query" in target) throw new SourceError("PostHog is read by its tables only");
  if (target.table.schema !== null) throw new SourceError("PostHog has no schemas");
  if (!target.table.name.trim()) throw new SourceError("Choose a table");
  return tableName(target.table.name);
}

const ref = (c: PhColumn) => ident(c.name);
/** A checkbox as 1 / 0 (none: 0). */
const boolSql = (r: string) => `ifNull(toInt(${r}), 0)`;
/** The value's text, as filters compare it ("" for none); a list's as the app writes one ("a, b"). */
const textSql = (c: PhColumn) => (c.read === "list" ? `arrayStringConcat(arrayMap(x -> toString(x), ${ref(c)}), ', ')` : `ifNull(toString(${ref(c)}), '')`);

/** The value as the connector reads it back (dates & times in the project's zone, made UTC by the connector). */
export const valueSql = (c: PhColumn) => ref(c);

/** An ILIKE pattern finding `text` anywhere (its own % _ \ taken literally). */
const containing = (text: string) => str(`%${text.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`);
const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** A UTC instant (Unix seconds) as a DateTime. */
const instant = (seconds: number) => `fromUnixTimestamp(${num(Math.round(seconds))})`;

/** One filter rule as a condition. A value that can't be compared matches nothing (as in the app). */
export function filterSql(c: PhColumn, rule: SourceFilter, tz: string): string {
  const r = ref(c);
  const value = rule.value.trim();
  const op = rule.operator;
  const refuse = () => {
    throw new SourceError(`“${c.name}” can't be filtered with ${op}`);
  };
  if (c.kind === "string_list") {
    switch (op) {
      case "contains":
        return `arrayExists(x -> toString(x) ILIKE ${containing(value)}, ${r})`;
      case "notContains":
        return `NOT arrayExists(x -> toString(x) ILIKE ${containing(value)}, ${r})`;
      case "is":
        return `has(arrayMap(x -> lower(toString(x)), ${r}), lower(${str(value)}))`;
      case "isNot":
        return `NOT has(arrayMap(x -> lower(toString(x)), ${r}), lower(${str(value)}))`;
      case "isEmpty":
        return `empty(${r})`;
      case "isNotEmpty":
        return `notEmpty(${r})`;
      default:
        return refuse();
    }
  }
  if (c.kind === "string") {
    const empty = `(${r} IS NULL OR toString(${r}) = '')`;
    switch (op) {
      case "contains":
        return `${textSql(c)} ILIKE ${containing(value)}`;
      case "notContains":
        return `NOT (${textSql(c)} ILIKE ${containing(value)})`;
      case "isEmpty":
        return empty;
      case "isNotEmpty":
        return `NOT ${empty}`;
      case "is":
      case "isNot":
        if (c.plain) return refuse();
        return `lower(${textSql(c)}) ${op === "is" ? "=" : "!="} lower(${str(value)})`;
      default:
        return refuse();
    }
  }
  if (c.kind === "number") {
    if (op === "isEmpty") return `${r} IS NULL`;
    if (op === "isNotEmpty") return `${r} IS NOT NULL`;
    const n = Number(value);
    if (value === "" || !Number.isFinite(n)) return "false";
    switch (op) {
      case "is":
        return `${r} = ${num(n)}`;
      case "isNot":
        return `(${r} IS NULL OR ${r} != ${num(n)})`;
      case "gt":
        return `${r} > ${num(n)}`;
      case "lt":
        return `${r} < ${num(n)}`;
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
        return `${v} = 0`;
      case "is":
        if (!/^(true|false)$/i.test(value)) return "false";
        return `${v} = ${value.toLowerCase() === "true" ? 1 : 0}`;
      default:
        return refuse();
    }
  }
  // Dates, and dates & times by the day (or minute) they are on in the device's time zone.
  if (op === "isEmpty") return `${r} IS NULL`;
  if (op === "isNotEmpty") return `${r} IS NOT NULL`;
  let from: string;
  let to: string;
  if (op === "between") {
    const bounds = betweenBounds(value);
    if (!bounds) return "false";
    [from, to] = [bounds.start, bounds.end];
  } else {
    if (!DAY.test(value)) return "false";
    [from, to] = [value, value];
  }
  if (c.kind === "date") {
    const day = (d: string) => `toDate(${str(d.slice(0, 10))})`;
    switch (op) {
      case "is":
        return `${r} = ${day(from)}`;
      case "before":
        return `${r} < ${day(from)}`;
      case "after":
        return `${r} > ${day(from)}`;
      case "between":
        return `(${r} >= ${day(from)} AND ${r} <= ${day(to)})`;
      default:
        return refuse();
    }
  }
  switch (op) {
    case "is":
    case "between":
      return `(${r} >= ${instant(dayStart(from, tz))} AND ${r} < ${instant(dayStart(to, tz, 1))})`;
    case "before":
      return `${r} < ${instant(dayStart(from, tz))}`;
    case "after":
      return `${r} >= ${instant(dayStart(from, tz, 1))}`;
    default:
      return refuse();
  }
}

/**
 * A sort key: comparable, null for none (sorted last). A text, a number or Unix seconds, so a page's last key can be
 * written back into the next page's condition as a plain literal (keyset paging: `querySql`); a date & time by its
 * second (the key breaks ties within one).
 */
function sortSql(c: PhColumn): string {
  if (c.plain) throw new SourceError(`“${c.name}” can't be sorted`);
  const r = ref(c);
  switch (c.read) {
    case "text":
    case "list":
      return `nullIf(lower(${textSql(c)}), '')`;
    case "bool":
      return boolSql(r); // unchecked is a value, not empty
    case "number":
      return `toFloat(${r})`;
    case "date":
      return `toString(${r})`;
    case "datetime":
      return `toUnixTimestamp(${r})`;
  }
}

/** The title (the app's itemLabel): the first non-blank of the title columns, else the untitled name. */
function titleSql(shape: SourceShape, columns: Map<string, PhColumn>): string {
  const parts = shape.title.map((name) => `nullIf(trim(${textSql(column(columns, name))}), '')`);
  return `coalesce(${[...parts, str(shape.untitled)].join(", ")})`;
}

/** A time zone as a literal, only one Intl knows (it goes into the statement). */
function zone(tz: string): string {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
  } catch {
    throw new SourceError(`Unknown time zone “${tz}”`);
  }
  return str(tz);
}

/** The group a row is in, as text ("" for none); a list's row once per value (arrayJoin). */
function groupKeySql(c: PhColumn, tz: string): string {
  if (c.plain) throw new SourceError(`“${c.name}” can't be grouped`);
  const r = ref(c);
  switch (c.read) {
    case "bool":
      return `if(${boolSql(r)} = 1, 'yes', 'no')`;
    case "datetime":
      return `ifNull(formatDateTime(toTimeZone(${r}, ${zone(tz)}), '%Y-%m-%d'), '')`;
    case "list":
      return `arrayJoin(if(empty(${r}), [''], arrayMap(x -> toString(x), ${r})))`;
    default:
      return `ifNull(toString(${r}), '')`;
  }
}

/** The group column a grouped query reads. */
const G = "kubus_group";

/** A sort key and its direction (empty values last either way). */
interface SortKey {
  expr: string;
  desc: boolean;
}

/** Groups in order: the empty one last, then by size (largest first) or by value either way. */
function groupKeys(c: PhColumn, order: SourceQuery["groupOrder"], count: string): SortKey[] {
  const value = c.kind === "number" ? `toFloat(${G})` : c.kind === "checkbox" ? `if(${G} = 'yes', 0, 1)` : c.kind === "string" || c.kind === "string_list" ? `lower(${G})` : G;
  return [{ expr: `if(${G} = '', 1, 0)`, desc: false }, ...(order === "count" ? [{ expr: count, desc: true }] : []), { expr: value, desc: order === "desc" }];
}

const orderBy = (keys: SortKey[]) => keys.map((k) => `${k.expr} ${k.desc ? "DESC" : "ASC"} NULLS LAST`).join(", ");

/** A page's last key value as a literal (as PostHog answered it: a number, text, true / false or null). */
function literal(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "boolean") return v ? "1" : "0";
  if (typeof v === "number") return num(v);
  return str(String(v));
}

/**
 * The rows after a page's last one in `keys`' order (empty values last both ways), from its keys' values (`after`):
 * the first key past its value, or it equal and the next past its, and so on. PostHog refuses OFFSET with a
 * personal API key (on events), so a page after the first is asked for this way.
 */
export function keysetSql(keys: SortKey[], after: unknown[]): string {
  if (after.length !== keys.length) throw new SourceError("The page to go on from doesn't fit the query");
  const values = after.map(literal);
  const equal = (i: number) => (values[i] === null ? `${keys[i].expr} IS NULL` : `${keys[i].expr} = ${values[i]}`);
  const past = (i: number) => (values[i] === null ? null : `(${keys[i].expr} ${keys[i].desc ? "<" : ">"} ${values[i]} OR ${keys[i].expr} IS NULL)`);
  const ways = keys.flatMap((_, i) => {
    const p = past(i);
    return p ? [[...keys.slice(0, i).map((__, j) => equal(j)), p].join(" AND ")] : [];
  });
  return ways.length ? `(${ways.map((w) => `(${w})`).join(" OR ")})` : "false";
}

function column(columns: Map<string, PhColumn>, name: string): PhColumn {
  const c = columns.get(name);
  if (!c) throw new SourceError(`There is no column “${name}” (refresh the collection's columns)`);
  return c;
}

/** The SELECT list of a row: its key as text, then the asked columns' values (read back by position). */
function selectSql(shape: SourceShape, columns: Map<string, PhColumn>): string {
  return [`toString(${ref(column(columns, shape.key))})`, ...shape.columns.map((name) => valueSql(column(columns, name)))].join(", ");
}

/** The conditions of a query (its filter's and / or tree, and search), "true" for none. */
function whereSql(query: SourceQuery, columns: Map<string, PhColumn>): string {
  const filter = conditionText(query.filter, (rule) => filterSql(column(columns, rule.column), rule, query.timeZone), { and: "AND", or: "OR", all: "true", none: "false" });
  const conditions = filter === "true" ? [] : [filter];
  const needle = query.search.trim();
  if (needle) {
    const searched = query.columns.map((name) => column(columns, name)).filter((c) => c.kind === "string" || c.kind === "string_list").map((c) => `${textSql(c)} ILIKE ${containing(needle)}`);
    conditions.push(searched.length ? `(${searched.join(" OR ")})` : "false");
  }
  return conditions.length ? conditions.join(" AND ") : "true";
}

/**
 * The most rows one request asks PostHog for: below HogQL's own cap on a LIMIT (a larger one is cut
 * short without a word, which would read as the last page). A larger page is answered in parts: the app
 * asks for the next from the rows it has.
 */
export const POSTHOG_PAGE = 5000;

/**
 * The statements of a query: its page of rows (at most `pageRows`), and (with `counts`) its total and groups. A row
 * is its key, its values, its group when grouped, then its sort keys (`sortKeys` of them: the last row's are where the
 * next page goes on from, `after`). The first page has no OFFSET; a later one goes on from `after` (keyset), else (it
 * isn't known) by OFFSET, which PostHog allows on some tables only.
 */
export function querySql(query: SourceQuery, columns: Map<string, PhColumn>, after: unknown[] | null = null): { rows: string; pageRows: number; sortKeys: number; total?: string; groups?: string } {
  if (!Number.isInteger(query.offset) || query.offset < 0) throw new SourceError("offset must be a whole number");
  if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > MAX_SOURCE_PAGE) throw new SourceError(`limit must be 1 to ${MAX_SOURCE_PAGE}`);
  const group = query.groupBy ? column(columns, query.groupBy) : null;
  const from = fromSql(query.target);
  const where = whereSql(query, columns);
  const pageRows = Math.min(query.limit, POSTHOG_PAGE);
  const keys: SortKey[] = [
    ...(group ? groupKeys(group, query.groupOrder, "kubus_group_size") : []),
    ...query.sort.map((s) => ({ expr: s.column === TITLE_COLUMN ? `lower(${titleSql(query, columns)})` : sortSql(column(columns, s.column)), desc: s.direction === "desc" })),
    { expr: `toString(${ref(column(columns, query.key))})`, desc: false },
  ];
  const page = (rest: string) => `${rest} LIMIT ${pageRows + 1}${query.offset > 0 && !after ? ` OFFSET ${query.offset}` : ""}`;
  let rows: string;
  if (!group) {
    // Flat, so ClickHouse can read a table in its own order where the sort is it (events by time).
    const conditions = [where, ...(query.offset > 0 && after ? [keysetSql(keys, after)] : [])].filter((c) => c !== "true");
    rows = page(`SELECT ${selectSql(query, columns)}, ${keys.map((k) => k.expr).join(", ")} FROM ${from} WHERE ${conditions.join(" AND ") || "true"} ORDER BY ${orderBy(keys)}`);
  } else {
    // Grouped: a group's size is a window, which a condition can't use; the rows with their keys are read first.
    const named = keys.map((k, i) => ({ ...k, name: `kubus_s${i}` }));
    const values = query.columns.map((_, i) => `kubus_v${i}`);
    const inner = `SELECT toString(${ref(column(columns, query.key))}) AS kubus_key, ${query.columns.map((name, i) => `${valueSql(column(columns, name))} AS kubus_v${i}`).join(", ")}${query.columns.length ? ", " : ""}${groupKeySql(group, query.timeZone)} AS ${G}, count() OVER (PARTITION BY ${G}) AS kubus_group_size, ${named.map((k) => `${k.expr} AS ${k.name}`).join(", ")} FROM ${from} WHERE ${where}`;
    const aliased = named.map((k) => ({ expr: k.name, desc: k.desc }));
    const condition = query.offset > 0 && after ? ` WHERE ${keysetSql(aliased, after)}` : "";
    rows = page(`SELECT kubus_key, ${[...values, G, ...named.map((k) => k.name)].join(", ")} FROM (${inner})${condition} ORDER BY ${orderBy(aliased)}`);
  }
  const result = { rows, pageRows, sortKeys: keys.length };
  if (!query.counts) return result;
  const total = `SELECT count() FROM ${from} WHERE ${where}`;
  if (!group) return { ...result, total };
  const groups = `SELECT ${groupKeySql(group, query.timeZone)} AS ${G}, count() AS n FROM ${from} WHERE ${where} GROUP BY ${G} ORDER BY ${orderBy(groupKeys(group, query.groupOrder, "n"))} LIMIT ${MAX_SOURCE_GROUPS}`;
  return { ...result, total, groups };
}

/** One row by its key (compared as text). */
export function rowSql(shape: SourceShape & { keyValue: string }, columns: Map<string, PhColumn>): string {
  return `SELECT ${selectSql(shape, columns)} FROM ${fromSql(shape.target)} WHERE toString(${ref(column(columns, shape.key))}) = ${str(shape.keyValue)} LIMIT 1`;
}

/** What a table's columns are read by: one row of every column the schema lists (their ClickHouse types come back with it). */
export function probeSql(table: string, names: string[] | null, time: string | null = null): string {
  // Of a table read by time (events, sessions) only the last day: unbounded, sessions are made from every event ever
  // (its expression fields too) before one row comes back, which outlasts the time limit or a proxy's.
  const recent = time ? ` WHERE ${ident(time)} >= now() - INTERVAL 1 DAY` : "";
  return `SELECT ${names ? names.map(ident).join(", ") : "*"} FROM ${tableName(table)}${recent} LIMIT 1`;
}
