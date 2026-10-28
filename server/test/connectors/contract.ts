// The contract every connector keeps (shared/sources.ts), run against a real service (or the closest
// stand-in): the same questions are asked of a connector and of the memory connector's `queryRows` on
// the rows the service holds, which is the app's own meaning (applyQuery) in code. A fixture says what
// the service holds (its columns as the app should read them, and every row's values); `contractCases`
// derives from that every filter operator of each column's type, every sort, grouping and page, and
// `runContract` checks the answers equal the reference's, then the errors a bad request gets.
import { expect, it } from "vitest";
import { SourceError, type Connector } from "../../src/connectors/connector.ts";
import { queryRows, type MemoryRow, type TextCompare } from "../../src/connectors/memory.ts";
import { TITLE_COLUMN, type SourceColumn, type SourceCondition, type SourceFilter, type SourceOperator, type SourceQuery, type SourceResult, type SourceRow, type SourceTarget } from "../../../shared/sources.ts";

/** What a service holds, and how the connector should read it. */
export interface Fixture {
  connector: Connector;
  target: SourceTarget;
  /** The columns the app should get (name, kind, plain), in this order; a connector may add hidden ones (a synthetic key). */
  columns: SourceColumn[];
  /** Every row's values by column name, as the app stores them. */
  rows: MemoryRow[];
  /** The key column (unique, in every row). */
  key: string;
  /** The key `describe` reports where it isn't that column (a synthetic one the connector adds). */
  describedKey?: string[];
  /** The title columns, in order. */
  title: string[];
  /** Time zones to compare dates & times in (the first is UTC-like; others move days). */
  timeZones?: string[];
  /** Operators a connector is allowed not to know, by column. */
  unsupported?: (column: SourceColumn, operator: SourceOperator) => boolean;
  /** How the source orders texts, where it isn't the app's (docs/sync.md "Known limits"). */
  text?: TextCompare;
  /** Rows that tie on every sort may come in either order (a source that breaks ties its own way); the pages still must not overlap. */
  looseTies?: boolean;
}

const KINDS_BY_OPERATOR: Record<SourceColumn["kind"], SourceOperator[]> = {
  string: ["contains", "notContains", "is", "isNot", "isEmpty", "isNotEmpty"],
  number: ["is", "isNot", "gt", "lt", "isEmpty", "isNotEmpty"],
  checkbox: ["isChecked", "isNotChecked", "is"],
  date: ["is", "before", "after", "between", "isEmpty", "isNotEmpty"],
  datetime: ["is", "before", "after", "between", "isEmpty", "isNotEmpty"],
  string_list: ["contains", "notContains", "isEmpty", "isNotEmpty"],
};

export const baseQuery = (fx: Pick<Fixture, "target" | "key" | "columns" | "title">, over: Partial<SourceQuery> = {}): SourceQuery => ({
  target: fx.target,
  key: fx.key,
  columns: fx.columns.map((c) => c.name),
  title: fx.title,
  untitled: "Thing",
  filter: { and: [] },
  search: "",
  sort: [{ column: TITLE_COLUMN, direction: "asc" }],
  groupBy: null,
  groupOrder: "asc",
  timeZone: "UTC",
  offset: 0,
  limit: 100,
  counts: true,
  ...over,
});

/** The values a column holds, distinct, in the rows' order. */
function present(fx: Fixture, name: string): unknown[] {
  const seen = new Map<string, unknown>();
  for (const row of fx.rows) {
    const v = row[name];
    if (v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length)) continue;
    seen.set(JSON.stringify(v), v);
  }
  return [...seen.values()];
}

const DAY_MS = 86_400_000;
const dayOf = (v: unknown) => String(v).slice(0, 10);
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

/** Rules for a column: each operator with the values worth asking (present ones, near misses, odd ones). */
export function rulesFor(fx: Fixture, c: SourceColumn): SourceFilter[] {
  const values = present(fx, c.name);
  const rule = (operator: SourceOperator, value: string): SourceFilter => ({ column: c.name, operator, value });
  const out: SourceFilter[] = [];
  const first = values[0];
  const middle = values[Math.floor(values.length / 2)];
  const ops = KINDS_BY_OPERATOR[c.kind].filter((op) => !(c.plain && ["is", "isNot"].includes(op)) && !fx.unsupported?.(c, op));
  for (const op of ops) {
    switch (c.kind) {
      case "string":
        if (op === "isEmpty" || op === "isNotEmpty") out.push(rule(op, ""));
        else {
          for (const v of [first, middle]) {
            const text = String(v);
            out.push(rule(op, text), rule(op, text.toUpperCase()), rule(op, text.slice(1, 4)));
          }
          // Characters that mean something in SQL, LIKE, regular expressions and Flux.
          if (op === "contains" || op === "is") out.push(rule(op, "no such text"), rule(op, "%"), rule(op, "_"), rule(op, "'"), rule(op, '"'), rule(op, "\\"), rule(op, "  "));
        }
        break;
      case "number":
        if (op === "isEmpty" || op === "isNotEmpty") out.push(rule(op, ""));
        else {
          for (const v of [first, middle]) out.push(rule(op, String(v)));
          out.push(rule(op, "0"), rule(op, "-1"), rule(op, "1.5"), rule(op, "x"), rule(op, ""));
        }
        break;
      case "checkbox":
        if (op === "is") out.push(rule(op, "true"), rule(op, "false"), rule(op, "maybe"));
        else out.push(rule(op, ""));
        break;
      case "string_list":
        if (op === "isEmpty" || op === "isNotEmpty") out.push(rule(op, ""));
        else out.push(rule(op, String((first as string[])[0])), rule(op, String((first as string[])[0]).toUpperCase()), rule(op, "no such"));
        break;
      default: {
        // date, datetime
        if (op === "isEmpty" || op === "isNotEmpty") {
          out.push(rule(op, ""));
          break;
        }
        const days = values.map(dayOf).sort();
        const lo = days[0];
        const hi = days.at(-1)!;
        const mid = days[Math.floor(days.length / 2)];
        if (op === "between") {
          out.push(rule(op, `${lo}..${hi}`), rule(op, `${mid}..${mid}`), rule(op, `${addDays(lo, -3)}..${addDays(lo, -1)}`), rule(op, `${hi}..${lo}`), rule(op, "nonsense"));
          if (c.kind === "datetime") {
            const t = String(values.find((v) => dayOf(v) === mid));
            const minute = t.slice(0, 16);
            out.push(rule(op, `${minute}..${minute}`), rule(op, `${mid}T00:00..${mid}T23:59`), rule(op, `${mid}T00:00..${addDays(mid, 1)}`));
          }
        } else {
          for (const d of [lo, mid, hi, addDays(hi, 1)]) out.push(rule(op, d));
          out.push(rule(op, "yesterday"));
        }
      }
    }
  }
  return out;
}

export interface Case {
  name: string;
  query: Partial<SourceQuery>;
}

/** Every question worth asking of a fixture. */
export function contractCases(fx: Fixture): Case[] {
  const cases: Case[] = [];
  const zones = fx.timeZones ?? ["UTC", "Pacific/Auckland", "America/Los_Angeles"];
  const readable = fx.columns.filter((c) => !c.plain);
  for (const c of fx.columns) {
    const rules = rulesFor(fx, c);
    for (const rule of rules) {
      const zoned = c.kind === "datetime";
      for (const timeZone of zoned ? zones.slice(0, 2) : [zones[0]]) cases.push({ name: `filter ${c.name} ${rule.operator} ${JSON.stringify(rule.value)}${zoned ? ` in ${timeZone}` : ""}`, query: { filter: rule, timeZone, sort: [{ column: fx.key, direction: "asc" }] } });
    }
  }
  // Trees: and / or / nested / empty, with a rule of each type.
  const some = fx.columns.flatMap((c) => rulesFor(fx, c).slice(0, 2));
  const tree = (x: SourceCondition) => x;
  cases.push(
    { name: "empty and", query: { filter: { and: [] } } },
    { name: "empty or", query: { filter: { or: [] } } },
    { name: "and of all", query: { filter: tree({ and: some.slice(0, 4) }) } },
    { name: "or of all", query: { filter: tree({ or: some.slice(0, 6) }) } },
    { name: "nested", query: { filter: tree({ and: [{ or: some.slice(0, 3) }, { and: [{ or: some.slice(3, 5) }, some[5]] }] }) } },
    { name: "a rule that can't match among others", query: { filter: tree({ or: [{ and: [] }, some[0]] }) } },
  );
  // Sorting: each column both ways, the title, several keys.
  for (const c of readable) for (const direction of ["asc", "desc"] as const) cases.push({ name: `sort ${c.name} ${direction}`, query: { sort: [{ column: c.name, direction }] } });
  for (const direction of ["asc", "desc"] as const) cases.push({ name: `sort title ${direction}`, query: { sort: [{ column: TITLE_COLUMN, direction }] } });
  cases.push({ name: "no sort (the key breaks ties)", query: { sort: [] } });
  if (readable.length >= 2) cases.push({ name: "sort by two columns", query: { sort: [{ column: readable[1].name, direction: "desc" }, { column: readable[0].name, direction: "asc" }] } });
  // Search: text found in any read column, case-insensitively.
  const texts = fx.columns.filter((c) => c.kind === "string" && !c.plain);
  for (const c of texts.slice(0, 2)) {
    const v = String(present(fx, c.name)[1] ?? present(fx, c.name)[0]);
    cases.push({ name: `search ${c.name} text`, query: { search: v.slice(0, 4).toUpperCase() } }, { name: `search ${c.name} text padded`, query: { search: `  ${v.slice(0, 3)}  ` } });
  }
  cases.push({ name: "search for nothing", query: { search: "no such text anywhere" } }, { name: "search a wildcard", query: { search: "%" } }, { name: "search a number", query: { search: "1" } });
  // Paging: every size and offset, walking the whole result.
  for (const [offset, limit] of [[0, 1], [0, 3], [2, 3], [3, 5], [fx.rows.length - 1, 5], [fx.rows.length, 5], [fx.rows.length + 10, 5], [0, fx.rows.length], [0, fx.rows.length - 1]]) cases.push({ name: `page offset ${offset} limit ${limit}`, query: { offset, limit } });
  cases.push({ name: "without counts", query: { counts: false, limit: 3 } });
  // Grouping: each column, each order, with a page in the middle of the groups.
  for (const c of readable) {
    for (const groupOrder of ["asc", "desc", "count"] as const) {
      for (const timeZone of c.kind === "datetime" ? zones : [zones[0]]) cases.push({ name: `group by ${c.name} ${groupOrder}${c.kind === "datetime" ? ` in ${timeZone}` : ""}`, query: { groupBy: c.name, groupOrder, timeZone } });
    }
    cases.push({ name: `group by ${c.name}, paged`, query: { groupBy: c.name, offset: 2, limit: 3 }});
    cases.push({ name: `group by ${c.name} without counts`, query: { groupBy: c.name, counts: false, limit: 4 } });
  }
  // Columns: a subset in another order, only the key.
  cases.push({ name: "some columns, reordered", query: { columns: [...fx.columns.map((c) => c.name)].reverse().slice(0, 3) } }, { name: "the key alone", query: { columns: [fx.key] } });
  return cases;
}

/** A result in one line: the keys of its rows, whether more follow, the total and the groups. */
function describeResult(r: unknown): string {
  if (typeof r === "string") return r;
  const x = r as SourceResult;
  const groups = x.groups ? ` groups ${x.groups.map((g) => `${g.key}:${g.count}`).join("|")}` : "";
  return `rows [${x.rows.map((row) => (row.group === undefined ? row.key : `${row.group}/${row.key}`)).join(" ")}] more ${x.more} total ${x.total}${groups}`;
}

/** The first row whose values differ, for the failure's report. */
function firstDifference(got: unknown, want: unknown): string {
  if (typeof got === "string" || typeof want === "string") return "";
  const [g, w] = [(got as SourceResult).rows, (want as SourceResult).rows];
  const i = g.findIndex((row, n) => JSON.stringify(row) !== JSON.stringify(w[n]));
  return i < 0 ? "" : `\n  first difference, row ${i}: want ${JSON.stringify(w[i])} got ${JSON.stringify(g[i])}`;
}

/** The answer the app's meaning gives. */
export function reference(fx: Fixture, query: SourceQuery) {
  return queryRows(fx.rows, new Map(fx.columns.map((c) => [c.name, c])), query, fx.text);
}

/** What a row is sorted by, comparable as text: its group, then the value of each sort column (the title, lower-cased). */
function orderOf(fx: Fixture, query: SourceQuery, row: { key: string; group?: string }): string {
  const source = fx.rows.find((r) => String(r[fx.key]) === row.key)!;
  const parts = query.sort.map((s) => {
    if (s.column === TITLE_COLUMN) return fx.title.map((t) => String(source[t] ?? "")).find((t) => t.trim() !== "")?.toLowerCase() ?? query.untitled.toLowerCase();
    const c = fx.columns.find((x) => x.name === s.column)!;
    const v = source[s.column] ?? null;
    if (c.kind === "checkbox") return v === true;
    if (v === null || v === "" || (Array.isArray(v) && !v.length)) return null;
    return Array.isArray(v) ? v.join(", ").toLowerCase() : typeof v === "string" ? v.toLowerCase() : v;
  });
  return JSON.stringify([row.group ?? null, ...parts]);
}

/** Whether two lists of rows come in the same order, rows that tie (and so are in either order) aside: all of them must be there when the list is `whole`. */
function sameRows(fx: Fixture, query: SourceQuery, got: SourceRow[], want: SourceRow[], whole: boolean): boolean {
  if (got.length !== want.length) return false;
  const orders = got.map((r, i) => [orderOf(fx, query, r), orderOf(fx, query, want[i])]);
  if (orders.some(([a, b]) => a !== b)) return false;
  // A whole list (no page cuts a tie): the same rows in each run of ties.
  if (whole) {
    for (let i = 0; i < got.length; ) {
      let j = i;
      while (j < got.length && orders[j][0] === orders[i][0]) j++;
      const keys = (rows: SourceRow[]) => rows.slice(i, j).map((r) => r.key).sort().join();
      if (keys(got) !== keys(want)) return false;
      i = j;
    }
  }
  return true;
}

/** Whether an answer is the reference's; with `looseTies`, rows that tie may swap places (and so a page that cuts a tie may differ). */
function same(fx: Fixture, query: SourceQuery, got: SourceResult, want: SourceResult): boolean {
  if (!fx.looseTies) return JSON.stringify(got) === JSON.stringify(want);
  const whole = query.offset === 0 && !want.more;
  if (JSON.stringify({ ...got, rows: 0, groups: 0 }) !== JSON.stringify({ ...want, rows: 0, groups: 0 })) return false;
  if (query.groupBy) {
    // Groups that tie (of the same size, or that the source's order doesn't tell apart) come in either order.
    const [g, w] = [got.groups ?? [], want.groups ?? []];
    if (g.length !== w.length) return false;
    const tied = (a: { key: string; count: number }, b: { key: string; count: number }) =>
      query.groupOrder === "count" ? a.count === b.count : (fx.text ?? ((x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0)))(a.key.toLowerCase(), b.key.toLowerCase()) === 0 && a.key !== "" === (b.key !== "");
    const classes = new Map<string, number>();
    w.forEach((x, i) => classes.set(x.key, i > 0 && tied(w[i - 1], x) ? classes.get(w[i - 1].key)! : i));
    if (!g.every((x, i) => classes.get(x.key) === classes.get(w[i].key) && x.count === w.find((y) => y.key === x.key)?.count)) return false;
    if (!whole) return got.rows.length === want.rows.length;
    const byGroup = (rows: SourceRow[]) => {
      const out = new Map<string, SourceRow[]>();
      for (const r of rows) out.set(r.group ?? "", [...(out.get(r.group ?? "") ?? []), r]);
      return out;
    };
    const [gr, wr] = [byGroup(got.rows), byGroup(want.rows)];
    return gr.size === wr.size && [...wr].every(([key, rows]) => gr.has(key) && sameRows(fx, query, gr.get(key)!, rows, true));
  }
  if (JSON.stringify(got.groups) !== JSON.stringify(want.groups)) return false;
  return sameRows(fx, query, got.rows, want.rows, whole);
}

/** Runs the contract's checks as tests of the current describe. `get` gives the fixture (made once). */
export function runContract(get: () => Fixture, options: { errors?: boolean; timeoutMs?: number; concurrency?: number } = {}) {
  const timeout = options.timeoutMs ?? 120_000;
  it("describes its columns as the app should read them", async () => {
    const fx = get();
    const d = await fx.connector.describe(fx.target);
    const byName = new Map(d.columns.map((c) => [c.name, c]));
    for (const want of fx.columns) {
      const got = byName.get(want.name);
      expect(got, `column ${want.name}`).toBeDefined();
      expect({ kind: got!.kind, plain: !!got!.plain }, `column ${want.name}`).toEqual({ kind: want.kind, plain: !!want.plain });
    }
    expect(d.key).toEqual(fx.describedKey ?? [fx.key]);
  });

  it("answers every filter, sort, search, page and grouping as the app's own meaning does", async () => {
    const fx = get();
    const failures: string[] = [];
    const cases = contractCases(fx);
    const ask = async ({ name, query }: Case) => {
      const q = baseQuery(fx, query);
      let got: unknown;
      let want: unknown;
      try {
        want = reference(fx, q);
      } catch (e) {
        want = `error: ${(e as Error).message}`;
      }
      try {
        got = await fx.connector.query(q);
      } catch (e) {
        got = `error: ${(e as Error).message}`;
      }
      const ok = typeof want === "string" ? typeof got === "string" : typeof got !== "string" && same(fx, q, got as SourceResult, want as SourceResult);
      if (!ok) failures.push(`${name}\n  want ${describeResult(want)}\n  got  ${describeResult(got)}${firstDifference(got, want)}`);
    };
    // A few at a time: a service answers several requests at once.
    const queue = [...cases];
    await Promise.all(Array.from({ length: options.concurrency ?? 6 }, async () => {
      for (let next = queue.shift(); next; next = queue.shift()) await ask(next);
    }));
    const n = cases.length;
    expect(n).toBeGreaterThan(50);
    expect(failures.join("\n\n")).toBe("");
  }, timeout);

  it("pages never overlap or skip a row, whatever the sort or grouping", async () => {
    const fx = get();
    const everyKey = fx.rows.map((r) => String(r[fx.key])).sort();
    const readable = fx.columns.filter((c) => !c.plain);
    const orders: Partial<SourceQuery>[] = [
      { sort: [{ column: TITLE_COLUMN, direction: "asc" }] },
      { sort: [] },
      ...readable.flatMap((c) => (["asc", "desc"] as const).map((direction) => ({ sort: [{ column: c.name, direction }] }))),
      ...readable.map((c) => ({ groupBy: c.name })),
    ];
    for (const order of orders) {
      const seen: string[] = [];
      for (let offset = 0; offset < fx.rows.length * 4; offset += 3) {
        const page = await fx.connector.query(baseQuery(fx, { ...order, offset, limit: 3, counts: false }));
        seen.push(...page.rows.map((r) => (r.group === undefined ? r.key : `${r.group}\u0000${r.key}`)));
        if (!page.more) break;
      }
      // A grouped list column lists a row under each of its values; the others once.
      const keys = [...new Set(seen.map((k) => k.split("\u0000").at(-1)!))].sort();
      expect(new Set(seen).size, JSON.stringify(order)).toBe(seen.length);
      expect(keys, JSON.stringify(order)).toEqual(everyKey);
    }
  }, timeout);

  it("reads one row by its key, every row, and none for a key it hasn't", async () => {
    const fx = get();
    const shape = baseQuery(fx);
    for (const row of fx.rows) {
      const got = await fx.connector.row({ ...shape, keyValue: String(row[fx.key]) });
      expect(got, `row ${row[fx.key]}`).toEqual({ key: String(row[fx.key]), values: shape.columns.map((name) => row[name] ?? null) });
    }
    expect(await fx.connector.row({ ...shape, keyValue: "no such key" })).toBeNull();
    expect(await fx.connector.row({ ...shape, keyValue: "-12345" })).toBeNull();
  });

  if (options.errors !== false) {
    it("refuses a request it can't answer as a SourceError (not a failure of the source)", async () => {
      const fx = get();
      const q = (over: Partial<SourceQuery>) => baseQuery(fx, over);
      const numeric = fx.columns.find((c) => c.kind === "number");
      const bad: [string, Partial<SourceQuery>][] = [
        ["an unknown column", { columns: ["no_such_column"] }],
        ["an unknown filter column", { filter: { column: "no_such_column", operator: "is", value: "x" } }],
        ["an unknown sort column", { sort: [{ column: "no_such_column", direction: "asc" }] }],
        ["an unknown group column", { groupBy: "no_such_column" }],
        ["an unknown key", { key: "no_such_column" }],
        ["a negative offset", { offset: -1 }],
        ["a limit of 0", { limit: 0 }],
        ["a limit past the largest page", { limit: 10_001 }],
        ["a fractional limit", { limit: 1.5 }],
        ["an unknown time zone", { timeZone: "Mars/Olympus", filter: { column: fx.columns.find((c) => c.kind === "datetime")?.name ?? fx.key, operator: "is", value: "2026-03-01" } }],
        ...(numeric ? ([["an operator the type doesn't have", { filter: { column: numeric.name, operator: "contains", value: "1" } }]] as [string, Partial<SourceQuery>][]) : []),
      ];
      for (const [what, over] of bad) {
        const error = await fx.connector.query(q(over)).then(() => null, (e: unknown) => e);
        // Where the reference accepts it (an unknown time zone with no datetime column), nothing to refuse.
        let refused = true;
        try {
          reference(fx, q(over));
          refused = false;
        } catch {
          // Refused by the reference: so must the connector.
        }
        if (refused) {
          expect(error, what).toBeInstanceOf(SourceError);
        }
      }
    });
  }
}
