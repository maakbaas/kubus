import type { SourceDescription, SourceQuery, SourceResult, SourceRow, SourceRowRequest, SourceShape, SourceTable, SourceTarget, SourceValue } from "../../../shared/sources.ts";
import { SourceError, type Connector, type SourceConfig } from "./connector.ts";
import { addressOf } from "./kinds.ts";
import { fromSql, phColumn, probeSql, querySql, rowSql, type PhColumn } from "./posthogHogql.ts";

// PostHog (product analytics), read-only through its query API: POST /api/projects/<project>/query/ with
// one HogQL statement (`{ query: { kind: "HogQLQuery", query } }`), the password a personal API key
// (Authorization: Bearer). Its fields are PostHog's address (https://us.posthog.com, https://eu.posthog.com
// or a self-hosted one; the ingestion hosts us.i.posthog.com / eu.i.posthog.com are taken as those) and the
// project's ID (empty: the key's current project, `@current`). Strictly read-only: HogQL only reads, and only
// statements made here are sent (posthogHogql.ts); give it a key with only the Query: Read scope.
//
// Tables are what HogQL offers (`DatabaseSchemaQuery`: events, persons, sessions, groups, data warehouse
// tables, saved views), else the four PostHog always has. A table's columns are read by one probe row
// (its ClickHouse types come back with it). Its query API has rate limits, so an answer is kept a few
// seconds (a view's page and its counts are made of one read each, its item pages share them).

/** How long a target's columns are trusted before they are read again. */
const COLUMNS_TTL_MS = 60_000;
/** How long the list of tables is kept. */
const TABLES_TTL_MS = 60_000;
/** How long an answer is kept (one view's pages and counts, its item pages). */
const ANSWER_TTL_MS = 5_000;

/** The tables PostHog always has, if its schema can't be read. */
const BASE_TABLES = ["events", "persons", "sessions", "groups"];
/** The key and time column of PostHog's own tables. */
const KEYS: Record<string, string> = { events: "uuid", persons: "id", sessions: "session_id" };
const TIMES: Record<string, string> = { events: "timestamp", sessions: "$start_timestamp" };
/** Schema fields that are joins to other tables, not values of the row. */
const JOINS = new Set(["lazy_table", "virtual_table", "field_traverser", "view", "materialized_view"]);

/** The answer to a HogQL query. */
interface HogQLResponse {
  columns?: string[] | null;
  /** Each column's name and ClickHouse type. */
  types?: ([string, string] | string)[] | null;
  results?: unknown[][] | null;
  error?: string | null;
}

/** A schema's table, as `DatabaseSchemaQuery` describes it. */
interface SchemaTable {
  name?: string;
  type?: string;
  fields?: Record<string, { name?: string; type?: string }>;
}

/** The API's root and the project's part of it from the source's fields. */
export function posthogEndpoint(address: string, project: string): string {
  let u: URL;
  try {
    u = addressOf(address || "https://us.posthog.com", true);
  } catch {
    throw new SourceError("The address isn't one (https://eu.posthog.com)");
  }
  // The ingestion hosts don't answer the API: their app's host does.
  const host = u.host.replace(/^(us|eu)\.i\.posthog\.com$/i, "$1.posthog.com");
  const id = project.trim() || "@current";
  if (!/^(\d+|@current)$/.test(id)) throw new SourceError("The project ID is a number (in PostHog: Settings → Project → Project ID)");
  return `${u.protocol}//${host}${u.pathname.replace(/\/+$/, "")}/api/projects/${id}/query/`;
}

/** What PostHog's error answer says ({ detail } or { error }). */
function detailOf(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  for (const k of ["detail", "error", "message"]) if (typeof b[k] === "string" && b[k]) return b[k] as string;
  return null;
}

export class PostHogConnector implements Connector {
  readonly kind = "posthog";
  private config: SourceConfig;
  private endpoint: string;
  private columns = new Map<string, { at: number; columns: Promise<Map<string, PhColumn>> }>();
  private answers = new Map<string, { at: number; answer: Promise<HogQLResponse> }>();
  /**
   * Where pages end, by query (all of it but its offset, limit and counts) and the offset of the page that follows:
   * that row's sort keys. The app asks for the next page from the rows it has, and PostHog refuses OFFSET with a
   * personal API key (on events): the next page is asked for after them (keyset). The most recent queries only.
   */
  private pageEnds = new Map<string, Map<number, unknown[]>>();
  private tableList: { at: number; tables: Promise<{ tables: SourceTable[]; schema: Map<string, SchemaTable> | null }> } | null = null;

  constructor(config: SourceConfig) {
    this.config = config;
    this.endpoint = posthogEndpoint(config.fields.address ?? "", config.fields.project ?? "");
    if (!config.password) throw new SourceError("A PostHog source needs a personal API key");
  }

  /** Sends one query (a HogQL statement or another kind, e.g. the schema). */
  private async send(query: object): Promise<HogQLResponse> {
    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${this.config.password}`, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ query, name: "kubus" }),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch (e) {
      if ((e as Error).name === "TimeoutError") throw new SourceError("The query took too long (the source's time limit)");
      throw new Error(`PostHog can't be reached: ${(e as Error).message}`);
    }
    const body = (await response.json().catch(() => null)) as unknown;
    const detail = detailOf(body);
    if (response.status === 400) throw new SourceError(detail ?? "PostHog refused the query");
    if (response.status === 401 || response.status === 403) throw new Error(`PostHog: ${detail ?? "the API key isn't accepted"} (a personal API key with the Query: Read scope)`);
    if (response.status === 404) throw new Error("PostHog: no such project (check the address and the project ID)");
    if (response.status === 429) throw new Error("PostHog: too many requests (its rate limit); try again in a minute");
    if (!response.ok || !body || typeof body !== "object") throw new Error(`PostHog: ${detail ?? `${response.status} ${response.statusText}`}`);
    const answer = body as HogQLResponse;
    if (answer.error) throw new SourceError(answer.error);
    return answer;
  }

  /** Runs one HogQL statement; the same one again within a few seconds is answered once. */
  private run(hogql: string): Promise<HogQLResponse> {
    const now = Date.now();
    for (const [k, a] of this.answers) if (now - a.at >= ANSWER_TTL_MS) this.answers.delete(k);
    const kept = this.answers.get(hogql);
    if (kept) return kept.answer;
    const answer = this.send({ kind: "HogQLQuery", query: hogql });
    answer.catch(() => this.answers.delete(hogql));
    this.answers.set(hogql, { at: now, answer });
    return answer;
  }

  async check(): Promise<string[]> {
    await this.run("SELECT 1");
    // A key's scopes can't be read back here: whether it could write isn't known (HogQL itself only reads).
    return this.config.schemas.length ? ["PostHog has no schemas: the source's schemas are ignored"] : [];
  }

  /** The tables HogQL offers, with their schema (null when it can't be read: the base tables then). */
  private listTables(): Promise<{ tables: SourceTable[]; schema: Map<string, SchemaTable> | null }> {
    if (this.tableList && Date.now() - this.tableList.at < TABLES_TTL_MS) return this.tableList.tables;
    const base = () => ({ tables: BASE_TABLES.map((name) => ({ schema: null, name, type: "table" })), schema: null });
    const tables = this.send({ kind: "DatabaseSchemaQuery" }).then(
      (answer) => {
        const raw = (answer as { tables?: Record<string, SchemaTable> }).tables;
        if (!raw || typeof raw !== "object" || !Object.keys(raw).length) return base();
        const schema = new Map(Object.entries(raw).map(([key, t]) => [t.name || key, t]));
        const list = [...schema.entries()]
          .filter(([, t]) => t.type !== "system")
          .map(([name, t]) => ({ schema: null, name, type: t.type === "data_warehouse" ? "data warehouse" : t.type?.includes("view") ? "view" : "table" }))
          .sort((a, b) => Number(!BASE_TABLES.includes(a.name)) - Number(!BASE_TABLES.includes(b.name)) || a.name.localeCompare(b.name));
        return { tables: list, schema };
      },
      (e) => {
        // An older or self-hosted PostHog without the schema query: its own tables.
        if (e instanceof SourceError) return base();
        throw e;
      },
    );
    tables.catch(() => (this.tableList = null));
    this.tableList = { at: Date.now(), tables };
    return tables;
  }

  async tables(): Promise<SourceTable[]> {
    return (await this.listTables()).tables;
  }

  private columnsOf(target: SourceTarget): Promise<Map<string, PhColumn>> {
    const key = JSON.stringify(target);
    const cached = this.columns.get(key);
    if (cached && Date.now() - cached.at < COLUMNS_TTL_MS) return cached.columns;
    const columns = this.describeColumns(target).then((d) => new Map(d.columns.map((c) => [c.name, c])));
    columns.catch(() => this.columns.delete(key));
    this.columns.set(key, { at: Date.now(), columns });
    return columns;
  }

  private async describeColumns(target: SourceTarget): Promise<Omit<SourceDescription, "columns"> & { columns: PhColumn[] }> {
    fromSql(target); // a table, or why not
    const table = (target as { table: { name: string } }).table.name;
    const { schema } = await this.listTables().catch(() => ({ schema: null }));
    const fields = schema?.get(table)?.fields;
    const listed = fields ? Object.entries(fields).map(([key, f]) => ({ name: f.name || key, type: f.type ?? "unknown" })).filter((f) => !JOINS.has(f.type)) : null;
    // One row of every listed column (expression fields too, which `*` leaves out); `*` when there is no schema, or the list is refused.
    let probe: HogQLResponse;
    try {
      probe = await this.send({ kind: "HogQLQuery", query: probeSql(table, listed?.length ? listed.map((f) => f.name) : null) });
    } catch (e) {
      if (!(e instanceof SourceError) || !listed?.length) throw e;
      probe = await this.send({ kind: "HogQLQuery", query: probeSql(table, null) });
    }
    const names = probe.columns ?? [];
    if (!names.length) throw new SourceError("It returns no columns");
    const chTypes = new Map((probe.types ?? []).flatMap((t, i) => (Array.isArray(t) ? [[t[0], t[1]] as const] : typeof t === "string" ? [[names[i], t] as const] : [])));
    const schemaTypes = new Map((listed ?? []).map((f) => [f.name, f.type]));
    const columns: PhColumn[] = [];
    const dropped: { name: string; type: string }[] = [];
    for (const name of names) {
      const c = phColumn(name, chTypes.get(name) ?? null, schemaTypes.get(name) ?? null);
      if (c) columns.push(c);
      else dropped.push({ name, type: chTypes.get(name) ?? schemaTypes.get(name) ?? "unknown" });
    }
    const has = (name: string | undefined) => (name && columns.some((c) => c.name === name) ? name : undefined);
    const key = has(KEYS[table]);
    const time = has(TIMES[table]);
    return { columns, key: key ? [key] : [], dropped, ...(time && { time }) };
  }

  async describe(target: SourceTarget): Promise<SourceDescription> {
    const description = await this.describeColumns(target);
    this.columns.set(JSON.stringify(target), { at: Date.now(), columns: Promise.resolve(new Map(description.columns.map((c) => [c.name, c]))) });
    // What the app needs to know, without how the server reads it.
    return { ...description, columns: description.columns.map(({ read: _read, ...c }) => c) };
  }

  async query(query: SourceQuery): Promise<SourceResult> {
    const columns = await this.columnsOf(query.target);
    const { offset: _o, limit: _l, counts: _c, ...asked } = query;
    const which = JSON.stringify(asked);
    const after = query.offset > 0 ? (this.pageEnds.get(which)?.get(query.offset) ?? null) : null;
    const statements = querySql(query, columns, after);
    const [page, total, groups] = await Promise.all([this.run(statements.rows), statements.total && this.run(statements.total), statements.groups && this.run(statements.groups)]);
    const rows = page.results ?? [];
    const last = rows[Math.min(rows.length, statements.pageRows) - 1];
    if (rows.length > statements.pageRows && last) {
      const ends = this.pageEnds.get(which) ?? new Map<number, unknown[]>();
      ends.set(query.offset + statements.pageRows, last.slice(last.length - statements.sortKeys));
      // Most recent last; at most 50 queries remembered.
      this.pageEnds.delete(which);
      this.pageEnds.set(which, ends);
      if (this.pageEnds.size > 50) this.pageEnds.delete(this.pageEnds.keys().next().value!);
    }
    const result: SourceResult = {
      rows: rows.slice(0, statements.pageRows).map((r) => toRow(r, query, columns, !!query.groupBy)),
      // A page cut at POSTHOG_PAGE has more too: the app asks for the next from the rows it has.
      more: rows.length > statements.pageRows,
    };
    if (total) result.total = Number(total.results?.[0]?.[0] ?? 0);
    if (groups) result.groups = (groups.results ?? []).map(([g, n]) => ({ key: String(g ?? ""), count: Number(n) }));
    return result;
  }

  async row(request: SourceRowRequest): Promise<SourceRow | null> {
    const columns = await this.columnsOf(request.target);
    const answer = await this.run(rowSql(request, columns));
    const r = answer.results?.[0];
    return r ? toRow(r, request, columns, false) : null;
  }

  async close() {}
}

/** A value as the app stores it: dates & times as ISO 8601 UTC (PostHog answers in the project's zone), dates yyyy-mm-dd. */
export function phValue(c: PhColumn | undefined, v: unknown): SourceValue {
  if (v === null || v === undefined) return null;
  switch (c?.read) {
    case "number": {
      const n = typeof v === "number" ? v : Number(v);
      return Number.isFinite(n) ? n : null;
    }
    case "bool":
      return v === true || v === 1 || v === "1" || v === "true";
    case "date":
      return /^\d{4}-\d{2}-\d{2}/.test(String(v)) ? String(v).slice(0, 10) : null;
    case "datetime": {
      // ClickHouse's "yyyy-mm-dd hh:mm:ss" has no zone: UTC.
      const text = String(v);
      const t = Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(text) ? text : `${text.replace(" ", "T")}Z`);
      return Number.isNaN(t) ? null : new Date(t).toISOString();
    }
    case "list":
      return Array.isArray(v) ? v.map((x) => (typeof x === "string" ? x : JSON.stringify(x))) : [String(v)];
    default:
      return typeof v === "string" ? v : JSON.stringify(v);
  }
}

function toRow(r: unknown[], shape: SourceShape, columns: Map<string, PhColumn>, grouped: boolean): SourceRow {
  const row: SourceRow = { key: String(r[0] ?? ""), values: shape.columns.map((name, i) => phValue(columns.get(name), r[i + 1])) };
  if (grouped) row.group = String(r[shape.columns.length + 1] ?? "");
  return row;
}
