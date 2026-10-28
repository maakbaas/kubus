// Sync, against a fake server (routes on the test's browser context): the settings form, the first
// connection's confirmation, uploading to an empty server, the status button and its popover in
// every state (off, up to date, failed), a rejected token, disconnecting, and connecting to a
// server that already holds data, which replaces this device's data.

/**
 * A fake Kubus server at `url`: POST /api/sync stores the rows it is sent and answers with the rows
 * changed since the cursor, as the server's database `fake.database`; /api/health answers ok,
 * /api/events 204 (no live signal), /api/settings `fake.settings` when set (a PUT is kept in
 * `fake.saved`), anything else 404. `rows` preloads it
 * ({ table: [row] }); `fake.reject` makes it answer 401.
 */
async function fakeServer(t, url, rows = {}) {
  const fake = { requests: [], seq: 0, store: [], reject: false, settings: null, saved: null, database: { id: "db-gui", createdAt: "2026-10-01T00:00:00.000Z" } };
  for (const [table, list] of Object.entries(rows)) for (const row of list) fake.store.push({ seq: ++fake.seq, table, row });
  await t.context.route(`${url}/api/**`, async (route) => {
    const req = route.request();
    const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET, POST, OPTIONS" };
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    if (req.url().endsWith("/api/events")) return route.fulfill({ status: 204, headers: cors });
    if (req.url().endsWith("/api/health")) return route.fulfill({ status: 200, headers: cors, json: { ok: true } });
    if (fake.reject) return route.fulfill({ status: 401, headers: cors, json: { error: "bad token" } });
    if (req.url().endsWith("/api/settings") && fake.settings) {
      if (req.method() === "PUT") fake.saved = JSON.parse(req.postData() || "{}");
      return route.fulfill({ status: 200, headers: cors, json: fake.settings });
    }
    // Only syncing: what else devices ask (the server's language model, its sources) it doesn't offer.
    if (!req.url().endsWith("/api/sync")) return route.fulfill({ status: 404, headers: cors, json: { error: "Not found" } });
    let body = { since: 0, changes: {} };
    try {
      body = JSON.parse(req.postData() || "{}");
    } catch {}
    fake.requests.push({ since: body.since, tables: Object.fromEntries(Object.entries(body.changes || {}).map(([k, v]) => [k, v.length])), auth: req.headers().authorization || "" });
    for (const [table, list] of Object.entries(body.changes || {})) for (const row of list) fake.store.push({ seq: ++fake.seq, table, row });
    const changes = {};
    for (const e of fake.store) if (e.seq > (body.since || 0)) (changes[e.table] ||= []).push(e.row);
    return route.fulfill({ status: 200, headers: cors, json: { cursor: fake.seq, changes, database: fake.database } });
  });
  return fake;
}

/**
 * The rows the fake server holds, the latest per key. A row sent twice (a second sync right after
 * connecting) is stored twice; kept both, the unchanged copy could be applied after a changed one.
 */
function serverRows(fake) {
  const keyOf = (table, row) => (table === "field_values" ? `${row.item_id}/${row.field_id}` : String(row.id));
  const latest = new Map();
  for (const e of fake.store) latest.set(`${e.table}:${keyOf(e.table, e.row)}`, e);
  const out = {};
  for (const e of latest.values()) (out[e.table] ||= []).push(e.row);
  return out;
}

const statusButton = (t) => t.page.locator(".sync-status").first();

/** Saves the server (Settings → Server), then switches sync on (Settings → Sync): a new server asks first. */
async function connect(t, url, { confirm = true, test = false } = {}) {
  await t.open("/settings?section=server");
  const form = t.page.locator(".ws-pane--active form:has(input[id$=\"-token\"])").first();
  await form.getByRole("textbox", { name: "Server" }).fill(url);
  await form.locator("input[id$=\"-token\"]").fill("secret-token");
  if (test) {
    await form.getByRole("button", { name: "Test connection" }).click();
    await t.until("Test connection says the server answers", async () => (await form.innerText()).includes("accepts the token"));
    await t.audit("server settings, connection tested");
  }
  const save = form.getByRole("button", { name: "Save" });
  if (await save.isEnabled()) await save.click();
  await t.settle();
  await t.open("/settings?section=sync");
  const pane = t.page.locator(".ws-pane--active");
  const toggle = pane.getByRole("switch", { name: /Sync this device/ });
  // Carbon's switch button is hidden behind its drawn track: click that, as a person does.
  if ((await toggle.getAttribute("aria-checked")) !== "true") await pane.locator('label[for$="-enabled"] .cds--toggle__appearance').first().click();
  if (!confirm) return;
  const modal = t.page.locator(".cds--modal.is-visible");
  await t.until("connecting to a new server asks first", async () => (await modal.innerText().catch(() => "")).includes("Connect to this server?"));
}

/** Disconnect (Settings → Server) asks first, then sync is off. */
async function disconnect(t) {
  await t.open("/settings?section=server");
  await t.page.locator(".ws-pane--active").getByRole("button", { name: "Disconnect" }).click();
  await t.until("Disconnect asks first", async () => (await t.page.locator(".cds--modal.is-visible").innerText().catch(() => "")).includes("Disconnect from the server?"));
}

for (const vp of ["desktop", "phone"]) {
  test(`sync: connect to an empty server, status, a rejected token, disconnect @ ${vp}`, async (t) => {
    await t.boot();
    const fake = await fakeServer(t, "https://sync.test");
    await t.seed(profileSpec("typical", { items: 3 }));
    await t.open("/settings?section=sync");
    await t.audit("sync settings, off");
    await t.check("the status button says sync is off", (await statusButton(t).getAttribute("aria-label").catch(() => "")) === "Sync is off" || (await statusButton(t).innerText().catch(() => "")).includes("Sync is off") || (await t.page.getByRole("button", { name: "Sync is off" }).count()) > 0);
    await connect(t, "https://sync.test", { test: true });
    await t.audit("connect to this server? dialog");
    await t.page.locator(".cds--modal.is-visible").getByRole("button", { name: "Connect" }).click();
    await t.until("an empty server receives this device's data", () => fake.requests.some((r) => (r.tables.items || 0) >= 3) || JSON.stringify(fake.requests), { timeout: 10000 });
    await t.check("the token is sent as the bearer token", fake.requests.every((r) => r.auth === "Bearer secret-token"), fake.requests.map((r) => r.auth).join(", "));
    await t.until("the settings say it is up to date", async () => (await t.page.locator(".ws-pane--active").innerText()).includes("Up to date"));
    await t.audit("sync settings, connected");
    // The status button and its popover.
    await t.page.getByRole("button", { name: "Up to date" }).first().click();
    await t.settle();
    await t.audit("sync status popover, up to date");
    await t.escapeCloses("sync status popover");
    // A change syncs by itself.
    const before = fake.requests.length;
    await t.page.evaluate(async () => {
      const repo = window.kubus.repo;
      const c = (await repo.listCollections())[0];
      const space = (await repo.listSpaces())[0];
      await repo.createItem(c, { [c.fields[0].id]: "Made after connecting" }, space.id);
    });
    await t.until("a local change is sent by itself", () => fake.requests.length > before && fake.requests.slice(before).some((r) => (r.tables.items || 0) > 0), { timeout: 10000 });
    // The token is refused: the settings and the status button say so.
    fake.reject = true;
    await t.page.evaluate(async () => {
      const repo = window.kubus.repo;
      const c = (await repo.listCollections())[0];
      const space = (await repo.listSpaces())[0];
      await repo.createItem(c, { [c.fields[0].id]: "Made while the token is refused" }, space.id);
    });
    await t.until("a refused token shows as failed", async () => (await t.page.locator(".ws-pane--active").innerText()).includes("The server did not accept the token"), { timeout: 10000 });
    await t.audit("sync failed");
    await t.page.getByRole("button", { name: "Sync failed" }).first().click();
    await t.settle();
    await t.check("the status popover shows the error", (await t.page.locator(".sync-popover").innerText().catch(() => "")).includes("did not accept"));
    await t.audit("sync status popover, failed");
    await t.page.keyboard.press("Escape");
    await t.settle();
    // Disconnect asks first, then sync is off.
    fake.reject = false;
    await disconnect(t);
    await t.audit("disconnect dialog");
    await t.page.locator(".cds--modal.is-visible").getByRole("button", { name: "Disconnect" }).click();
    await t.until("after disconnecting sync is off", async () => (await t.page.getByRole("button", { name: "Sync is off" }).count()) > 0);
    await t.audit("sync settings after disconnecting");
  }, { viewport: vp, smoke: vp === "desktop" });
}

test("sync: a server that holds data replaces this device's data, after asking", async (t) => {
  await t.boot();
  // A first device's data, as the server would hold it: uploaded once to an empty server.
  const first = await fakeServer(t, "https://first.test");
  const ids = await t.seed(profileSpec("typical", { items: 3 }));
  await t.open("/settings?section=sync");
  await connect(t, "https://first.test");
  await t.page.locator(".cds--modal.is-visible").getByRole("button", { name: "Connect" }).click();
  await t.until("the data is uploaded", () => first.requests.some((r) => (r.tables.items || 0) >= 3), { timeout: 10000 });
  const rows = serverRows(first);
  // The server's copy differs: one title was changed there.
  // A book's title (authors' names are titles of books too, and aren't on the Books page).
  const title = (rows.field_values || []).find((r) => r.field_id === ids.fields["books.title"] && typeof r.value_text === "string");
  await t.require("a title is among the uploaded rows", !!title, `${(rows.field_values || []).length} field values`);
  title.value_text = "Changed on the server";
  await fakeServer(t, "https://second.test", rows);
  // Disconnect; change something here; connect to the second server: asked, then replaced.
  await disconnect(t);
  await t.page.locator(".cds--modal.is-visible").getByRole("button", { name: "Disconnect" }).click();
  await t.until("disconnected", async () => (await t.page.getByRole("button", { name: "Sync is off" }).count()) > 0);
  await connect(t, "https://second.test");
  await t.page.locator(".cds--modal.is-visible").getByRole("button", { name: "Connect" }).click();
  await t.until("connected to the second server", async () => (await t.page.locator(".ws-pane--active").innerText()).includes("Up to date"), { timeout: 10000 });
  await t.open(t.listPath(ids.collections.books));
  await t.until("this device now shows the server's data", async () => (await t.page.locator(".ws-pane--active").innerText()).includes("Changed on the server"), { timeout: 10000 });
  await t.audit("data replaced by the server's");
});

test("connections: a source is set up with its kind's own fields", async (t) => {
  await t.boot();
  const fake = await fakeServer(t, "https://conn.test");
  const kind = (id, label, fields, password, schemas) => ({ id, label, fields: fields.map(([key, label]) => ({ key, label })), password: { label: password, helperText: "" }, schemas: schemas && { label: schemas, helperText: "" } });
  fake.settings = {
    ai: { url: "", fieldModel: "", codeModel: "", keySet: false },
    kinds: [kind("postgres", "PostgreSQL", [["host", "Host"], ["port", "Port"], ["database", "Database"], ["user", "User"]], "Password", "Schemas"), kind("d1", "Cloudflare D1", [["account", "Account ID"], ["database", "Database ID"]], "API token", null)],
    sources: [{ id: "s1", name: "CRM", kind: "postgres", fields: { host: "crm", port: "5432", database: "crm", user: "reader" }, schemas: [], timeoutSeconds: 30, passwordSet: true }],
  };
  await connect(t, "https://conn.test", { confirm: false });
  await t.open("/settings?section=connections");
  const pane = t.page.locator(".ws-pane--active");
  await t.until("the source shows its kind's fields", async () => (await pane.getByRole("textbox", { name: "Host" }).inputValue().catch(() => "")) === "crm");
  await t.audit("connections, a PostgreSQL source");
  await pane.locator("select[id$='-src-kind-s1']").selectOption("d1");
  await t.settle();
  await t.check("another kind shows its own fields", (await pane.getByRole("textbox", { name: "Account ID" }).count()) === 1 && (await pane.getByRole("textbox", { name: "Host" }).count()) === 0);
  await t.check("a kind without schemas has no Schemas box", (await pane.getByRole("textbox", { name: "Schemas" }).count()) === 0);
  await pane.getByRole("textbox", { name: "Account ID" }).fill("acc");
  await pane.getByRole("textbox", { name: "Database ID" }).fill("db");
  await t.audit("connections, a D1 source");
  await pane.getByRole("button", { name: "Save" }).click();
  await t.until("saving sends the kind and its fields", () => fake.saved?.sources?.[0]?.kind === "d1" || JSON.stringify(fake.saved));
  await t.check("the fields are sent as typed", JSON.stringify(fake.saved.sources[0].fields) === JSON.stringify({ account: "acc", database: "db" }), JSON.stringify(fake.saved.sources[0]));
}, { viewport: "desktop" });
