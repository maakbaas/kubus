// A real Actual Budget behind a real actual-http-api (tests/services.yml, profile `connectors`; KUBUS_TEST_ACTUAL is
// actual-http-api's address, e.g. http://localhost:5007): the budget "Kubus test" that actualSeed.cjs makes when the
// service starts, emptied and filled through actual-http-api's own write routes (accounts, category groups,
// categories, payees, transactions, schedules). The API key is the one the service is started with (services.yml), or
// KUBUS_TEST_ACTUAL_KEY.
export const ACTUAL = process.env.KUBUS_TEST_ACTUAL;
export const API_KEY = process.env.KUBUS_TEST_ACTUAL_KEY ?? "kubus-test-api-key";

/** A call of actual-http-api (v1), its `data` back. */
export async function call<T = unknown>(method: string, path: string, body?: unknown, key = API_KEY): Promise<T> {
  const response = await fetch(`${ACTUAL}/v1${path}`, {
    method,
    headers: { "x-api-key": key, "content-type": "application/json" },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`actual-http-api ${method} ${path}: ${response.status} ${text.slice(0, 300)}`);
  const answer = text ? (JSON.parse(text) as { data?: T }) : {};
  return answer.data as T;
}

/** The sync ID of the budget the service made. */
async function templateId(): Promise<string> {
  const budgets = await call<{ groupId: string; name: string }[]>("GET", "/budgets");
  const ours = budgets.find((b) => b.name === "Kubus test");
  if (!ours) throw new Error("actual-http-api has no budget “Kubus test” (actualSeed.cjs makes it when the service starts)");
  return ours.groupId;
}

/**
 * A budget of this run's own: the service's empty one exported and imported again, which makes a new budget with a new
 * sync ID. Runs (parallel ones, or after earlier ones that were cut off) never see each other's data, whatever the
 * service has been through. Actual's API can't delete a budget, so a test cleans up with `empty`.
 */
export async function budgetId(): Promise<string> {
  const template = await templateId();
  // (A first read downloads the budget into actual-http-api: its export doesn't, and a new container hasn't it yet.)
  await call("GET", `/budgets/${template}/accounts`);
  const response = await fetch(`${ACTUAL}/v1/budgets/${template}/export`, { headers: { "x-api-key": API_KEY } });
  if (!response.ok) throw new Error(`actual-http-api export: ${response.status} ${(await response.text()).slice(0, 300)}`);
  const file = Buffer.from(await response.arrayBuffer());
  const made = await fetch(`${ACTUAL}/v1/budgets/import?type=actual`, { method: "POST", headers: { "x-api-key": API_KEY, "content-type": "application/zip" }, body: file });
  const text = await made.text();
  if (!made.ok) throw new Error(`actual-http-api import: ${made.status} ${text.slice(0, 300)}`);
  return (JSON.parse(text) as { data: { syncId: string } }).data.syncId;
}

/** Deletes everything in the budget that earlier runs (or tests) left. */
export async function empty(id: string): Promise<void> {
  const ids = (rows: { id: string }[]) => rows.map((r) => r.id);
  const transactions = await call<{ id: string }[]>("POST", `/budgets/${id}/run-query`, { ActualQLquery: { table: "transactions", select: ["id"], options: { splits: "all" } } });
  if (transactions.length) await call("DELETE", `/budgets/${id}/transactions/batch`, { ids: ids(transactions) });
  for (const s of await call<{ id: string }[]>("GET", `/budgets/${id}/schedules`)) await call("DELETE", `/budgets/${id}/schedules/${s.id}`);
  for (const a of await call<{ id: string }[]>("GET", `/budgets/${id}/accounts`)) await call("DELETE", `/budgets/${id}/accounts/${a.id}`);
  // (Not the income group a budget starts with: its months can't be worked out without it.)
  for (const g of await call<{ id: string; is_income: boolean }[]>("GET", `/budgets/${id}/categorygroups`)) if (!g.is_income) await call("DELETE", `/budgets/${id}/categorygroups/${g.id}`);
  for (const p of await call<{ id: string; transfer_acct?: string }[]>("GET", `/budgets/${id}/payees`)) if (!p.transfer_acct) await call("DELETE", `/budgets/${id}/payees/${p.id}`);
}

export interface Seeded {
  accounts: Record<string, string>;
  groups: Record<string, string>;
  categories: Record<string, string>;
}

export const makeAccount = (id: string, name: string, extra: object = {}) => call<string>("POST", `/budgets/${id}/accounts`, { account: { name, offbudget: false, ...extra }, initialBalance: 0 });
export const makeGroup = (id: string, name: string) => call<string>("POST", `/budgets/${id}/categorygroups`, { category_group: { name } });
export const makeCategory = (id: string, name: string, group: string, extra: object = {}) => call<string>("POST", `/budgets/${id}/categories`, { category: { name, group_id: group, ...extra } });
export const addTransactions = (id: string, account: string, transactions: object[]) => call("POST", `/budgets/${id}/accounts/${account}/transactions/batch`, { transactions });
