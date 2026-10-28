import { conditionText, MAX_SOURCE_GROUPS, MAX_SOURCE_PAGE, TITLE_COLUMN, type SourceColumn, type SourceCondition, type SourceFilter, type SourceQuery, type SourceShape, type SourceTarget, type SourceValue } from "../../../shared/sources.ts";
import { SourceError } from "./connector.ts";

// The InfluxDB 2 connector's Flux: how a column of each type is read, the scripts a query
// (shared/sources.ts) becomes, and the annotated CSV InfluxDB answers with. Pure (no connection),
// so it is tested without a server (app/src/data/remote/influxFlux.test.ts).
//
// A table is a measurement of a bucket (its "schema"), read as InfluxDB's own UI shows it: one row
// per series and time, its fields pivoted into columns beside its tags, and `_id` (the series and
// time) telling rows apart. A query is a Flux script whose tables are put together as one.
//
// Strictly read-only: what this writes only reads (from, range, filter, pivot, map, sort, …), and a
// query written in the app is refused when it could do anything else (`checkFlux`: only packages
// without side effects may be imported, and `to` is never called). The token should still be one
// that can only read (docs/sync.md): `check` warns when it can write.
//
// What a filter means follows the app's own (applyQuery in app/src/domain/query.ts): text is
// compared case-insensitively, empty values sort last, a date & time is on its day in the device's
// time zone. Days are worked out here (dayStart), so a filter on `_time` narrows the range read.

/** How a column's values are read. */
export type InfluxReader = "string" | "number" | "bool" | "time" | "duration";

export interface InfluxColumn extends SourceColumn {
  read: InfluxReader;
  /** A tag of a measurement (part of its series). */
  tag?: boolean;
  /**
   * The field's key in InfluxDB when its column is named otherwise: a field and a tag of a
   * measurement may share a key, the field's column is then "<key> (field)" (`fieldColumns`).
   */
  field?: string;
}

/** Names a field's column can't take: the time and what the read drops. */
const TAKEN = ["_time", "_start", "_stop", "_measurement", "_field", "_value"];

/**
 * A measurement's field columns, from its fields' keys and types (as their latest values gave them):
 * each key once (one with values of more than one type is a number when all are numbers, else
 * text); a key a tag (or the time, the key) already has is named "<key> (field)", then
 * "<key> (field 2)", …. By key, so the same fields and tags give the same names on every read.
 */
export function fieldColumns(fields: readonly (readonly [string, string])[], taken: Iterable<string>): { name: string; field: string; datatype: string }[] {
  const types = new Map<string, Set<string>>();
  for (const [field, datatype] of fields) {
    if (!types.has(field)) types.set(field, new Set());
    types.get(field)!.add(datatype);
  }
  const reserved = new Set([...TAKEN, ID_COLUMN, ...taken]);
  const keys = [...types.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  // A key of its own is always its field's name; only then are the others named.
  const used = new Set([...reserved, ...keys]);
  return keys.map((field) => {
    const all = [...types.get(field)!];
    const numeric = all.every((t) => /^(long|unsignedLong|double)$/.test(t));
    const datatype = all.length === 1 ? all[0] : numeric ? "double" : "string";
    let name = field;
    if (reserved.has(field)) {
      for (let n = 1; used.has(name); n++) name = `${field} (field${n > 1 ? ` ${n}` : ""})`;
      used.add(name);
    }
    return { name, field, datatype };
  });
}

/** The synthetic column of a measurement's rows: its time and series (`<time>,tag=value,…`). */
export const ID_COLUMN = "_id";
/** Everything there is: InfluxDB keeps times from 1677 to 2262; Flux needs a range. */
export const ALL_START = "1970-01-01T00:00:00Z";
export const ALL_STOP = "2262-01-01T00:00:00Z";
const ALL_START_MS = Date.parse(ALL_START);
const ALL_STOP_MS = Date.parse(ALL_STOP);

/** A Flux string literal (its own \ " and ${ taken literally). */
export const fluxString = (text: string) =>
  `"${text.replace(/[\\"$]/g, (ch) => `\\${ch}`).replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t")}"`;

/** A case-insensitive Flux regular expression finding `text` (anywhere, or `whole`), taken literally. */
export function fluxRegex(text: string, whole = false): string {
  const body = [...text]
    .map((ch) => {
      if (/[\\.+*?()|[\]{}^$/]/.test(ch)) return `\\${ch}`;
      const code = ch.codePointAt(0)!;
      return code < 0x20 || code === 0x7f ? `\\x{${code.toString(16)}}` : ch;
    })
    .join("");
  return `/(?i)${whole ? "^" : ""}${body}${whole ? "$" : ""}/`;
}

const ref = (name: string) => `r[${fluxString(name)}]`;

/** How a column of an annotated CSV datatype is read, or null when it isn't (binary data). */
export function influxColumn(name: string, datatype: string, tag = false): InfluxColumn | null {
  const base = { name, type: tag ? "tag" : datatype };
  switch (datatype.replace(/:.*/, "")) {
    case "long":
    case "unsignedLong":
    case "double":
      return { ...base, kind: "number", read: "number" };
    case "boolean":
      return { ...base, kind: "checkbox", read: "bool" };
    case "dateTime":
      // A query's range: there in every row, rarely worth a column.
      return { ...base, type: "dateTime", kind: "datetime", read: "time", ...((name === "_start" || name === "_stop") && { hidden: true }) };
    case "duration":
      return { ...base, kind: "string", read: "duration", plain: true };
    case "base64Binary":
      return null;
    default:
      return { ...base, kind: "string", read: "string", ...(tag && { tag: true }) };
  }
}

/** A CSV cell as the app stores it (FieldValue): numbers, true / false, ISO 8601 UTC, text; "" for none. */
export function influxValue(raw: string, datatype: string): SourceValue {
  if (raw === "") return null;
  switch (datatype.replace(/:.*/, "")) {
    case "long":
    case "unsignedLong":
    case "double": {
      const n = Number(raw);
      return Number.isFinite(n) ? n : null;
    }
    case "boolean":
      return raw === "true";
    case "dateTime": {
      const d = new Date(raw.replace(/(\.\d{3})\d+/, "$1"));
      return Number.isNaN(d.getTime()) ? raw : d.toISOString();
    }
    default:
      return raw;
  }
}

// --- Annotated CSV (what /api/v2/query answers) ---

export interface CsvTable {
  columns: { name: string; datatype: string; group: boolean }[];
  /** Cells by column, the #default annotation filled in. */
  rows: string[][];
}

/** RFC 4180 records (quoted cells, CRLF or LF); a blank line is an empty record. */
function csvRecords(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      record.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      record.push(cell);
      records.push(record);
      record = [];
      cell = "";
    } else cell += ch;
  }
  if (cell !== "" || record.length) {
    record.push(cell);
    records.push(record);
  }
  return records;
}

/** The tables of an annotated CSV answer; an error InfluxDB reports in it is thrown. */
export function parseAnnotatedCsv(text: string): CsvTable[] {
  const tables: CsvTable[] = [];
  let datatypes: string[] = [];
  let groups: string[] = [];
  let defaults: string[] = [];
  let table: CsvTable | null = null;
  for (const record of csvRecords(text)) {
    if (record.length === 1 && record[0] === "") {
      table = null;
      continue;
    }
    const first = record[0];
    if (first.startsWith("#")) {
      if (first === "#datatype") datatypes = record;
      else if (first === "#group") groups = record;
      else if (first === "#default") defaults = record;
      table = null;
      continue;
    }
    if (!table) {
      // The header: the first cell is the annotations' column.
      table = {
        columns: record.slice(1).map((name, i) => ({ name, datatype: datatypes[i + 1] ?? "string", group: groups[i + 1] === "true" })),
        rows: [],
      };
      tables.push(table);
      continue;
    }
    const row = record.slice(1).map((cell, i) => (cell === "" ? (defaults[i + 1] ?? "") : cell));
    const names = table.columns.map((c) => c.name);
    if (names.includes("error") && names.includes("reference")) throw new SourceError(row[names.indexOf("error")] || "InfluxDB reported an error");
    table.rows.push(row);
  }
  return tables;
}

// --- Days in a time zone ---

const formats = new Map<string, Intl.DateTimeFormat>();
function formatIn(tz: string): Intl.DateTimeFormat {
  let format = formats.get(tz);
  if (!format) {
    try {
      format = new Intl.DateTimeFormat("en-US", {
        timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
      });
    } catch {
      throw new SourceError(`Unknown time zone “${tz}”`);
    }
    formats.set(tz, format);
  }
  return format;
}

function partsIn(at: number, tz: string) {
  const parts = formatIn(tz).formatToParts(new Date(at));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute"), second: get("second") };
}

/** How far the time zone is ahead of UTC at a moment, in milliseconds. */
function offsetAt(at: number, tz: string): number {
  const p = partsIn(at, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(at / 1000) * 1000;
}

/** The moment a day (yyyy-mm-dd) starts in the time zone, `days` later than it, in ms since 1970. */
export function dayStart(day: string, tz: string, days = 0): number {
  const [y, m, d] = day.split("-").map(Number);
  const wall = Date.UTC(y, m - 1, d + days);
  const guess = wall - offsetAt(wall, tz);
  return wall - offsetAt(guess, tz);
}

/** The day (yyyy-mm-dd) a moment is on in the time zone. */
export function dayIn(at: number, tz: string): string {
  const p = partsIn(at, tz);
  return `${String(p.year).padStart(4, "0")}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** A moment as a Flux time literal. */
const timeLiteral = (ms: number) => new Date(ms).toISOString();

/** A time's nanoseconds since 1970 from its RFC 3339 text, or null. */
export function nanosOf(text: string): bigint | null {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(text);
  if (!m) return null;
  const ms = Date.parse(`${m[1]}${m[3]}`);
  if (Number.isNaN(ms)) return null;
  return BigInt(ms) * 1_000_000n + BigInt((m[2] ?? "").padEnd(9, "0"));
}

// --- Queries written in the app ---

/** Packages a query may import: none of them can write or reach anything else. */
export const READ_ONLY_PACKAGES = new Set([
  "array", "date", "date/boundaries", "dict", "influxdata/influxdb/schema", "influxdata/influxdb/v1", "interpolate", "join",
  "math", "regexp", "strings", "timezone", "types",
]);

interface Token {
  kind: "ident" | "string" | "number" | "punct" | "regex";
  text: string;
  start: number;
  end: number;
}

const KEYWORDS = new Set(["and", "or", "not", "exists", "if", "then", "else", "return", "import", "option", "package", "with"]);

/** Flux's tokens (comments left out; a string's interpolations ${…} read as code too). */
function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const regexMay = () => {
    const last = tokens[tokens.length - 1];
    if (!last) return true;
    if (last.kind === "ident") return KEYWORDS.has(last.text);
    if (last.kind === "punct") return !/^[)\]}]$/.test(last.text);
    return false;
  };
  // Reads code until an unmatched } (inside an interpolation) or the end.
  const code = (inside: boolean) => {
    let depth = 0;
    while (i < src.length) {
      const ch = src[i];
      if (/\s/.test(ch)) i++;
      else if (ch === "/" && src[i + 1] === "/") {
        while (i < src.length && src[i] !== "\n") i++;
      } else if (ch === '"') {
        const start = i++;
        let value = "";
        while (i < src.length && src[i] !== '"') {
          if (src[i] === "\\") {
            value += src[i + 1] ?? "";
            i += 2;
          } else if (src[i] === "$" && src[i + 1] === "{") {
            i += 2;
            code(true);
            i++; // its }
          } else value += src[i++];
        }
        if (i >= src.length) throw new SourceError("The query has a string that isn't closed");
        i++;
        tokens.push({ kind: "string", text: value, start, end: i });
      } else if (ch === "/" && regexMay()) {
        const start = i++;
        while (i < src.length && src[i] !== "/" && src[i] !== "\n") i += src[i] === "\\" ? 2 : 1;
        if (src[i] !== "/") throw new SourceError("The query has a regular expression that isn't closed");
        i++;
        tokens.push({ kind: "regex", text: src.slice(start, i), start, end: i });
      } else if (/[A-Za-z_]/.test(ch)) {
        const start = i;
        while (i < src.length && /[A-Za-z0-9_]/.test(src[i])) i++;
        tokens.push({ kind: "ident", text: src.slice(start, i), start, end: i });
      } else if (/[0-9]/.test(ch)) {
        const start = i;
        while (i < src.length && /[0-9A-Za-z_.:+-]/.test(src[i]) && !(src[i] === "-" && !/[eE0-9]/.test(src[i - 1]))) i++;
        tokens.push({ kind: "number", text: src.slice(start, i), start, end: i });
      } else {
        if (ch === "{") depth++;
        else if (ch === "}") {
          if (inside && depth === 0) return;
          depth--;
        }
        tokens.push({ kind: "punct", text: ch, start: i, end: i + 1 });
        i++;
      }
    }
    if (inside) throw new SourceError("The query has a string that isn't closed");
  };
  code(false);
  return tokens;
}

export interface CheckedFlux {
  /** Its imports: the package and the name it is imported as. */
  imports: { path: string; alias: string | null }[];
  /** Where its imports end (what follows is its statements). */
  importsEnd: number;
}

/** A query written in the app, refused unless it only reads (see above). */
export function checkFlux(script: string): CheckedFlux {
  if (!script.trim()) throw new SourceError("The query is empty");
  const tokens = tokenize(script);
  const imports: CheckedFlux["imports"] = [];
  let importsEnd = 0;
  for (let t = 0; t < tokens.length; t++) {
    const token = tokens[t];
    if (token.kind !== "ident") continue;
    if (token.text === "import") {
      const alias = tokens[t + 1]?.kind === "ident" ? tokens[t + 1] : null;
      const path = tokens[t + (alias ? 2 : 1)];
      if (path?.kind !== "string") throw new SourceError("An import names its package in quotes");
      if (!READ_ONLY_PACKAGES.has(path.text)) {
        throw new SourceError(`A query may only import packages that read (not “${path.text}”): ${[...READ_ONLY_PACKAGES].join(", ")}`);
      }
      imports.push({ path: path.text, alias: alias?.text ?? null });
      importsEnd = path.end;
      t += alias ? 2 : 1;
    } else if (token.text === "to" && tokens[t - 1]?.text !== ".") {
      throw new SourceError("A query only reads: it can't use to()");
    }
  }
  // No literal holds "to" (1to(…) isn't Flux, but nothing is left to how InfluxDB would read it).
  if (tokens.some((t) => t.kind === "number" && /to/i.test(t.text))) throw new SourceError("A query only reads: it can't use to()");
  return { imports, importsEnd };
}

/** A query's statements, a trailing yield() dropped (its tables go on to be filtered and paged). */
const queryBody = (body: string) => body.trim().replace(/\|>\s*yield\s*\(\s*(?:name\s*:\s*"[^"]*"\s*)?\)\s*$/, "").trim();

// --- Scripts ---

function column(columns: Map<string, InfluxColumn>, name: string): InfluxColumn {
  const c = columns.get(name);
  if (!c) throw new SourceError(`There is no column “${name}” (refresh the collection's columns)`);
  return c;
}

/** A Flux script being put together: imports and statements before the target's tables and what is piped onto them. */
class Script {
  readonly imports = new Set<string>();
  readonly statements: string[] = [];
  private target: SourceTarget;
  private columns: Map<string, InfluxColumn>;
  /** The range a measurement is read in (Flux time expressions). */
  private range: { start: string; stop: string };

  constructor(target: SourceTarget, columns: Map<string, InfluxColumn>, range = { start: ALL_START, stop: ALL_STOP }) {
    this.target = target;
    this.columns = columns;
    this.range = range;
  }

  need(pkg: string) {
    this.imports.add(pkg);
  }

  render(pipeline: string[]): string {
    const pipe = pipeline.map((p) => `\n  |> ${p}`).join("");
    if ("table" in this.target) {
      const { schema, name } = this.target.table;
      const tags = [...this.columns.values()].filter((c) => c.tag).map((c) => c.name);
      const id = ["string(v: r._time)", ...tags.map((t) => `${fluxString(`,${t}=`)} + (if exists ${ref(t)} then ${ref(t)} else "")`)].join(" + ");
      // A field whose column is named otherwise (its key a tag's too) is renamed before it becomes a column.
      const renamed = [...this.columns.values()].filter((c) => c.field !== undefined && c.field !== c.name);
      const rename = renamed.length
        ? `\n  |> map(fn: (r) => ({r with _field: ${renamed.map((c) => `if r._field == ${fluxString(c.field!)} then ${fluxString(c.name)} else `).join("")}r._field}))`
        : "";
      return [
        ...[...this.imports].map((p) => `import ${fluxString(p)}`),
        ...this.statements,
        `from(bucket: ${fluxString(schema ?? "")})
  |> range(start: ${this.range.start}, stop: ${this.range.stop})
  |> filter(fn: (r) => r._measurement == ${fluxString(name)})${rename}
  |> pivot(rowKey: ["_time"], columnKey: ["_field"], valueColumn: "_value")
  |> drop(columns: ["_start", "_stop", "_measurement"])
  |> group()
  |> map(fn: (r) => ({r with ${ID_COLUMN}: ${id}}))${pipe}`,
      ].join("\n");
    }
    const script = this.target.query;
    const checked = checkFlux(script);
    const own = new Set(checked.imports.filter((i) => !i.alias).map((i) => i.path));
    const body = queryBody(script.slice(checked.importsEnd));
    if (!body) throw new SourceError("The query has no tables to read");
    return [
      ...[...this.imports].filter((p) => !own.has(p)).map((p) => `import ${fluxString(p)}`),
      script.slice(0, checked.importsEnd).trim(),
      ...this.statements,
      `${body}\n  |> group()${pipe}`,
    ]
      .filter(Boolean)
      .join("\n");
  }
}

/** The value's text, as filters compare it ("" for none). */
function textOf(c: InfluxColumn): string {
  const r = ref(c.name);
  return c.read === "string" ? `(if exists ${r} then ${r} else "")` : `(if exists ${r} then string(v: ${r}) else "")`;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The days a date filter covers, as moments [from, to); null when its value isn't a day. */
function dayBounds(rule: SourceFilter, tz: string): { from?: number; to?: number } | null {
  const value = rule.value.trim();
  if (rule.operator === "between") {
    const [start, end] = value.split("..");
    if (!DAY.test(start ?? "") || !DAY.test(end ?? "")) return null;
    return { from: dayStart(start, tz), to: dayStart(end, tz, 1) };
  }
  if (!DAY.test(value)) return null;
  switch (rule.operator) {
    case "is":
      return { from: dayStart(value, tz), to: dayStart(value, tz, 1) };
    case "before":
      return { to: dayStart(value, tz) };
    case "after":
      return { from: dayStart(value, tz, 1) };
    default:
      return null;
  }
}

/** One filter rule as a condition. A value that can't be compared matches nothing (as in the app). */
export function filterFlux(c: InfluxColumn, rule: SourceFilter, tz: string): string {
  const r = ref(c.name);
  const value = rule.value.trim();
  const op = rule.operator;
  const refuse = () => {
    throw new SourceError(`“${c.name}” can't be filtered with ${op}`);
  };
  if (c.kind === "string" || c.kind === "string_list") {
    switch (op) {
      case "contains":
        return `${textOf(c)} =~ ${fluxRegex(value)}`;
      case "notContains":
        return `${textOf(c)} !~ ${fluxRegex(value)}`;
      case "isEmpty":
        return `${textOf(c)} == ""`;
      case "isNotEmpty":
        return `${textOf(c)} != ""`;
      case "is":
      case "isNot":
        if (c.plain) return refuse();
        return `${textOf(c)} ${op === "is" ? "=~" : "!~"} ${fluxRegex(value, true)}`;
      default:
        return refuse();
    }
  }
  if (c.kind === "number") {
    if (op === "isEmpty") return `(not exists ${r})`;
    if (op === "isNotEmpty") return `(exists ${r})`;
    const n = Number(value);
    if (value === "" || !Number.isFinite(n)) return "false";
    const v = `float(v: ${fluxString(String(n))})`;
    switch (op) {
      case "is":
        return `(exists ${r} and float(v: ${r}) == ${v})`;
      case "isNot":
        return `(not exists ${r} or float(v: ${r}) != ${v})`;
      case "gt":
        return `(exists ${r} and float(v: ${r}) > ${v})`;
      case "lt":
        return `(exists ${r} and float(v: ${r}) < ${v})`;
      default:
        return refuse();
    }
  }
  if (c.kind === "checkbox") {
    const checked = `(exists ${r} and ${r} == true)`;
    switch (op) {
      case "isChecked":
        return checked;
      case "isNotChecked":
        return `(not ${checked})`;
      case "is":
        if (!/^(true|false)$/i.test(value)) return "false";
        return value.toLowerCase() === "true" ? checked : `(not ${checked})`;
      default:
        return refuse();
    }
  }
  // Dates & times, by the day they are on in the device's time zone.
  if (op === "isEmpty") return `(not exists ${r})`;
  if (op === "isNotEmpty") return `(exists ${r})`;
  if (!["is", "between", "before", "after"].includes(op)) return refuse();
  const bounds = dayBounds(rule, tz);
  if (!bounds) return "false";
  const parts = [`exists ${r}`];
  if (bounds.from !== undefined) parts.push(`${r} >= ${timeLiteral(bounds.from)}`);
  if (bounds.to !== undefined) parts.push(`${r} < ${timeLiteral(bounds.to)}`);
  return `(${parts.join(" and ")})`;
}

/** The rules every row a condition keeps must meet: those not under an `or` (of more than one). */
export function requiredRules(c: SourceCondition): SourceFilter[] {
  if ("and" in c) return c.and.flatMap(requiredRules);
  if ("or" in c) return c.or.length === 1 ? requiredRules(c.or[0]) : [];
  return [c];
}

/** The range a measurement's filter on _time leaves to read (so InfluxDB reads only those days). */
export function rangeOf(filter: SourceCondition, tz: string): { start: string; stop: string } {
  let from = ALL_START_MS;
  let to = ALL_STOP_MS;
  for (const rule of requiredRules(filter)) {
    if (rule.column !== "_time") continue;
    const bounds = dayBounds(rule, tz);
    if (!bounds) continue;
    if (bounds.from !== undefined) from = Math.max(from, bounds.from);
    if (bounds.to !== undefined) to = Math.min(to, bounds.to);
  }
  // Nothing left: a range of its own still has to be one (the filters then match nothing).
  from = Math.min(from, ALL_STOP_MS - 1);
  if (to <= from) to = from + 1;
  return { start: timeLiteral(from), stop: timeLiteral(to) };
}

/** The conditions of a query (its filter's and / or tree, and search), or null for none. */
function whereFlux(query: SourceQuery, columns: Map<string, InfluxColumn>): string | null {
  const filter = conditionText(query.filter, (rule) => filterFlux(column(columns, rule.column), rule, query.timeZone), { and: "and", or: "or", all: "true", none: "false" });
  const conditions = filter === "true" ? [] : [filter];
  const needle = query.search.trim();
  if (needle) {
    const searched = query.columns.map((name) => `${textOf(column(columns, name))} =~ ${fluxRegex(needle)}`);
    conditions.push(searched.length ? `(${searched.join(" or ")})` : "false");
  }
  return conditions.length ? conditions.join(" and ") : null;
}

/** A script with the query's range, filters and search. */
function filtered(query: SourceQuery, columns: Map<string, InfluxColumn>): { script: Script; pipeline: string[] } {
  const script = new Script(query.target, columns, "table" in query.target ? rangeOf(query.filter, query.timeZone) : undefined);
  const where = whereFlux(query, columns);
  return { script, pipeline: where ? [`filter(fn: (r) => ${where})`] : [] };
}

/** The group a row is in, as text ("" for none); a date & time by the start of its day (`groupKey` makes it the day). */
function groupFlux(c: InfluxColumn, script: Script, tz: string): string {
  const r = ref(c.name);
  switch (c.read) {
    case "number":
      return `(if exists ${r} then string(v: float(v: ${r})) else "")`;
    case "bool":
      return `(if exists ${r} then (if ${r} then "yes" else "no") else "")`;
    case "time":
      formatIn(tz);
      script.need("date");
      script.need("timezone");
      return `(if exists ${r} then string(v: date.truncate(t: ${r}, unit: 1d, location: timezone.location(name: ${fluxString(tz)}))) else "")`;
    default:
      return textOf(c);
  }
}

/** A group's key as the app shows it (SourceRow.group): numbers as numbers, a date & time as its day. */
export function groupKey(c: InfluxColumn, raw: string, tz: string): string {
  if (raw === "") return "";
  if (c.read === "number") return String(Number(raw));
  if (c.read === "time") {
    const at = Date.parse(raw.replace(/(\.\d{3})\d+/, "$1"));
    return Number.isNaN(at) ? raw : dayIn(at, tz);
  }
  return raw;
}

/** A group's value, comparable (for ordering groups by value). */
function groupValueFlux(c: InfluxColumn): string {
  const r = ref(c.name);
  switch (c.read) {
    case "number":
      return `(if exists ${r} then float(v: ${r}) else 0.0)`;
    case "bool":
      return `(if exists ${r} and ${r} then 0 else 1)`;
    case "time":
      return `(if exists ${r} then int(v: ${r}) else 0)`;
    default:
      return "r._kubus_g";
  }
}

const checkPage = (query: SourceQuery) => {
  if (!Number.isInteger(query.offset) || query.offset < 0) throw new SourceError("offset must be a whole number");
  if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > MAX_SOURCE_PAGE) throw new SourceError(`limit must be 1 to ${MAX_SOURCE_PAGE}`);
};

/**
 * The groups of a grouped query (its key `_kubus_g` and size `_kubus_n`), in order: the empty one
 * last, then by size (largest first) or by value either way. Asked for every page of a grouped
 * query: the rows are ordered by their group's place in it.
 */
export function groupsFlux(query: SourceQuery, columns: Map<string, InfluxColumn>): string {
  const group = column(columns, query.groupBy ?? "");
  const { script, pipeline } = filtered(query, columns);
  const key = groupFlux(group, script, query.timeZone);
  // Flux sorts all columns one way: the empty group's marker is turned to fall last either way.
  const desc = query.groupOrder !== "asc";
  const empty = desc ? `(if r._kubus_g == "" then 0 else 1)` : `(if r._kubus_g == "" then 1 else 0)`;
  return script.render([
    ...pipeline,
    `map(fn: (r) => ({r with _kubus_g: ${key}}))`,
    `map(fn: (r) => ({_kubus_g: r._kubus_g, _kubus_v: ${groupValueFlux(group)}, _kubus_n: 1}))`,
    `group(columns: ["_kubus_g", "_kubus_v"])`,
    `sum(column: "_kubus_n")`,
    `group()`,
    `map(fn: (r) => ({r with _kubus_e: ${empty}}))`,
    `sort(columns: ${JSON.stringify(["_kubus_e", ...(query.groupOrder === "count" ? ["_kubus_n"] : []), "_kubus_v"])}, desc: ${desc})`,
    `limit(n: ${MAX_SOURCE_GROUPS})`,
    `keep(columns: ["_kubus_g", "_kubus_n"])`,
  ]);
}

/**
 * The total of a query's rows (`_kubus_n`). The 1 is added to the row (`r with`): a map whose
 * record doesn't read `r` gives no rows at all (InfluxDB 2.7), and the sum of none is null.
 */
export function totalFlux(query: SourceQuery, columns: Map<string, InfluxColumn>): string {
  const { script, pipeline } = filtered(query, columns);
  return script.render([...pipeline, `keep(columns: ["_time"])`, `map(fn: (r) => ({r with _kubus_n: 1}))`, `sum(column: "_kubus_n")`]);
}

/**
 * A page of a query's rows: the key, the asked columns and (grouped) `_kubus_g`. `groups` are the
 * groups' keys in order (groupsFlux): a row is placed by its group's. Flux sorts all columns one
 * way: numbers, times and checkboxes sorted the other way are negated; text sorts the way of the
 * first text sort (a second one asked the other way can't be: a known limit).
 */
export function rowsFlux(query: SourceQuery, columns: Map<string, InfluxColumn>, groups: string[] = []): string {
  checkPage(query);
  column(columns, query.key);
  for (const name of query.columns) column(columns, name);
  const { script, pipeline } = filtered(query, columns);
  const textual = (s: SourceQuery["sort"][number]) => s.column === TITLE_COLUMN || column(columns, s.column).read === "string" || column(columns, s.column).read === "duration";
  const desc = (query.sort.find(textual) ?? query.sort[0])?.direction === "desc";
  const added: string[] = [];
  const order: string[] = [];
  if (query.groupBy) {
    const group = column(columns, query.groupBy);
    pipeline.push(`map(fn: (r) => ({r with _kubus_g: ${groupFlux(group, script, query.timeZone)}}))`);
    if (groups.length) {
      script.need("dict");
      script.statements.push(`_kubus_groups = dict.fromList(pairs: [${groups.map((g, i) => `{key: ${fluxString(g)}, value: ${i}}`).join(", ")}])`);
      const place = `dict.get(dict: _kubus_groups, key: r._kubus_g, default: ${groups.length})`;
      added.push(`_kubus_r: ${desc ? `0 - ${place}` : place}`);
      order.push("_kubus_r");
    }
  }
  query.sort.forEach((s, i) => {
    let text: string;
    let value: string;
    if (s.column === TITLE_COLUMN) {
      script.need("strings");
      text = titleFlux(query, columns);
      value = `strings.toLower(v: ${text})`;
    } else {
      const c = column(columns, s.column);
      if (c.plain) throw new SourceError(`“${c.name}” can't be sorted`);
      const r = ref(c.name);
      const flip = (s.direction === "desc") !== desc;
      text = textOf(c);
      switch (c.read) {
        case "number":
          value = `(if exists ${r} then ${flip ? "0.0 - " : ""}float(v: ${r}) else 0.0)`;
          break;
        case "time":
          value = `(if exists ${r} then ${flip ? "0 - " : ""}int(v: ${r}) else 0)`;
          break;
        case "bool":
          value = `(if exists ${r} and ${r} then ${flip ? -1 : 1} else 0)`;
          break;
        default:
          script.need("strings");
          value = `strings.toLower(v: ${text})`;
      }
    }
    // Empty values last both ways.
    added.push(`_kubus_e${i}: (if ${text} == "" then ${desc ? 0 : 1} else ${desc ? 1 : 0})`, `_kubus_s${i}: ${value}`);
    order.push(`_kubus_e${i}`, `_kubus_s${i}`);
  });
  order.push(query.key);
  if (added.length) pipeline.push(`map(fn: (r) => ({r with ${added.join(", ")}}))`);
  const kept = [...new Set([query.key, ...query.columns, ...(query.groupBy ? ["_kubus_g"] : [])])];
  return script.render([
    ...pipeline,
    `sort(columns: ${JSON.stringify(order)}, desc: ${desc})`,
    `limit(n: ${query.limit + 1}, offset: ${query.offset})`,
    `keep(columns: ${JSON.stringify(kept)})`,
  ]);
}

/**
 * A page of a measurement's rows by time (newest or oldest first), not grouped. Read as asked it pivots,
 * sorts and counts every row of the range (all history without a `_time` filter) for a page of 100, so the
 * connector reads it from the nearest point's day (`nearestFlux`) and more days only while they hold less
 * than the page (`pageDays`), and counts with `countFlux` where it can.
 */
export function isTimeOrdered(query: SourceQuery): boolean {
  return "table" in query.target && !query.groupBy && query.sort.length === 1 && query.sort[0].column === "_time";
}

/** Whether a filter holds only rules on `_time`, all of them required (no `or`): a range alone. */
function timeOnly(c: SourceCondition): boolean {
  if ("and" in c) return c.and.every(timeOnly);
  if ("or" in c) return c.or.length === 1 && timeOnly(c.or[0]);
  return c.column === "_time" && ["is", "between", "before", "after"].includes(c.operator);
}

/**
 * The rows of a measurement in a query's range, counted by InfluxDB from its index (`count()`, not a pivot
 * of every row): per series the most points of any of its fields (a row is a series' moment; fields written
 * together, as usual, have one each), added up. Null when the filter or search needs the rows themselves.
 */
export function countFlux(query: SourceQuery, columns: Map<string, InfluxColumn>): string | null {
  if (!("table" in query.target) || query.search.trim() || !timeOnly(query.filter)) return null;
  const { schema, name } = query.target.table;
  const range = rangeOf(query.filter, query.timeZone);
  const tags = [...columns.values()].filter((c) => c.tag).map((c) => c.name);
  return `from(bucket: ${fluxString(schema ?? "")})
  |> range(start: ${range.start}, stop: ${range.stop})
  |> filter(fn: (r) => r._measurement == ${fluxString(name)})
  |> count()
  |> group(columns: ${JSON.stringify(tags)})
  |> max()
  |> group()
  |> sum()
  |> rename(columns: {_value: "_kubus_n"})`;
}

/** The moment (`_time`) of the measurement's latest (desc) or earliest point in the query's range, any field's. */
export function nearestFlux(query: SourceQuery, direction: "asc" | "desc"): string {
  if (!("table" in query.target)) throw new SourceError("Only a measurement is read by time");
  const { schema, name } = query.target.table;
  const range = rangeOf(query.filter, query.timeZone);
  const desc = direction === "desc";
  return `from(bucket: ${fluxString(schema ?? "")})
  |> range(start: ${range.start}, stop: ${range.stop})
  |> filter(fn: (r) => r._measurement == ${fluxString(name)})
  |> ${desc ? "last" : "first"}()
  |> group()
  |> ${desc ? "max" : "min"}(column: "_time")
  |> keep(columns: ["_time"])`;
}

/**
 * The days read for a page by time whose nearest point is at `at`: that point's day and the `days` before it
 * (desc) or after it, in the time zone; the query's filter then picks the rows (its other rules may leave
 * fewer than the page: more days are read then).
 */
export function pageDays(at: string, direction: "asc" | "desc", days: number, timeZone: string): SourceFilter {
  const day = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(Date.parse(at));
  const shifted = new Date(Date.parse(`${day}T00:00:00Z`) + (direction === "desc" ? -days : days) * 86_400_000).toISOString().slice(0, 10);
  return { column: "_time", operator: "between", value: direction === "desc" ? `${shifted}..${day}` : `${day}..${shifted}` };
}

/** The title: the first title column that isn't blank, else `untitled`. */
function titleFlux(shape: SourceShape, columns: Map<string, InfluxColumn>): string {
  let title = fluxString(shape.untitled);
  for (const name of [...shape.title].reverse()) {
    const text = textOf(column(columns, name));
    title = `(if strings.trimSpace(v: ${text}) != "" then ${text} else ${title})`;
  }
  return title;
}

/** One row by its key: a measurement's `_id` or `_time` reads only that moment. Null when the key can't name a row. */
export function rowFlux(shape: SourceShape & { keyValue: string }, columns: Map<string, InfluxColumn>): string | null {
  const key = column(columns, shape.key);
  for (const name of shape.columns) column(columns, name);
  let range: { start: string; stop: string } | undefined;
  let where: string;
  if ("table" in shape.target && (key.name === ID_COLUMN || key.name === "_time")) {
    const nanos = nanosOf(key.name === ID_COLUMN ? shape.keyValue.split(",")[0] : shape.keyValue);
    if (nanos === null) return null;
    range = { start: `time(v: ${nanos})`, stop: `time(v: ${nanos + 1n})` };
    where = key.name === ID_COLUMN ? `r.${ID_COLUMN} == ${fluxString(shape.keyValue)}` : `r._time == time(v: ${nanos})`;
  } else {
    where = `(exists ${ref(key.name)} and string(v: ${ref(key.name)}) == ${fluxString(shape.keyValue)})`;
  }
  return new Script(shape.target, columns, range).render([`filter(fn: (r) => ${where})`, "limit(n: 1)", `keep(columns: ${JSON.stringify([...new Set([shape.key, ...shape.columns])])})`]);
}

/** A query's first rows: what its columns are read from. */
export function sampleFlux(target: SourceTarget & { query: string }): string {
  return new Script(target, new Map()).render(["limit(n: 100)"]);
}
