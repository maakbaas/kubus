// @vitest-environment node
// The InfluxDB connector (server/src/connectors/influx.ts) against a stand-in for InfluxDB 2's
// HTTP API: each kind of Flux it sends is answered with annotated CSV, as InfluxDB would. Its Flux
// itself is tested in influxFlux.test.ts; here the requests, the answers read and the errors.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SourceError } from "../../src/connectors/connector.ts";
import { InfluxConnector } from "../../src/connectors/influx.ts";
import type { SourceQuery } from "../../../shared/sources.ts";

/** An annotated CSV table: columns as name:datatype, then rows. */
function csv(columns: string[], rows: string[][]): string {
  const names = columns.map((c) => c.split(":")[0]);
  const types = columns.map((c) => c.split(":").slice(1).join(":"));
  return [
    `#datatype,string,long,${types.join(",")}`,
    `#group,false,false,${types.map(() => "false").join(",")}`,
    `#default,_result,,${types.map(() => "").join(",")}`,
    `,result,table,${names.join(",")}`,
    ...rows.map((r) => `,,0,${r.join(",")}`),
    "",
  ].join("\r\n");
}

let requests: { url: string; method: string; authorization: string | null; query?: string }[];
/** What GET /api/v2/authorizations answers (InfluxDB shows them only to tokens that may read them). */
let authorizations: Response;
/** An answer to every query instead of the stand-in's own (InfluxDB's errors). */
let failure: Response | null;

function answer(flux: string): string {
  if (flux.startsWith("buckets()")) return csv(["name:string"], flux.includes("limit(n: 1)") ? [["_monitoring"]] : [["_monitoring"], ["office"], ["home"]]);
  if (flux.includes("schema.measurements(")) return csv(["_value:string"], flux.includes('"home"') ? [["temp"], ["cpu"]] : [["door"]]);
  // "cpu": a tag and a field with the same key, a field whose values have two types (as Telegraf's can).
  if (flux.includes("schema.measurementTagKeys(") && flux.includes('"cpu"')) return csv(["_value:string"], [["host"], ["source_type_str"]]);
  // A range's rows counted from the index.
  if (flux.includes("|> count()")) return csv(["_kubus_n:long"], [["3"]]);
  if (flux.includes("last()") && flux.includes('"cpu"')) {
    return [
      csv(["_field:string", "_value:string"], [["source_type_str", "agent"]]),
      csv(["_field:string", "_value:long"], [["load", "3"]]),
      csv(["_field:string", "_value:double"], [["load", "2.5"]]),
    ].join("\r\n");
  }
  if (flux.includes("schema.measurementTagKeys(")) return csv(["_value:string"], [["_start"], ["_measurement"], ["room"], ["host"]]);
  if (flux.includes("last()")) {
    // One table per field type, as InfluxDB answers: its _value column's datatype is the field's type.
    return [csv(["_field:string", "_value:double"], [["celsius", "21.5"]]), csv(["_field:string", "_value:boolean"], [["ok", "true"]])].join("\r\n");
  }
  if (flux.includes('sum(column: "_kubus_n")') && !flux.includes("_kubus_g")) return csv(["_kubus_n:long"], [["3"]]);
  if (flux.includes("_kubus_g") && flux.includes('keep(columns: ["_kubus_g", "_kubus_n"])')) return csv(["_kubus_g:string", "_kubus_n:long"], [["kitchen", "2"], ["hall", "1"]]);
  return csv(
    ["_id:string", "_kubus_g:string", "_time:dateTime:RFC3339", "room:string", "celsius:double", "ok:boolean"],
    [
      ["s1@1", "kitchen", "2026-03-01T10:00:00Z", "kitchen", "21.5", "true"],
      ["s1@2", "kitchen", "2026-03-01T11:00:00Z", "kitchen", "", "false"],
      ["s2@1", "hall", "2026-03-01T10:00:00Z", "hall", "18", ""],
    ],
  );
}

beforeEach(() => {
  requests = [];
  failure = null;
  authorizations = new Response(null, { status: 401 });
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const authorization = new Headers(init.headers).get("authorization");
    if (url.endsWith("/api/v2/authorizations")) {
      requests.push({ url, method: init.method ?? "GET", authorization });
      return authorizations;
    }
    const { query } = JSON.parse(String(init.body)) as { query: string };
    requests.push({ url, method: init.method ?? "GET", authorization, query });
    return failure ?? new Response(answer(query), { headers: { "Content-Type": "text/csv" } });
  });
});

afterEach(() => vi.unstubAllGlobals());

const connector = (over: { fields?: Record<string, string>; schemas?: string[] } = {}) =>
  new InfluxConnector({ name: "Sensors", kind: "influxdb", fields: { address: "influx.example.com:8086", org: "acme" }, password: "tok", schemas: [], timeoutMs: 5000, ...over });

const temps = (over: Partial<SourceQuery> = {}): SourceQuery => ({
  target: { table: { schema: "home", name: "temp" } },
  key: "_id",
  columns: ["room", "celsius", "ok"],
  title: ["room"],
  untitled: "Reading",
  filter: { and: [] },
  search: "",
  sort: [{ column: "_time", direction: "asc" }],
  groupBy: null,
  groupOrder: "asc",
  timeZone: "UTC",
  offset: 0,
  limit: 2,
  counts: true,
  ...over,
});

describe("InfluxDB connector", () => {
  it("counts from the index, not every row, when the filter is a time range alone", async () => {
    const page = temps({ sort: [{ column: "_time", direction: "desc" }], limit: 2, counts: true, filter: { column: "_time", operator: "between", value: "2026-03-01..2026-03-07" } });
    const r = await connector().query(page);
    expect(r.rows).toHaveLength(2);
    expect(r.more).toBe(true);
    expect(r.total).toBe(3);
    const sent = requests.map((q) => q.query ?? "");
    // The rows read over the period alone, one query; the count by count().
    const pivots = sent.filter((q) => q.includes("pivot("));
    expect(pivots).toHaveLength(1);
    expect(pivots[0]).toContain("range(start: 2026-03-01T00:00:00.000Z, stop: 2026-03-08T00:00:00.000Z)");
    expect(sent.some((q) => q.includes("|> count()"))).toBe(true);
    expect(sent.some((q) => q.includes('sum(column: "_kubus_n")'))).toBe(false);
    // A filter on a field needs the rows: counted the slow way.
    requests = [];
    await connector().query({ ...page, filter: { column: "room", operator: "is", value: "kitchen" } });
    expect(requests.some((q) => q.query?.includes('sum(column: "_kubus_n")'))).toBe(true);
  });

  it("asks the organization's query endpoint with its token, over HTTPS for influxdbs://", async () => {
    await connector().check();
    expect(requests[0]).toMatchObject({ url: "http://influx.example.com:8086/api/v2/query?org=acme", method: "POST", authorization: "Token tok" });
    await connector({ fields: { address: "https://cloud.example.com/", org: "my org" } }).check();
    expect(requests.at(-2)?.url).toBe("https://cloud.example.com:443/api/v2/query?org=my%20org");
    expect(() => connector({ fields: { address: "influx.example.com:8086", org: "" } })).toThrow(/organization/);
  });

  it("warns about a token that can do more than read", async () => {
    expect(await connector().check()).toEqual([]);
    authorizations = Response.json({ authorizations: [{ token: "tok", permissions: [{ action: "read" }, { action: "write" }] }] });
    expect(await connector().check()).toEqual([expect.stringMatching(/can write/)]);
    authorizations = Response.json({ authorizations: [{ token: "another", permissions: [{ action: "read" }] }] });
    expect(await connector().check()).toEqual([expect.stringMatching(/can read the server's tokens/)]);
  });

  it("lists the measurements of its buckets (not InfluxDB's own), only the offered ones when set", async () => {
    expect(await connector().tables()).toEqual([
      { schema: "home", name: "cpu", type: "measurement" },
      { schema: "home", name: "temp", type: "measurement" },
      { schema: "office", name: "door", type: "measurement" },
    ]);
    expect((await connector({ schemas: ["office"] }).tables()).map((t) => t.name)).toEqual(["door"]);
  });

  it("describes a measurement: its time, tags and fields, with a hidden key", async () => {
    const d = await connector().describe({ table: { schema: "home", name: "temp" } });
    expect(d.columns.map((c) => [c.name, c.kind, !!c.hidden])).toEqual([
      ["_time", "datetime", false],
      ["host", "string", false],
      ["room", "string", false],
      ["celsius", "number", false],
      ["ok", "checkbox", false],
      ["_id", "string", true],
    ]);
    expect(d.key).toEqual(["_id"]);
    // Read by time: a collection of it starts with a date period on _time.
    expect(d.time).toBe("_time");
    await expect(connector({ schemas: ["office"] }).describe({ table: { schema: "home", name: "temp" } })).rejects.toThrow(/doesn't offer the bucket/);
  });

  it("names a field apart from a tag with its key, and a field of two types once", async () => {
    const target = { table: { schema: "home", name: "cpu" } };
    const c = connector();
    const d = await c.describe(target);
    expect(d.columns.map((col) => [col.name, col.kind, col.type])).toEqual([
      ["_time", "datetime", "dateTime"],
      ["host", "string", "tag"],
      ["source_type_str", "string", "tag"],
      ["load", "number", "double"],
      ["source_type_str (field)", "string", "string"],
      ["_id", "string", "series and time"],
    ]);
    expect(d.columns.some((col) => "field" in col)).toBe(false);
    // The same names on every read; the field is renamed before the pivot makes it a column.
    expect((await connector().describe(target)).columns.map((col) => col.name)).toEqual(d.columns.map((col) => col.name));
    await c.query({ ...temps(), target, columns: ["source_type_str", "source_type_str (field)"], title: ["host"], sort: [{ column: "source_type_str (field)", direction: "asc" }] });
    const rows = requests.at(-2)?.query ?? "";
    expect(rows).toContain('|> map(fn: (r) => ({r with _field: if r._field == "source_type_str" then "source_type_str (field)" else r._field}))\n  |> pivot(');
    expect(rows).toContain('r["source_type_str (field)"]');
  });

  it("reads a page of rows as the app's values, with the total", async () => {
    expect(await connector().query(temps())).toEqual({
      rows: [
        { key: "s1@1", values: ["kitchen", 21.5, true] },
        { key: "s1@2", values: ["kitchen", null, false] },
      ],
      more: true,
      total: 3,
    });
  });

  it("groups", async () => {
    const result = await connector().query(temps({ groupBy: "room", limit: 10 }));
    expect(result.groups).toEqual([{ key: "kitchen", count: 2 }, { key: "hall", count: 1 }]);
    expect(result.rows.map((r) => r.group)).toEqual(["kitchen", "kitchen", "hall"]);
  });

  it("only ever sends Flux that reads", async () => {
    const c = connector();
    await c.check();
    await c.tables();
    await c.query(temps({ groupBy: "room" }));
    await c.row({ ...temps(), keyValue: "s1@1" });
    const scripts = requests.flatMap((r) => (r.query ? [r.query] : []));
    expect(scripts.length).toBeGreaterThan(5);
    for (const flux of scripts) expect(flux).not.toMatch(/\bto\(|\bdelete\(|experimental/);
  });

  it("refuses a written query", async () => {
    await expect(connector().describe({ query: 'from(bucket: "home") |> range(start: -1h)' })).rejects.toThrow(/measurements only/);
    expect(requests).toEqual([]);
  });

  it("tells a script's mistake (400) from the server's trouble", async () => {
    failure = Response.json({ code: "invalid", message: "compilation failed: undefined identifier" }, { status: 400 });
    await expect(connector().tables()).rejects.toThrow(new SourceError("compilation failed: undefined identifier"));
    failure = Response.json({ code: "unauthorized", message: "unauthorized access" }, { status: 401 });
    const error = await connector().tables().catch((e: Error) => e);
    expect(error).not.toBeInstanceOf(SourceError);
    expect((error as Error).message).toBe("InfluxDB answered 401: unauthorized access");
  });
});
