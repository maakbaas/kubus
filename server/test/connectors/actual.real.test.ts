// @vitest-environment node
// The Actual Budget connector against a real Actual server behind a real actual-http-api (KUBUS_TEST_ACTUAL:
// actualSeed.ts), asked the shared contract's questions (contract.ts) of the dataset's people as transactions.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ActualConnector } from "../../src/connectors/actual.ts";
import { SourceError } from "../../src/connectors/connector.ts";
import type { MemoryRow } from "../../src/connectors/memory.ts";
import type { SourceColumn } from "../../../shared/sources.ts";
import { baseQuery, runContract, type Fixture } from "./contract.ts";
import { PEOPLE, type Person } from "./dataset.ts";
import { ACTUAL, addTransactions, API_KEY, budgetId, call, empty, makeAccount, makeCategory, makeGroup } from "./actualSeed.ts";

// (Not required in CI: it takes two services and a mounted seed script, which a job's service containers can't have; tests/services.yml.)

const config = (budget: string, over: { address?: string; password?: string; timeoutMs?: number; encryption?: string } = {}) => ({
  name: "Money",
  kind: "actual",
  fields: { address: over.address ?? ACTUAL ?? "", budget, ...(over.encryption && { encryption: over.encryption }) },
  password: over.password ?? API_KEY,
  schemas: [],
  timeoutMs: over.timeoutMs ?? 60_000,
});

const COLUMNS: SourceColumn[] = [
  { name: "date", type: "date", kind: "date" },
  { name: "account", type: "string", kind: "string" },
  { name: "payee", type: "string", kind: "string" },
  { name: "category", type: "string", kind: "string" },
  { name: "category_group", type: "string", kind: "string" },
  { name: "amount", type: "amount", kind: "number" },
  { name: "notes", type: "string", kind: "string" },
  { name: "cleared", type: "boolean", kind: "checkbox" },
  { name: "imported_payee", type: "string", kind: "string", hidden: true },
];

// A person as a transaction: the day it was last seen (Actual makes a budget month of every month back to the
// first transaction), its name the payee, its first tag the category (Actual's names differ by more than case), its city the notes, its score the amount.
const dayOf = (p: Person) => p.seen?.slice(0, 10) ?? "2026-01-15";
const accountOf = (p: Person) => (p.city === "Cairo" ? "Savings" : "Checking");
const cents = (p: Person) => Math.round((p.score ?? 0) * 100);

describe.skipIf(!ACTUAL)("Actual Budget connector, against Actual", () => {
  let id: string;
  let connector: ActualConnector;
  let fixture: Fixture;

  beforeAll(async () => {
    id = await budgetId();
    await empty(id);
    const accounts = { Checking: await makeAccount(id, "Checking"), Savings: await makeAccount(id, "Savings") };
    const group = await makeGroup(id, "Usual");
    const categories = new Map<string, string>();
    for (const name of new Set(PEOPLE.flatMap((p) => p.tags ?? []).map((t) => t.toLowerCase()))) categories.set(name, await makeCategory(id, name, group));
    for (const account of ["Checking", "Savings"] as const) {
      await addTransactions(
        id,
        accounts[account],
        PEOPLE.filter((p) => accountOf(p) === account).map((p) => ({
          date: dayOf(p),
          amount: cents(p),
          payee_name: p.name?.trim() || undefined,
          category: p.tags?.[0] === undefined ? undefined : categories.get(p.tags[0].toLowerCase()),
          notes: p.city ?? undefined,
          cleared: p.active === true,
          imported_payee: String(p.id),
        })),
      );
    }
    connector = new ActualConnector(config(id));
    const rows: MemoryRow[] = PEOPLE.map((p) => ({
      date: dayOf(p),
      account: accountOf(p),
      payee: p.name?.trim() || null,
      category: p.tags?.[0]?.toLowerCase() ?? null,
      category_group: p.tags?.[0] === undefined ? null : "Usual",
      amount: cents(p) / 100,
      notes: p.city,
      cleared: p.active === true,
      imported_payee: String(p.id),
    }));
    fixture = { connector, target: { table: { schema: null, name: "Transactions" } }, columns: COLUMNS, rows, key: "imported_payee", describedKey: ["id"], title: ["payee", "notes"] };
  }, 180_000);

  afterAll(async () => {
    await connector?.close();
    if (id) await empty(id);
  });

  it("checks its key and budget", async () => {
    expect(await connector.check()).toEqual([]);
  });

  it("offers its curated tables", async () => {
    expect((await connector.tables()).map((t) => t.name)).toEqual(["Transactions", "Accounts", "Categories", "Payees", "Schedules", "Budget months"]);
  });

  runContract(() => fixture, { concurrency: 1 });

  describe("the other tables, and a budget with a bit of everything", () => {
    /** A table's query by column names. */
    const shapeOf = (table: string, columns: string[], key = "id") =>
      baseQuery({ target: { table: { schema: null, name: table } }, key, columns: columns.map((name) => ({ name, type: "", kind: "string" as const })), title: [columns[0]] });
    const all = (c: ActualConnector, table: string, columns: string[], key = "id") => c.query({ ...shapeOf(table, columns, key), limit: 1000, sort: [{ column: columns[0], direction: "asc" }] });
    let accounts: Record<string, string>;
    let categories: Record<string, string>;

    beforeAll(async () => {
      await empty(id);
      accounts = { Main: await makeAccount(id, "Main"), Vault: await makeAccount(id, "Vault", { offbudget: true }) };
      const bills = await makeGroup(id, "Bills");
      categories = { Rent: await makeCategory(id, "Rent", bills), Gas: await makeCategory(id, "Gas", bills, { hidden: true }) };
      const landlord = await call<string>("POST", `/budgets/${id}/payees`, { payee: { name: "Landlord" } });
      await addTransactions(id, accounts.Main, [
        { date: "2026-03-01", amount: -3000, payee: landlord, notes: "March", subtransactions: [{ amount: -1000, category: categories.Rent }, { amount: -2000, category: categories.Gas, notes: "gas" }] },
        { date: "2026-03-02", amount: 150000, notes: "pay", cleared: true },
      ]);
      await call("POST", `/budgets/${id}/schedules`, {
        schedule: { name: "Rent", account: accounts.Main, payee: landlord, amount: -90000, amountOp: "is", date: { start: "2026-11-01", frequency: "monthly", interval: 1, endMode: "never" }, posts_transaction: true },
      });
      await call("PATCH", `/budgets/${id}/months/2026-03/categories/${categories.Rent}`, { category: { budgeted: 90000 } });
    }, 120_000);

    it("reads split transactions as their parts, amounts from cents", async () => {
      const r = await all(connector, "Transactions", ["date", "amount", "category", "category_group", "payee", "notes", "split"], "date");
      expect(r.rows.map((x) => x.values)).toEqual([
        ["2026-03-01", -10, "Rent", "Bills", "Landlord", null, true],
        ["2026-03-01", -20, "Gas", "Bills", "Landlord", "gas", true],
        ["2026-03-02", 1500, null, null, null, "pay", false],
      ]);
      const parts = await all(connector, "Transactions", ["parent_id", "split"], "date");
      expect(parts.rows[0].values[0]).toBe(parts.rows[1].values[0]);
      expect(parts.rows[2].values[0]).toBeNull();
    });

    it("reads accounts with their balances, categories with their groups, payees with transfers, schedules and budget months", async () => {
      expect((await all(connector, "Accounts", ["name", "balance", "off_budget", "closed"], "name")).rows.map((x) => x.values)).toEqual([
        ["Main", 1470, false, false],
        ["Vault", 0, true, false],
      ]);
      const cats = (await all(connector, "Categories", ["name", "group", "income", "hidden"], "name")).rows.map((x) => x.values);
      expect(cats).toEqual([
        ["Gas", "Bills", false, true],
        ["Income", "Income", true, false],
        ["Rent", "Bills", false, false],
        ["Starting Balances", "Income", true, false],
      ]);
      const payees = (await all(connector, "Payees", ["name", "transfer", "transfer_account"], "name")).rows.map((x) => x.values);
      expect(payees).toEqual([["Landlord", false, null], ["Main", true, "Main"], ["Vault", true, "Vault"]]);
      const schedules = (await all(connector, "Schedules", ["name", "next_date", "payee", "account", "amount", "amount_op", "repeats", "completed", "posts_transaction"], "name")).rows.map((x) => x.values);
      expect(schedules).toEqual([["Rent", "2026-11-01", "Landlord", "Main", -900, "is", "monthly", false, true]]);
      const march = await connector.query({
        ...shapeOf("Budget months", ["month", "category", "budgeted", "spent", "balance"]),
        filter: { column: "month", operator: "between", value: "2026-03-01..2026-03-31" },
        sort: [{ column: "category", direction: "asc" }],
      });
      // (An income category has what it received, not a budget, spending or balance.)
      expect(march.rows.map((x) => x.values)).toEqual([
        ["2026-03-01", "Gas", 0, -20, -20],
        ["2026-03-01", "Income", null, null, null],
        ["2026-03-01", "Rent", 900, -10, 890],
        ["2026-03-01", "Starting Balances", null, null, null],
      ]);
      // Only the months the filter keeps are asked for (a request each): the other tests' filters on months stay cheap.
      expect(march.total).toBe(4);
    });

    it("finds one transaction and one budget month by their keys", async () => {
      // (Both parts of the split share a date: the amount settles which comes first.)
      const [first] = (await connector.query({ ...shapeOf("Transactions", ["date", "amount"]), sort: [{ column: "date", direction: "asc" }, { column: "amount", direction: "desc" }] })).rows;
      const shape = shapeOf("Transactions", ["amount", "notes"]);
      expect(await connector.row({ ...shape, keyValue: first.key })).toMatchObject({ key: first.key, values: [-10, null] });
      expect(await connector.row({ ...shape, keyValue: "no-such-id" })).toBeNull();
      const month = shapeOf("Budget months", ["category", "budgeted"]);
      expect(await connector.row({ ...month, keyValue: `2026-03:${categories.Rent}` })).toEqual({ key: `2026-03:${categories.Rent}`, values: ["Rent", 900] });
    });

    it("refuses a written query and a table it hasn't", async () => {
      await expect(connector.describe({ query: "SELECT 1" })).rejects.toThrow(/tables only/);
      await expect(connector.describe({ table: { schema: null, name: "Rules" } })).rejects.toThrow(SourceError);
    });

    it("tells a wrong key, a budget that isn't there and an unreachable server, in words, not as the request's mistake", async () => {
      const wrong = await new ActualConnector(config(id, { password: "not-the-key" })).check().catch((e: Error) => e);
      expect(wrong).not.toBeInstanceOf(SourceError);
      expect((wrong as Error).message).toMatch(/refused the API key|403/);
      const lost = await new ActualConnector(config("00000000-0000-0000-0000-000000000000")).check().catch((e: Error) => e);
      expect(lost).not.toBeInstanceOf(SourceError);
      expect((lost as Error).message).toMatch(/no budget with the sync ID/);
      await expect(new ActualConnector(config(id, { address: "http://127.0.0.1:1" })).check()).rejects.toThrow();
      await expect(new ActualConnector(config(id, { timeoutMs: 1 })).check()).rejects.toThrow(/too long|abort|timeout/i);
    });

    it("only reads: the budget holds the same after everything above", async () => {
      const count = async () => (await call<unknown[]>("POST", `/budgets/${id}/run-query`, { ActualQLquery: { table: "transactions", select: ["id"] } })).length;
      const before = [await count(), (await call<unknown[]>("GET", `/budgets/${id}/accounts`)).length, (await call<unknown[]>("GET", `/budgets/${id}/schedules`)).length];
      const c = new ActualConnector(config(id));
      await c.check();
      await c.tables();
      await all(c, "Transactions", ["id"]);
      await all(c, "Budget months", ["id"]);
      expect([await count(), (await call<unknown[]>("GET", `/budgets/${id}/accounts`)).length, (await call<unknown[]>("GET", `/budgets/${id}/schedules`)).length]).toEqual(before);
      expect(before).toEqual([3, 2, 1]);
    });
  });
});
