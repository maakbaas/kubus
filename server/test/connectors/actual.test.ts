// @vitest-environment node
// The Actual Budget connector (server/src/connectors/actual.ts) against a stand-in for actual-http-api.
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActualConnector, actualEndpoint, dateFilter, monthsKept } from "../../src/connectors/actual.ts";
import { SourceError } from "../../src/connectors/connector.ts";
import type { SourceQuery } from "../../../shared/sources.ts";

const ACCOUNTS = [
  { id: "a1", name: "Checking", offbudget: false, closed: false, clearedBalance: 150000, unclearedBalance: -4550, workingBalance: 145450 },
  { id: "a2", name: "Savings", offbudget: true, closed: false, clearedBalance: 50000, unclearedBalance: 0, workingBalance: 50000 },
];
const PAYEES = [
  { id: "p1", name: "Grocer", transfer_acct: null },
  { id: "p2", name: "", transfer_acct: "a2" },
  { id: "p3", name: "Employer", transfer_acct: null },
];
const GROUPS = [
  { id: "g1", name: "Food", is_income: false, hidden: false, categories: [{ id: "c1", name: "Groceries", is_income: false, hidden: false, group_id: "g1" }] },
  { id: "g2", name: "Income", is_income: true, hidden: false, categories: [{ id: "c2", name: "Salary", is_income: true, hidden: true, group_id: "g2" }] },
];
const CATEGORIES = GROUPS.flatMap((g) => g.categories.map((c) => ({ ...c, group: g.id })));
/** As Actual stores them: a split's parent and its parts. */
const TRANSACTIONS = [
  { id: "t1", date: "2026-03-02", account: "a1", payee: "p1", category: "c1", amount: -4550, notes: "Milk", cleared: false, reconciled: false, is_parent: false, is_child: false, parent_id: null, transfer_id: null, imported_payee: "GROCER 12" },
  { id: "t2", date: "2026-03-05", account: "a1", payee: "p3", category: "c2", amount: 300000, notes: null, cleared: true, reconciled: true, is_parent: false, is_child: false, parent_id: null, transfer_id: null, imported_payee: null },
  { id: "t3", date: "2026-03-10", account: "a1", payee: "p1", category: null, amount: -10000, notes: "Split", cleared: true, reconciled: false, is_parent: true, is_child: false, parent_id: null, transfer_id: null, imported_payee: null },
  { id: "t3a", date: "2026-03-10", account: "a1", payee: "p1", category: "c1", amount: -6000, notes: null, cleared: true, reconciled: false, is_parent: false, is_child: true, parent_id: "t3", transfer_id: null, imported_payee: null },
  { id: "t3b", date: "2026-03-10", account: "a1", payee: "p1", category: null, amount: -4000, notes: null, cleared: true, reconciled: false, is_parent: false, is_child: true, parent_id: "t3", transfer_id: null, imported_payee: null },
  { id: "t4", date: "2026-02-20", account: "a1", payee: "p2", category: null, amount: -50000, notes: null, cleared: true, reconciled: false, is_parent: false, is_child: false, parent_id: null, transfer_id: "t5", imported_payee: null },
];
const MONTHS: Record<string, unknown> = {
  "2026-02": { month: "2026-02", categoryGroups: [{ ...GROUPS[0], categories: [{ ...GROUPS[0].categories[0], budgeted: 40000, spent: 0, balance: 40000, carryover: false }] }] },
  "2026-03": {
    month: "2026-03",
    categoryGroups: [
      { ...GROUPS[0], categories: [{ ...GROUPS[0].categories[0], budgeted: 40000, spent: -10550, balance: 69450, carryover: true }] },
      { ...GROUPS[1], categories: [{ ...GROUPS[1].categories[0], received: 300000 }] },
    ],
  },
};
const SCHEDULES = [
  { id: "s1", name: "Rent", rule: "r1", next_date: "2026-04-01", completed: false, posts_transaction: true, payee: "p1", account: "a1", amount: -120000, amountOp: "is", date: { frequency: "monthly", interval: 1, start: "2026-01-01", endMode: "never" } },
  { id: "s2", name: "Power", rule: "r2", next_date: "2026-05-01", completed: false, posts_transaction: false, payee: "p2", account: null, amount: { num1: -5000, num2: -7000 }, amountOp: "isbetween", date: { frequency: "weekly", interval: 2, start: "2026-01-01", endMode: "never" } },
];

const TABLES: Record<string, Record<string, unknown>[]> = { transactions: TRANSACTIONS, accounts: ACCOUNTS, payees: PAYEES, categories: CATEGORIES, category_groups: GROUPS };
/** Where a reference leads (ActualQL's joins). */
const REFS: Record<string, Record<string, string>> = {
  transactions: { account: "accounts", payee: "payees", category: "categories" },
  payees: { transfer_acct: "accounts" },
  categories: { group: "category_groups" },
};
function path(table: string, row: Record<string, unknown> | undefined, fields: string[]): unknown {
  if (!row) return null;
  const [field, ...rest] = fields;
  if (!rest.length) return row[field] ?? null;
  const to = REFS[table]?.[field];
  return to ? path(to, TABLES[to].find((r) => r.id === row[field]), rest) : null;
}

/** ActualQL as far as the connector uses it: splits inline, date and id filters, aliased selects, a count. */
function runQuery(q: { table: string; options?: { splits?: string }; filter?: Record<string, unknown>; select?: (string | Record<string, string>)[]; calculate?: unknown; limit?: number }) {
  if (q.table !== "transactions" || q.options?.splits !== (q.calculate ? undefined : "inline")) throw new Error(`unexpected query ${JSON.stringify(q)}`);
  const tests: ((t: Record<string, unknown>) => boolean)[] = [];
  const add = (f: Record<string, unknown>) => {
    if (Array.isArray(f.$and)) return f.$and.forEach(add);
    if (typeof f.id === "string") return tests.push((t) => t.id === f.id);
    const [op, v] = Object.entries(f.date as Record<string, string>)[0];
    if (v < "1995-01-01") throw new Error(`Invalid date: ${v}`);
    tests.push((t) => {
      const d = String(t.date);
      return ({ $gte: d >= v, $lte: d <= v, $gt: d > v, $lt: d < v } as Record<string, boolean>)[op];
    });
  };
  if (q.filter) add(q.filter);
  const rows = TRANSACTIONS.filter((t) => !t.is_parent && tests.every((test) => test(t)));
  if (q.calculate) return rows.length;
  return rows.slice(0, q.limit).map((t) =>
    Object.fromEntries((q.select ?? []).map((s) => (typeof s === "string" ? [s, path("transactions", t, [s])] : [Object.keys(s)[0], path("transactions", t, Object.values(s)[0].split("."))]))),
  );
}

interface Options {
  experimental?: boolean;
  balances?: boolean;
  encrypted?: boolean;
}

/** actual-http-api (at /actual/v1): `{ data }` or `{ error }`, as its error handler answers. */
function stub({ experimental = true, balances = true, encrypted = false }: Options = {}) {
  const requests: { url: URL; method: string; headers: Headers; body?: unknown }[] = [];
  vi.stubGlobal("fetch", async (input: string, init: RequestInit) => {
    const url = new URL(input);
    const headers = new Headers(init.headers);
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ url, method: init.method ?? "GET", headers, body });
    const data = (d: unknown) => Response.json({ data: d });
    const error = (status: number, e: string) => Response.json({ error: e }, { status });
    if (url.pathname === "/actual/v1/budgets") return data([{ id: "My-Finances-1", groupId: "sync-1", name: "My Finances" }, { cloudFileId: "f1", groupId: "sync-1", name: "My Finances", encryptKeyId: encrypted ? "k1" : null }]);
    const m = /^\/actual\/v1\/budgets\/([^/]+)(\/.*)$/.exec(url.pathname);
    if (!m) return new Response("<html>Actual</html>", { status: 200, headers: { "content-type": "text/html" } });
    if (headers.get("x-api-key") !== "secret") return error(403, "Forbidden");
    if (m[1] !== "sync-1") return error(404, `Budget "${m[1]}" not found. Check the sync id of your budget in the Advanced section of the settings page.`);
    if (encrypted && headers.get("budget-encryption-password") !== "pw") return error(500, "Unknown error while interacting with Actual Api. See server logs for more information");
    const route = m[2];
    if (init.method === "POST" && route === "/run-query") return experimental ? data(runQuery(body.ActualQLquery)) : error(501, "This operation is experimental and is currently disabled.");
    if (init.method !== "GET") return error(405, "Not allowed");
    if (route === "/accounts") return data(balances ? ACCOUNTS : ACCOUNTS.map(({ id, name, offbudget, closed }) => ({ id, name, offbudget, closed })));
    const balance = /^\/accounts\/([^/]+)\/balance$/.exec(route);
    if (balance) return data(ACCOUNTS.find((a) => a.id === balance[1])!.workingBalance);
    if (route === "/payees") return data(PAYEES);
    if (route === "/categorygroups") return data(GROUPS);
    if (route === "/schedules") return data(SCHEDULES);
    if (route === "/months") return data(Object.keys(MONTHS));
    const month = /^\/months\/(\d{4}-\d{2})$/.exec(route);
    if (month && MONTHS[month[1]]) return data(MONTHS[month[1]]);
    return error(404, "Not found");
  });
  return requests;
}

const config = (fields: Record<string, string> = {}, password = "secret") => ({ name: "Budget", kind: "actual", fields: { address: "api.example.com/actual", budget: "sync-1", ...fields }, password, schemas: [], timeoutMs: 5000 });
const query = (table: string, over: Partial<SourceQuery> = {}): SourceQuery => ({
  target: { table: { schema: null, name: table } },
  key: "id",
  columns: [],
  title: [],
  untitled: table,
  filter: { and: [] },
  search: "",
  sort: [],
  groupBy: null,
  groupOrder: "asc",
  timeZone: "UTC",
  offset: 0,
  limit: 100,
  counts: true,
  ...over,
});
const values = async (connector: ActualConnector, table: string, columns: string[], over: Partial<SourceQuery> = {}) =>
  (await connector.query(query(table, { columns, sort: [{ column: "id", direction: "asc" }], ...over }))).rows.map((r) => r.values);
/** Every request a read: GETs, and POSTs only to run-query. */
const onlyReads = (requests: { url: URL; method: string }[]) => requests.every((r) => r.method === "GET" || (r.method === "POST" && r.url.pathname.endsWith("/run-query")));

afterEach(() => vi.unstubAllGlobals());

describe("Actual Budget connector", () => {
  it("reads its endpoint from its address", () => {
    expect(actualEndpoint("http://localhost:5007")).toBe("http://localhost:5007/v1");
    expect(actualEndpoint("api.example.com/actual/v1/")).toBe("https://api.example.com/actual/v1");
  });

  it("offers its curated tables only, keyed by id", async () => {
    stub();
    const connector = new ActualConnector(config());
    expect((await connector.tables()).map((t) => t.name)).toEqual(["Transactions", "Accounts", "Categories", "Payees", "Schedules", "Budget months"]);
    const d = await connector.describe({ table: { schema: null, name: "Transactions" } });
    expect(d.key).toEqual(["id"]);
    expect(d.columns.filter((c) => !c.hidden).map((c) => [c.name, c.kind])).toEqual([
      ["date", "date"], ["account", "string"], ["payee", "string"], ["category", "string"], ["category_group", "string"], ["amount", "number"], ["notes", "string"],
      ["cleared", "checkbox"], ["reconciled", "checkbox"], ["transfer", "checkbox"], ["split", "checkbox"],
    ]);
    await expect(connector.describe({ query: "SELECT 1" })).rejects.toThrow(/tables only/);
    await expect(connector.describe({ table: { schema: null, name: "Rules" } })).rejects.toThrow(/no table/);
    expect(() => new ActualConnector(config({ budget: " " }))).toThrow(/sync ID/);
  });

  it("reads transactions in one run-query, with names, amounts from cents and splits as their parts", async () => {
    const requests = stub();
    const connector = new ActualConnector(config());
    const rows = await values(connector, "Transactions", ["date", "account", "payee", "category", "category_group", "amount", "transfer", "split", "parent_id"]);
    expect(rows).toEqual([
      ["2026-03-02", "Checking", "Grocer", "Groceries", "Food", -45.5, false, false, null],
      ["2026-03-05", "Checking", "Employer", "Salary", "Income", 3000, false, false, null],
      ["2026-03-10", "Checking", "Grocer", "Groceries", "Food", -60, false, true, "t3"],
      ["2026-03-10", "Checking", "Grocer", null, null, -40, false, true, "t3"],
      ["2026-02-20", "Checking", "Savings", null, null, -500, true, false, null],
    ]);
    // Another page and the counts come from the same read.
    await connector.query(query("Transactions", { columns: ["amount"], offset: 2, limit: 2 }));
    expect(requests.length).toBe(1);
    expect(requests[0]).toMatchObject({ method: "POST" });
    expect(requests[0].url.pathname).toBe("/actual/v1/budgets/sync-1/run-query");
    expect(requests[0].headers.get("x-api-key")).toBe("secret");
    expect(requests[0].headers.has("budget-encryption-password")).toBe(false);
    expect(onlyReads(requests)).toBe(true);
  });

  it("sends a filter's required date bounds, and filters exactly in memory", async () => {
    const requests = stub();
    const connector = new ActualConnector(config());
    const march = { column: "date", operator: "between", value: "2026-03-01..2026-03-31" } as const;
    const result = await connector.query(query("Transactions", { columns: ["amount"], filter: { and: [march, { column: "payee", operator: "is", value: "grocer" }] } }));
    expect(result.total).toBe(3);
    expect(requests[0].body).toMatchObject({ ActualQLquery: { filter: { $and: [{ date: { $gte: "2026-03-01" } }, { date: { $lte: "2026-03-31" } }] } } });
    // Under an `or`, or before 1995 (ActualQL refuses those), nothing is sent.
    expect(dateFilter({ or: [march, { column: "date", operator: "after", value: "2026-01-01" }] })).toBeNull();
    expect(dateFilter({ and: [{ column: "date", operator: "before", value: "1990-01-01" }] })).toBeNull();
    expect(dateFilter({ and: [{ column: "date", operator: "is", value: "2026-03-10" }] })).toEqual({ $and: [{ date: { $gte: "2026-03-10" } }, { date: { $lte: "2026-03-10" } }] });
    // One transaction by its id is read alone.
    expect(await connector.row({ ...query("Transactions", { columns: ["amount", "notes"] }), keyValue: "t1" })).toEqual({ key: "t1", values: [-45.5, "Milk"] });
    expect(requests.at(-1)!.body).toMatchObject({ ActualQLquery: { filter: { id: "t1" } } });
  });

  it("reads accounts with balances, categories with groups, payees and schedules", async () => {
    const requests = stub();
    const connector = new ActualConnector(config());
    expect(await values(connector, "Accounts", ["name", "balance", "cleared_balance", "off_budget"])).toEqual([["Checking", 1454.5, 1500, false], ["Savings", 500, 500, true]]);
    expect(await values(connector, "Categories", ["name", "group", "income", "hidden"])).toEqual([["Groceries", "Food", false, false], ["Salary", "Income", true, true]]);
    expect(await values(connector, "Payees", ["name", "transfer", "transfer_account"])).toEqual([["Grocer", false, null], ["Savings", true, "Savings"], ["Employer", false, null]]);
    expect(await values(connector, "Schedules", ["name", "next_date", "payee", "account", "amount", "amount_op", "repeats", "posts_transaction"])).toEqual([
      ["Rent", "2026-04-01", "Grocer", "Checking", -1200, "is", "monthly", true],
      ["Power", "2026-05-01", "Savings", null, -60, "isbetween", "every 2 weeks", false],
    ]);
    // The accounts were read once, shared by the payees and schedules.
    expect(requests.filter((r) => r.url.pathname.endsWith("/accounts")).length).toBe(1);
    expect(requests.every((r) => r.method === "GET")).toBe(true);
  });

  it("asks an older actual-http-api for each account's balance", async () => {
    const requests = stub({ balances: false });
    expect(await values(new ActualConnector(config()), "Accounts", ["name", "balance", "cleared_balance"])).toEqual([["Checking", 1454.5, null], ["Savings", 500, null]]);
    expect(requests.map((r) => r.url.pathname)).toEqual(["/actual/v1/budgets/sync-1/accounts", "/actual/v1/budgets/sync-1/accounts/a1/balance", "/actual/v1/budgets/sync-1/accounts/a2/balance"]);
  });

  it("reads budget months as month × category, only the months a filter keeps", async () => {
    const requests = stub();
    const connector = new ActualConnector(config());
    expect(await values(connector, "Budget months", ["month", "group", "category", "budgeted", "spent", "received", "balance", "carryover", "income"], { sort: [{ column: "month", direction: "asc" }] })).toEqual([
      ["2026-02-01", "Food", "Groceries", 400, 0, null, 400, false, false],
      ["2026-03-01", "Food", "Groceries", 400, -105.5, null, 694.5, true, false],
      ["2026-03-01", "Income", "Salary", null, null, 3000, null, false, true],
    ]);
    requests.length = 0;
    const connector2 = new ActualConnector(config());
    const march = await connector2.query(query("Budget months", { columns: ["category"], filter: { and: [{ column: "month", operator: "after", value: "2026-02-15" }] } }));
    expect(march.rows.map((r) => r.key)).toEqual(["2026-03:c1", "2026-03:c2"]);
    expect(requests.map((r) => r.url.pathname.replace("/actual/v1/budgets/sync-1", ""))).toEqual(["/months", "/months/2026-03"]);
    expect(monthsKept(["2026-01", "2026-02", "2026-03"], { and: [{ column: "month", operator: "between", value: "2026-02-01..2026-02-28" }] })).toEqual(["2026-02"]);
    // One row by its id reads its month alone.
    requests.length = 0;
    expect(await new ActualConnector(config()).row({ ...query("Budget months", { columns: ["budgeted"] }), keyValue: "2026-02:c1" })).toEqual({ key: "2026-02:c1", values: [400] });
    expect(requests.map((r) => r.url.pathname)).toEqual(["/actual/v1/budgets/sync-1/months/2026-02"]);
  });

  it("checks the budget, warning when run-query is off and failing transactions in words", async () => {
    let requests = stub();
    expect(await new ActualConnector(config()).check()).toEqual([]);
    expect(onlyReads(requests)).toBe(true);
    requests = stub({ experimental: false });
    const connector = new ActualConnector(config());
    const warnings = await connector.check();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/EXPERIMENTAL_OPERATIONS_ENABLED=false/);
    await expect(connector.query(query("Transactions", { columns: ["amount"] }))).rejects.toThrow(/EXPERIMENTAL_OPERATIONS_ENABLED=false/);
    // A plain Error (the source's problem), not a request's mistake.
    expect(await connector.query(query("Transactions")).catch((e: unknown) => e)).not.toBeInstanceOf(SourceError);
    expect((await connector.query(query("Accounts", { columns: ["name"] }))).total).toBe(2);
  });

  it("tells a wrong key, budget or address", async () => {
    stub();
    await expect(new ActualConnector(config({}, "wrong")).check()).rejects.toThrow(/refused the API key/);
    await expect(new ActualConnector(config({ budget: "sync-2" })).check()).rejects.toThrow(/no budget with the sync ID “sync-2”/);
    await expect(new ActualConnector(config({ address: "api.example.com" })).check()).rejects.toThrow(/not as actual-http-api/);
  });

  it("opens an encrypted budget with its encryption password, and says when it is missing or wrong", async () => {
    let requests = stub({ encrypted: true });
    await expect(new ActualConnector(config()).check()).rejects.toThrow(/end-to-end encrypted: set its encryption password/);
    await expect(new ActualConnector(config()).query(query("Accounts", { columns: ["name"] }))).rejects.toThrow(/set its encryption password/);
    await expect(new ActualConnector(config({ encryption: "nope" })).query(query("Accounts", { columns: ["name"] }))).rejects.toThrow(/check its encryption password/);
    requests = stub({ encrypted: true });
    const connector = new ActualConnector(config({ encryption: "pw" }));
    expect(await connector.check()).toEqual([]);
    expect((await connector.query(query("Transactions", { columns: ["amount"] }))).total).toBe(5);
    const budgetRequests = requests.filter((r) => r.url.pathname.startsWith("/actual/v1/budgets/"));
    expect(budgetRequests.length).toBeGreaterThan(0);
    expect(budgetRequests.every((r) => r.headers.get("budget-encryption-password") === "pw")).toBe(true);
  });
});
