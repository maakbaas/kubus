// A real n8n (tests/services.yml, profile `connectors`; KUBUS_TEST_N8N is its address, e.g. http://localhost:5678)
// filled through its own API: the owner account is set up on first use (n8n's /rest/owner/setup, then its login),
// API keys are made through /rest/api-keys with the scopes a test wants, and data tables and their rows through the
// public API (/api/v1/data-tables) with a key that may write. The connector gets a key that can only read.
export const N8N = process.env.KUBUS_TEST_N8N;
const OWNER = { email: "test@example.com", firstName: "Test", lastName: "User", password: "Kubus-test-1" };

let session: Promise<string> | null = null;

async function json<T>(response: Response, what: string): Promise<T> {
  const text = await response.text();
  if (!response.ok) throw new Error(`n8n ${what}: ${response.status} ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : null) as T;
}

/** The owner's session cookie (the account is made the first time). */
function owner(): Promise<string> {
  session ??= (async () => {
    const post = (path: string, body: object) => fetch(`${N8N}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    let response = await post("/rest/owner/setup", OWNER);
    if (!response.ok) response = await post("/rest/login", { emailOrLdapLoginId: OWNER.email, password: OWNER.password });
    const cookie = response.headers.get("set-cookie")?.split(";")[0];
    if (!response.ok || !cookie) throw new Error(`n8n owner login: ${response.status} ${await response.text()}`);
    return cookie;
  })();
  return session;
}

/** A name for this run's own: runs (also parallel ones) never meet each other's keys and tables, whatever an interrupted run left. */
export const unique = (name: string) => `${name} ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/** An API key with these scopes (e.g. "dataTable:list"): its id (to delete it) and secret; n8n wants labels of their own, give it a `unique` one. */
export async function createKey(label: string, scopes: string[]): Promise<{ id: string; key: string }> {
  const cookie = await owner();
  const made = await json<{ data: { id: string; rawApiKey: string } }>(
    await fetch(`${N8N}/rest/api-keys`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ label, scopes, expiresAt: null }) }),
    "create key",
  );
  return { id: made.data.id, key: made.data.rawApiKey };
}

export async function deleteKey(id: string): Promise<void> {
  await fetch(`${N8N}/rest/api-keys/${id}`, { method: "DELETE", headers: { cookie: await owner() } });
}

/** The scopes of a key that reads data tables only, and of one that makes and fills them. */
export const READ_SCOPES = ["dataTable:list", "dataTable:read", "dataTableRow:read"];
export const WRITE_SCOPES = ["dataTable:create", "dataTable:delete", "dataTable:list", "dataTable:read", "dataTableRow:create", "dataTableRow:read"];

/** A call of the public API with `key`. */
export async function api<T>(key: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const response = await fetch(`${N8N}/api/v1${path}`, {
    method: init.method ?? "GET",
    headers: { "X-N8N-API-KEY": key, "content-type": "application/json" },
    ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
  });
  return json<T>(response, `${init.method ?? "GET"} ${path}`);
}

export interface Table {
  id: string;
  name: string;
  projectId: string;
}

/** A new data table (give it a `unique` name), filled with `rows`. */
export async function createTable(key: string, name: string, columns: { name: string; type: "string" | "number" | "boolean" | "date" }[], rows: Record<string, unknown>[]): Promise<Table> {
  const table = await api<Table>(key, "/data-tables", { method: "POST", body: { name, columns } });
  // In order, in batches: the rows get ids 1, 2, … in that order.
  for (let i = 0; i < rows.length; i += 100) await api(key, `/data-tables/${table.id}/rows`, { method: "POST", body: { data: rows.slice(i, i + 100), returnType: "count" } });
  return table;
}

export async function deleteTable(key: string, id: string): Promise<void> {
  await api(key, `/data-tables/${id}`, { method: "DELETE" });
}

/** How many rows a table holds (to see that a connector changed none). */
export async function countRows(key: string, id: string): Promise<number> {
  let count = 0;
  let cursor: string | null = null;
  do {
    const page: { data: unknown[]; nextCursor: string | null } = await api(key, `/data-tables/${id}/rows?limit=250${cursor ? `&cursor=${cursor}` : ""}`);
    count += page.data.length;
    cursor = page.nextCursor;
  } while (cursor);
  return count;
}
