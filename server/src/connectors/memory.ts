import { MAX_SOURCE_GROUPS, MAX_SOURCE_PAGE, TITLE_COLUMN, type SourceColumn, type SourceCondition, type SourceFilter, type SourceQuery, type SourceResult, type SourceRow, type SourceShape, type SourceValue } from "../../../shared/sources.ts";
import { SourceError } from "./connector.ts";

// Queries answered in memory, for connectors whose source can't run them itself (an API with a
// flat filter, one sort and no counts: n8n's data tables). The connector reads a table's rows (as
// the app stores values: datetimes ISO 8601 UTC, dates yyyy-mm-dd) and this filters, searches,
// sorts, groups, counts and pages them as postgresSql.ts does in SQL, which follows the app's own
// applyQuery: text compared case-insensitively, empty values last both ways, a date & time on the
// day it is in the device's time zone, the key breaking ties. Text sorts as the app's does
// ("Customer 9" before "Customer 10"). Pure, tested in app/src/data/remote/memory.test.ts. Lists
// (string_list) aren't read by any connector that uses it yet, so it doesn't take them.

/** A row: its values by column name. */
export type MemoryRow = Record<string, SourceValue>;

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function column(columns: Map<string, SourceColumn>, name: string): SourceColumn {
  const c = columns.get(name);
  if (!c) throw new SourceError(`There is no column “${name}” (refresh the collection's columns)`);
  return c;
}

/** The day (yyyy-mm-dd) a date & time is on in a time zone. */
function dayIn(timeZone: string): (iso: string) => string | null {
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  } catch {
    throw new SourceError(`Unknown time zone “${timeZone}”`);
  }
  return (iso) => {
    const t = Date.parse(iso);
    return Number.isNaN(t) ? null : format.format(t);
  };
}

/** A value's text, as filters and search compare it ("" for none). */
const textOf = (v: SourceValue) => (v === null ? "" : Array.isArray(v) ? v.join(", ") : String(v));

/** One filter rule as a test. A value that can't be compared matches nothing (as in the app). */
export function ruleTest(c: SourceColumn, rule: SourceFilter, day: (iso: string) => string | null): (row: MemoryRow) => boolean {
  const value = rule.value.trim();
  const op = rule.operator;
  const get = (row: MemoryRow) => row[c.name] ?? null;
  const refuse = () => {
    throw new SourceError(`“${c.name}” can't be filtered with ${op}`);
  };
  const never = () => false;
  if (c.kind === "string") {
    const needle = value.toLowerCase();
    const text = (row: MemoryRow) => textOf(get(row)).toLowerCase();
    switch (op) {
      case "contains":
        return (row) => text(row).includes(needle);
      case "notContains":
        return (row) => !text(row).includes(needle);
      case "isEmpty":
        return (row) => text(row) === "";
      case "isNotEmpty":
        return (row) => text(row) !== "";
      case "is":
      case "isNot":
        if (c.plain) return refuse();
        return op === "is" ? (row) => text(row) === needle : (row) => text(row) !== needle;
      default:
        return refuse();
    }
  }
  if (c.kind === "number") {
    if (op === "isEmpty") return (row) => typeof get(row) !== "number";
    if (op === "isNotEmpty") return (row) => typeof get(row) === "number";
    const n = Number(value);
    if (value === "" || !Number.isFinite(n)) return never;
    const num = (row: MemoryRow) => {
      const v = get(row);
      return typeof v === "number" ? v : null;
    };
    switch (op) {
      case "is":
        return (row) => num(row) === n;
      case "isNot":
        return (row) => num(row) !== n;
      case "gt":
        return (row) => (num(row) ?? -Infinity) > n;
      case "lt":
        return (row) => (num(row) ?? Infinity) < n;
      default:
        return refuse();
    }
  }
  if (c.kind === "checkbox") {
    switch (op) {
      case "isChecked":
        return (row) => get(row) === true;
      case "isNotChecked":
        return (row) => get(row) !== true;
      case "is":
        if (!/^(true|false)$/i.test(value)) return never;
        return value.toLowerCase() === "true" ? (row) => get(row) === true : (row) => get(row) !== true;
      default:
        return refuse();
    }
  }
  if (c.kind !== "date" && c.kind !== "datetime") return refuse();
  // Dates, and dates & times by the day they are on in the device's time zone.
  const dayOf = (row: MemoryRow) => {
    const v = get(row);
    if (typeof v !== "string" || v === "") return null;
    return c.kind === "date" ? v.slice(0, 10) : day(v);
  };
  if (op === "isEmpty") return (row) => dayOf(row) === null;
  if (op === "isNotEmpty") return (row) => dayOf(row) !== null;
  let from: string;
  let to: string;
  if (op === "between") {
    const [start, end] = value.split("..");
    if (!DAY.test(start ?? "") || !DAY.test(end ?? "")) return never;
    [from, to] = [start, end];
  } else {
    if (!DAY.test(value)) return never;
    [from, to] = [value, value];
  }
  const test = (pass: (d: string) => boolean) => (row: MemoryRow) => {
    const d = dayOf(row);
    return d !== null && pass(d);
  };
  switch (op) {
    case "is":
    case "between":
      return test((d) => d >= from && d <= to);
    case "before":
      return test((d) => d < from);
    case "after":
      return test((d) => d > from);
    default:
      return refuse();
  }
}

/** A condition tree as one test. */
function conditionTest(c: SourceCondition, columns: Map<string, SourceColumn>, day: (iso: string) => string | null): (row: MemoryRow) => boolean {
  if ("and" in c) {
    const tests = c.and.map((x) => conditionTest(x, columns, day));
    return (row) => tests.every((t) => t(row));
  }
  if ("or" in c) {
    const tests = c.or.map((x) => conditionTest(x, columns, day));
    return (row) => tests.some((t) => t(row));
  }
  return ruleTest(column(columns, c.column), c, day);
}

/** The title (the app's itemLabel): the first non-blank of the title columns, else the untitled name. */
function titleOf(row: MemoryRow, shape: SourceShape): string {
  for (const name of shape.title) {
    const text = textOf(row[name] ?? null);
    if (text.trim() !== "") return text;
  }
  return shape.untitled;
}

type Key = string | number | null;

/** A sort key: comparable, null for none (sorted last). */
function sortKeyOf(c: SourceColumn): (row: MemoryRow) => Key {
  if (c.plain) throw new SourceError(`“${c.name}” can't be sorted`);
  return (row) => {
    const v = row[c.name] ?? null;
    if (c.kind === "checkbox") return v === true ? 1 : 0; // unchecked is a value, not empty
    if (v === null || v === "") return null;
    if (typeof v === "number") return v;
    if (c.kind === "datetime") return Date.parse(String(v));
    return textOf(v).toLowerCase();
  };
}

/** As the app compares sort keys (compareKeys in domain/query.ts), empty last either way. */
function compareKeys(a: Key, b: Key, direction: 1 | -1): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  if (typeof a === "number" && typeof b === "number") return (a - b) * direction;
  return String(a).localeCompare(String(b), undefined, { numeric: true }) * direction;
}

/** The group a row is in, as text ("" for none), as postgresSql.ts makes it. */
function groupKeyOf(c: SourceColumn, day: (iso: string) => string | null): (row: MemoryRow) => string {
  if (c.plain) throw new SourceError(`“${c.name}” can't be grouped`);
  return (row) => {
    const v = row[c.name] ?? null;
    if (c.kind === "checkbox") return v === true ? "yes" : "no";
    if (v === null) return "";
    if (c.kind === "datetime") return day(String(v)) ?? "";
    if (c.kind === "date") return String(v).slice(0, 10);
    return textOf(v);
  };
}

/** A query over rows: its page, and (with `counts`) its total and groups. */
export function queryRows(rows: MemoryRow[], columns: Map<string, SourceColumn>, query: SourceQuery): SourceResult {
  if (!Number.isInteger(query.offset) || query.offset < 0) throw new SourceError("offset must be a whole number");
  if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > MAX_SOURCE_PAGE) throw new SourceError(`limit must be 1 to ${MAX_SOURCE_PAGE}`);
  const day = dayIn(query.timeZone);
  const keyColumn = column(columns, query.key);
  for (const name of query.columns) column(columns, name);
  for (const name of query.title) column(columns, name);

  const pass = conditionTest(query.filter, columns, day);
  const needle = query.search.trim().toLowerCase();
  const found = rows.filter((row) => pass(row) && (!needle || query.columns.some((name) => textOf(row[name] ?? null).toLowerCase().includes(needle))));

  const sorts = query.sort.map((s) => ({
    key: s.column === TITLE_COLUMN ? (row: MemoryRow) => titleOf(row, query).toLowerCase() : sortKeyOf(column(columns, s.column)),
    direction: (s.direction === "desc" ? -1 : 1) as 1 | -1,
  }));
  const keyOf = sortKeyOf(keyColumn);
  const keyed = found.map((row) => ({ row, keys: sorts.map((s) => s.key(row)), id: keyOf(row) }));
  keyed.sort((a, b) => {
    for (let i = 0; i < sorts.length; i++) {
      const d = compareKeys(a.keys[i], b.keys[i], sorts[i].direction);
      if (d) return d;
    }
    return compareKeys(a.id, b.id, 1);
  });

  let ordered: { row: MemoryRow; group?: string }[] = keyed;
  let groups: { key: string; count: number }[] | undefined;
  if (query.groupBy) {
    const group = column(columns, query.groupBy);
    const groupOf = groupKeyOf(group, day);
    const byGroup = new Map<string, MemoryRow[]>();
    for (const { row } of keyed) {
      const g = groupOf(row);
      byGroup.set(g, [...(byGroup.get(g) ?? []), row]);
    }
    const value = (g: string): Key => (g === "" ? null : group.kind === "number" ? Number(g) : group.kind === "checkbox" ? (g === "yes" ? 0 : 1) : g);
    const direction = query.groupOrder === "desc" ? -1 : 1;
    const order = [...byGroup.keys()].sort((a, b) => {
      if ((a === "") !== (b === "")) return a === "" ? 1 : -1;
      if (query.groupOrder === "count") {
        const d = byGroup.get(b)!.length - byGroup.get(a)!.length;
        if (d) return d;
      }
      return compareKeys(value(a), value(b), direction);
    });
    ordered = order.flatMap((g) => byGroup.get(g)!.map((row) => ({ row, group: g })));
    groups = order.slice(0, MAX_SOURCE_GROUPS).map((g) => ({ key: g, count: byGroup.get(g)!.length }));
  }

  const page = ordered.slice(query.offset, query.offset + query.limit).map(({ row, group }) => {
    const r = toRow(row, query);
    if (query.groupBy) r.group = group ?? "";
    return r;
  });
  const result: SourceResult = { rows: page, more: ordered.length > query.offset + query.limit };
  if (query.counts) {
    result.total = found.length;
    if (groups) result.groups = groups;
  }
  return result;
}

/** One row by its key (compared as text), or null. */
export function findRow(rows: MemoryRow[], columns: Map<string, SourceColumn>, request: SourceShape & { keyValue: string }): SourceRow | null {
  column(columns, request.key);
  for (const name of request.columns) column(columns, name);
  const row = rows.find((r) => textOf(r[request.key] ?? null) === request.keyValue);
  return row ? toRow(row, request) : null;
}

function toRow(row: MemoryRow, shape: SourceShape): SourceRow {
  return { key: textOf(row[shape.key] ?? null), values: shape.columns.map((name) => row[name] ?? null) };
}
