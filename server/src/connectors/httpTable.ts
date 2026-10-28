import type { SourceColumn, SourceDescription, SourceQuery, SourceResult, SourceRow, SourceRowRequest, SourceTable, SourceTarget, SourceValue } from "../../../shared/sources.ts";
import { SourceError, type Connector, type SourceConfig } from "./connector.ts";
import { documentAddress, fetchDocument, MAX_DOCUMENT_BYTES, nextLink, withSecret, type HttpDocument } from "./httpDocument.ts";
import { findRow, queryRows, type MemoryRow } from "./memory.ts";

// One table read from a document over HTTP (json.ts, csv.ts): one per source, its rows the
// document's (and its next pages', by `Link: rel="next"`), queried in memory (memory.ts). The
// columns are inferred from the values (`inferColumn`): numbers, checkboxes, dates, dates & times,
// lists of strings, else text (nested JSON as hidden plain text). The key is a column `id`, `uuid`
// or `key` with a different value in every row, else the row's place (`_row`: a row's page and links
// to it change when rows are added above it; `check` warns). The password goes in the address's
// `{secret}`, else under the query parameter or header set, else as `Authorization: Bearer`; only
// to the address's own origin. Only GETs (httpDocument.ts). Pure parts exported and tested
// (server/test/connectors/json.test.ts, csv.test.ts).

/** The most rows a source may have to be read. */
export const MAX_ROWS = 100_000;
/** The most pages read (by `Link: rel="next"`). */
export const MAX_PAGES = 100;
/** The column of a row's place (1, 2, …), the key when no column is one. */
export const ROW_COLUMN = "_row";

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/i;
// Numbers as text: no leading zeros (codes, postcodes), no "+" (phone numbers), at most 15 digits (ids lose digits beyond).
const NUMBER = /^-?(0|[1-9]\d*)(\.\d+)?([eE][-+]?\d+)?$/;
const COMMA_NUMBER = /^-?(0|[1-9]\d*)(,\d+)?$/;
const BOOLEAN = /^(true|false)$/i;

/** A column and how a document's value becomes its value. */
export interface HttpColumn extends SourceColumn {
  value: (v: unknown) => SourceValue;
}

/** How values are inferred: `text` when every value is text (CSV), `decimalComma` when "1,5" may be a number there. */
export interface InferOptions {
  text?: boolean;
  decimalComma?: boolean;
}

const scalar = (v: unknown) => typeof v === "string" || typeof v === "number" || typeof v === "boolean";
const json = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));
const digits = (s: string) => s.replace(/[^\d]/g, "").replace(/^0+/, "").length;

/** A date & time as the app stores it (ISO 8601 UTC; one without a zone taken as UTC), or null. */
export function isoOf(v: unknown): string | null {
  if (typeof v !== "string" || !DATETIME.test(v.trim())) return null;
  const t = v.trim().replace(" ", "T");
  const ms = Date.parse(/(Z|[+-]\d{2}:?\d{2})$/i.test(t) ? t : `${t}Z`);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** A column's field type from all its values (null, undefined and empty text don't count). */
export function inferColumn(name: string, values: unknown[], options: InferOptions = {}): HttpColumn {
  const present = values.filter((v) => v !== null && v !== undefined && !(typeof v === "string" && v.trim() === ""));
  const every = (test: (v: unknown) => boolean) => present.length > 0 && present.every(test);
  const strings = every((v) => typeof v === "string");
  const trimmed = (v: unknown) => String(v).trim();
  const empty = (v: unknown) => v === null || v === undefined || (typeof v === "string" && v.trim() === "");
  if (every((v) => typeof v === "number")) return { name, type: "number", kind: "number", value: (v) => (typeof v === "number" && Number.isFinite(v) ? v : null) };
  if (every((v) => typeof v === "boolean")) return { name, type: "boolean", kind: "checkbox", value: (v) => (typeof v === "boolean" ? v : null) };
  if (strings && options.text) {
    if (every((v) => BOOLEAN.test(trimmed(v)))) return { name, type: "boolean", kind: "checkbox", value: (v) => (empty(v) ? null : trimmed(v).toLowerCase() === "true") };
    if (every((v) => NUMBER.test(trimmed(v)) && digits(trimmed(v)) <= 15)) return { name, type: "number", kind: "number", value: (v) => (empty(v) ? null : Number(trimmed(v))) };
    // Decimal commas only when the delimiter isn't a comma and no value has a dot: "1,5" is then one and a half.
    if (options.decimalComma && every((v) => COMMA_NUMBER.test(trimmed(v)) && digits(trimmed(v)) <= 15) && present.some((v) => String(v).includes(",")))
      return { name, type: "number", kind: "number", value: (v) => (empty(v) ? null : Number(trimmed(v).replace(",", "."))) };
  }
  if (strings && every((v) => DAY.test(trimmed(v)))) return { name, type: "date", kind: "date", value: (v) => (typeof v === "string" && DAY.test(v.trim()) ? v.trim() : null) };
  if (strings && every((v) => isoOf(v) !== null)) return { name, type: "datetime", kind: "datetime", value: isoOf };
  if (every((v) => Array.isArray(v) && v.every((x) => x === null || scalar(x))))
    return { name, type: "list", kind: "string_list", value: (v) => (Array.isArray(v) ? v.filter((x) => x !== null).map(String) : null) };
  if (present.some((v) => typeof v === "object")) return { name, type: "json", kind: "string", plain: true, hidden: true, value: (v) => (v === null || v === undefined ? null : json(v)) };
  return { name, type: "text", kind: "string", value: (v) => (v === null || v === undefined || (options.text && v === "") ? null : json(v)) };
}

/** Records as a table: columns in the order they first appear, rows, the key column and what to warn about. */
export function tableOf(records: Record<string, unknown>[], options: InferOptions = {}): { columns: HttpColumn[]; rows: MemoryRow[]; key: string; warnings: string[] } {
  if (records.length > MAX_ROWS) throw new Error(`More than ${MAX_ROWS.toLocaleString("en")} rows: too many for a source to read`);
  const names = new Set<string>();
  for (const r of records) for (const name of Object.keys(r)) names.add(name);
  const columns = [...names].map((name) => inferColumn(name, records.map((r) => r[name]), options));
  const rows = records.map((r) => Object.fromEntries(columns.map((c) => [c.name, c.value(r[c.name])])) as MemoryRow);
  const keyed = ["id", "uuid", "key"].flatMap((k) => columns.filter((c) => c.name.toLowerCase() === k && c.kind !== "string_list" && !c.plain));
  const key = keyed.find((c) => {
    const seen = new Set<string>();
    for (const row of rows) {
      const v = row[c.name];
      if (v === null || v === "" || seen.has(String(v))) return false;
      seen.add(String(v));
    }
    return true;
  });
  if (key) return { columns, rows, key: key.name, warnings: [] };
  let place = ROW_COLUMN;
  while (names.has(place)) place = `_${place}`;
  columns.push({ name: place, type: "place", kind: "number", hidden: true, value: (v) => v as number });
  rows.forEach((row, i) => (row[place] = i + 1));
  const warnings = [
    `No column id, uuid or key has a value of its own in every row: rows are told apart by their place (${place}), so a row's page and links to it change when rows are added or removed above it`,
  ];
  return { columns, rows, key: place, warnings };
}

/** A header name as HTTP allows one (a token). */
const HEADER = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** Where a source's document is read and how its password goes: in the address's {secret}, else the query parameter, the header, or Bearer. */
export function httpRequest(fields: Record<string, string>, password: string): { url: URL; headers: Record<string, string>; param: string } {
  const typed = documentAddress(fields.address ?? "");
  const param = (fields.param ?? "").trim();
  const header = (fields.header ?? "").trim();
  if (header && !HEADER.test(header)) throw new SourceError(`“${header}” isn't a header name`);
  const headers: Record<string, string> = {};
  if (/\{secret\}|%7Bsecret%7D/i.test(typed.toString())) {
    if (!password) throw new SourceError("The address has a {secret}, but the source has no password to put there");
    return { url: new URL(withSecret(typed, password)), headers, param: "" };
  }
  if (password && param) typed.searchParams.set(param, password);
  else if (password && header) headers[header] = password;
  else if (password) headers.Authorization = `Bearer ${password}`;
  return { url: typed, headers, param: password ? param : "" };
}

/** What a kind adds: what it reads, which content types, its table's name and how a document becomes records. */
export interface HttpTableKind {
  kind: string;
  what: string;
  accepts: (contentType: string) => boolean;
  table: string;
  records: (doc: HttpDocument) => { records: Record<string, unknown>[]; options?: InferOptions };
}

type Table = ReturnType<typeof tableOf>;

export class HttpTableConnector implements Connector {
  readonly kind: string;
  private config: SourceConfig;
  private spec: HttpTableKind;
  private request: ReturnType<typeof httpRequest>;
  /** The table of the last read, kept while the documents are the same (fetchDocument keeps them a minute). */
  private last: { docs: HttpDocument[]; table: Table } | null = null;

  constructor(config: SourceConfig, spec: HttpTableKind) {
    this.config = config;
    this.spec = spec;
    this.kind = spec.kind;
    this.request = httpRequest(config.fields, config.password);
  }

  /** The documents: the address's, then each next page's (the password only to the address's origin). */
  private async documents(): Promise<HttpDocument[]> {
    const { url, headers, param } = this.request;
    const docs: HttpDocument[] = [];
    const seen = new Set<string>();
    let next: string | null = url.toString();
    let bytes = 0;
    while (next && !seen.has(next)) {
      if (docs.length === MAX_PAGES) throw new Error(`More than ${MAX_PAGES} pages: too many for a source to read`);
      seen.add(next);
      const at = new URL(next);
      const own = at.origin === url.origin;
      if (own && param && !at.searchParams.has(param)) at.searchParams.set(param, url.searchParams.get(param) ?? "");
      const doc = await fetchDocument(at, { headers: own ? headers : {}, timeoutMs: this.config.timeoutMs, what: this.spec.what, accepts: this.spec.accepts });
      bytes += doc.bytes.length;
      if (bytes > MAX_DOCUMENT_BYTES) throw new Error(`The pages are larger than ${Math.round(MAX_DOCUMENT_BYTES / 1024 / 1024)} MB in all, more than a source reads`);
      docs.push(doc);
      next = nextLink(doc);
    }
    return docs;
  }

  private async read(): Promise<Table> {
    const docs = await this.documents();
    if (this.last && this.last.docs.length === docs.length && this.last.docs.every((d, i) => d === docs[i])) return this.last.table;
    const parts = docs.map((doc) => this.spec.records(doc));
    const table = tableOf(parts.flatMap((p) => p.records), parts[0]?.options);
    this.last = { docs, table };
    return table;
  }

  /** The one table, by any name (a collection reads on when "Rows at" changes its name). */
  private async table(target: SourceTarget): Promise<Table> {
    if ("query" in target) throw new SourceError(`${this.config.name} is read as its one table (${this.spec.what} has no query language)`);
    if (target.table.schema !== null) throw new SourceError(`${this.config.name} has no table “${target.table.schema}.${target.table.name}”`);
    return this.read();
  }

  async check(): Promise<string[]> {
    return (await this.read()).warnings;
  }

  async tables(): Promise<SourceTable[]> {
    return [{ schema: null, name: this.spec.table, type: "table" }];
  }

  async describe(target: SourceTarget): Promise<SourceDescription> {
    const { columns, key } = await this.table(target);
    return { columns: columns.map(({ value: _v, ...c }) => c), key: [key], dropped: [] };
  }

  async query(query: SourceQuery): Promise<SourceResult> {
    const { columns, rows } = await this.table(query.target);
    return queryRows(rows, new Map(columns.map((c) => [c.name, c])), query);
  }

  async row(request: SourceRowRequest): Promise<SourceRow | null> {
    const { columns, rows } = await this.table(request.target);
    return findRow(rows, new Map(columns.map((c) => [c.name, c])), request);
  }

  async close() {
    this.last = null;
  }
}
