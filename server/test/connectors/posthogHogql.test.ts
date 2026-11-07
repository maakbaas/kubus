// @vitest-environment node
// The PostHog connector's HogQL without PostHog: how columns are read, how values are written in (escaped,
// never as the user's HogQL) and what a query becomes.
import { describe, expect, it } from "vitest";
import { bareType, phColumn, probeSql, querySql, rowSql, str, tableName, type PhColumn } from "../../src/connectors/posthogHogql.ts";
import type { SourceQuery } from "../../../shared/sources.ts";

const col = (name: string, ch: string | null, schema: string | null = null) => phColumn(name, ch, schema)!;
const columns = new Map<string, PhColumn>(
  [col("uuid", "UUID"), col("event", "String"), col("timestamp", "DateTime64(6, 'UTC')"), col("$is_bounce", "UInt8", "boolean"), col("$pageview_count", "Nullable(Int64)"), col("day", "Date"), col("urls", "Array(String)"), col("properties", "String", "json")].map((c) => [c.name, c]),
);

const query = (over: Partial<SourceQuery> = {}): SourceQuery => ({
  target: { table: { schema: null, name: "events" } },
  key: "uuid",
  columns: ["event", "timestamp"],
  title: ["event"],
  untitled: "Event",
  filter: { and: [] },
  search: "",
  sort: [],
  groupBy: null,
  groupOrder: "asc",
  timeZone: "Europe/Amsterdam",
  offset: 0,
  limit: 100,
  counts: false,
  ...over,
});

describe("phColumn", () => {
  it("reads ClickHouse types, the schema's JSON and booleans winning", () => {
    expect(bareType("Nullable(LowCardinality(String))")).toBe("String");
    expect(col("a", "Nullable(Float64)")).toMatchObject({ kind: "number" });
    expect(col("a", "Bool")).toMatchObject({ kind: "checkbox" });
    expect(col("a", "UInt8", "boolean")).toMatchObject({ kind: "checkbox" });
    expect(col("a", "Date32")).toMatchObject({ kind: "date" });
    expect(col("a", "DateTime64(6, 'UTC')")).toMatchObject({ kind: "datetime" });
    expect(col("a", "Array(LowCardinality(String))")).toMatchObject({ kind: "string_list" });
    expect(col("properties", "String")).toMatchObject({ kind: "string", plain: true, hidden: true });
    expect(phColumn("a", "Map(String, String)")).toBeNull();
    expect(phColumn("a", "Array(Tuple(String, Int8))")).toBeNull();
    expect(col("a", null, "integer")).toMatchObject({ kind: "number" });
    expect(col("a", null, "expression")).toMatchObject({ kind: "string" });
  });
});

describe("literals and names", () => {
  it("escapes what goes into a statement", () => {
    expect(str("it's a \\ test\n")).toBe("'it\\'s a \\\\ test\\n'");
    expect(tableName("stripe.customer`s")).toBe("`stripe`.`customer\\`s`");
    expect(probeSql("sessions", ["$is_bounce", "session_id"])).toBe("SELECT `$is_bounce`, `session_id` FROM `sessions` LIMIT 1");
  });
});

describe("querySql", () => {
  it("pages a table, the key breaking ties", () => {
    const q = querySql(query({ sort: [{ column: "timestamp", direction: "desc" }] }), columns);
    expect(q.rows).toBe("SELECT toString(`uuid`), `event`, `timestamp` FROM `events` WHERE true ORDER BY `timestamp` DESC NULLS LAST, `uuid` ASC LIMIT 101 OFFSET 0");
    expect(q.total).toBeUndefined();
  });

  it("asks at most POSTHOG_PAGE rows at once", () => {
    expect(querySql(query({ limit: 10_000 }), columns)).toMatchObject({ pageRows: 5000 });
    expect(querySql(query({ limit: 10_000 }), columns).rows).toContain("LIMIT 5001");
  });

  it("filters a date & time by its day in the device's zone, on the column itself", () => {
    const q = querySql(query({ counts: true, filter: { column: "timestamp", operator: "is", value: "2024-07-01" } }), columns);
    // Amsterdam is UTC+2 in July: the day starts at 22:00 UTC the day before.
    const start = Date.UTC(2024, 5, 30, 22) / 1000;
    expect(q.total).toBe(`SELECT count() FROM \`events\` WHERE ((\`timestamp\` >= fromUnixTimestamp(${start}) AND \`timestamp\` < fromUnixTimestamp(${start + 86400})))`);
  });

  it("writes text, numbers, checkboxes and lists as the app means them", () => {
    const where = (filter: SourceQuery["filter"]) => querySql(query({ counts: true, filter }), columns).total!.split(" WHERE ")[1];
    expect(where({ column: "event", operator: "contains", value: "50%_off's" })).toBe("(ifNull(toString(`event`), '') ILIKE '%50\\\\%\\\\_off\\'s%')");
    expect(where({ column: "event", operator: "is", value: "$pageview" })).toBe("(lower(ifNull(toString(`event`), '')) = lower('$pageview'))");
    expect(where({ column: "$pageview_count", operator: "gt", value: "1; DROP" })).toBe("(false)");
    expect(where({ column: "$pageview_count", operator: "isNot", value: "1" })).toBe("((`$pageview_count` IS NULL OR `$pageview_count` != 1))");
    expect(where({ column: "$is_bounce", operator: "isChecked", value: "" })).toBe("(ifNull(toInt(`$is_bounce`), 0) = 1)");
    expect(where({ column: "day", operator: "between", value: "2024-01-01..2024-01-31" })).toBe("((`day` >= toDate('2024-01-01') AND `day` <= toDate('2024-01-31')))");
    expect(where({ column: "urls", operator: "is", value: "/" })).toBe("(has(arrayMap(x -> lower(toString(x)), `urls`), lower('/')))");
    expect(where({ or: [{ column: "event", operator: "isEmpty", value: "" }, { column: "$is_bounce", operator: "isNotChecked", value: "" }] })).toBe(
      "(((`event` IS NULL OR toString(`event`) = '')) OR (ifNull(toInt(`$is_bounce`), 0) = 0))",
    );
    expect(() => where({ column: "properties", operator: "is", value: "x" })).toThrow(/can't be filtered/);
    expect(() => where({ column: "nope", operator: "is", value: "x" })).toThrow(/no column/);
  });

  it("searches text columns only", () => {
    expect(querySql(query({ counts: true, search: "sign", columns: ["event", "$pageview_count"] }), columns).total).toBe(
      "SELECT count() FROM `events` WHERE (ifNull(toString(`event`), '') ILIKE '%sign%')",
    );
  });

  it("groups by a value, the empty group last, by size or value", () => {
    const q = querySql(query({ counts: true, groupBy: "$is_bounce", groupOrder: "count" }), columns);
    expect(q.rows).toContain("if(ifNull(toInt(`$is_bounce`), 0) = 1, 'yes', 'no') AS kubus_group, count() OVER (PARTITION BY kubus_group) AS kubus_group_size");
    expect(q.rows).toContain("ORDER BY kubus_group = '' ASC, kubus_group_size DESC, if(kubus_group = 'yes', 0, 1) ASC, `uuid` ASC");
    expect(q.groups).toBe(
      "SELECT if(ifNull(toInt(`$is_bounce`), 0) = 1, 'yes', 'no') AS kubus_group, count() AS n FROM `events` WHERE true GROUP BY kubus_group ORDER BY kubus_group = '' ASC, n DESC, if(kubus_group = 'yes', 0, 1) ASC LIMIT 1000",
    );
    expect(querySql(query({ counts: true, groupBy: "timestamp" }), columns).groups).toContain("formatDateTime(toTimeZone(`timestamp`, 'Europe/Amsterdam'), '%Y-%m-%d')");
    expect(querySql(query({ counts: true, groupBy: "urls" }), columns).groups).toContain("arrayJoin(if(empty(`urls`), [''], arrayMap(x -> toString(x), `urls`)))");
    expect(() => querySql(query({ groupBy: "timestamp", timeZone: "Mars/Olympus') --" }), columns)).toThrow(/time zone/);
  });

  it("sorts by the title, and refuses what isn't a table", () => {
    expect(querySql(query({ sort: [{ column: "$title", direction: "asc" }] }), columns).rows).toContain("ORDER BY lower(coalesce(nullIf(trimBoth(ifNull(toString(`event`), '')), ''), 'Event')) ASC NULLS LAST");
    expect(() => querySql(query({ target: { query: "SELECT 1" } }), columns)).toThrow(/tables only/);
  });

  it("reads one row by its key as text", () => {
    expect(rowSql({ ...query(), keyValue: "a'b" }, columns)).toBe("SELECT toString(`uuid`), `event`, `timestamp` FROM `events` WHERE toString(`uuid`) = 'a\\'b' LIMIT 1");
  });
});
