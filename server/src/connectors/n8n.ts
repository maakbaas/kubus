import type { SourceColumn, SourceDescription, SourceQuery, SourceResult, SourceRow, SourceRowRequest, SourceTable, SourceTarget } from "../../../shared/sources.ts";
import { SourceError, type Connector, type SourceConfig } from "./connector.ts";
import { findRow, queryRows, type MemoryRow } from "./memory.ts";

// n8n's data tables, read-only, through n8n's public API (/api/v1/data-tables, header
// X-N8N-API-KEY). The connection string is n8n://host[:port][/path] (https) or
// n8n+http://host:5678 (plain http, e.g. on the same machine); the password is the API key. Its
// only requests are GETs (`get`): it never writes, whatever the key could do. Give it a key with
// only the read scopes (dataTable:list, dataTableRow:read) where n8n offers scopes.
//
// The API filters with one flat and / or list, sorts by one column and doesn't count, so a table is
// read whole (a page of 250 at a time, by id) and queried in memory (memory.ts); a read is kept a
// few seconds, so a view's pages and counts come from one read. n8n caps a data table's size, so
// tables stay small; MAX_ROWS bounds one anyway. There is no query language: tables only.

const PAGE = 250;
/** The most rows a table may have to be read. */
const MAX_ROWS = 100_000;
/** How long a table's rows are kept (one view's pages, its counts, its item pages). */
const ROWS_TTL_MS = 5_000;
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

/** The API's address and key from a connection string (n8n://:key@host/path). */
export function n8nEndpoint(url: string): { base: string; key: string } {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new SourceError("The connection string isn't a URL (n8n://n8n.example.com)");
  }
  const scheme = u.protocol === "n8n+http:" ? "http" : "https";
  const path = u.pathname.replace(/\/+$/, "");
  return { base: `${scheme}://${u.host}${path}/api/v1`, key: decodeURIComponent(u.password) };
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

export class N8nConnector implements Connector {
  readonly kind = "n8n";
  readonly capabilities = { query: false };
  private config: SourceConfig;
  private endpoint: { base: string; key: string };
  private tableList: { at: number; tables: Promise<Map<string, N8nTable>> } | null = null;
  private rows = new Map<string, { at: number; rows: Promise<MemoryRow[]> }>();

  constructor(config: SourceConfig) {
    this.config = config;
    this.endpoint = n8nEndpoint(config.url);
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

  private async rowsOf(table: N8nTable): Promise<{ rows: MemoryRow[]; columns: Map<string, SourceColumn> }> {
    const columns = n8nColumns(table);
    const cached = this.rows.get(table.id);
    if (!cached || Date.now() - cached.at >= ROWS_TTL_MS) {
      const rows = this.all<Record<string, unknown>>(`/data-tables/${encodeURIComponent(table.id)}/rows`, { sortBy: "id:asc" }, MAX_ROWS).then((raw) =>
        raw.map((r) => n8nRow(r, columns)),
      );
      rows.catch(() => this.rows.delete(table.id));
      this.rows.set(table.id, { at: Date.now(), rows });
    }
    return { rows: await this.rows.get(table.id)!.rows, columns: new Map(columns.map((c) => [c.name, c])) };
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
    const { rows, columns } = await this.rowsOf(await this.table(query.target));
    return queryRows(rows, columns, query);
  }

  async row(request: SourceRowRequest): Promise<SourceRow | null> {
    const { rows, columns } = await this.rowsOf(await this.table(request.target));
    return findRow(rows, columns, request);
  }

  async close() {
    this.rows.clear();
    this.tableList = null;
  }
}
