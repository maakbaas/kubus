import type { SourceDescription, SourceQuery, SourceResult, SourceRow, SourceRowRequest, SourceShape, SourceTable, SourceTarget } from "../../../shared/sources.ts";
import { SourceError, type Connector, type SourceConfig } from "./connector.ts";
import { addressOf } from "./kinds.ts";
import {
  ALL_START,
  ALL_STOP,
  fieldColumns,
  fluxString,
  groupKey,
  groupsFlux,
  ID_COLUMN,
  influxColumn,
  influxValue,
  countFlux,
  isTimeOrdered,
  nearestFlux,
  pageDays,
  parseAnnotatedCsv,
  rowFlux,
  rowsFlux,
  totalFlux,
  type CsvTable,
  type InfluxColumn,
} from "./influxFlux.ts";

// An InfluxDB 2 server, strictly read-only: it is only ever asked Flux that reads (influxFlux.ts),
// over its HTTP API with the token. Its fields: the address
// (http://host:8086, or https://) and the organization; the token as its password. Buckets are its "schemas", their measurements its tables.
// The real protection is a token that can only read (docs/sync.md): `check` warns when it can write.

/** How long a target's columns are trusted before they are read again (new fields or tags). */
const COLUMNS_TTL_MS = 60_000;

/** A query slower than this is logged (with its script). */
const SLOW_MS = 3000;

export class InfluxConnector implements Connector {
  readonly kind = "influxdb";
  private config: SourceConfig;
  private base: string;
  private org: string;
  private token: string;
  private columns = new Map<string, { at: number; columns: Promise<Map<string, InfluxColumn>> }>();

  constructor(config: SourceConfig) {
    this.config = config;
    let url: URL;
    try {
      url = addressOf(config.fields.address ?? "", false);
    } catch {
      throw new SourceError("The address isn't one (http://influx.example.com:8086)");
    }
    const secure = url.protocol === "https:";
    this.base = `${url.protocol}//${url.hostname}:${url.port || (secure ? "443" : "8086")}`;
    this.org = config.fields.org ?? "";
    this.token = config.password;
    if (!this.org) throw new SourceError("An InfluxDB source needs its organization");
  }

  private headers(more: Record<string, string> = {}) {
    return { Authorization: `Token ${this.token}`, ...more };
  }

  /** Runs a Flux script (one that only reads), with the source's time limit. */
  private async flux(query: string): Promise<CsvTable[]> {
    const started = Date.now();
    try {
      return await this.run(query);
    } finally {
      // A slow query in the server's log, by its time and its script (what it reads, how): which one to look at.
      const took = Date.now() - started;
      if (took >= SLOW_MS) console.warn(`[source ${this.config.name}] InfluxDB query took ${(took / 1000).toFixed(1)}s:\n${query}`);
    }
  }

  private async run(query: string): Promise<CsvTable[]> {
    let response: Response;
    try {
      response = await fetch(`${this.base}/api/v2/query?org=${encodeURIComponent(this.org)}`, {
        method: "POST",
        headers: this.headers({ "Content-Type": "application/json", Accept: "application/csv" }),
        body: JSON.stringify({
          query,
          type: "flux",
          dialect: { header: true, delimiter: ",", annotations: ["datatype", "group", "default"], commentPrefix: "#", dateTimeFormat: "RFC3339Nano" },
        }),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch (e) {
      if ((e as Error).name === "TimeoutError") throw new SourceError("The query took too long (the source's time limit)");
      throw e;
    }
    const text = await response.text();
    if (!response.ok) {
      let message = text;
      try {
        message = (JSON.parse(text) as { message?: string }).message ?? text;
      } catch {
        // Not JSON: the text as it is.
      }
      // A mistake in the script (its syntax, an unknown bucket) is the request's; the rest the source's.
      if (response.status === 400 || response.status === 404) throw new SourceError(message);
      throw new Error(`InfluxDB answered ${response.status}: ${message}`);
    }
    return parseAnnotatedCsv(text);
  }

  /** The values of one column of every row. */
  private static values(tables: CsvTable[], name: string): string[] {
    return tables.flatMap((t) => {
      const i = t.columns.findIndex((c) => c.name === name);
      return i < 0 ? [] : t.rows.map((r) => r[i]);
    });
  }

  async check(): Promise<string[]> {
    await this.flux(`buckets()\n  |> keep(columns: ["name"])\n  |> limit(n: 1)`);
    // Only a token that may read authorizations sees them: then it is likely one that can do more.
    const response = await fetch(`${this.base}/api/v2/authorizations`, { headers: this.headers(), signal: AbortSignal.timeout(this.config.timeoutMs) });
    if (!response.ok) return [];
    const { authorizations = [] } = (await response.json()) as { authorizations?: { token?: string; permissions?: { action: string }[] }[] };
    const own = authorizations.find((a) => a.token === this.token);
    if (own?.permissions?.some((p) => p.action === "write")) return ["its token can write: use a token that can only read (docs/sync.md)"];
    if (authorizations.length) return ["its token can read the server's tokens: use a token that can only read buckets (docs/sync.md)"];
    return [];
  }

  async tables(): Promise<SourceTable[]> {
    const offered = this.config.schemas;
    const buckets = InfluxConnector.values(await this.flux(`buckets()\n  |> keep(columns: ["name"])`), "name")
      .filter((b) => !b.startsWith("_") && (!offered.length || offered.includes(b)))
      .sort();
    const lists = await Promise.all(
      buckets.map(async (bucket) => {
        const measurements = InfluxConnector.values(
          await this.flux(`import "influxdata/influxdb/schema"\n\nschema.measurements(bucket: ${fluxString(bucket)}, start: ${ALL_START})`),
          "_value",
        );
        return measurements.sort().map((name): SourceTable => ({ schema: bucket, name, type: "measurement" }));
      }),
    );
    return lists.flat();
  }

  private allowed(target: SourceTarget) {
    if ("query" in target) throw new SourceError(`${this.config.name} is read by its measurements only`);
    const bucket = target.table.schema ?? "";
    if (!bucket) throw new SourceError("A measurement is read from a bucket");
    if (this.config.schemas.length && !this.config.schemas.includes(bucket)) throw new SourceError(`${this.config.name} doesn't offer the bucket “${bucket}”`);
  }

  /** The target's columns as read (cached a while; also what every query checks its names against). */
  private columnsOf(target: SourceTarget): Promise<Map<string, InfluxColumn>> {
    this.allowed(target);
    const key = JSON.stringify(target);
    const cached = this.columns.get(key);
    if (cached && Date.now() - cached.at < COLUMNS_TTL_MS) return cached.columns;
    const columns = this.describeColumns(target).then((d) => new Map(d.columns.map((c) => [c.name, c])));
    columns.catch(() => this.columns.delete(key));
    this.columns.set(key, { at: Date.now(), columns });
    return columns;
  }

  private async describeColumns(target: SourceTarget): Promise<Omit<SourceDescription, "columns"> & { columns: InfluxColumn[] }> {
    const columns: InfluxColumn[] = [];
    const dropped: { name: string; type: string }[] = [];
    const add = (name: string, datatype: string, tag = false, field?: string) => {
      const column = influxColumn(name, datatype, tag);
      if (column) columns.push(field !== undefined && field !== name ? { ...column, field } : column);
      else dropped.push({ name, type: datatype });
    };
    if ("query" in target) throw new SourceError(`${this.config.name} is read by its measurements only`);
    const bucket = fluxString(target.table.schema ?? "");
    const measurement = fluxString(target.table.name);
    const [tags, fields] = await Promise.all([
      this.flux(`import "influxdata/influxdb/schema"\n\nschema.measurementTagKeys(bucket: ${bucket}, measurement: ${measurement}, start: ${ALL_START})`),
      // Each field's latest value, for its type.
      this.flux(`from(bucket: ${bucket})
  |> range(start: ${ALL_START}, stop: ${ALL_STOP})
  |> filter(fn: (r) => r._measurement == ${measurement})
  |> last()
  |> group(columns: ["_field"])
  |> limit(n: 1)
  |> keep(columns: ["_field", "_value"])`),
    ]);
    add("_time", "dateTime:RFC3339");
    const tagKeys = [...new Set(InfluxConnector.values(tags, "_value").filter((t) => !t.startsWith("_")))].sort();
    for (const tag of tagKeys) add(tag, "string", true);
    const types = fields.flatMap((t) => {
      const field = t.columns.findIndex((c) => c.name === "_field");
      const datatype = t.columns.find((c) => c.name === "_value")?.datatype ?? "string";
      return field < 0 ? [] : t.rows.map((r) => [r[field], datatype] as const);
    });
    // A field may share its key with a tag, or have values of more than one type (a table each): each once, named apart.
    for (const { name, field, datatype } of fieldColumns(types, tagKeys)) add(name, datatype, false, field);
    if (columns.length === 1) throw new SourceError(`“${target.table.name}” has no data in “${target.table.schema}”`);
    columns.push({ name: ID_COLUMN, type: "series and time", kind: "string", read: "string", hidden: true });
    return { columns, key: [ID_COLUMN], dropped };
  }

  async describe(target: SourceTarget): Promise<SourceDescription> {
    this.allowed(target);
    const description = await this.describeColumns(target);
    this.columns.set(JSON.stringify(target), { at: Date.now(), columns: Promise.resolve(new Map(description.columns.map((c) => [c.name, c]))) });
    // What the app needs to know, without how the server reads it.
    return { ...description, columns: description.columns.map(({ read: _read, tag: _tag, field: _field, ...c }) => c) };
  }

  async query(query: SourceQuery): Promise<SourceResult> {
    if (isTimeOrdered(query)) return this.byTime(query);
    return this.page(query);
  }

  /**
   * A page by time (isTimeOrdered): from the nearest point's day and the days next to it; rows beyond the page
   * in those days mean the page is the range's own (every row outside them is further away), else the whole
   * range is read as asked. The total counted from InfluxDB's index where it can be.
   */
  private async byTime(query: SourceQuery): Promise<SourceResult> {
    const direction = query.sort[0].direction;
    const counted = query.counts ? this.total(query) : Promise.resolve(undefined);
    const at = InfluxConnector.values(await this.flux(nearestFlux(query, direction)), "_time")[0];
    let result: SourceResult | null = at ? null : { rows: [], more: false };
    // The page's days: the nearest point's and as many before (or after) as the page needs at least a day a
    // row of (a month at most). Too few rows there: the whole range, as asked (no wider tries in between).
    if (at) {
      const days = Math.min(31, Math.max(1, Math.ceil((query.offset + query.limit) / 100)));
      const r = await this.page({ ...query, counts: false, filter: { and: [query.filter, pageDays(at, direction, days, query.timeZone)] } });
      if (r.more) result = r;
    }
    result ??= await this.page({ ...query, counts: false });
    const total = await counted;
    return total === undefined ? result : { ...result, total };
  }

  /** A query's rows counted: by InfluxDB's index (countFlux) where the filter is a range alone, else every row read. */
  private async total(query: SourceQuery): Promise<number> {
    const columns = await this.columnsOf(query.target);
    const flux = countFlux(query, columns) ?? totalFlux(query, columns);
    return Number(InfluxConnector.values(await this.flux(flux), "_kubus_n")[0] ?? 0);
  }

  private async page(query: SourceQuery): Promise<SourceResult> {
    const columns = await this.columnsOf(query.target);
    const group = query.groupBy ? columns.get(query.groupBy) : undefined;
    // A grouped query's rows are placed by their group's place, so its groups come first.
    const groups = group
      ? (await this.flux(groupsFlux(query, columns))).flatMap((t) => {
          const g = t.columns.findIndex((c) => c.name === "_kubus_g");
          const n = t.columns.findIndex((c) => c.name === "_kubus_n");
          return t.rows.map((r) => ({ raw: r[g] ?? "", count: Number(r[n] ?? 0) }));
        })
      : [];
    const [page, total] = await Promise.all([
      this.flux(rowsFlux(query, columns, groups.map((g) => g.raw))),
      // Counted as byTime counts: by InfluxDB's index where it can be, not every row read.
      query.counts ? this.total(query) : Promise.resolve(null),
    ]);
    const rows = toRows(page, query, group, query.timeZone);
    const result: SourceResult = { rows: rows.slice(0, query.limit), more: rows.length > query.limit };
    if (total !== null) result.total = total;
    if (group && query.counts) result.groups = groups.map((g) => ({ key: groupKey(group, g.raw, query.timeZone), count: g.count }));
    return result;
  }

  async row(request: SourceRowRequest): Promise<SourceRow | null> {
    const columns = await this.columnsOf(request.target);
    const flux = rowFlux(request, columns);
    if (!flux) return null;
    return toRows(await this.flux(flux), request, undefined, "UTC")[0] ?? null;
  }

  async close() {
    // Nothing held open: every request is its own.
  }
}

/** The rows of an answer, in order: the key's text, the asked columns' values, the group. */
function toRows(tables: CsvTable[], shape: SourceShape, group: InfluxColumn | undefined, tz: string): SourceRow[] {
  return tables.flatMap((table) => {
    const index = new Map(table.columns.map((c, i) => [c.name, i]));
    const key = index.get(shape.key);
    const g = index.get("_kubus_g");
    return table.rows.map((r): SourceRow => {
      const row: SourceRow = {
        key: key === undefined ? "" : r[key],
        values: shape.columns.map((name) => {
          const i = index.get(name);
          return i === undefined ? null : influxValue(r[i], table.columns[i].datatype);
        }),
      };
      if (group) row.group = groupKey(group, g === undefined ? "" : r[g], tz);
      return row;
    });
  });
}
