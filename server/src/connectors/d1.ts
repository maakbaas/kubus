import type { SourceDescription, SourceQuery, SourceResult, SourceRow, SourceRowRequest, SourceShape, SourceTable, SourceTarget, SourceValue } from "../../../shared/sources.ts";
import { SourceError, type Connector, type SourceConfig } from "./connector.ts";
import { d1Column, fromSql, ident, querySql, rowSql, type D1Column, type Statement } from "./d1Sql.ts";

// A Cloudflare D1 database (SQLite), read over Cloudflare's HTTP API by its account ID and
// database ID, the password an API token. Strictly read-only, though D1 has no read-only mode to ask for: only
// statements made here are sent (SELECT, and PRAGMA table_xinfo for a table's columns: `readOnly`
// refuses anything else), a written query is one statement (D1 would run several) inside a
// subquery, where SQLite allows nothing but a SELECT, and a statement D1 says changed the database
// is an error. The real protection is a token that can only read (D1 Read: docs/sync.md).

/** How long a target's columns are trusted before they are read again (a changed table). */
const COLUMNS_TTL_MS = 60_000;
/** Rows read to tell a column's field type when it has no declared type (a query's columns). */
const SAMPLE_ROWS = 200;
const API = "https://api.cloudflare.com/client/v4";

/** D1's answer to /raw: each statement's columns and rows (rows as arrays, in column order). */
interface RawResponse {
  success: boolean;
  errors?: { code?: number; message: string }[];
  result?: { success: boolean; results?: { columns?: string[]; rows?: unknown[][] }; meta?: { changed_db?: boolean; changes?: number } }[];
}

interface Rows {
  columns: string[];
  rows: unknown[][];
}

/** The only statements the connector sends: reading ones. */
function readOnly(sql: string): string {
  if (!/^(SELECT\s|PRAGMA table_xinfo\()/i.test(sql)) throw new Error("A D1 source is only read (a statement that doesn't read was refused)");
  return sql;
}

export class D1Connector implements Connector {
  readonly kind = "d1";
  private config: SourceConfig;
  private endpoint: string;
  private token: string;
  private columns = new Map<string, { at: number; columns: Promise<Map<string, D1Column>> }>();

  constructor(config: SourceConfig) {
    this.config = config;
    const { account, database } = config.fields;
    if (!account || !database) throw new SourceError("A D1 source needs its account ID and database ID");
    this.endpoint = `${API}/accounts/${encodeURIComponent(account)}/d1/database/${encodeURIComponent(database)}/raw`;
    this.token = config.password;
  }

  /** Runs one statement. */
  private async run(statement: Statement): Promise<Rows> {
    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
        body: JSON.stringify({ sql: readOnly(statement.sql), params: statement.params }),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch (e) {
      if ((e as Error).name === "TimeoutError") throw new SourceError("The query took too long (the source's time limit)");
      throw e;
    }
    const body = (await response.json().catch(() => null)) as RawResponse | null;
    const message = body?.errors?.map((e) => e.message).join("; ") || `${response.status} ${response.statusText}`;
    // 400 is the statement's own fault (D1's SQLite error, code 7500) unless Cloudflare says the Authorization
    // header isn't one (6003 / 6111: an empty or malformed token); anything else is the token or Cloudflare.
    if (response.status === 400 && !body?.errors?.some((e) => e.code === 6003 || e.code === 6111)) throw new SourceError(message);
    if (!response.ok || !body?.success) throw new Error(`Cloudflare: ${message}`);
    const result = body.result?.[0];
    if (result?.meta?.changed_db || (result?.meta?.changes ?? 0) > 0) {
      throw new Error("A statement changed the D1 database (it is only to be read): give the source a token with D1 Read only");
    }
    return { columns: result?.results?.columns ?? [], rows: result?.results?.rows ?? [] };
  }

  async check(): Promise<string[]> {
    await this.run({ sql: "SELECT 1", params: [] });
    // A token's permissions can't be read back: whether it can write isn't known here.
    return this.config.schemas.length ? ["D1 has no schemas: the source's schemas are ignored"] : [];
  }

  async tables(): Promise<SourceTable[]> {
    const { rows } = await this.run({
      sql: `SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY name`,
      params: [],
    });
    return rows.map(([name, type]) => ({ schema: null, name: String(name), type: String(type) }));
  }

  /** The target's columns as read (cached a while; also what every query checks its names against). */
  private columnsOf(target: SourceTarget): Promise<Map<string, D1Column>> {
    this.allowed(target);
    const key = JSON.stringify(target);
    const cached = this.columns.get(key);
    if (cached && Date.now() - cached.at < COLUMNS_TTL_MS) return cached.columns;
    const columns = this.describeColumns(target).then((d) => new Map(d.columns.map((c) => [c.name, c])));
    columns.catch(() => this.columns.delete(key));
    this.columns.set(key, { at: Date.now(), columns });
    return columns;
  }

  private allowed(target: SourceTarget) {
    if ("query" in target) throw new SourceError(`${this.config.name} is read by its tables only`);
    if (target.table.schema !== null) throw new SourceError(`${this.config.name} has no schemas`);
  }

  private async describeColumns(target: SourceTarget): Promise<Omit<SourceDescription, "columns"> & { columns: D1Column[] }> {
    // The columns of what it reads, with a sample of their values (for those without a declared type).
    const sample = await this.run({ sql: `SELECT * FROM ${fromSql(target)} LIMIT ${SAMPLE_ROWS}`, params: [] });
    const names = sample.columns;
    if (!names.length) throw new SourceError("It returns no columns");
    const duplicate = names.find((n, i) => names.indexOf(n) !== i);
    if (duplicate) throw new SourceError(`Two columns are called “${duplicate}”: name them apart (… AS another_name)`);
    const declared = new Map<string, string>();
    let key: string[] = [];
    if ("table" in target) {
      // cid, name, type, notnull, dflt_value, pk, hidden
      const info = await this.run({ sql: `PRAGMA table_xinfo(${ident(target.table.name)})`, params: [] });
      for (const [, name, type] of info.rows) declared.set(String(name), String(type ?? ""));
      key = info.rows.filter((r) => Number(r[5]) > 0).sort((a, b) => Number(a[5]) - Number(b[5])).map((r) => String(r[1]));
    }
    const columns: D1Column[] = [];
    const dropped: { name: string; type: string }[] = [];
    names.forEach((name, i) => {
      const column = d1Column(name, declared.get(name) || null, sample.rows.map((r) => r[i]));
      if (column) columns.push(column);
      else dropped.push({ name, type: declared.get(name) || "blob" });
    });
    return { columns, key, dropped };
  }

  async describe(target: SourceTarget): Promise<SourceDescription> {
    this.allowed(target);
    const description = await this.describeColumns(target);
    this.columns.set(JSON.stringify(target), { at: Date.now(), columns: Promise.resolve(new Map(description.columns.map((c) => [c.name, c]))) });
    // What the app needs to know, without how the server reads it.
    return { ...description, columns: description.columns.map(({ read: _read, ...c }) => c) };
  }

  async query(query: SourceQuery): Promise<SourceResult> {
    const columns = await this.columnsOf(query.target);
    const statements = querySql(query, columns);
    const [page, total, groups] = await Promise.all([
      this.run(statements.rows),
      statements.total && this.run(statements.total),
      statements.groups && this.run(statements.groups),
    ]);
    const result: SourceResult = { rows: page.rows.slice(0, query.limit).map((r) => toRow(page.columns, r, query, columns, !!query.groupBy)), more: page.rows.length > query.limit };
    if (total) result.total = Number(total.rows[0]?.[0] ?? 0);
    if (groups) result.groups = groups.rows.map(([g, n]) => ({ key: String(g ?? ""), count: Number(n) }));
    return result;
  }

  async row(request: SourceRowRequest): Promise<SourceRow | null> {
    const columns = await this.columnsOf(request.target);
    const { columns: names, rows } = await this.run(rowSql(request, columns));
    return rows[0] ? toRow(names, rows[0], request, columns, false) : null;
  }

  async close() {}
}

function toRow(names: string[], r: unknown[], shape: SourceShape, columns: Map<string, D1Column>, grouped: boolean): SourceRow {
  const at = (name: string) => r[names.indexOf(name)];
  const row: SourceRow = {
    key: String(at("$key")),
    values: shape.columns.map((name, i) => {
      const value = (at(`v${i}`) ?? null) as SourceValue;
      return columns.get(name)?.read === "bool" && value !== null ? Number(value) === 1 : value;
    }),
  };
  if (grouped) row.group = String(at("$group") ?? "");
  return row;
}
