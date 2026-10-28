import mysql from "mysql2/promise";
import type { SourceDescription, SourceQuery, SourceResult, SourceRow, SourceRowRequest, SourceShape, SourceTable, SourceTarget, SourceValue } from "../../../shared/sources.ts";
import { SourceError, type Connector, type SourceConfig } from "./connector.ts";
import { grantWarnings, myColumn, querySql, rowSql, type Flavour, type MyColumn, type Statement } from "./mysqlSql.ts";

// A MySQL or MariaDB server, read-only: every statement runs in a START TRANSACTION READ ONLY
// with a time limit (MySQL's max_execution_time, MariaDB's max_statement_time) and the session's
// time zone at UTC, as one prepared statement (the driver never sends several). Its databases are
// the schemas. The real protection is a user that can only read (docs/sync.md): `check` warns at
// start when SHOW GRANTS says it can do more.

/** How long a target's columns are trusted before they are read again (a changed table). */
const COLUMNS_TTL_MS = 60_000;
const SYSTEM = ["mysql", "information_schema", "performance_schema", "sys"];

type Rows = Record<string, unknown>[];

export class MysqlConnector implements Connector {
  readonly kind: string;
  private config: SourceConfig;
  private flavour: Flavour;
  private pool: mysql.Pool;
  private columns = new Map<string, { at: number; columns: Promise<Map<string, MyColumn>> }>();

  constructor(config: SourceConfig, flavour: Flavour) {
    this.config = config;
    this.kind = flavour;
    this.flavour = flavour;
    const { host, port, database, user, ssl } = config.fields;
    if (!host) throw new SourceError(`A ${flavour === "mariadb" ? "MariaDB" : "MySQL"} source needs its host`);
    this.pool = mysql.createPool({
      host,
      port: Number(port) || 3306,
      database: database || undefined,
      user: user || undefined,
      password: config.password || undefined,
      ssl: ssl === "verify" ? {} : ssl === "require" ? { rejectUnauthorized: false } : undefined,
      connectionLimit: 4,
      maxIdle: 4,
      idleTimeout: 30_000,
      connectTimeout: 10_000,
      charset: "utf8mb4_unicode_ci",
      multipleStatements: false,
      dateStrings: true,
      supportBigNumbers: true,
      // Each query's text is prepared once per connection: keep only the latest.
      maxPreparedStatements: 64,
    });
  }

  /** Runs statements in one read-only transaction, its session at UTC with the source's time limit. */
  private async read<T>(work: (run: (s: Statement) => Promise<Rows>) => Promise<T>): Promise<T> {
    const conn = await this.pool.getConnection();
    try {
      const ms = Math.max(1, Math.round(Number(this.config.timeoutMs) || 30_000));
      await conn.query(this.flavour === "mariadb" ? `SET time_zone = '+00:00', max_statement_time = ${ms / 1000}` : `SET time_zone = '+00:00', max_execution_time = ${ms}`);
      await conn.query("START TRANSACTION READ ONLY");
      const result = await work(async (s) => (await conn.execute(s.sql, s.params))[0] as Rows);
      await conn.query("COMMIT");
      return result;
    } catch (e) {
      await conn.query("ROLLBACK").catch(() => undefined);
      throw asSourceError(e);
    } finally {
      conn.release();
    }
  }

  async check(): Promise<string[]> {
    const warnings: string[] = [];
    // The server says which it is: its time limit is set by another name.
    const [version] = (await this.pool.query("SELECT VERSION() AS v"))[0] as Rows;
    const actual: Flavour = /mariadb/i.test(String(version?.v)) ? "mariadb" : "mysql";
    if (actual !== this.flavour) {
      warnings.push(`is a ${actual === "mariadb" ? "MariaDB" : "MySQL"} server, set up as ${this.flavour === "mariadb" ? "MariaDB" : "MySQL"}: read as what it is`);
      this.flavour = actual;
    }
    const grants = await this.read((run) => run({ sql: "SHOW GRANTS", params: [] }));
    return [...warnings, ...grantWarnings(grants.map((g) => String(Object.values(g)[0] ?? "")))];
  }

  async tables(): Promise<SourceTable[]> {
    const schemas = this.config.schemas;
    const rows = await this.read((run) =>
      run({
        sql: `SELECT TABLE_SCHEMA AS \`schema\`, TABLE_NAME AS name, TABLE_TYPE AS type FROM information_schema.TABLES
               WHERE TABLE_SCHEMA NOT IN (${SYSTEM.map(() => "?").join(", ")}) AND TABLE_TYPE <> 'SEQUENCE'
                 ${schemas.length ? `AND TABLE_SCHEMA IN (${schemas.map(() => "?").join(", ")})` : ""}
               ORDER BY 1, 2`,
        params: [...SYSTEM, ...schemas],
      }),
    );
    return rows.map((r) => ({ schema: String(r.schema), name: String(r.name), type: /VIEW/.test(String(r.type)) ? "view" : "table" }));
  }

  /** The target's columns as read (cached a while; also what every query checks its names against). */
  private columnsOf(target: SourceTarget): Promise<Map<string, MyColumn>> {
    this.allowed(target);
    const key = JSON.stringify(target);
    const cached = this.columns.get(key);
    if (cached && Date.now() - cached.at < COLUMNS_TTL_MS) return cached.columns;
    const columns = this.describeColumns(target).then((d) => new Map(d.columns.map((c) => [c.name, c])));
    columns.catch(() => this.columns.delete(key));
    this.columns.set(key, { at: Date.now(), columns });
    return columns;
  }

  private allowed(target: SourceTarget): asserts target is { table: { schema: string | null; name: string } } {
    if ("query" in target) throw new SourceError(`${this.config.name} is read by its tables only`);
    const { schema } = target.table;
    if (this.config.schemas.length && !this.config.schemas.includes(schema ?? "")) {
      throw new SourceError(`${this.config.name} doesn't offer the database “${schema ?? ""}”`);
    }
  }

  private async describeColumns(target: SourceTarget): Promise<Omit<SourceDescription, "columns"> & { columns: MyColumn[] }> {
    this.allowed(target);
    const { schema, name } = target.table;
    return this.read(async (run) => {
      const where = "TABLE_SCHEMA = COALESCE(?, DATABASE()) AND TABLE_NAME = ?";
      const found = await run({
        sql: `SELECT COLUMN_NAME AS name, DATA_TYPE AS data_type, COLUMN_TYPE AS column_type FROM information_schema.COLUMNS WHERE ${where} ORDER BY ORDINAL_POSITION`,
        params: [schema, name],
      });
      if (!found.length) throw new SourceError(`There is no table “${name}” its user can read`);
      // MariaDB's JSON is a LONGTEXT with a json_valid() check.
      const json = new Set<string>();
      if (this.flavour === "mariadb") {
        const checks = await run({ sql: `SELECT CHECK_CLAUSE AS c FROM information_schema.CHECK_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = COALESCE(?, DATABASE()) AND TABLE_NAME = ?`, params: [schema, name] });
        for (const { c } of checks) for (const m of String(c).matchAll(/json_valid\(`((?:[^`]|``)+)`\)/gi)) json.add(m[1].replace(/``/g, "`"));
      }
      const pk = await run({
        sql: `SELECT COLUMN_NAME AS name FROM information_schema.STATISTICS WHERE ${where} AND INDEX_NAME = 'PRIMARY' ORDER BY SEQ_IN_INDEX`,
        params: [schema, name],
      });
      const columns: MyColumn[] = [];
      const dropped: { name: string; type: string }[] = [];
      for (const f of found) {
        const column = myColumn(String(f.name), String(f.data_type), String(f.column_type), json.has(String(f.name)));
        if (column) columns.push(column);
        else dropped.push({ name: String(f.name), type: String(f.column_type) });
      }
      return { columns, key: pk.map((r) => String(r.name)), dropped };
    });
  }

  async describe(target: SourceTarget): Promise<SourceDescription> {
    this.allowed(target);
    const description = await this.describeColumns(target);
    this.columns.set(JSON.stringify(target), { at: Date.now(), columns: Promise.resolve(new Map(description.columns.map((c) => [c.name, c]))) });
    // What the app needs to know, without how the server reads it.
    return { ...description, columns: description.columns.map(({ read: _read, members: _members, ...c }) => c) };
  }

  async query(query: SourceQuery): Promise<SourceResult> {
    const columns = await this.columnsOf(query.target);
    const statements = querySql(query, columns, this.flavour);
    return this.read(async (run) => {
      const page = await run(statements.rows);
      const rows = page.slice(0, query.limit).map((r) => toRow(r, query, columns, !!query.groupBy));
      const result: SourceResult = { rows, more: page.length > query.limit };
      if (statements.total) result.total = Number((await run(statements.total))[0]?.n ?? 0);
      if (statements.groups) result.groups = (await run(statements.groups)).map((g) => ({ key: String(g.g ?? ""), count: Number(g.n) }));
      return result;
    });
  }

  async row(request: SourceRowRequest): Promise<SourceRow | null> {
    const columns = await this.columnsOf(request.target);
    const rows = await this.read((run) => run(rowSql(request, columns)));
    return rows[0] ? toRow(rows[0], request, columns, false) : null;
  }

  async close() {
    await this.pool.end();
  }
}

function toRow(r: Record<string, unknown>, shape: SourceShape, columns: Map<string, MyColumn>, grouped: boolean): SourceRow {
  const row: SourceRow = {
    key: String(r.$key),
    values: shape.columns.map((name, i) => {
      const v = r[`v${i}`] ?? null;
      switch (columns.get(name)?.read) {
        case "set":
          return v === null || v === "" ? [] : String(v).split(",");
        case "bool":
          return v === null ? null : Number(v) !== 0;
        case "int":
        case "number":
          return v === null ? null : Number(v);
        default:
          return v as SourceValue;
      }
    }),
  };
  if (grouped) row.group = String(r.$group ?? "");
  return row;
}

/** MySQL's time limits (MySQL's max_execution_time, MariaDB's max_statement_time) and a write refused in a read-only transaction. */
const TIMEOUTS = new Set([3024, 1969]);
const READ_ONLY = 1792;

/**
 * What the server said, as an error the app shows: its own message for a mistake in the request
 * (syntax, unknown names, no privilege, bad data, a time limit, a write refused), kept as is otherwise.
 */
function asSourceError(e: unknown): unknown {
  if (e instanceof SourceError) return e;
  const { errno, sqlState } = e as { errno?: number; sqlState?: string };
  if (errno === undefined) return e;
  if (TIMEOUTS.has(errno) || errno === READ_ONLY || sqlState?.startsWith("42") || sqlState?.startsWith("22")) {
    const err = new SourceError(TIMEOUTS.has(errno) ? "The query took too long (the source's time limit)" : (e as Error).message);
    (err as { errno?: number }).errno = errno;
    return err;
  }
  return e;
}
