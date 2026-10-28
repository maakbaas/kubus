import type { SourceColumn, SourceDescription, SourceFilter, SourceQuery, SourceResult, SourceRow, SourceRowRequest, SourceTable, SourceTarget } from "../../../shared/sources.ts";
import { SourceError, type Connector, type SourceConfig } from "./connector.ts";
import { addressOf } from "./kinds.ts";
import { dayStart, requiredRules } from "./influxFlux.ts";
import { findRow, queryRows, type MemoryRow } from "./memory.ts";

// n8n's data tables, read-only, through n8n's public API (/api/v1/data-tables, header
// X-N8N-API-KEY). Its field is n8n's address (https://host[:port][/path], or
// http://host:5678, e.g. on the same machine); the password is the API key. Its
// only requests are GETs (`get`): it never writes, whatever the key could do. Give it a key with
// only the read scopes (dataTable:list, dataTableRow:read) where n8n offers scopes.
//
// The API filters with one flat and / or list, sorts by one column and doesn't count, so the rows
// a query could keep are read (a page of 250 at a time, by id) and queried in memory (memory.ts):
// n8n is sent the rules every kept row meets (`n8nFilter`, looser where n8n compares differently)
// and the search where it can, memory.ts then filters exactly. A read is kept a few seconds, so a
// view's pages and counts come from one read. n8n caps a data table's size, so tables stay small;
// MAX_ROWS bounds one anyway. There is no query language: tables only.

const PAGE = 250;
/** The most rows a table may have to be read. */
const MAX_ROWS = 100_000;
/** How long a read is kept (one view's pages, its counts, its item pages). */
const ROWS_TTL_MS = 5_000;
const DAY_MS = 86_400_000;
/** How long the list of tables (and so their columns) is kept. */
const TABLES_TTL_MS = 60_000;

/** A column as n8n's API describes it. */
interface N8nColumn {
  name: string;
  type: string;
  index: number;
}
interface N8nTable {
  id: string;
  name: string;
  projectId: string;
  columns: N8nColumn[];
}
interface Page<T> {
  data: T[];
  nextCursor: string | null;
}

/** The API's root from n8n's address (https:// unless it says http://). */
export function n8nEndpoint(address: string): string {
  let u: URL;
  try {
    u = addressOf(address, true);
  } catch {
    throw new SourceError("The address isn't one (https://n8n.example.com)");
  }
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}/api/v1`;
}

/** A column of n8n's types (string, number, boolean, date) as the app reads it. */
export function n8nColumn(c: { name: string; type: string }): SourceColumn {
  switch (c.type) {
    case "number":
      return { name: c.name, type: c.type, kind: "number" };
    case "boolean":
      return { name: c.name, type: c.type, kind: "checkbox" };
    case "date":
      return { name: c.name, type: c.type, kind: "datetime" };
    default:
      return { name: c.name, type: c.type, kind: "string" };
  }
}

/** Every table's columns: its own in order, then n8n's (id, createdAt, updatedAt). */
export function n8nColumns(table: { columns: N8nColumn[] }): SourceColumn[] {
  const own = [...table.columns].sort((a, b) => a.index - b.index).map(n8nColumn);
  return [
    ...own,
    { name: "id", type: "id", kind: "number" },
    { name: "createdAt", type: "date", kind: "datetime" },
    { name: "updatedAt", type: "date", kind: "datetime" },
  ];
}

/** A row from the API as the app stores values (dates & times as ISO 8601 UTC). */
export function n8nRow(raw: Record<string, unknown>, columns: SourceColumn[]): MemoryRow {
  const row: MemoryRow = {};
  for (const c of columns) {
    const v = raw[c.name];
    if (v === null || v === undefined) row[c.name] = null;
    else if (c.kind === "number") row[c.name] = typeof v === "number" ? v : Number.isFinite(Number(v)) ? Number(v) : null;
    else if (c.kind === "checkbox") row[c.name] = v === true || v === "true" || v === 1;
    else if (c.kind === "datetime") {
      const t = Date.parse(String(v));
      row[c.name] = Number.isNaN(t) ? null : new Date(t).toISOString();
    } else row[c.name] = typeof v === "string" ? v : JSON.stringify(v);
  }
  return row;
}

/** A rule as n8n's API filters rows (`filter={"type":"and","filters":[…]}`). */
export interface N8nRule {
  columnName: string;
  condition: "eq" | "neq" | "ilike" | "gt" | "gte" | "lt" | "isEmpty" | "isNotEmpty";
  value: string | number | null;
}

/** What a read asks n8n for: rules all rows meet, and a search ("" for none). */
interface N8nRead {
  filters: N8nRule[];
  search: string;
}

/**
 * Text n8n matches as the app does: printable ASCII (n8n's SQLite UPPER folds only ASCII, so other
 * letters could miss rows the app finds).
 */
const ASCII = /^[\x20-\x7e]+$/;

/** An ilike containing the text. n8n wraps a value without % itself; a % in the text is a wildcard there (more rows, never fewer). */
const containing = (text: string) => `%${text}%`;

/**
 * One filter rule as n8n's rules, keeping at least every row the rule keeps (memory.ts then
 * filters exactly), or null when n8n can't narrow it. Dates: n8n on SQLite stores
 * "yyyy-mm-dd hh:mm:ss" but compares it as text with the ISO time it is sent ("…T…Z"), so on the
 * bound's own UTC day a stored time is always less: an upper bound then keeps that day (more rows),
 * a lower bound is moved to the start of the UTC day before (exact on Postgres, looser on both).
 */
export function n8nRules(c: SourceColumn, rule: SourceFilter, timeZone: string): N8nRule[] | null {
  const value = rule.value.trim();
  const op = rule.operator;
  const r = (condition: N8nRule["condition"], v: N8nRule["value"]): N8nRule => ({ columnName: c.name, condition, value: v });
  if (c.kind === "string") {
    if (op === "isEmpty" || op === "isNotEmpty") return [r(op, null)];
    if ((op === "contains" || op === "is") && ASCII.test(value)) return [r("ilike", containing(value))];
    return null;
  }
  if (c.kind === "number") {
    if (op === "isEmpty") return [r("eq", null)];
    if (op === "isNotEmpty") return [r("neq", null)];
    const n = Number(value);
    if (value === "" || !Number.isFinite(n)) return null;
    const condition = ({ is: "eq", isNot: "neq", gt: "gt", lt: "lt" } as const)[op as "is" | "isNot" | "gt" | "lt"];
    return condition ? [r(condition, n)] : null;
  }
  if (c.kind !== "datetime") return null;
  if (op === "isEmpty") return [r("eq", null)];
  if (op === "isNotEmpty") return [r("neq", null)];
  const DAY = /^\d{4}-\d{2}-\d{2}$/;
  let from: number | undefined;
  let to: number | undefined;
  if (op === "between") {
    const [start, end] = value.split("..");
    if (!DAY.test(start ?? "") || !DAY.test(end ?? "")) return null;
    [from, to] = [dayStart(start, timeZone), dayStart(end, timeZone, 1)];
  } else if (DAY.test(value) && (op === "is" || op === "before" || op === "after")) {
    if (op !== "before") from = dayStart(value, timeZone, op === "after" ? 1 : 0);
    if (op !== "after") to = dayStart(value, timeZone, op === "is" ? 1 : 0);
  } else return null;
  const rules: N8nRule[] = [];
  if (from !== undefined) rules.push(r("gte", new Date(Math.floor(from / DAY_MS) * DAY_MS - DAY_MS).toISOString()));
  if (to !== undefined) rules.push(r("lt", new Date(to).toISOString()));
  return rules;
}

/** What to ask n8n for a query: its required rules n8n can narrow by, and its search where n8n's finds at least the same rows. */
export function n8nRead(query: Pick<SourceQuery, "filter" | "search" | "columns" | "timeZone">, columns: Map<string, SourceColumn>): N8nRead {
  const filters = requiredRules(query.filter).flatMap((rule) => {
    const c = columns.get(rule.column);
    return (c && n8nRules(c, rule, query.timeZone)) ?? [];
  });
  // n8n looks in every one of the table's own columns as text, so it finds at least what the app
  // does in its text columns; a % there would be a pattern rather than text.
  const needle = query.search.trim();
  const search = needle && ASCII.test(needle) && !needle.includes("%") && query.columns.every((name) => columns.get(name)?.kind === "string") ? needle : "";
  return { filters, search };
}

export class N8nConnector implements Connector {
  readonly kind = "n8n";
  private config: SourceConfig;
  private endpoint: { base: string; key: string };
  private tableList: { at: number; tables: Promise<Map<string, N8nTable>> } | null = null;
  private rows = new Map<string, { at: number; rows: Promise<MemoryRow[]> }>();

  constructor(config: SourceConfig) {
    this.config = config;
    this.endpoint = { base: n8nEndpoint(config.fields.address ?? ""), key: config.password };
  }

  /** One GET of the API (the only kind of request this connector makes). */
  private async get<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const query = new URLSearchParams(params).toString();
    let response: Response;
    try {
      response = await fetch(`${this.endpoint.base}${path}${query ? `?${query}` : ""}`, {
        method: "GET",
        headers: { accept: "application/json", "X-N8N-API-KEY": this.endpoint.key },
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch (e) {
      if ((e as Error).name === "TimeoutError") throw new SourceError("n8n took too long to answer (the source's time limit)");
      throw e;
    }
    if (!response.ok) {
      const message = await response.json().then((b: { message?: unknown }) => (typeof b?.message === "string" ? b.message : ""), () => "");
      const text = `n8n answered ${response.status}${message ? `: ${message}` : ""}`;
      // A request n8n finds wrong is the request's mistake; a refused key or a failing n8n is the source's.
      throw response.status === 400 || response.status === 404 ? new SourceError(text) : new Error(text);
    }
    return (await response.json()) as T;
  }

  /** Every page of a list. */
  private async all<T>(path: string, params: Record<string, string>, max: number): Promise<T[]> {
    const items: T[] = [];
    let cursor: string | null = null;
    do {
      const page: Page<T> = await this.get<Page<T>>(path, { ...params, limit: String(PAGE), ...(cursor && { cursor }) });
      items.push(...page.data);
      if (items.length > max) throw new SourceError(`More than ${max.toLocaleString("en")} rows: too many to read from n8n`);
      cursor = page.data.length ? page.nextCursor : null;
    } while (cursor);
    return items;
  }

  /** The tables offered, by the name the app shows (a name two projects share gets its id). */
  private tablesByName(): Promise<Map<string, N8nTable>> {
    if (this.tableList && Date.now() - this.tableList.at < TABLES_TTL_MS) return this.tableList.tables;
    const tables = this.all<N8nTable>("/data-tables", { sortBy: "name:asc" }, MAX_ROWS).then((list) => {
      const projects = this.config.schemas;
      const offered = projects.length ? list.filter((t) => projects.includes(t.projectId)) : list;
      const count = new Map<string, number>();
      for (const t of offered) count.set(t.name, (count.get(t.name) ?? 0) + 1);
      return new Map(offered.map((t) => [count.get(t.name)! > 1 ? `${t.name} (${t.id})` : t.name, t]));
    });
    tables.catch(() => (this.tableList = null));
    this.tableList = { at: Date.now(), tables };
    return tables;
  }

  private async table(target: SourceTarget): Promise<N8nTable> {
    if ("query" in target) throw new SourceError(`${this.config.name} is read by its tables only (n8n has no query language)`);
    const table = (await this.tablesByName()).get(target.table.name);
    if (!table || target.table.schema !== null) throw new SourceError(`${this.config.name} has no data table “${target.table.name}”`);
    return table;
  }

  /** The rows n8n has for a read (kept a moment, by table and read). */
  private async rowsOf(table: N8nTable, columns: SourceColumn[], read: N8nRead): Promise<MemoryRow[]> {
    const params: Record<string, string> = { sortBy: "id:asc" };
    if (read.filters.length) params.filter = JSON.stringify({ type: "and", filters: read.filters });
    if (read.search) params.search = read.search;
    const key = `${table.id} ${params.filter ?? ""} ${params.search ?? ""}`;
    const now = Date.now();
    for (const [k, c] of this.rows) if (now - c.at >= ROWS_TTL_MS) this.rows.delete(k);
    if (!this.rows.has(key)) {
      const rows = this.all<Record<string, unknown>>(`/data-tables/${encodeURIComponent(table.id)}/rows`, params, MAX_ROWS).then((raw) =>
        raw.map((r) => n8nRow(r, columns)),
      );
      rows.catch(() => this.rows.delete(key));
      this.rows.set(key, { at: now, rows });
    }
    return this.rows.get(key)!.rows;
  }

  async check(): Promise<string[]> {
    this.tableList = null;
    await this.tablesByName();
    return [];
  }

  async tables(): Promise<SourceTable[]> {
    this.tableList = null;
    return [...(await this.tablesByName()).keys()].map((name) => ({ schema: null, name, type: "table" }));
  }

  async describe(target: SourceTarget): Promise<SourceDescription> {
    this.tableList = null;
    const table = await this.table(target);
    return { columns: n8nColumns(table), key: ["id"], dropped: [] };
  }

  async query(query: SourceQuery): Promise<SourceResult> {
    const table = await this.table(query.target);
    const list = n8nColumns(table);
    const columns = new Map(list.map((c) => [c.name, c]));
    const read = n8nRead(query, columns);
    const sort = query.sort[0];
    if (query.limit === 1 && query.offset === 0 && !query.groupBy && query.sort.length === 1 && columns.get(sort.column)?.kind === "datetime") return this.nearest(table, list, columns, read, query);
    return queryRows(await this.rowsOf(table, list, read), columns, query);
  }

  /**
   * One row, the first by a date & time (an edge: server/src/sources.ts queryWithEdges): n8n's rows read
   * in that order, a page at a time, until the filter (exactly, in memory) keeps one; not every row.
   */
  private async nearest(table: N8nTable, list: SourceColumn[], columns: Map<string, SourceColumn>, read: N8nRead, query: SourceQuery): Promise<SourceResult> {
    const params: Record<string, string> = { sortBy: `${query.sort[0].column}:${query.sort[0].direction}`, limit: String(PAGE) };
    if (read.filters.length) params.filter = JSON.stringify({ type: "and", filters: read.filters });
    if (read.search) params.search = read.search;
    const rows: MemoryRow[] = [];
    let cursor: string | null = null;
    do {
      const page: Page<Record<string, unknown>> = await this.get<Page<Record<string, unknown>>>(`/data-tables/${encodeURIComponent(table.id)}/rows`, { ...params, ...(cursor && { cursor }) });
      rows.push(...page.data.map((r) => n8nRow(r, list)));
      const found = queryRows(rows, columns, query);
      if (found.rows.length) return { rows: found.rows, more: false };
      cursor = page.data.length && rows.length < MAX_ROWS ? page.nextCursor : null;
    } while (cursor);
    return { rows: [], more: false };
  }

  async row(request: SourceRowRequest): Promise<SourceRow | null> {
    const table = await this.table(request.target);
    const list = n8nColumns(table);
    // By id, n8n finds the one row.
    const filters: N8nRule[] = request.key === "id" && /^\d+$/.test(request.keyValue) ? [{ columnName: "id", condition: "eq", value: Number(request.keyValue) }] : [];
    return findRow(await this.rowsOf(table, list, { filters, search: "" }), new Map(list.map((c) => [c.name, c])), request);
  }

  async close() {
    this.rows.clear();
    this.tableList = null;
  }
}
