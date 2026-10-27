import pg from "pg";
import type { SourceDescription, SourceQuery, SourceResult, SourceRow, SourceRowRequest, SourceShape, SourceTable, SourceTarget, SourceValue } from "../../../shared/sources.ts";
import { SourceError, type Connector, type SourceConfig } from "./connector.ts";
import { fromSql, pgColumn, querySql, rowSql, type PgColumn, type PgType, type Statement } from "./postgresSql.ts";

// A Postgres database, read-only: every statement runs in a READ ONLY transaction with a time
// limit, over connections that start read-only too, using the extended protocol (one statement
// per query, so a written query can't add another). The real protection is a user that can only
// read (docs/sync.md): `check` warns at start when it can do more.

/** How long a target's columns are trusted before they are read again (a changed table). */
const COLUMNS_TTL_MS = 60_000;

export class PostgresConnector implements Connector {
  readonly kind = "postgres";
  readonly capabilities;
  private config: SourceConfig;
  private pool: pg.Pool;
  private columns = new Map<string, { at: number; columns: Promise<Map<string, PgColumn>> }>();

  constructor(config: SourceConfig) {
    this.config = config;
    this.capabilities = { query: config.queries, ...(config.queries && { queryLanguage: "SQL" }) };
    this.pool = new pg.Pool({
      connectionString: config.url,
      max: 4,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      options: `-c default_transaction_read_only=on -c statement_timeout=${config.timeoutMs}`,
    });
    // An idle connection the database dropped mustn't take the server down.
    this.pool.on("error", (e) => console.error(`[source ${config.name}] ${e.message}`));
  }

  /** Runs statements in one read-only transaction. */
  private async read<T>(work: (run: (s: Statement) => Promise<pg.QueryResult>) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN TRANSACTION READ ONLY");
      await client.query(`SET LOCAL statement_timeout = ${Number(this.config.timeoutMs)}`);
      // The extended protocol (missing from pg's types): one statement per query, never several.
      const result = await work((s) => client.query({ text: s.text, values: s.values, queryMode: "extended" } as pg.QueryConfig));
      await client.query("COMMIT");
      return result;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw asSourceError(e);
    } finally {
      client.release();
    }
  }

  async check(): Promise<string[]> {
    const { rows } = await this.read((run) =>
      run({
        text: `SELECT r.rolsuper AS super, EXISTS (
                 SELECT 1 FROM information_schema.table_privileges
                 WHERE grantee = current_user AND privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')) AS writes
               FROM pg_roles r WHERE r.rolname = current_user`,
        values: [],
      }),
    );
    const role = rows[0] as { super: boolean; writes: boolean } | undefined;
    const warnings: string[] = [];
    if (role?.super) warnings.push("connects as a superuser: use a user that can only read (docs/sync.md)");
    else if (role?.writes) warnings.push("its user may write to some tables: a user that can only read is safer (docs/sync.md)");
    return warnings;
  }

  async tables(): Promise<SourceTable[]> {
    const schemas = this.config.schemas;
    const { rows } = await this.read((run) =>
      run({
        text: `SELECT table_schema AS schema, table_name AS name, CASE table_type WHEN 'VIEW' THEN 'view' ELSE 'table' END AS type
                 FROM information_schema.tables
                WHERE table_schema NOT IN ('pg_catalog', 'information_schema') AND table_schema NOT LIKE 'pg\\_%'
                  AND ($1::text[] IS NULL OR table_schema = ANY($1))
               UNION ALL
               SELECT schemaname, matviewname, 'view' FROM pg_matviews
                WHERE has_table_privilege(format('%I.%I', schemaname, matviewname), 'SELECT')
                  AND ($1::text[] IS NULL OR schemaname = ANY($1))
               ORDER BY 1, 2`,
        values: [schemas.length ? schemas : null],
      }),
    );
    return rows as SourceTable[];
  }

  /** The target's columns as read (cached a while; also what every query checks its names against). */
  private columnsOf(target: SourceTarget): Promise<Map<string, PgColumn>> {
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
    if ("query" in target) {
      if (!this.config.queries) throw new SourceError(`${this.config.name} doesn't allow queries, only its tables`);
      return;
    }
    const { schema } = target.table;
    if (this.config.schemas.length && !this.config.schemas.includes(schema ?? "")) {
      throw new SourceError(`${this.config.name} doesn't offer the schema “${schema ?? ""}”`);
    }
  }

  private async describeColumns(target: SourceTarget): Promise<Omit<SourceDescription, "columns"> & { columns: PgColumn[] }> {
    return this.read(async (run) => {
      // The columns of what it reads, as a query with no rows gives them (a table and a query alike).
      const shape = await run({ text: `SELECT * FROM ${fromSql(target)} LIMIT 0`, values: [] });
      const names = shape.fields.map((f) => f.name);
      const duplicate = names.find((n, i) => names.indexOf(n) !== i);
      if (duplicate) throw new SourceError(`Two columns are called “${duplicate}”: name them apart (… AS another_name)`);
      const oids = [...new Set(shape.fields.map((f) => f.dataTypeID))];
      const types = await run({
        text: `SELECT t.oid, b.typname AS name, format_type(t.oid, NULL) AS display, b.typcategory AS category,
                      e.typname AS element_name, e.typcategory AS element_category
                 FROM pg_type t
                 JOIN pg_type b ON b.oid = CASE WHEN t.typtype = 'd' THEN t.typbasetype ELSE t.oid END
                 LEFT JOIN pg_type e ON e.oid = b.typelem AND b.typcategory = 'A'
                WHERE t.oid = ANY($1::oid[])`,
        values: [oids],
      });
      const byOid = new Map<number, PgType>(
        (types.rows as { oid: number; name: string; display: string; category: string; element_name: string | null; element_category: string | null }[]).map((t) => [
          Number(t.oid),
          { name: t.name, display: t.display, category: t.category, element: t.element_name ? { name: t.element_name, category: t.element_category ?? "" } : null },
        ]),
      );
      const columns: PgColumn[] = [];
      const dropped: { name: string; type: string }[] = [];
      for (const f of shape.fields) {
        const type = byOid.get(f.dataTypeID) ?? { name: "unknown", display: "unknown", category: "X", element: null };
        const column = pgColumn(f.name, type);
        if (column) columns.push(column);
        else dropped.push({ name: f.name, type: type.display });
      }
      let key: string[] = [];
      if ("table" in target) {
        const { schema, name } = target.table;
        const pk = await run({
          text: `SELECT a.attname AS name FROM pg_index i
                   JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
                  WHERE i.indrelid = to_regclass($1) AND i.indisprimary
                  ORDER BY array_position(i.indkey, a.attnum)`,
          values: [`${schema ? `"${schema.replace(/"/g, '""')}".` : ""}"${name.replace(/"/g, '""')}"`],
        });
        key = (pk.rows as { name: string }[]).map((r) => r.name);
      }
      return { columns, key, dropped };
    });
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
    return this.read(async (run) => {
      const page = await run(statements.rows);
      const rows = page.rows.slice(0, query.limit).map((r) => toRow(r, query, !!query.groupBy));
      const result: SourceResult = { rows, more: page.rows.length > query.limit };
      if (statements.total) result.total = Number((await run(statements.total)).rows[0]?.n ?? 0);
      if (statements.groups) result.groups = (await run(statements.groups)).rows.map((g) => ({ key: String(g.g), count: Number(g.n) }));
      return result;
    });
  }

  async row(request: SourceRowRequest): Promise<SourceRow | null> {
    const columns = await this.columnsOf(request.target);
    try {
      const { rows } = await this.read((run) => run(rowSql(request, columns)));
      return rows[0] ? toRow(rows[0], request, false) : null;
    } catch (e) {
      // A key that isn't of the key column's type (text for a number) names no row.
      if ((e as { code?: string }).code === "22P02") return null;
      throw e;
    }
  }

  async close() {
    await this.pool.end();
  }
}

function toRow(r: Record<string, unknown>, shape: SourceShape, grouped: boolean): SourceRow {
  const row: SourceRow = { key: String(r.$key), values: shape.columns.map((_, i) => (r[`v${i}`] ?? null) as SourceValue) };
  if (grouped) row.group = String(r.$group ?? "");
  return row;
}

/**
 * What the database said, as an error the app shows: its own message for a mistake in the request
 * (a written query's syntax, an unknown table, a time limit), kept as is otherwise.
 */
function asSourceError(e: unknown): unknown {
  if (e instanceof SourceError) return e;
  const code = (e as { code?: string }).code;
  // Class 42 (syntax, unknown names, no privilege), 22 (bad data), 57014 (the time limit), 25006 (a write refused).
  if (code && (code.startsWith("42") || code.startsWith("22") || code === "57014" || code === "25006")) {
    const err = new SourceError(code === "57014" ? "The query took too long (the source's time limit)" : (e as Error).message);
    (err as { code?: string }).code = code;
    return err;
  }
  return e;
}
