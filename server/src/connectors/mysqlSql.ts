import { conditionText, MAX_SOURCE_GROUPS, MAX_SOURCE_PAGE, TITLE_COLUMN, type SourceColumn, type SourceFilter, type SourceQuery, type SourceShape, type SourceTarget } from "../../../shared/sources.ts";
import { SourceError } from "./connector.ts";
import { dayStart, zoneOffsets } from "./d1Sql.ts";

// The MySQL / MariaDB connector's SQL: how a column of each type is read, and the statements a
// query (shared/sources.ts) becomes. Pure (no connection), so it is tested without a database
// (server/test/connectors/mysqlSql.test.ts; mysql.test.ts runs it on one). Every value goes in as
// a parameter (?) and every name is quoted (`name`); a query written by the user is the one
// exception (it is the query), one SELECT / WITH statement wrapped as a subquery.
//
// What a filter means follows the app's (applyQuery in app/src/domain/query.ts), as Postgres's
// does, though MySQL's collations are mostly case- and accent-insensitive: text is compared
// lower-cased in utf8mb4_bin (so "é" is not "e"), sorted in utf8mb4_unicode_ci with its digit runs
// padded to 20 digits, so "Customer 9" sorts before "Customer 10" as in the app; empty values sort
// last both ways. Zero dates ("0000-00-00", or a zero month or day) are empty. A DATETIME has no
// zone and is taken as UTC (like a Postgres timestamp); a TIMESTAMP is read with the session's
// time_zone at +00:00, so both are UTC here. Named time zones need MySQL's time zone tables
// (often not loaded), so a day in the device's zone uses the zone's offsets (`zoneOffsets`, as D1's).

/** How a column's values are read: decides its value, text, sort and group expressions. */
export type MyReader = "text" | "int" | "number" | "bool" | "date" | "datetime" | "set";

export interface MyColumn extends SourceColumn {
  read: MyReader;
  /** A SET's members, in order (its groups). */
  members?: string[];
}

/** Which server: they differ in a few words (a regex's back reference, the time limit's variable). */
export type Flavour = "mysql" | "mariadb";

/** Types that are never read: binary data, shapes, vectors. */
const DROPPED = new Set([
  "binary", "varbinary", "tinyblob", "blob", "mediumblob", "longblob", "geometry", "point", "linestring", "polygon",
  "multipoint", "multilinestring", "multipolygon", "geometrycollection", "geomcollection", "vector",
]);
const INTS = new Set(["tinyint", "smallint", "mediumint", "int", "integer", "bigint", "year"]);
const NUMBERS = new Set(["decimal", "numeric", "float", "double", "real", "bit"]);

/** A SET's or ENUM's members from its column type, e.g. set('a','b''c'). */
export function membersOf(columnType: string): string[] {
  const inner = /^\w+\((.*)\)$/s.exec(columnType.trim())?.[1] ?? "";
  return [...inner.matchAll(/'((?:[^'\\]|''|\\.)*)'/g)].map((m) => m[1].replace(/''/g, "'").replace(/\\(.)/g, "$1"));
}

/**
 * How a column is read, from information_schema.COLUMNS (DATA_TYPE, COLUMN_TYPE), or null when it
 * isn't (dropped). `json`: MariaDB's JSON, a LONGTEXT checked by json_valid().
 */
export function myColumn(name: string, dataType: string, columnType: string, json = false): MyColumn | null {
  const t = dataType.toLowerCase();
  const full = columnType.toLowerCase();
  const base = { name, type: columnType };
  if (DROPPED.has(t)) return null;
  if (t === "json" || json) return { ...base, kind: "string", read: "text", plain: true, hidden: true };
  if ((t === "tinyint" && /^tinyint\(1\)/.test(full)) || full === "bit(1)") return { ...base, kind: "checkbox", read: "bool" };
  if (INTS.has(t)) return { ...base, kind: "number", read: "int" };
  if (NUMBERS.has(t)) return { ...base, kind: "number", read: "number" };
  if (t === "date") return { ...base, kind: "date", read: "date" };
  if (t === "datetime" || t === "timestamp") return { ...base, kind: "datetime", read: "datetime" };
  if (t === "set") return { ...base, kind: "string_list", read: "set", members: membersOf(columnType) };
  // Text, ENUM (by its text), TIME ("14:30" sorts right as text), MariaDB's UUID and INET types.
  return { ...base, kind: "string", read: "text" };
}

/** A quoted identifier. */
export const ident = (name: string) => `\`${name.replace(/`/g, "``")}\``;

/**
 * The parameters of one statement. MySQL's are positional (?), so `add` leaves a marker and
 * `statement` turns the finished text's markers into ? in the order they appear (a value used
 * twice is passed twice).
 */
export class Params {
  private added: (string | number)[] = [];
  add(value: string | number): string {
    this.added.push(value);
    return `\u0000${this.added.length - 1}\u0000`;
  }
  statement(text: string): Statement {
    const params: (string | number)[] = [];
    const sql = text.replace(/\u0000(\d+)\u0000/g, (_, i: string) => {
      params.push(this.added[Number(i)]);
      return "?";
    });
    return { sql, params };
  }
}

export interface Statement {
  sql: string;
  params: (string | number | null)[];
}

/**
 * A user's query as one SELECT / WITH statement: trailing semicolons dropped, any other semicolon
 * outside a string, quoted name or comment refused (the driver sends one statement; this says why).
 */
export function cleanQuery(query: string): string {
  const text = query.trim().replace(/;+\s*$/, "").trim();
  if (!text) throw new SourceError("The query is empty");
  if (!/^(\(\s*)*(SELECT|WITH)\b/i.test(text)) throw new SourceError("A query is one SELECT (or WITH … SELECT)");
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "'" || ch === '"' || ch === "`") {
      // Up to its closing quote: a doubled quote or (in strings) a backslash escapes one.
      for (i++; i < text.length; i++) {
        if (text[i] === "\\" && ch !== "`") i++;
        else if (text[i] === ch) {
          if (text[i + 1] === ch) i++;
          else break;
        }
      }
    } else if ((ch === "-" && text[i + 1] === "-") || ch === "#") {
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

/** What the target reads from, aliased q (a written query on lines of its own: a trailing comment ends there). */
export function fromSql(target: SourceTarget): string {
  if ("table" in target) {
    const { schema, name } = target.table;
    return `${schema ? `${ident(schema)}.` : ""}${ident(name)} AS q`;
  }
  return `(\n${cleanQuery(target.query)}\n) AS q`;
}

const ref = (c: MyColumn) => `q.${ident(c.name)}`;
const cast = (r: string) => `CAST(${r} AS CHAR CHARACTER SET utf8mb4)`;
/** Not a zero date (nor a zero month or day). */
const realDate = (r: string) => `(MONTH(${r}) <> 0 AND DAY(${r}) <> 0)`;
/** A UTC time (Unix seconds) as MySQL reads a DATETIME. */
const utc = (seconds: number) => new Date(seconds * 1000).toISOString().slice(0, 19).replace("T", " ");

/** The value as the app stores it (FieldValue), but checkboxes as 1 / 0 and SETs as "a,b" (made true / false and lists by the connector). */
export function valueSql(c: MyColumn): string {
  const r = ref(c);
  switch (c.read) {
    case "text":
    case "set":
      return cast(r);
    case "int":
    case "number":
      return `(${r} + 0E0)`;
    case "bool":
      return `(${r} <> 0)`;
    case "date":
      return `(CASE WHEN ${realDate(r)} THEN DATE_FORMAT(${r}, '%Y-%m-%d') END)`;
    case "datetime":
      return `(CASE WHEN ${realDate(r)} THEN CONCAT(LEFT(DATE_FORMAT(${r}, '%Y-%m-%dT%H:%i:%s.%f'), 23), 'Z') END)`;
  }
}

/** The value's text, as filters compare it ("" for none); a SET's as the app writes a list ("a, b"). */
const textSql = (c: MyColumn) => (c.read === "set" ? `REPLACE(COALESCE(${cast(ref(c))}, ''), ',', ', ')` : `COALESCE(${cast(ref(c))}, '')`);
/** Text lower-cased as it is (accents kept apart). */
const folded = (text: string) => `LOWER(${text} COLLATE utf8mb4_bin)`;

/** A LIKE pattern finding `text` anywhere (its own % _ ! taken literally: ! is the escape, whatever the sql_mode makes of \). */
const containing = (text: string) => `%${text.replace(/[!%_]/g, (ch) => `!${ch}`)}%`;
const like = (c: MyColumn, p: Params, text: string) => `${folded(textSql(c))} LIKE LOWER(${p.add(containing(text))}) ESCAPE '!'`;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A text's sort key: its digit runs padded to 20 digits (a number's text sorts by its value, as the app's localeCompare with numeric). */
function naturalSql(text: string, p: Params, flavour: Flavour): string {
  const back = flavour === "mariadb" ? "\\1" : "$1";
  return `(REGEXP_REPLACE(REGEXP_REPLACE(${text}, '(?<![0-9])([0-9])', ${p.add(`0000000000000000000${back}`)}), '(?<![0-9])0*([0-9]{20})(?![0-9])', ${p.add(back)}) COLLATE utf8mb4_unicode_ci)`;
}

/** One filter rule as a condition. A value that can't be compared matches nothing (as in the app). */
export function filterSql(c: MyColumn, rule: SourceFilter, p: Params, tz: string): string {
  const r = ref(c);
  const value = rule.value.trim();
  const op = rule.operator;
  const refuse = () => {
    throw new SourceError(`“${c.name}” can't be filtered with ${op}`);
  };
  if (c.kind === "string" || c.kind === "string_list") {
    const empty = `(${r} IS NULL OR ${cast(r)} = '')`;
    switch (op) {
      case "contains":
        return like(c, p, value);
      case "notContains":
        return `NOT (${like(c, p, value)})`;
      case "isEmpty":
        return empty;
      case "isNotEmpty":
        return `NOT ${empty}`;
      case "is":
      case "isNot":
        if (c.kind === "string_list" || c.plain) return refuse();
        return `${folded(textSql(c))} ${op === "is" ? "=" : "<>"} LOWER(${p.add(value)})`;
      default:
        return refuse();
    }
  }
  if (c.kind === "number") {
    if (op === "isEmpty") return `${r} IS NULL`;
    if (op === "isNotEmpty") return `${r} IS NOT NULL`;
    const n = Number(value);
    if (value === "" || !Number.isFinite(n)) return "FALSE";
    // Compared with the column itself (its index).
    switch (op) {
      case "is":
        return `${r} = ${p.add(n)}`;
      case "isNot":
        return `NOT (${r} <=> ${p.add(n)})`;
      case "gt":
        return `${r} > ${p.add(n)}`;
      case "lt":
        return `${r} < ${p.add(n)}`;
      default:
        return refuse();
    }
  }
  if (c.kind === "checkbox") {
    switch (op) {
      case "isChecked":
        return `${r} <> 0`;
      case "isNotChecked":
        return `(${r} IS NULL OR ${r} = 0)`;
      case "is":
        if (!/^(true|false)$/i.test(value)) return "FALSE";
        return value.toLowerCase() === "true" ? `${r} <> 0` : `(${r} IS NULL OR ${r} = 0)`;
      default:
        return refuse();
    }
  }
  // Dates, and dates & times by the day they are on in the device's time zone; zero dates are empty.
  if (op === "isEmpty") return `(${r} IS NULL OR NOT ${realDate(r)})`;
  if (op === "isNotEmpty") return realDate(r);
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
  const real = realDate(r);
  if (c.kind === "date") {
    switch (op) {
      case "is":
        return `${r} = ${p.add(from)} AND ${real}`;
      case "before":
        return `${r} < ${p.add(from)} AND ${real}`;
      case "after":
        return `${r} > ${p.add(from)} AND ${real}`;
      case "between":
        return `${r} BETWEEN ${p.add(from)} AND ${p.add(to)} AND ${real}`;
      default:
        return refuse();
    }
  }
  // Compared with the column itself (its index), as UTC times.
  const start = (day: string, days = 0) => p.add(utc(dayStart(day, tz, days)));
  switch (op) {
    case "is":
    case "between":
      return `${r} >= ${start(from)} AND ${r} < ${start(to, 1)} AND ${real}`;
    case "before":
      return `${r} < ${start(from)} AND ${real}`;
    case "after":
      return `${r} >= ${start(from, 1)} AND ${real}`;
    default:
      return refuse();
  }
}

/** A sort key: comparable, null for none (sorted last). */
function sortSql(c: MyColumn, p: Params, flavour: Flavour): string {
  if (c.plain) throw new SourceError(`“${c.name}” can't be sorted`);
  const r = ref(c);
  switch (c.read) {
    case "text":
    case "set":
      return naturalSql(`NULLIF(${textSql(c)}, '')`, p, flavour);
    case "bool":
      return `COALESCE(${r} <> 0, 0)`; // unchecked is a value, not empty
    case "date":
    case "datetime":
      return `(CASE WHEN ${realDate(r)} THEN ${r} END)`;
    default:
      return r;
  }
}

/** ORDER BY a key either way, empty (null) last. */
const ordered = (key: string, direction: "asc" | "desc") => `(${key}) IS NULL, ${key} ${direction === "desc" ? "DESC" : "ASC"}`;

/** The title (the app's itemLabel): the first non-blank of the title columns, else the untitled name. */
function titleSql(shape: SourceShape, columns: Map<string, MyColumn>, p: Params): string {
  const parts = shape.title.map((name) => {
    const text = cast(ref(column(columns, name)));
    return `CASE WHEN TRIM(${text}) <> '' THEN ${text} END`;
  });
  return `COALESCE(${[...parts, p.add(shape.untitled)].join(", ")})`;
}

/** The day (yyyy-mm-dd) a date & time is on in the time zone. */
function daySql(r: string, tz: string): string {
  const [first, ...changes] = zoneOffsets(tz);
  const offset = changes.length
    ? `(CASE ${changes.map((o, i) => `WHEN ${r} < '${utc(o.from)}' THEN ${(i ? changes[i - 1] : first).minutes}`).join(" ")} ELSE ${changes[changes.length - 1].minutes} END)`
    : `${first.minutes}`;
  return `DATE_FORMAT(${r} + INTERVAL ${offset} MINUTE, '%Y-%m-%d')`;
}

/** The group a row is in, as text (null for none); not for a SET (a row per member: groupedFromSql). */
function groupKeySql(c: MyColumn, tz: string): string {
  const r = ref(c);
  switch (c.read) {
    case "bool":
      return `(CASE WHEN ${r} <> 0 THEN 'yes' ELSE 'no' END)`;
    case "int":
      return cast(r);
    case "number":
      return cast(`${r} + 0E0`);
    case "date":
      return valueSql(c);
    case "datetime":
      return `(CASE WHEN ${realDate(r)} THEN ${daySql(r, tz)} END)`;
    default:
      return cast(r);
  }
}

/** The group column added to what a grouped query reads. */
const G = ident("$kubus_group");

/** What a grouped query reads from: the target with each row's group (a SET's row once per member, "" for none), aliased q. */
function groupedFromSql(target: SourceTarget, c: MyColumn, p: Params, tz: string): string {
  if (c.plain) throw new SourceError(`“${c.name}” can't be grouped`);
  if (c.read === "set") {
    const text = cast(ref(c));
    const members = ["SELECT '' AS g", ...(c.members ?? []).map((m) => `SELECT ${p.add(m)}`)].join(" UNION ALL ");
    return `(SELECT q.*, gx.g COLLATE utf8mb4_bin AS ${G} FROM ${fromSql(target)} JOIN (${members}) AS gx ON (gx.g = '' AND COALESCE(${text}, '') = '') OR FIND_IN_SET(gx.g, ${text}) > 0) AS q`;
  }
  return `(SELECT q.*, COALESCE(${groupKeySql(c, tz)}, '') COLLATE utf8mb4_bin AS ${G} FROM ${fromSql(target)}) AS q`;
}

/** Groups in order: the empty one last, then by size (largest first) or by value either way. */
function groupOrderSql(c: MyColumn, g: string, order: SourceQuery["groupOrder"], count: string, p: Params, flavour: Flavour): string {
  const value =
    c.kind === "number" ? `(NULLIF(${g}, '') + 0E0)` : c.kind === "checkbox" ? `(CASE ${g} WHEN 'yes' THEN 0 ELSE 1 END)` : c.kind === "string" || c.kind === "string_list" ? naturalSql(g, p, flavour) : g;
  return [`(${g} = '')`, ...(order === "count" ? [`${count} DESC`] : []), `${value} ${order === "desc" ? "DESC" : "ASC"}`].join(", ");
}

function column(columns: Map<string, MyColumn>, name: string): MyColumn {
  const c = columns.get(name);
  if (!c) throw new SourceError(`There is no column “${name}” (refresh the collection's columns)`);
  return c;
}

/** The SELECT list of a row: its key as text, then the asked columns' values. */
function selectSql(shape: SourceShape, columns: Map<string, MyColumn>): string {
  return [`${cast(ref(column(columns, shape.key)))} AS \`$key\``, ...shape.columns.map((name, i) => `${valueSql(column(columns, name))} AS \`v${i}\``)].join(", ");
}

/** The conditions of a query (its filter's and / or tree, and search), "TRUE" for none. */
function whereSql(query: SourceQuery, columns: Map<string, MyColumn>, p: Params): string {
  const filter = conditionText(query.filter, (rule) => filterSql(column(columns, rule.column), rule, p, query.timeZone), { and: "AND", or: "OR", all: "TRUE", none: "FALSE" });
  const conditions = filter === "TRUE" ? [] : [filter];
  const needle = query.search.trim();
  if (needle) {
    const searched = query.columns.map((name) => like(column(columns, name), p, needle));
    conditions.push(searched.length ? `(${searched.join(" OR ")})` : "FALSE");
  }
  return conditions.length ? conditions.join(" AND ") : "TRUE";
}

/** The statements of a query: its page of rows, and (with `counts`) its total and groups. */
export function querySql(query: SourceQuery, columns: Map<string, MyColumn>, flavour: Flavour): { rows: Statement; total?: Statement; groups?: Statement } {
  if (!Number.isInteger(query.offset) || query.offset < 0) throw new SourceError("offset must be a whole number");
  if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > MAX_SOURCE_PAGE) throw new SourceError(`limit must be 1 to ${MAX_SOURCE_PAGE}`);
  const group = query.groupBy ? column(columns, query.groupBy) : null;

  const p = new Params();
  const from = group ? groupedFromSql(query.target, group, p, query.timeZone) : fromSql(query.target);
  const order = [
    ...(group ? [groupOrderSql(group, `q.${G}`, query.groupOrder, `COUNT(*) OVER (PARTITION BY q.${G})`, p, flavour)] : []),
    ...query.sort.map((s) => ordered(s.column === TITLE_COLUMN ? naturalSql(titleSql(query, columns, p), p, flavour) : sortSql(column(columns, s.column), p, flavour), s.direction)),
    `${ref(column(columns, query.key))} ASC`,
  ];
  // Limits are whole numbers (checked above): written as they are, as a prepared LIMIT ? may not take them.
  const rows = p.statement(
    `SELECT ${selectSql(query, columns)}${group ? `, q.${G} AS \`$group\`` : ""} FROM ${from} WHERE ${whereSql(query, columns, p)} ORDER BY ${order.join(", ")} LIMIT ${query.limit + 1} OFFSET ${query.offset}`,
  );
  if (!query.counts) return { rows };

  const tp = new Params();
  const total = tp.statement(`SELECT COUNT(*) AS n FROM ${fromSql(query.target)} WHERE ${whereSql(query, columns, tp)}`);
  if (!group) return { rows, total };
  const gp = new Params();
  const counted = `SELECT q.${G} AS g, COUNT(*) AS n FROM ${groupedFromSql(query.target, group, gp, query.timeZone)} WHERE ${whereSql(query, columns, gp)} GROUP BY q.${G}`;
  const groups = gp.statement(`SELECT gs.g, gs.n FROM (${counted}) AS gs ORDER BY ${groupOrderSql(group, "gs.g", query.groupOrder, "gs.n", gp, flavour)} LIMIT ${MAX_SOURCE_GROUPS}`);
  return { rows, total, groups };
}

/** One row by its key (compared as the key column itself, so its index is used; a number key that isn't one names no row). */
export function rowSql(shape: SourceShape & { keyValue: string }, columns: Map<string, MyColumn>): Statement {
  const p = new Params();
  const c = column(columns, shape.key);
  const value = shape.keyValue.trim();
  const fits = c.kind !== "number" || (value !== "" && Number.isFinite(Number(value)));
  return p.statement(`SELECT ${selectSql(shape, columns)} FROM ${fromSql(shape.target)} WHERE ${fits ? `${ref(c)} = ${p.add(shape.keyValue)}` : "FALSE"} LIMIT 1`);
}

/** Privileges that change data or tables. */
const WRITES = new Set([
  "ALL", "ALL PRIVILEGES", "INSERT", "UPDATE", "DELETE", "CREATE", "DROP", "ALTER", "INDEX", "TRIGGER", "EVENT", "CREATE VIEW",
  "CREATE ROUTINE", "ALTER ROUTINE", "DELETE HISTORY", "FILE", "SUPER",
]);

/**
 * What SHOW GRANTS says about a user (one GRANT per line): a superuser (ALL or SUPER on *.*) or one
 * that can write somewhere is warned about. A role's privileges (MySQL 8) aren't listed there, so aren't seen.
 */
export function grantWarnings(grants: string[]): string[] {
  let superuser = false;
  let writes = false;
  for (const line of grants) {
    const m = /^GRANT\s+(.+?)\s+ON\s+(?:(?:TABLE|FUNCTION|PROCEDURE|PACKAGE(?: BODY)?)\s+)?(\S+)\s+TO\s/is.exec(line.trim());
    if (!m) continue;
    const privileges = m[1].replace(/\([^)]*\)/g, "").split(",").map((x) => x.trim().toUpperCase().replace(/\s+/g, " "));
    const everywhere = m[2] === "*.*";
    if (everywhere && privileges.some((x) => x === "ALL" || x === "ALL PRIVILEGES" || x === "SUPER")) superuser = true;
    if (privileges.some((x) => WRITES.has(x))) writes = true;
  }
  if (superuser) return ["connects as a superuser (all privileges): use a user that can only read (docs/sync.md)"];
  if (writes) return ["its user may write to some tables: a user that can only read is safer (docs/sync.md)"];
  return [];
}
