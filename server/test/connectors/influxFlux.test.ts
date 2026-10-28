// @vitest-environment node
// The InfluxDB 2 connector's Flux and CSV without a server.
import { describe, expect, it } from "vitest";
import {
  checkFlux,
  dayIn,
  dayStart,
  fieldColumns,
  filterFlux,
  fluxRegex,
  fluxString,
  groupKey,
  groupsFlux,
  influxColumn,
  influxValue,
  nanosOf,
  parseAnnotatedCsv,
  rangeOf,
  rowFlux,
  rowsFlux,
  totalFlux,
  type InfluxColumn,
} from "../../src/connectors/influxFlux.ts";
import type { SourceQuery } from "../../../shared/sources.ts";

const columns = new Map<string, InfluxColumn>(
  [
    influxColumn("_time", "dateTime:RFC3339"),
    influxColumn("host", "string", true),
    influxColumn("usage", "double"),
    influxColumn("ok", "boolean"),
    influxColumn("note", "string"),
    { name: "_id", type: "series and time", kind: "string" as const, read: "string" as const, hidden: true },
  ].map((c) => [c!.name, c!]),
);
const query = (over: Partial<SourceQuery> = {}): SourceQuery => ({
  target: { table: { schema: "metrics", name: "cpu" } }, key: "_id", columns: ["host", "usage"], title: ["host"], untitled: "cpu",
  filter: { and: [] }, search: "", sort: [], groupBy: null, groupOrder: "asc", timeZone: "UTC", offset: 0, limit: 10, counts: false, ...over,
});

describe("literals", () => {
  it("escapes strings, interpolation included", () => {
    expect(fluxString('a"b\\c${d}\n')).toBe('"a\\"b\\\\c\\${d}\\n"');
  });
  it("takes a regular expression's text literally", () => {
    expect(fluxRegex("a.b/c(d)")).toBe("/(?i)a\\.b\\/c\\(d\\)/");
    expect(fluxRegex("x", true)).toBe("/(?i)^x$/");
  });
});

describe("columns and values", () => {
  it("reads CSV datatypes as field types", () => {
    expect(influxColumn("a", "long")).toMatchObject({ kind: "number" });
    expect(influxColumn("a", "unsignedLong")).toMatchObject({ kind: "number" });
    expect(influxColumn("a", "boolean")).toMatchObject({ kind: "checkbox" });
    expect(influxColumn("a", "dateTime:RFC3339Nano")).toMatchObject({ kind: "datetime" });
    expect(influxColumn("_start", "dateTime:RFC3339")).toMatchObject({ hidden: true });
    expect(influxColumn("a", "duration")).toMatchObject({ kind: "string", plain: true });
    expect(influxColumn("host", "string", true)).toMatchObject({ kind: "string", tag: true, type: "tag" });
    expect(influxColumn("a", "base64Binary")).toBeNull();
  });
  it("converts cells to the app's values", () => {
    expect(influxValue("1.5", "double")).toBe(1.5);
    expect(influxValue("", "long")).toBeNull();
    expect(influxValue("true", "boolean")).toBe(true);
    expect(influxValue("2026-03-01T10:00:00.123456789Z", "dateTime:RFC3339Nano")).toBe("2026-03-01T10:00:00.123Z");
    expect(influxValue("x", "string")).toBe("x");
  });
});

describe("annotated CSV", () => {
  const csv = [
    "#datatype,string,long,dateTime:RFC3339,string,double",
    "#group,false,false,false,true,false",
    "#default,_result,,,,",
    ",result,table,_time,host,usage",
    ',,0,2026-03-01T10:00:00Z,"a,b",1.5',
    ",,0,2026-03-01T11:00:00Z,c,",
    "",
    "#datatype,string,long,string",
    "#group,false,false,false",
    "#default,_result,,",
    ",result,table,note",
    ',,1,"say ""hi"""',
    "",
  ].join("\r\n");
  it("reads tables, quoted cells and defaults", () => {
    const tables = parseAnnotatedCsv(csv);
    expect(tables).toHaveLength(2);
    expect(tables[0].columns.map((c) => c.name)).toEqual(["result", "table", "_time", "host", "usage"]);
    expect(tables[0].columns[3]).toMatchObject({ datatype: "string", group: true });
    expect(tables[0].rows[0]).toEqual(["_result", "0", "2026-03-01T10:00:00Z", "a,b", "1.5"]);
    expect(tables[1].rows[0][2]).toBe('say "hi"');
  });
  it("throws the error InfluxDB reports in it", () => {
    expect(() => parseAnnotatedCsv("#datatype,string,string\n#group,true,true\n#default,,\n,error,reference\n,runtime error: boom,\n")).toThrow("runtime error: boom");
  });
});

describe("days in a time zone", () => {
  it("finds a day's start, across a change of clocks", () => {
    expect(new Date(dayStart("2026-03-01", "Europe/Amsterdam")).toISOString()).toBe("2026-02-28T23:00:00.000Z");
    expect(new Date(dayStart("2026-03-29", "Europe/Amsterdam", 1)).toISOString()).toBe("2026-03-29T22:00:00.000Z");
    expect(new Date(dayStart("2026-03-29T03:59", "Europe/Amsterdam", 1)).toISOString()).toBe("2026-03-29T02:00:00.000Z");
    expect(dayIn(Date.parse("2026-02-28T23:30:00Z"), "Europe/Amsterdam")).toBe("2026-03-01");
  });
  it("reads a time's nanoseconds", () => {
    expect(nanosOf("1970-01-01T00:00:01.000000002Z")).toBe(1_000_000_002n);
    expect(nanosOf("nope")).toBeNull();
  });
});

describe("filters", () => {
  it("compares text case-insensitively, literally", () => {
    expect(filterFlux(columns.get("host")!, { column: "host", operator: "contains", value: "a.b" }, "UTC")).toBe('(if exists r["host"] then r["host"] else "") =~ /(?i)a\\.b/');
    expect(filterFlux(columns.get("host")!, { column: "host", operator: "is", value: "A" }, "UTC")).toContain("=~ /(?i)^A$/");
  });
  it("compares numbers and checkboxes, nothing for a value that isn't one", () => {
    expect(filterFlux(columns.get("usage")!, { column: "usage", operator: "gt", value: "3" }, "UTC")).toBe('(exists r["usage"] and float(v: r["usage"]) > float(v: "3"))');
    expect(filterFlux(columns.get("usage")!, { column: "usage", operator: "gt", value: "x" }, "UTC")).toBe("false");
    expect(filterFlux(columns.get("ok")!, { column: "ok", operator: "isNotChecked", value: "" }, "UTC")).toBe('(not (exists r["ok"] and r["ok"] == true))');
  });
  it("compares a date & time by its day in the time zone", () => {
    expect(filterFlux(columns.get("_time")!, { column: "_time", operator: "is", value: "2026-03-01" }, "Europe/Amsterdam")).toBe(
      '(exists r["_time"] and r["_time"] >= 2026-02-28T23:00:00.000Z and r["_time"] < 2026-03-01T23:00:00.000Z)',
    );
  });
  it("compares a date & time with minutes in the time zone, the last one included", () => {
    expect(filterFlux(columns.get("_time")!, { column: "_time", operator: "between", value: "2026-03-01T10:00..2026-03-01T10:59" }, "Europe/Amsterdam")).toBe(
      '(exists r["_time"] and r["_time"] >= 2026-03-01T09:00:00.000Z and r["_time"] < 2026-03-01T10:00:00.000Z)',
    );
  });
  it("narrows a measurement's range to the days filtered on", () => {
    expect(rangeOf({ and: [{ column: "_time", operator: "after", value: "2026-03-01" }] }, "UTC")).toEqual({ start: "2026-03-02T00:00:00.000Z", stop: "2262-01-01T00:00:00.000Z" });
    expect(rangeOf({ and: [] }, "UTC").start).toBe("1970-01-01T00:00:00.000Z");
    const none = rangeOf({ and: [{ column: "_time", operator: "before", value: "2026-01-01" }, { column: "_time", operator: "after", value: "2026-02-01" }] }, "UTC");
    expect(Date.parse(none.stop)).toBeGreaterThan(Date.parse(none.start));
  });
  it("narrows the range only by rules every row must meet (not those under an or)", () => {
    const after = { column: "_time", operator: "after" as const, value: "2026-03-01" };
    const host = { column: "host", operator: "is" as const, value: "a" };
    expect(rangeOf({ or: [after, host] }, "UTC").start).toBe("1970-01-01T00:00:00.000Z");
    expect(rangeOf({ and: [{ or: [after] }, { or: [host, after] }] }, "UTC").start).toBe("2026-03-02T00:00:00.000Z");
  });
});

describe("scripts", () => {
  it("reads a measurement pivoted, its rows told apart by time and series", () => {
    const flux = rowsFlux(query({ filter: { and: [{ column: "_time", operator: "after", value: "2026-03-01" }] } }), columns);
    expect(flux).toContain('from(bucket: "metrics")\n  |> range(start: 2026-03-02T00:00:00.000Z, stop: 2262-01-01T00:00:00.000Z)');
    expect(flux).toContain('r._measurement == "cpu"');
    expect(flux).toContain('pivot(rowKey: ["_time"], columnKey: ["_field"], valueColumn: "_value")');
    expect(flux).toContain('_id: string(v: r._time) + ",host=" + (if exists r["host"] then r["host"] else "")');
    expect(flux).toMatch(/\|> sort\(columns: \["_id"\], desc: false\)\n {2}\|> limit\(n: 11, offset: 0\)\n {2}\|> keep\(columns: \["_id","host","usage"\]\)$/);
  });
  it("sorts empty values last, flipping numbers sorted the other way", () => {
    const flux = rowsFlux(query({ sort: [{ column: "$title", direction: "desc" }, { column: "usage", direction: "asc" }] }), columns);
    expect(flux.startsWith('import "strings"\n')).toBe(true);
    expect(flux).toContain("_kubus_s1: (if exists r[\"usage\"] then 0.0 - float(v: r[\"usage\"]) else 0.0)");
    expect(flux).toContain('sort(columns: ["_kubus_e0","_kubus_s0","_kubus_e1","_kubus_s1","_id"], desc: true)');
  });
  it("places grouped rows by their group's place", () => {
    const q = query({ groupBy: "_time", groupOrder: "count", timeZone: "Europe/Amsterdam" });
    expect(groupsFlux(q, columns)).toContain('sort(columns: ["_kubus_e","_kubus_n","_kubus_v"], desc: true)');
    const flux = rowsFlux(q, columns, ["2026-02-28T23:00:00Z", ""]);
    expect(flux).toMatch(/^import "date"\nimport "timezone"\nimport "dict"\n_kubus_groups = dict\.fromList\(pairs: \[\{key: "2026-02-28T23:00:00Z", value: 0\}, \{key: "", value: 1\}\]\)\n/);
    expect(flux).toContain('timezone.location(name: "Europe/Amsterdam")');
    expect(groupKey(columns.get("_time")!, "2026-02-28T23:00:00Z", "Europe/Amsterdam")).toBe("2026-03-01");
    expect(groupKey(columns.get("usage")!, "3", "UTC")).toBe("3");
  });
  it("counts", () => {
    expect(totalFlux(query({ search: "x" }), columns)).toMatch(/filter\(fn: \(r\) => \(.*=~ \/\(\?i\)x\/ or .*\)\)\n {2}\|> keep\(columns: \["_time"\]\)\n {2}\|> map\(fn: \(r\) => \(\{r with _kubus_n: 1\}\)\)\n {2}\|> sum\(column: "_kubus_n"\)$/);
  });
  it("reads one row by its key in only its moment", () => {
    const flux = rowFlux({ ...query(), keyValue: "1970-01-01T00:00:01.000000002Z,host=a" }, columns)!;
    expect(flux).toContain("range(start: time(v: 1000000002), stop: time(v: 1000000003))");
    expect(flux).toContain('filter(fn: (r) => r._id == "1970-01-01T00:00:01.000000002Z,host=a")');
    expect(rowFlux({ ...query(), keyValue: "nope" }, columns)).toBeNull();
  });
  it("refuses unknown columns and pages out of range", () => {
    expect(() => rowsFlux(query({ columns: ["nope"] }), columns)).toThrow(/no column “nope”/);
    expect(() => rowsFlux(query({ limit: 100_000 }), columns)).toThrow(/limit/);
  });
});

describe("queries written in the app", () => {
  const written = (text: string) => query({ target: { query: text }, key: "host", columns: ["host"] });
  it("puts its tables together and pipes onto them, after its imports, its yield dropped", () => {
    const flux = rowsFlux({ ...written('import "strings"\nfrom(bucket: "b")\n  |> range(start: -1h)\n  |> yield(name: "x")\n'), groupBy: "host" }, columns, ["a"]);
    expect(flux).toMatch(/^import "dict"\nimport "strings"\n_kubus_groups = dict\.fromList\(pairs: \[\{key: "a", value: 0\}\]\)\nfrom\(bucket: "b"\)/);
    expect(flux).toContain('from(bucket: "b")\n  |> range(start: -1h)\n  |> group()\n  |> map(');
    expect(flux).not.toContain("yield");
  });
  it("only reads", () => {
    expect(() => checkFlux('from(bucket: "a") |> range(start: -1h) |> to(bucket: "b")')).toThrow(/to\(\)/);
    expect(() => checkFlux('f = to\nfrom(bucket: "a") |> f(bucket: "b")')).toThrow(/to\(\)/);
    expect(() => checkFlux('import "http"\nhttp.post(url: "http://x")')).toThrow(/import/);
    expect(() => checkFlux('import "experimental"\nfrom(bucket: "a") |> experimental.to(bucket: "b")')).toThrow(/import/);
    expect(() => checkFlux('import s "sql"\ns.to()')).toThrow(/import/);
    expect(() => checkFlux('x = "${to(bucket: "b")}"')).toThrow(/to\(\)/);
    expect(() => checkFlux('x = /"/\nfrom(bucket: "a") |> to(bucket: "b")')).toThrow(/to\(\)/);
  });
  it("lets reading through", () => {
    expect(checkFlux('import "strings"\n// convert to celsius\nfrom(bucket: "a") |> range(start: -1h) |> map(fn: (r) => ({r with x: r.to, y: "to(", z: 2.0 / 3.0}))')).toEqual({
      imports: [{ path: "strings", alias: null }],
      importsEnd: 16,
    });
  });
});

describe("fieldColumns", () => {
  it("gives each field key one column, named apart from the tags, the time and the key", () => {
    expect(
      fieldColumns(
        [["b", "long"], ["a", "string"], ["b", "double"], ["mixed", "long"], ["mixed", "boolean"], ["room", "double"], ["room (field)", "string"], ["_id", "string"]],
        ["room"],
      ),
    ).toEqual([
      { name: "_id (field)", field: "_id", datatype: "string" },
      { name: "a", field: "a", datatype: "string" },
      { name: "b", field: "b", datatype: "double" },
      { name: "mixed", field: "mixed", datatype: "string" },
      { name: "room (field 2)", field: "room", datatype: "double" },
      { name: "room (field)", field: "room (field)", datatype: "string" },
    ]);
  });
});
