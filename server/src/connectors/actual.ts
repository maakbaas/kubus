import { betweenBounds, type SourceColumn, type SourceCondition, type SourceDescription, type SourceQuery, type SourceResult, type SourceRow, type SourceRowRequest, type SourceTable, type SourceTarget } from "../../../shared/sources.ts";
import { SourceError, type Connector, type SourceConfig } from "./connector.ts";
import { requiredRules } from "./influxFlux.ts";
import { addressOf } from "./kinds.ts";
import { findRow, queryRows, ruleTest, type MemoryRow } from "./memory.ts";

// Actual Budget, read-only, through actual-http-api (https://github.com/jhonderson/actual-http-api;
// not Actual itself: its Node API needs Actual's core and one budget per process). Its fields are
// actual-http-api's address and the budget's sync ID, the password its API key (header
// `x-api-key`), a secret field the budget's encryption password (header `budget-encryption-password`,
// only when set). Its only requests are GETs and `POST …/run-query` (an ActualQL query: a read):
// `send` refuses anything else, whatever the key could do.
//
// Curated tables, no query language (`schema` null): Transactions, Accounts, Categories, Payees,
// Schedules, Budget months. Amounts from Actual's integer cents to numbers, dates yyyy-mm-dd, names
// beside the ids they come from. Every request makes actual-http-api load and sync the budget (and it
// holds one budget at a time), so requests go one at a time and a read is kept a few seconds
// (a view's pages and counts share it). Tables are read whole and queried in memory (memory.ts):
// ActualQL compares text with SQLite's case rules, has no "empty last" and no time zones, so letting
// it filter, sort or page would answer differently from the app. Only what narrows exactly is sent:
// a transactions read gets the filter's required date bounds (dates are plain days on both sides),
// a budget months read only the months its required month rules keep (each month is a request).
// Transactions come from run-query (one request with the names joined; the per-account GETs need
// a request per account and give ids only), so a 501 there (EXPERIMENTAL_OPERATIONS_ENABLED=false)
// is the source's problem, said in words; the other tables use plain GETs. Split transactions are
// read as their parts (`splits: "inline"`: amounts add up), each with its own stable id and its
// split's `parent_id`. actual-http-api answers a budget it can't open with a bare 500, so then its
// list of budgets (`GET /v1/budgets`) tells a wrong sync ID or an encrypted budget (`encryptKeyId`)
// without its password, or with a wrong one, from other failures.

/** How long a read is kept (one view's pages, its counts, its item pages). */
const ROWS_TTL_MS = 5_000;
/** The most transactions one read may have. */
const MAX_ROWS = 200_000;
/** The most budget months one read asks for (a request each). */
const MAX_MONTHS = 240;
/** ActualQL refuses dates before this one: an earlier bound is left to memory.ts. */
const FIRST_DAY = "1995-01-01";
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const text = (name: string, over: Partial<SourceColumn> = {}): SourceColumn => ({ name, type: "string", kind: "string", ...over });
const id = (name: string): SourceColumn => ({ name, type: "id", kind: "string", hidden: true });
const amount = (name: string): SourceColumn => ({ name, type: "amount", kind: "number" });
const flag = (name: string): SourceColumn => ({ name, type: "boolean", kind: "checkbox" });
const date = (name: string): SourceColumn => ({ name, type: "date", kind: "date" });

/** The tables, by the name the app shows, with their columns (each keyed by `id`). */
const TABLES: Record<string, SourceColumn[]> = {
  Transactions: [
    date("date"), text("account"), text("payee"), text("category"), text("category_group"), amount("amount"), text("notes"),
    flag("cleared"), flag("reconciled"), flag("transfer"), flag("split"), text("imported_payee", { hidden: true }),
    id("parent_id"), id("account_id"), id("payee_id"), id("category_id"), id("id"),
  ],
  Accounts: [text("name"), amount("balance"), amount("cleared_balance"), amount("uncleared_balance"), flag("off_budget"), flag("closed"), id("id")],
  Categories: [text("name"), text("group"), flag("income"), flag("hidden"), id("group_id"), id("id")],
  Payees: [text("name"), flag("transfer"), text("transfer_account"), id("transfer_account_id"), id("id")],
  Schedules: [
    text("name"), date("next_date"), text("payee"), text("account"), amount("amount"), text("amount_op"), text("repeats"),
    flag("completed"), flag("posts_transaction"), id("payee_id"), id("account_id"), id("id"),
  ],
  "Budget months": [
    { name: "month", type: "month", kind: "date" }, text("group"), text("category"), amount("budgeted"), amount("spent"), amount("received"),
    amount("balance"), flag("carryover"), flag("income"), id("category_id"), id("id"),
  ],
};

/** The API's root from its address (https:// unless it says http://). */
export function actualEndpoint(address: string): string {
  let u: URL;
  try {
    u = addressOf(address, true);
  } catch {
    throw new SourceError("The address isn't one (https://actual-api.example.com)");
  }
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "").replace(/\/v1$/, "")}/v1`;
}

/** Cents as a number (12.34), or null. */
const money = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v / 100 : null);
const str = (v: unknown) => (typeof v === "string" ? v : v === null || v === undefined ? null : String(v));
const yes = (v: unknown) => v === true || v === 1 || v === "1" || v === "true";
/** A date as yyyy-mm-dd (ActualQL gives that; Actual stores 20260301). */
function day(v: unknown): string | null {
  const s = typeof v === "number" ? String(v) : typeof v === "string" ? v : "";
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6)}`;
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}

/** What run-query is asked for transactions: the parts of splits, names joined, the deleted left out. */
export function transactionsQuery(filter: Record<string, unknown> | null) {
  return {
    table: "transactions",
    options: { splits: "inline" },
    ...(filter && { filter }),
    select: [
      "id", "date", "amount", "notes", "cleared", "reconciled", "is_child", "parent_id", "transfer_id", "imported_payee",
      { account_id: "account" }, { account_name: "account.name" },
      { payee_id: "payee" }, { payee_name: "payee.name" }, { transfer_account_name: "payee.transfer_acct.name" },
      { category_id: "category" }, { category_name: "category.name" }, { category_group_name: "category.group.name" },
    ],
    limit: MAX_ROWS + 1,
  };
}

export function transactionRow(t: Record<string, unknown>): MemoryRow {
  return {
    date: day(t.date),
    account: str(t.account_name),
    // A transfer's payee is the other account (its payee has no name of its own).
    payee: str(t.payee_name) || str(t.transfer_account_name),
    category: str(t.category_name),
    category_group: str(t.category_group_name),
    amount: money(t.amount),
    notes: str(t.notes),
    cleared: yes(t.cleared),
    reconciled: yes(t.reconciled),
    transfer: !!t.transfer_id,
    split: yes(t.is_child),
    imported_payee: str(t.imported_payee),
    parent_id: str(t.parent_id),
    account_id: str(t.account_id),
    payee_id: str(t.payee_id),
    category_id: str(t.category_id),
    id: str(t.id),
  };
}

/**
 * The ActualQL filter on `date` a query's required rules make (exact: both sides compare plain
 * days), or null for none. Bounds before 1995 are left out (ActualQL refuses them).
 */
export function dateFilter(filter: SourceCondition): Record<string, unknown> | null {
  const bounds: Record<string, unknown>[] = [];
  const bound = (op: "$gte" | "$lte" | "$gt" | "$lt", v: string) => {
    if (v >= FIRST_DAY) bounds.push({ date: { [op]: v } });
  };
  for (const rule of requiredRules(filter)) {
    if (rule.column !== "date") continue;
    const v = rule.value.trim();
    if (rule.operator === "between") {
      const bounds = betweenBounds(v);
      if (!bounds) continue;
      bound("$gte", bounds.start.slice(0, 10));
      bound("$lte", bounds.end.slice(0, 10));
    } else if (DAY.test(v)) {
      if (rule.operator === "is") {
        bound("$gte", v);
        bound("$lte", v);
      } else if (rule.operator === "before") bound("$lt", v);
      else if (rule.operator === "after") bound("$gt", v);
    }
  }
  return bounds.length ? { $and: bounds } : null;
}

/** The months (yyyy-mm) a query's required month rules keep (memory.ts then filters exactly). */
export function monthsKept(months: string[], filter: SourceCondition): string[] {
  const month = TABLES["Budget months"][0];
  const tests = requiredRules(filter)
    .filter((rule) => rule.column === "month")
    .map((rule) => ruleTest(month, rule, () => null));
  return months.filter((m) => tests.every((test) => test({ month: `${m}-01` })));
}

/** A schedule's recurrence in words ("monthly", "every 2 weeks"), "" for one date. */
function repeatsOf(date: unknown): string {
  if (!date || typeof date !== "object") return "";
  const { frequency, interval } = date as { frequency?: unknown; interval?: unknown };
  const unit = ({ daily: "day", weekly: "week", monthly: "month", yearly: "year" } as Record<string, string>)[String(frequency)];
  if (!unit) return String(frequency ?? "");
  return typeof interval === "number" && interval > 1 ? `every ${interval} ${unit}s` : String(frequency);
}

/** A failed request: its status and actual-http-api's message. */
class ActualAnswer extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type BudgetState = "missing" | "encrypted" | "plain";

interface RawAccount {
  id: string;
  name: string;
  offbudget?: unknown;
  closed?: unknown;
  clearedBalance?: number;
  unclearedBalance?: number;
  workingBalance?: number;
}
interface RawCategory {
  id: string;
  name: string;
  is_income?: unknown;
  hidden?: unknown;
  budgeted?: number;
  spent?: number;
  received?: number;
  balance?: number;
  carryover?: unknown;
}
interface RawGroup extends RawCategory {
  categories?: RawCategory[];
}

export class ActualConnector implements Connector {
  readonly kind = "actual";
  private config: SourceConfig;
  private base: string;
  private budget: string;
  private reads = new Map<string, { at: number; value: Promise<unknown> }>();
  /** The request before (requests go one at a time: each loads the budget). */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(config: SourceConfig) {
    this.config = config;
    this.base = actualEndpoint(config.fields.address ?? "");
    this.budget = (config.fields.budget ?? "").trim();
    if (!this.budget) throw new SourceError("It has no budget sync ID (in Actual: Settings → Show advanced settings → Sync ID)");
  }

  /** One request: a GET, or run-query's POST (a read). Nothing else is ever sent. */
  private send<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    if (method === "POST" && !path.endsWith("/run-query")) throw new Error("Only reads are sent to Actual Budget");
    const run = async (): Promise<T> => {
      const headers: Record<string, string> = { accept: "application/json", "x-api-key": this.config.password };
      if (this.config.fields.encryption) headers["budget-encryption-password"] = this.config.fields.encryption;
      if (body !== undefined) headers["content-type"] = "application/json";
      let response: Response;
      try {
        response = await fetch(`${this.base}${path}`, {
          method,
          headers,
          ...(body !== undefined && { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(this.config.timeoutMs),
        });
      } catch (e) {
        if ((e as Error).name === "TimeoutError") throw new Error("actual-http-api took too long to answer (the source's time limit)");
        throw e;
      }
      const answer = await response.json().catch(() => undefined);
      if (!response.ok) {
        const error = (answer as { error?: unknown } | undefined)?.error;
        throw new ActualAnswer(response.status, typeof error === "string" ? error : "");
      }
      if (!answer || typeof answer !== "object" || !("data" in answer)) throw new Error("The address answers, but not as actual-http-api (is it Actual itself?)");
      return (answer as { data: T }).data;
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }

  /** A budget's request, its failure said in words (the source's problem). */
  private async read<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    try {
      return await this.send<T>(method, `/budgets/${encodeURIComponent(this.budget)}${path}`, body);
    } catch (e) {
      if (!(e instanceof ActualAnswer)) throw e;
      if (e.status === 403) throw new Error("actual-http-api refused the API key (or the budget isn't among its ALLOWED_BUDGET_SYNC_IDS)");
      if (e.status === 501) throw new Error("actual-http-api has its experimental operations off (EXPERIMENTAL_OPERATIONS_ENABLED=false): transactions are read through its run-query");
      if (e.status === 500 && !/Actual Server/.test(e.message)) {
        const problem = this.problemOf(await this.budgetState(), true);
        if (problem) throw new Error(problem);
      }
      throw new Error(`actual-http-api answered ${e.status}${e.message ? `: ${e.message}` : ""}`);
    }
  }

  /** What actual-http-api's list of budgets says of this one (null: it couldn't be listed). */
  private async budgetState(): Promise<BudgetState | null> {
    let budgets: { groupId?: unknown; encryptKeyId?: unknown }[];
    try {
      budgets = await this.send("GET", "/budgets");
    } catch {
      return null;
    }
    if (!Array.isArray(budgets)) return null;
    const ours = budgets.filter((b) => b.groupId === this.budget);
    return !ours.length ? "missing" : ours.some((b) => b.encryptKeyId) ? "encrypted" : "plain";
  }

  /** Why the budget can't be opened as far as its state tells (`failed`: opening it just failed), or null. */
  private problemOf(state: BudgetState | null, failed: boolean): string | null {
    if (state === "missing") return `Actual has no budget with the sync ID “${this.budget}” (in Actual: Settings → Show advanced settings → Sync ID)`;
    if (state !== "encrypted") return null;
    if (!this.config.fields.encryption) return "The budget is end-to-end encrypted: set its encryption password";
    return failed ? "The budget is end-to-end encrypted and couldn't be opened: check its encryption password" : null;
  }

  /** A read kept a moment (from when it is done), by what was asked. */
  private kept<T>(key: string, read: () => Promise<T>): Promise<T> {
    const now = Date.now();
    for (const [k, c] of this.reads) if (now - c.at >= ROWS_TTL_MS) this.reads.delete(k);
    const hit = this.reads.get(key);
    if (hit) return hit.value as Promise<T>;
    const entry = { at: Infinity, value: read() as Promise<unknown> };
    entry.value.then(
      () => (entry.at = Date.now()),
      () => this.reads.get(key) === entry && this.reads.delete(key),
    );
    this.reads.set(key, entry);
    return entry.value as Promise<T>;
  }

  /** The accounts with their balances (older actual-http-api: a balance request each). */
  private accounts(): Promise<RawAccount[]> {
    return this.kept("accounts", async () => {
      const list = await this.read<RawAccount[]>("GET", "/accounts?include_balances=true");
      for (const a of list) {
        if (typeof a.workingBalance !== "number") a.workingBalance = await this.read<number>("GET", `/accounts/${encodeURIComponent(a.id)}/balance`);
      }
      return list;
    });
  }

  private payees() {
    return this.kept("payees", () => this.read<{ id: string; name: string; transfer_acct?: string | null }[]>("GET", "/payees"));
  }

  private async rowsOf(table: string, filter: SourceCondition): Promise<MemoryRow[]> {
    switch (table) {
      case "Transactions":
        return this.transactions(dateFilter(filter));
      case "Accounts":
        return (await this.accounts()).map((a) => ({
          name: str(a.name),
          balance: money(a.workingBalance),
          cleared_balance: money(a.clearedBalance),
          uncleared_balance: money(a.unclearedBalance),
          off_budget: yes(a.offbudget),
          closed: yes(a.closed),
          id: a.id,
        }));
      case "Categories": {
        const groups = await this.kept("categorygroups", () => this.read<RawGroup[]>("GET", "/categorygroups"));
        return groups.flatMap((g) =>
          (g.categories ?? []).map((c) => ({ name: str(c.name), group: str(g.name), income: yes(c.is_income ?? g.is_income), hidden: yes(c.hidden), group_id: g.id, id: c.id })),
        );
      }
      case "Payees": {
        const [payees, accounts] = await Promise.all([this.payees(), this.accounts()]);
        const account = new Map(accounts.map((a) => [a.id, a.name]));
        return payees.map((p) => {
          const other = p.transfer_acct ? (account.get(p.transfer_acct) ?? null) : null;
          return { name: str(p.name) || other, transfer: !!p.transfer_acct, transfer_account: other, transfer_account_id: p.transfer_acct ?? null, id: p.id };
        });
      }
      case "Schedules": {
        type RawSchedule = { id: string; name?: string | null; next_date?: unknown; payee?: string | null; account?: string | null; amount?: unknown; amountOp?: string; date?: unknown; completed?: unknown; posts_transaction?: unknown };
        const [schedules, payees, accounts] = await Promise.all([this.kept("schedules", () => this.read<RawSchedule[]>("GET", "/schedules")), this.payees(), this.accounts()]);
        const account = new Map(accounts.map((a) => [a.id, a.name]));
        const payee = new Map(payees.map((p) => [p.id, p.name || (p.transfer_acct ? (account.get(p.transfer_acct) ?? "") : "")]));
        return schedules.map((s) => {
          // A range ("isbetween": { num1, num2 }) as its middle, as Actual estimates it.
          const range = s.amount && typeof s.amount === "object" ? (s.amount as { num1?: number; num2?: number }) : null;
          const cents = range ? (Number(range.num1 ?? 0) + Number(range.num2 ?? 0)) / 2 : s.amount;
          return {
            name: str(s.name),
            next_date: day(s.next_date),
            payee: s.payee ? (payee.get(s.payee) ?? null) : null,
            account: s.account ? (account.get(s.account) ?? null) : null,
            amount: money(cents),
            amount_op: str(s.amountOp),
            repeats: repeatsOf(s.date),
            completed: yes(s.completed),
            posts_transaction: yes(s.posts_transaction),
            payee_id: s.payee ?? null,
            account_id: s.account ?? null,
            id: s.id,
          };
        });
      }
      case "Budget months": {
        const all = await this.kept("months", () => this.read<string[]>("GET", "/months"));
        return this.months(monthsKept(all, filter));
      }
    }
    throw new SourceError(`${this.config.name} has no table “${table}”`);
  }

  private transactions(filter: Record<string, unknown> | null): Promise<MemoryRow[]> {
    return this.kept(`transactions ${JSON.stringify(filter)}`, async () => {
      const raw = await this.read<Record<string, unknown>[]>("POST", "/run-query", { ActualQLquery: transactionsQuery(filter) });
      if (raw.length > MAX_ROWS) throw new SourceError(`More than ${MAX_ROWS.toLocaleString("en")} transactions: too many to read at once (filter by date)`);
      return raw.map(transactionRow);
    });
  }

  /** Each month's categories: budgeted, spent (or received), balance. */
  private async months(months: string[]): Promise<MemoryRow[]> {
    if (months.length > MAX_MONTHS) throw new SourceError(`${months.length} budget months: too many to read at once (at most ${MAX_MONTHS}; filter by month)`);
    const read = await Promise.all(months.map((m) => this.kept(`month ${m}`, () => this.read<{ categoryGroups?: RawGroup[] }>("GET", `/months/${encodeURIComponent(m)}`))));
    return read.flatMap((budget, i) =>
      (budget.categoryGroups ?? []).flatMap((g) =>
        (g.categories ?? []).map((c) => ({
          month: `${months[i]}-01`,
          group: str(g.name),
          category: str(c.name),
          budgeted: money(c.budgeted),
          spent: money(c.spent),
          received: money(c.received),
          balance: money(c.balance),
          carryover: yes(c.carryover),
          income: yes(c.is_income ?? g.is_income),
          category_id: c.id,
          id: `${months[i]}:${c.id}`,
        })),
      ),
    );
  }

  private table(target: SourceTarget): string {
    if ("query" in target) throw new SourceError(`${this.config.name} is read by its tables only (Actual Budget has no query language here)`);
    if (target.table.schema !== null || !Object.hasOwn(TABLES, target.table.name)) throw new SourceError(`${this.config.name} has no table “${target.table.name}”`);
    return target.table.name;
  }

  async check(): Promise<string[]> {
    this.reads.clear();
    const problem = this.problemOf(await this.budgetState(), false);
    if (problem) throw new Error(problem);
    // Opens the budget: the key, Actual's server and the encryption password.
    await this.accounts();
    const warnings: string[] = [];
    try {
      await this.read("POST", "/run-query", { ActualQLquery: { table: "transactions", calculate: { $count: "$id" } } });
    } catch (e) {
      if (!/EXPERIMENTAL_OPERATIONS_ENABLED/.test((e as Error).message)) throw e;
      warnings.push(`Transactions can't be read: ${(e as Error).message}`);
    }
    if (!this.config.password) warnings.push("No API key is set: actual-http-api accepts none only outside production (NODE_ENV)");
    return warnings;
  }

  async tables(): Promise<SourceTable[]> {
    return Object.keys(TABLES).map((name) => ({ schema: null, name, type: "table" }));
  }

  async describe(target: SourceTarget): Promise<SourceDescription> {
    return { columns: TABLES[this.table(target)], key: ["id"], dropped: [] };
  }

  async query(query: SourceQuery): Promise<SourceResult> {
    const table = this.table(query.target);
    const columns = new Map(TABLES[table].map((c) => [c.name, c]));
    return queryRows(await this.rowsOf(table, query.filter), columns, query);
  }

  async row(request: SourceRowRequest): Promise<SourceRow | null> {
    const table = this.table(request.target);
    const columns = new Map(TABLES[table].map((c) => [c.name, c]));
    let rows: MemoryRow[];
    // By id, a transaction or a budget month (its month and category) is read alone.
    if (table === "Transactions" && request.key === "id") rows = await this.transactions({ id: request.keyValue });
    else if (table === "Budget months" && request.key === "id" && /^\d{4}-\d{2}:/.test(request.keyValue)) rows = await this.months([request.keyValue.slice(0, 7)]);
    else rows = await this.rowsOf(table, { and: [] });
    return findRow(rows, columns, request);
  }

  async close() {
    this.reads.clear();
  }
}
