import { conditionText, keepsOnlyValues, MAX_SOURCE_GROUPS, MAX_SOURCE_PAGE, TITLE_COLUMN, type SourceColumn, type SourceFilter, type SourceQuery, type SourceShape, type SourceTarget } from "../../../shared/sources.ts";
import { SourceError } from "./connector.ts";

// The Postgres connector's SQL: how a column of each type is read, and the statements a query
// (shared/sources.ts) becomes. Pure (no connection), so it is tested without a database
// (app/src/data/remote/postgresSql.test.ts). Every value goes in as a parameter ($1, $2, …) and
// every name is quoted, so nothing a device sends is ever spliced into the SQL as code; a query
// written by the user is the one exception (it is the query), wrapped as a subquery.
//
// What a filter means follows the app's own (applyQuery in app/src/domain/query.ts): text is
// compared case-insensitively, empty values sort last in both directions, a date & time is on
// the day it is in the device's time zone. Comparisons keep to the column itself where they can
// (c < $1, not to_char(c) < $1), so the source's indexes are used on large tables.

/** How a column's values are read: decides its value, text, sort and group expressions. */
export type PgReader = "text" | "int" | "number" | "money" | "bool" | "date" | "timestamptz" | "timestamp" | "list";

export interface PgColumn extends SourceColumn {
  read: PgReader;
}

/** What a type is, from pg_type (domains already resolved to their base type). */
export interface PgType {
  /** pg_type.typname, e.g. "int4", "_text" for an array. */
  name: string;
  /** format_type(): for people, e.g. "integer", "text[]". */
  display: string;
  /** pg_type.typcategory. */
  category: string;
  /** An array's element type (name and category); null otherwise. */
  element: { name: string; category: string } | null;
}

/** Types that are never read: binary data, search indexes, PostGIS shapes, internals. */
const DROPPED = new Set([
  "bytea", "tsvector", "tsquery", "geometry", "geography", "box2d", "box3d", "raster", "pg_lsn", "xid", "xid8", "cid", "tid",
  "txid_snapshot", "pg_snapshot", "oid", "regclass", "regproc", "regprocedure", "regoper", "regoperator", "regtype",
  "regconfig", "regdictionary", "regnamespace", "regrole", "regcollation", "aclitem", "int2vector", "oidvector",
  "pg_node_tree", "pg_ndistinct", "pg_dependencies", "pg_mcv_list", "pg_brin_bloom_summary", "pg_brin_minmax_multi_summary",
]);
/** Text only (contains, empty), hidden at first: documents more than values. */
const DOCUMENTS = new Set(["json", "jsonb", "xml"]);
const INTS = new Set(["int2", "int4", "int8"]);

/** How a column of this type is read, or null when it isn't (dropped). */
export function pgColumn(name: string, type: PgType): PgColumn | null {
  const base = { name, type: type.display };
  if (DROPPED.has(type.name)) return null;
  // Pseudo, internal and unknown categories hold nothing a person reads.
  if (type.category === "P" || type.category === "Z" || type.category === "X") return null;
  if (DOCUMENTS.has(type.name)) return { ...base, kind: "string", read: "text", plain: true, hidden: true };
  switch (type.category) {
    case "B":
      return { ...base, kind: "checkbox", read: "bool" };
    case "N":
      return { ...base, kind: "number", read: type.name === "money" ? "money" : INTS.has(type.name) ? "int" : "number" };
    case "D":
      if (type.name === "date") return { ...base, kind: "date", read: "date" };
      if (type.name === "timestamptz") return { ...base, kind: "datetime", read: "timestamptz" };
      if (type.name === "timestamp") return { ...base, kind: "datetime", read: "timestamp" };
      return { ...base, kind: "string", read: "text" }; // time, timetz: "14:30" sorts right as text
    case "A": {
      const element = type.element;
      if (!element || DROPPED.has(element.name) || element.category === "P") return null;
      // An array of documents (or of arrays) reads as its text; others as a list of strings.
      if (DOCUMENTS.has(element.name) || element.category === "A") return { ...base, kind: "string", read: "text", plain: true, hidden: true };
      return { ...base, kind: "string_list", read: "list" };
    }
    // Intervals, ranges, composite rows, geometric values: readable, but their text doesn't sort.
    case "T":
    case "R":
    case "C":
    case "G":
      return { ...base, kind: "string", read: "text", plain: true };
    default:
      // Text, enums, uuid, network addresses, bit strings and other user types: as their text.
      return { ...base, kind: "string", read: "text" };
  }
}

/** A quoted identifier. */
export const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** The parameters of one statement, numbered as they are added. */
export class Params {
  readonly values: unknown[] = [];
  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

/** A user's query as a subquery: its trailing semicolons dropped (one statement only, by the protocol). */
export function cleanQuery(query: string): string {
  const text = query.trim().replace(/;+\s*$/, "").trim();
  if (!text) throw new SourceError("The query is empty");
  return text;
}

/** What the target reads from, aliased q. */
export function fromSql(target: SourceTarget): string {
  if ("table" in target) {
    const { schema, name } = target.table;
    return `${schema ? `${ident(schema)}.` : ""}${ident(name)} AS q`;
  }
  return `(${cleanQuery(target.query)}) AS q`;
}

const ref = (c: PgColumn) => `q.${ident(c.name)}`;
/** A date & time as a timestamptz (a timestamp without time zone is taken as UTC). */
const tsOf = (c: PgColumn) => (c.read === "timestamp" ? `(${ref(c)} AT TIME ZONE 'UTC')` : ref(c));

/** The value as the app stores it (FieldValue): text, a number, true / false, yyyy-mm-dd, ISO 8601 UTC, a list of strings. */
export function valueSql(c: PgColumn): string {
  const r = ref(c);
  switch (c.read) {
    case "text":
      return `${r}::text`;
    case "int":
    case "number":
    case "money":
      return `${r}::numeric::float8`;
    case "bool":
      return r;
    case "date":
      return `to_char(${r}, 'YYYY-MM-DD')`;
    case "timestamptz":
    case "timestamp":
      return `to_char(${tsOf(c)} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
    case "list":
      // unnest flattens arrays of any dimension; empty elements are left out.
      return `ARRAY(SELECT x::text FROM unnest(${r}) AS x WHERE x IS NOT NULL)`;
  }
}

/** The value's text, as filters compare it ("" for none). */
function textSql(c: PgColumn): string {
  return c.read === "list" ? `COALESCE(array_to_string(${ref(c)}, ', '), '')` : `COALESCE(${ref(c)}::text, '')`;
}

/** A LIKE pattern finding `text` anywhere (its own % _ \ taken literally). */
const containing = (text: string) => `%${text.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The start of a day (yyyy-mm-dd) in the time zone, as a timestamptz: `days` later than it. */
const dayStart = (p: Params, day: string, tz: string, days = 0) =>
  `((${p.add(day)}::date + ${days})::timestamp AT TIME ZONE ${p.add(tz)})`;

/** One filter rule as a condition. A value that can't be compared matches nothing (as in the app). */
export function filterSql(c: PgColumn, rule: SourceFilter, p: Params, tz: string): string {
  const r = ref(c);
  const value = rule.value.trim();
  const op = rule.operator;
  const refuse = () => {
    throw new SourceError(`“${c.name}” can't be filtered with ${op}`);
  };
  if (c.kind === "string" || c.kind === "string_list") {
    const list = c.kind === "string_list";
    const empty = list ? `COALESCE(cardinality(${r}), 0) = 0` : `(${r} IS NULL OR ${r}::text = '')`;
    switch (op) {
      case "contains":
        return `${textSql(c)} ILIKE ${p.add(containing(value))}`;
      case "notContains":
        return `NOT (${textSql(c)} ILIKE ${p.add(containing(value))})`;
      case "isEmpty":
        return empty;
      case "isNotEmpty":
        return `NOT ${empty}`;
      case "is":
      case "isNot":
        if (list || c.plain) return refuse();
        return `lower(${textSql(c)}) ${op === "is" ? "=" : "<>"} lower(${p.add(value)})`;
      default:
        return refuse();
    }
  }
  if (c.kind === "number") {
    if (op === "isEmpty") return `${r} IS NULL`;
    if (op === "isNotEmpty") return `${r} IS NOT NULL`;
    const n = Number(value);
    if (value === "" || !Number.isFinite(n)) return "FALSE";
    // Compared with the column itself (its index) unless the value doesn't fit its type.
    const lhs = c.read === "money" || (c.read === "int" && !Number.isInteger(n)) ? `${r}::numeric` : r;
    const rhs = `${p.add(String(n))}::numeric`;
    switch (op) {
      case "is":
        return `${lhs} = ${rhs}`;
      case "isNot":
        return `${lhs} IS DISTINCT FROM ${rhs}`;
      case "gt":
        return `${lhs} > ${rhs}`;
      case "lt":
        return `${lhs} < ${rhs}`;
      default:
        return refuse();
    }
  }
  if (c.kind === "checkbox") {
    switch (op) {
      case "isChecked":
        return `${r} IS TRUE`;
      case "isNotChecked":
        return `${r} IS NOT TRUE`;
      case "is":
        if (!/^(true|false)$/i.test(value)) return "FALSE";
        return value.toLowerCase() === "true" ? `${r} IS TRUE` : `${r} IS NOT TRUE`;
      default:
        return refuse();
    }
  }
  // Dates, and dates & times by the day they are on in the device's time zone.
  if (op === "isEmpty") return `${r} IS NULL`;
  if (op === "isNotEmpty") return `${r} IS NOT NULL`;
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
        return `${r} = ${p.add(from)}::date`;
      case "before":
        return `${r} < ${p.add(from)}::date`;
      case "after":
        return `${r} > ${p.add(from)}::date`;
      case "between":
        return `${r} BETWEEN ${p.add(from)}::date AND ${p.add(to)}::date`;
      default:
        return refuse();
    }
  }
  const ts = tsOf(c);
  switch (op) {
    case "is":
    case "between":
      return `(${ts} >= ${dayStart(p, from, tz)} AND ${ts} < ${dayStart(p, to, tz, 1)})`;
    case "before":
      return `${ts} < ${dayStart(p, from, tz)}`;
    case "after":
      return `${ts} >= ${dayStart(p, from, tz, 1)}`;
    default:
      return refuse();
  }
}

/** A sort key: comparable, null for none (sorted last). */
function sortSql(c: PgColumn): string {
  if (c.plain) throw new SourceError(`“${c.name}” can't be sorted`);
  const r = ref(c);
  switch (c.read) {
    case "text":
      return `NULLIF(lower(${r}::text), '')`;
    case "list":
      return `NULLIF(lower(array_to_string(${r}, ', ')), '')`;
    case "bool":
      return `(CASE WHEN ${r} THEN 1 ELSE 0 END)`; // unchecked is a value, not empty
    case "money":
      return `${r}::numeric`;
    case "timestamp":
      return tsOf(c);
    default:
      return r;
  }
}

/** The title (the app's itemLabel): the first non-blank of the title columns, else the untitled name. */
function titleSql(shape: SourceShape, columns: Map<string, PgColumn>, p: Params): string {
  const parts = shape.title.map((name) => {
    const r = ref(column(columns, name));
    return `CASE WHEN trim(${r}::text) <> '' THEN ${r}::text END`;
  });
  return `COALESCE(${[...parts, p.add(shape.untitled)].join(", ")})`;
}

/** The group a row is in, as text ("" for none); a list column puts a row in a group per value. */
function groupJoin(c: PgColumn, p: Params, tz: string): string {
  const r = ref(c);
  if (c.plain) throw new SourceError(`“${c.name}” can't be grouped`);
  if (c.read === "list") {
    return `CROSS JOIN LATERAL unnest(CASE WHEN COALESCE(cardinality(${r}), 0) = 0 THEN ARRAY['']::text[] ELSE ${r}::text[] END) AS gx(g)`;
  }
  let key: string;
  switch (c.read) {
    case "bool":
      key = `CASE WHEN ${r} THEN 'yes' ELSE 'no' END`;
      break;
    case "int":
    case "number":
    case "money":
      key = `${r}::numeric::float8::text`;
      break;
    case "date":
      key = `to_char(${r}, 'YYYY-MM-DD')`;
      break;
    case "timestamptz":
    case "timestamp":
      key = `to_char(${tsOf(c)} AT TIME ZONE ${p.add(tz)}, 'YYYY-MM-DD')`;
      break;
    default:
      key = `${r}::text`;
  }
  return `CROSS JOIN LATERAL (SELECT COALESCE(${key}, '') AS g) AS gx`;
}

/** Groups in order: the empty one last, then by size (largest first) or by value either way. */
function groupOrderSql(c: PgColumn, order: SourceQuery["groupOrder"], count: string): string[] {
  const value = c.kind === "number" ? "NULLIF(gx.g, '')::float8" : c.kind === "checkbox" ? "(CASE gx.g WHEN 'yes' THEN 0 ELSE 1 END)" : "gx.g";
  const direction = order === "desc" ? "DESC" : "ASC";
  return ["(gx.g = '')", ...(order === "count" ? [`${count} DESC`] : []), `${value} ${direction}`];
}

function column(columns: Map<string, PgColumn>, name: string): PgColumn {
  const c = columns.get(name);
  if (!c) throw new SourceError(`There is no column “${name}” (refresh the collection's columns)`);
  return c;
}

/** The SELECT list of a row: its key as text, then the asked columns' values. */
function selectSql(shape: SourceShape, columns: Map<string, PgColumn>): string {
  return [`${ref(column(columns, shape.key))}::text AS "$key"`, ...shape.columns.map((name, i) => `${valueSql(column(columns, name))} AS "v${i}"`)].join(", ");
}

/** The conditions of a query (its filter's and / or tree, and search), "TRUE" for none. */
function whereSql(query: SourceQuery, columns: Map<string, PgColumn>, p: Params): string {
  const filter = conditionText(query.filter, (rule) => filterSql(column(columns, rule.column), rule, p, query.timeZone), { and: "AND", or: "OR", all: "TRUE", none: "FALSE" });
  const conditions = filter === "TRUE" ? [] : [filter];
  const needle = query.search.trim();
  if (needle) {
    const pattern = p.add(containing(needle));
    const searched = query.columns.map((name) => `${textSql(column(columns, name))} ILIKE ${pattern}`);
    conditions.push(searched.length ? `(${searched.join(" OR ")})` : "FALSE");
  }
  return conditions.length ? conditions.join(" AND ") : "TRUE";
}

export interface Statement {
  text: string;
  values: unknown[];
}

/** The statements of a query: its page of rows, and (with `counts`) its total and groups. */
export function querySql(query: SourceQuery, columns: Map<string, PgColumn>): { rows: Statement; total?: Statement; groups?: Statement } {
  if (!Number.isInteger(query.offset) || query.offset < 0) throw new SourceError("offset must be a whole number");
  if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > MAX_SOURCE_PAGE) throw new SourceError(`limit must be 1 to ${MAX_SOURCE_PAGE}`);
  const from = fromSql(query.target);
  const group = query.groupBy ? column(columns, query.groupBy) : null;

  const p = new Params();
  const select = selectSql(query, columns);
  const join = group ? groupJoin(group, p, query.timeZone) : "";
  const where = whereSql(query, columns, p);
  const order = [
    ...(group ? groupOrderSql(group, query.groupOrder, "count(*) OVER (PARTITION BY gx.g)") : []),
    ...query.sort.map((s) => {
      const key = s.column === TITLE_COLUMN ? `lower(${titleSql(query, columns, p)})` : sortSql(column(columns, s.column));
      // Empty values last, unless the filter keeps none (then an index on the column can be read in order).
      return `${key} ${s.direction === "desc" ? "DESC" : "ASC"}${keepsOnlyValues(query.filter, s.column) ? "" : " NULLS LAST"}`;
    }),
    `${ref(column(columns, query.key))} ASC`,
  ];
  const rows: Statement = {
    text: `SELECT ${select}${group ? ', gx.g AS "$group"' : ""} FROM ${from} ${join} WHERE ${where} ORDER BY ${order.join(", ")} LIMIT ${p.add(query.limit + 1)} OFFSET ${p.add(query.offset)}`,
    values: p.values,
  };
  if (!query.counts) return { rows };

  const tp = new Params();
  const total: Statement = { text: `SELECT count(*)::float8 AS n FROM ${from} WHERE ${whereSql(query, columns, tp)}`, values: tp.values };
  if (!group) return { rows, total };
  const gp = new Params();
  const gJoin = groupJoin(group, gp, query.timeZone);
  const gWhere = whereSql(query, columns, gp);
  const groups: Statement = {
    text: `SELECT gx.g AS g, count(*)::float8 AS n FROM ${from} ${gJoin} WHERE ${gWhere} GROUP BY gx.g ORDER BY ${groupOrderSql(group, query.groupOrder, "count(*)").join(", ")} LIMIT ${MAX_SOURCE_GROUPS}`,
    values: gp.values,
  };
  return { rows, total, groups };
}

/** One row by its key (compared as the key column's own type, so its index is used). */
export function rowSql(shape: SourceShape & { keyValue: string }, columns: Map<string, PgColumn>): Statement {
  const p = new Params();
  const key = ref(column(columns, shape.key));
  return { text: `SELECT ${selectSql(shape, columns)} FROM ${fromSql(shape.target)} WHERE ${key} = ${p.add(shape.keyValue)} LIMIT 1`, values: p.values };
}
