// Settings, every section, against a fake Kubus server (routes on the test's browser context) and a
// fake language model (a route on the page, as suite 15): the section tabs and ?section= deep links;
// Server (Test connection ok / wrong token / unreachable / not a Kubus server, Save only when changed,
// Disconnect asks); Sync (switching it on asks first, Download images, Wipe local / server asks, a
// failed wipe); Connections (add, edit, delete, every kind's own fields, Time limit, secrets that are
// never shown again, a refused save, ?source= deep links); AI (Requests, the server's model and the
// device's own, key set / removed, the model lists, Test); Maps (Map style, the server's or this
// device's); API tokens (make, shown once, copy, revoke); and the source picker of a new remote
// collection. Each step asserts what it caused: what the form shows, what the fake server received,
// what is stored on the device, and that it is all still there after the page is loaded again.

const SRV = "https://srv.test";
const TOKEN = "secret-token";
const LLM = "https://llm.test/v1";
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS" };

/** The kinds of connection the server describes (a part of server/src/connectors/kinds.ts, as GET /api/settings sends them). */
const TLS = { key: "ssl", label: "TLS", choices: [{ value: "", text: "Off" }, { value: "require", text: "On, any certificate" }, { value: "verify", text: "On, a trusted certificate" }] };
const KINDS = [
  {
    id: "postgres",
    label: "PostgreSQL",
    fields: [
      { key: "host", label: "Host", placeholder: "db.example.com" },
      { key: "port", label: "Port", placeholder: "5432" },
      { key: "database", label: "Database", placeholder: "crm" },
      { key: "user", label: "User", helperText: "One that can only read." },
      TLS,
    ],
    password: { label: "Password", helperText: "Kept while left empty (unless the host, port or user changes)." },
    schemas: { label: "Schemas", helperText: "Only these schemas' tables are offered, comma-separated. Empty: all." },
  },
  {
    id: "influxdb",
    label: "InfluxDB 2",
    fields: [
      { key: "address", label: "Address", placeholder: "http://influx.example.com:8086" },
      { key: "org", label: "Organization", placeholder: "my-org" },
    ],
    password: { label: "Token", helperText: "One that can only read. Kept while left empty (unless the address changes)." },
    schemas: { label: "Buckets", helperText: "Only these buckets' measurements are offered, comma-separated. Empty: all." },
  },
  {
    id: "d1",
    label: "Cloudflare D1",
    fields: [
      { key: "account", label: "Account ID" },
      { key: "database", label: "Database ID" },
    ],
    password: { label: "API token", helperText: "One with D1 Read permission." },
    schemas: null,
  },
  {
    id: "actual",
    label: "Actual Budget",
    fields: [
      { key: "address", label: "Address", placeholder: "https://actual-api.example.com" },
      { key: "budget", label: "Budget sync ID" },
      { key: "encryption", label: "Encryption password", helperText: "Only for a budget with end-to-end encryption.", secret: true },
    ],
    password: { label: "API key", helperText: "actual-http-api's API_KEY." },
    schemas: null,
  },
  {
    id: "ics",
    label: "Calendar (ICS)",
    fields: [{ key: "address", label: "Address", placeholder: "webcal://calendar.example.com/…/basic.ics" }],
    password: { label: "Secret", helperText: "Fills {secret} in the address." },
    schemas: null,
  },
  {
    id: "json",
    label: "JSON over HTTP",
    fields: [
      { key: "address", label: "Address", placeholder: "https://api.example.com/items" },
      { key: "rows", label: "Rows at", placeholder: "/data/items" },
      { key: "param", label: "Query parameter", placeholder: "api_key" },
      { key: "header", label: "Header name", placeholder: "X-Api-Key" },
    ],
    password: { label: "Password", helperText: "The address's {secret}, an API key or token." },
    schemas: null,
  },
];

const pgSource = (over = {}) => ({
  id: "src-crm",
  name: "CRM",
  kind: "postgres",
  fields: { host: "db.test", port: "5432", database: "crm", user: "reader", ssl: "" },
  schemas: ["public"],
  timeoutSeconds: 30,
  passwordSet: true,
  secretsSet: [],
  connector: "postgres",
  ...over,
});

/**
 * A fake Kubus server at SRV: sync (as suite 18), /api/health, /api/settings (GET / PUT, secrets
 * kept apart as the real one does), /api/ai and its chat endpoint, /api/tokens, /api/wipe and the
 * remote sources (/api/sources, tables, describe). Everything it receives is logged for the test to
 * read; `f.fail*` make single endpoints answer with an error.
 */
async function fakeServer(t, init = {}) {
  const f = {
    log: [], // "METHOD /path"
    puts: [], // PUT /api/settings bodies
    syncs: [], // /api/sync requests: the number of rows sent per table
    chats: [], // /api/ai/chat/completions: { model, auth }
    wipes: [],
    describes: [],
    madeTokens: [],
    store: [],
    seq: 0,
    database: { id: "db-1", createdAt: "2026-10-01T00:00:00.000Z" },
    health: true,
    unreachable: false,
    failPut: null, // { status, error }
    failGet: null,
    failWipe: false,
    failTokens: null,
    settings: { ai: { url: "", fieldModel: "", codeModel: "", keySet: false }, map: { style: "auto" }, kinds: KINDS, sources: [] },
    tokens: [],
    sources: [], // GET /api/sources
    tables: {}, // source name -> [table]
    columns: {}, // table name -> { columns, key, dropped }
    ...init,
  };
  await t.context.route(`${SRV}/api/**`, async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const method = req.method();
    if (method === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    if (f.unreachable) return route.abort("failed");
    const reply = (status, json) => route.fulfill({ status, headers: CORS, json });
    f.log.push(`${method} ${path}`);
    if (path === "/api/health") return reply(200, f.health ? { ok: true } : { hello: "not kubus" });
    if (path === "/api/events") return route.fulfill({ status: 204, headers: CORS });
    if ((req.headers().authorization || "") !== `Bearer ${TOKEN}`) return reply(401, { error: "bad token" });
    let body = null;
    try {
      body = JSON.parse(req.postData() || "null");
    } catch {}
    if (path === "/api/settings" && method === "GET") {
      if (f.failGet) return reply(f.failGet.status, { error: f.failGet.error });
      return reply(200, f.settings);
    }
    if (path === "/api/settings" && method === "PUT") {
      f.puts.push(body);
      if (f.failPut) return reply(f.failPut.status, { error: f.failPut.error });
      const s = f.settings;
      s.ai = { url: body.ai.url, fieldModel: body.ai.fieldModel, codeModel: body.ai.codeModel, keySet: body.ai.key !== undefined ? body.ai.key !== "" : s.ai.keySet };
      if (body.map) s.map = body.map;
      s.sources = body.sources.map((b) => {
        const old = s.sources.find((o) => o.id === b.id);
        const secretsSet = new Set(old?.secretsSet || []);
        for (const [k, v] of Object.entries(b.secrets || {})) v ? secretsSet.add(k) : secretsSet.delete(k);
        return {
          id: b.id,
          name: b.name,
          kind: b.kind,
          fields: b.fields,
          schemas: b.schemas,
          timeoutSeconds: b.timeoutSeconds,
          passwordSet: b.password !== undefined ? b.password !== "" : !!old?.passwordSet,
          secretsSet: [...secretsSet],
          connector: b.kind,
          ...(old?.problem && { problem: old.problem }),
          ...(old?.warnings && { warnings: old.warnings }),
        };
      });
      return reply(200, s);
    }
    if (path === "/api/ai") return reply(200, { available: !!(f.settings.ai.url && f.settings.ai.fieldModel), fieldModel: f.settings.ai.fieldModel, codeModel: f.settings.ai.codeModel });
    if (path === "/api/ai/chat/completions") {
      f.chats.push({ model: body?.model, auth: req.headers().authorization });
      return reply(200, { choices: [{ message: { content: "ok" } }] });
    }
    if (path === "/api/tokens" && method === "GET") return f.failTokens ? reply(f.failTokens.status, { error: f.failTokens.error }) : reply(200, f.tokens);
    if (path === "/api/tokens" && method === "POST") {
      if (f.failTokens) return reply(f.failTokens.status, { error: f.failTokens.error });
      const made = { id: `tok-${f.tokens.length + 1}`, name: body.name, access: body.access, createdAt: new Date().toISOString(), lastUsedAt: null };
      f.tokens.push(made);
      f.madeTokens.push({ ...made, token: `kbs_${made.id}_0123456789abcdef` });
      return reply(201, { ...made, token: `kbs_${made.id}_0123456789abcdef` });
    }
    const revoke = /^\/api\/tokens\/([^/]+)$/.exec(path);
    if (revoke && method === "DELETE") {
      f.tokens = f.tokens.filter((x) => x.id !== decodeURIComponent(revoke[1]));
      return reply(200, { ok: true });
    }
    if (path === "/api/wipe") {
      f.wipes.push(body);
      if (f.failWipe) return reply(500, { error: "wipe failed" });
      f.store = [];
      f.seq = 0;
      f.database = { id: `db-${f.wipes.length + 1}`, createdAt: new Date().toISOString() };
      return reply(200, { ok: true });
    }
    if (path === "/api/sources") return reply(200, f.sources);
    const tables = /^\/api\/sources\/([^/]+)\/tables$/.exec(path);
    if (tables) return reply(200, f.tables[decodeURIComponent(tables[1])] || []);
    const describe = /^\/api\/sources\/([^/]+)\/describe$/.exec(path);
    if (describe) {
      f.describes.push({ source: decodeURIComponent(describe[1]), target: body.target });
      const name = body.target.table?.name ?? "query";
      const d = f.columns[name];
      return d ? reply(200, d) : reply(500, { error: `relation "${name}" does not exist` });
    }
    if (path === "/api/sync") {
      if (body?.database && body.database !== f.database.id) return reply(409, { error: "The server's database was wiped or replaced", database: f.database, empty: f.seq === 0 });
      f.syncs.push({ since: body?.since, tables: Object.fromEntries(Object.entries(body?.changes || {}).map(([k, v]) => [k, v.length])) });
      for (const [table, list] of Object.entries(body?.changes || {})) for (const row of list) f.store.push({ seq: ++f.seq, table, row });
      const changes = {};
      for (const e of f.store) if (e.seq > (body?.since || 0)) (changes[e.table] ||= []).push(e.row);
      return reply(200, { cursor: f.seq, changes, database: f.database });
    }
    return reply(404, { error: "not found" });
  });
  return f;
}

/** This device is connected to the fake server (as Settings → Server saves it), not yet syncing. */
async function connected(t, { enabled = false, originals = "always" } = {}) {
  await t.page.evaluate((c) => localStorage.setItem("kubus.sync", JSON.stringify(c)), { url: SRV, token: TOKEN, enabled, originals });
}

const pref = (t, key) => t.page.evaluate((k) => JSON.parse(localStorage.getItem(k) || "null"), key);
const rawPref = (t, key) => t.page.evaluate((k) => localStorage.getItem(k), key);
const panel = (t) => t.page.locator(".ws-pane--active .settings-panel:visible");
const modal = (t) => t.page.locator(".cds--modal.is-visible");
const panelText = async (t) => (await panel(t).innerText().catch(() => "")) || "";
const modalText = async (t) => (await modal(t).innerText().catch(() => "")) || "";
const selectedTab = async (t) => (await t.page.locator(".ws-pane--active .settings-page [role=tab][aria-selected=true]").first().innerText().catch(() => "")).trim();
/** A form field by its label, in the visible section. */
const field = (t, label) => panel(t).getByLabel(label, { exact: true });
const button = (t, name, scope = panel(t)) => scope.getByRole("button", { name, exact: true });
const switchOf = (t, label) => panel(t).locator(".cds--toggle").filter({ hasText: label });
const settingsPath = (section) => `/settings?section=${section}`;
const SECTIONS = [
  ["server", "Server"],
  ["sync", "Sync"],
  ["connections", "Connections"],
  ["ai", "AI"],
  ["maps", "Maps"],
  ["tokens", "API tokens"],
];

/** Opens a section in a fresh load. */
async function openSection(t, section, extra = "") {
  await t.open(settingsPath(section) + extra);
}

// ---------------------------------------------------------------------------------------------
// The tabs
// ---------------------------------------------------------------------------------------------

for (const vp of ["desktop", "phone"]) {
  test(`settings: ?section= deep links open the section, the tabs switch, without a server each says so @ ${vp}`, async (t) => {
    await t.boot();
    await fakeServer(t);
    // Without a server, the sections that are the server's say so; Maps and AI work on the device alone.
    const sayNoServer = { sync: true, connections: true, tokens: true, ai: true, maps: false, server: false };
    for (const [section, name] of SECTIONS) {
      // The first is a real load of the address; the others are in-app links to it.
      if (section === "server") await openSection(t, section);
      else await t.go(settingsPath(section));
      await t.until(`?section=${section} opens ${name}`, async () => (await selectedTab(t)) === name || `selected: ${await selectedTab(t)}`, { timeout: 6000 });
      const text = await panelText(t);
      await t.check(`${name} without a server ${sayNoServer[section] ? "says No server" : "has no such notice"}`, text.includes("Connect this device to a Kubus server first") === sayNoServer[section], text.slice(0, 200));
      await t.audit(`${name}, no server`);
    }
    // A real load of a deep link into the middle, then none, an unknown one: the first, Server.
    await openSection(t, "ai");
    await t.until("a loaded ?section=ai opens AI", async () => (await selectedTab(t)) === "AI" || await selectedTab(t), { timeout: 6000 });
    for (const path of ["/settings", "/settings?section=nonsense"]) {
      await t.go(path);
      await t.until(`${path} opens Server`, async () => (await selectedTab(t)) === "Server" || await selectedTab(t), { timeout: 6000 });
    }
    // Clicking a tab shows its section (tabs fold into a menu when they don't fit).
    for (const [, name] of [...SECTIONS].reverse()) {
      const tab = t.page.locator(".ws-pane--active .settings-page").getByRole("tab", { name, exact: true });
      // A tab only partly in the bar is reached through the menu, as a person would.
      const inBar = await tab.evaluate((el) => {
        const bar = el.closest(".views-bar").getBoundingClientRect();
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.left >= bar.left && r.right <= bar.right + 1;
      }).catch(() => false);
      if (inBar) await tab.click();
      else {
        await t.page.locator(".ws-pane--active").getByRole("button", { name: "Settings", exact: true }).first().click();
        await t.page.locator(".tab-menu__list").getByRole("link", { name, exact: true }).click();
      }
      await t.until(`the ${name} tab shows ${name}`, async () => (await selectedTab(t)) === name, { timeout: 6000 });
    }
    await t.audit("after switching through the tabs");
  }, { viewport: vp, smoke: vp === "desktop" });
}

// ---------------------------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------------------------

test("server: Test connection (ok, wrong token, unreachable, not Kubus), Save only when changed, Disconnect asks", async (t) => {
  await t.boot();
  const f = await fakeServer(t);
  await fakeServerAt(t, "https://plain.test", { ok: false });
  await fakeServerAt(t, "https://gone.test", { gone: true });
  await openSection(t, "server");
  await t.check("nothing to save or test yet", (await button(t, "Save").isDisabled()) && (await button(t, "Test connection").isDisabled()));
  await t.check("no Disconnect without a server", (await button(t, "Disconnect").count()) === 0);
  await t.audit("server, empty");
  const url = field(t, "Server");
  const token = panel(t).locator('input[id$="-token"]');
  const testButton = button(t, "Test connection");
  const result = async () => (await panel(t).locator(".cds--inline-notification").last().innerText().catch(() => "")).replace(/\s+/g, " ");
  const test = async (label, address, secret, title, text) => {
    await url.fill(address);
    await token.fill(secret);
    await testButton.click();
    await t.until(`Test connection: ${label}`, async () => (await result()).includes(title) && (await result()).includes(text), { timeout: 8000 });
  };
  await test("a server that accepts the token", SRV, TOKEN, "Connected", "The server answers and accepts the token.");
  await t.audit("test connection ok");
  await test("a wrong token", SRV, "wrong", "Can't connect", "The server did not accept the token");
  await test("a server that can't be reached", "https://gone.test", TOKEN, "Can't connect", "Cannot reach https://gone.test");
  await test("something that is not a Kubus server", "https://plain.test", TOKEN, "Can't connect", "https://plain.test is not a Kubus server");
  await t.audit("test connection failed");
  await t.check("testing saved nothing", (await rawPref(t, "kubus.sync")) === null, await rawPref(t, "kubus.sync"));
  await url.fill(`${SRV}/`);
  await token.fill(TOKEN);
  await testButton.click();
  await t.until("an address with a trailing slash tests fine", async () => (await result()).includes("Connected"), { timeout: 8000 });
  // Save stores it; nothing to save after that, and the form follows an edit and its undoing.
  await button(t, "Save").click();
  await t.until("Save stores the server on this device", async () => (await pref(t, "kubus.sync"))?.token === TOKEN, { timeout: 5000 });
  const stored = await pref(t, "kubus.sync");
  await t.check("the address is stored without its trailing slash, sync stays off", stored.url === SRV && stored.enabled === false, JSON.stringify(stored));
  await t.until("after saving there is nothing to save", async () => await button(t, "Save").isDisabled());
  await t.check("Disconnect appears", (await button(t, "Disconnect").count()) === 1);
  await url.fill(`${SRV}x`);
  await t.check("an edited address can be saved", !(await button(t, "Save").isDisabled()));
  await url.fill(SRV);
  await t.check("typing the saved address again leaves nothing to save", await button(t, "Save").isDisabled());
  await token.fill("other");
  await t.check("an edited token can be saved", !(await button(t, "Save").isDisabled()));
  await token.fill(TOKEN);
  await t.audit("server, connected");
  // It is still there after loading the page again.
  await openSection(t, "server");
  await t.check("the server is shown again after a reload", (await url.inputValue()) === SRV && (await token.inputValue()) === TOKEN);
  // Disconnect asks first.
  await button(t, "Disconnect").click();
  await t.until("Disconnect asks first", async () => (await modalText(t)).includes("Disconnect from the server?"));
  await t.audit("disconnect dialog");
  await button(t, "Cancel", modal(t)).click();
  await t.until("Cancel closes the dialog", async () => (await t.count(".cds--modal.is-visible")) === 0);
  await t.check("Cancel keeps the connection", (await pref(t, "kubus.sync")).token === TOKEN && (await button(t, "Disconnect").count()) === 1);
  await button(t, "Disconnect").click();
  await t.until("asked again", async () => (await modalText(t)).includes("Disconnect from the server?"));
  await button(t, "Disconnect", modal(t)).click();
  await t.until("Disconnect forgets the token and empties the form", async () => (await token.inputValue()) === "" && (await pref(t, "kubus.sync")).token === "");
  await t.check("no Disconnect button any more", (await button(t, "Disconnect").count()) === 0);
  await t.audit("server, disconnected");
  void f;
});

/** A second fake server for the connection test: `ok: false` answers health with something else, `gone` refuses everything. */
async function fakeServerAt(t, origin, { ok = true, gone = false } = {}) {
  await t.context.route(`${origin}/api/**`, (route) => {
    if (gone) return route.abort("failed");
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    return route.fulfill({ status: 200, headers: CORS, json: ok ? { ok: true } : { hello: "world" } });
  });
}

test("server: saving with sync on asks before connecting to a new server", async (t) => {
  await t.boot();
  const f = await fakeServer(t);
  await t.seed(profileSpec("typical", { items: 3 }));
  await t.page.evaluate((c) => localStorage.setItem("kubus.sync", JSON.stringify(c)), { url: "", token: "", enabled: true, originals: "always" });
  await openSection(t, "server");
  await field(t, "Server").fill(SRV);
  await panel(t).locator('input[id$="-token"]').fill(TOKEN);
  await button(t, "Save").click();
  await t.until("connecting to a new server asks first", async () => (await modalText(t)).includes("Connect to this server?"));
  await t.audit("connect to this server? dialog");
  await t.page.keyboard.press("Escape");
  await t.until("Escape cancels", async () => (await t.count(".cds--modal.is-visible")) === 0);
  await t.check("cancelled: nothing stored, nothing sent", (await pref(t, "kubus.sync"))?.token === "" && f.syncs.length === 0, `${JSON.stringify(await pref(t, "kubus.sync"))} ${f.syncs.length}`);
  await button(t, "Save").click();
  await t.until("asked again", async () => (await modalText(t)).includes("Connect to this server?"));
  await button(t, "Connect", modal(t)).click();
  await t.until("an empty server receives this device's data", () => f.syncs.some((s) => (s.tables.items || 0) >= 3) || JSON.stringify(f.syncs), { timeout: 10000 });
  await t.check("the server is stored with sync on", (await pref(t, "kubus.sync"))?.enabled === true);
});

// ---------------------------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------------------------

for (const vp of ["desktop", "phone"]) {
  test(`sync: switching on asks first, Download images, wiping asks and can fail @ ${vp}`, async (t) => {
    await t.boot();
    const f = await fakeServer(t);
    const ids = await t.seed(profileSpec("typical", { items: 3 }));
    await connected(t);
    await openSection(t, "sync");
    const enabled = () => switchOf(t, "Sync this device");
    const track = () => enabled().locator(".cds--toggle__appearance").first();
    const isOn = async () => (await enabled().getByRole("switch").getAttribute("aria-checked")) === "true";
    await t.check("Sync is off, nothing says No server", !(await isOn()) && !(await panelText(t)).includes("No server"));
    const state = async () => ((await panel(t).locator("p.helper").last().innerText().catch(() => "")) || "").trim();
    await t.check("the state reads Off", (await state()).startsWith("Off"), await state());
    await t.audit("sync, off");
    // On: asks first; Escape / Cancel leave it off and send nothing.
    await track().click();
    await t.until("switching sync on asks first", async () => (await modalText(t)).includes("Connect to this server?"));
    await t.audit("connect to this server? (sync tab)");
    await button(t, "Cancel", modal(t)).click();
    await t.until("Cancel closes it", async () => (await t.count(".cds--modal.is-visible")) === 0);
    await t.check("Cancel: still off, nothing stored, nothing synced", !(await isOn()) && (await pref(t, "kubus.sync")).enabled === false && f.syncs.length === 0);
    await track().click();
    await t.until("asked again", async () => (await modalText(t)).includes("Connect to this server?"));
    await button(t, "Connect", modal(t)).click();
    await t.until("the switch is on and the empty server receives this device's data", () => f.syncs.some((s) => (s.tables.items || 0) >= 3) || JSON.stringify(f.syncs), { timeout: 10000 });
    await t.until("the state reads Up to date", async () => (await state()).startsWith("Up to date"), { timeout: 8000 });
    await t.check("stored: sync on", (await pref(t, "kubus.sync")).enabled === true && (await isOn()));
    await t.audit("sync, up to date");
    // Download images: each choice is stored at once and explained.
    const originals = field(t, "Download images");
    await originals.selectOption("opened");
    await t.until("Full size when opened is stored", async () => (await pref(t, "kubus.sync")).originals === "opened");
    await t.check("its helper text says thumbnails", (await panelText(t)).includes("Thumbnails after each sync"));
    await t.check("choosing it left sync on", (await pref(t, "kubus.sync")).enabled === true);
    await openSection(t, "sync");
    await t.check("Full size when opened is still chosen after a reload", (await originals.inputValue()) === "opened");
    await originals.selectOption("always");
    await t.until("All, full size is stored", async () => (await pref(t, "kubus.sync")).originals === "always");
    await t.check("its helper text says every image", (await panelText(t)).includes("Every image, full size"));
    // Off again.
    await track().click();
    await t.until("switching off needs no question and stops sync", async () => !(await isOn()) && (await pref(t, "kubus.sync")).enabled === false);
    await t.until("the state reads Off again", async () => (await state()).startsWith("Off"));
    // Wipe local database: asks; Cancel keeps the data.
    const countItems = () => t.page.evaluate(async (id) => { const repo = window.kubus.repo; const c = (await repo.listCollections()).find((x) => x.id === id); return (await repo.listItems(c)).length; }, ids.collections.books);
    const before = await countItems();
    await button(t, "Wipe local database").click();
    await t.until("Wipe local database asks first", async () => (await modalText(t)).includes("Wipe this device's data?"));
    await t.check("it says the server keeps its data", (await modalText(t)).includes("the server keeps its data"));
    await t.audit("wipe local dialog");
    await button(t, "Cancel", modal(t)).click();
    await t.until("Cancel closes it", async () => (await t.count(".cds--modal.is-visible")) === 0);
    await t.check("Cancel keeps the data", (await countItems()) === before, `${await countItems()} of ${before}`);
    // Wipe server database: asks naming the server; Cancel sends nothing; a failure is shown.
    await button(t, "Wipe server database").click();
    await t.until("Wipe server database asks first", async () => (await modalText(t)).includes("Wipe the server's database?"));
    await t.check("it names the server and what goes with the data", (await modalText(t)).includes(SRV) && (await modalText(t)).includes("its API tokens"));
    await t.audit("wipe server dialog");
    await t.page.keyboard.press("Escape");
    await t.until("Escape closes it", async () => (await t.count(".cds--modal.is-visible")) === 0);
    await t.check("cancelled: the server was not asked to wipe", f.wipes.length === 0);
    f.failWipe = true;
    await button(t, "Wipe server database").click();
    await t.until("asked again", async () => (await modalText(t)).includes("Wipe the server's database?"));
    await button(t, "Wipe server database", modal(t)).click();
    await t.until("a failed wipe says so", async () => (await panelText(t)).includes("Wiping the server failed") && (await panelText(t)).includes("Server error 500"));
    await t.audit("wiping the server failed");
    await t.check("the failed wipe left this device's data alone", (await countItems()) === before);
    await panel(t).locator(".cds--inline-notification").getByRole("button", { name: /close/i }).click();
    await t.until("the notification can be closed", async () => !(await panelText(t)).includes("Wiping the server failed"));
    f.failWipe = false;
    await button(t, "Wipe server database").click();
    await t.until("asked once more", async () => (await modalText(t)).includes("Wipe the server's database?"));
    await button(t, "Wipe server database", modal(t)).click();
    await t.until("the wipe reaches the server with its confirmation", () => f.wipes.length === 2 && f.wipes[1]?.confirm === "wipe");
    await t.check("no error is shown once it worked", !(await panelText(t)).includes("Wiping the server failed"));
    await t.check("after the wipe sync on this device is paused, its data kept", !(await isOn()) && (await countItems()) === before);
    // Wipe local database for real: the app reloads and the data is gone.
    await button(t, "Wipe local database").click();
    await t.until("asked", async () => (await modalText(t)).includes("Wipe this device's data?"));
    await button(t, "Wipe", modal(t)).click();
    await t.until("the page reloaded without the data", async () => {
      const n = await t.page.evaluate(async () => (window.kubus ? (await window.kubus.repo.listCollections()).length : -1));
      return n === 0 || `${n} collections`;
    }, { timeout: 15000 });
    await t.audit("after wiping the local database");
  }, { viewport: vp, smoke: vp === "desktop" });
}

test("sync: without a server it says so; wiping then has no server option", async (t) => {
  await t.boot();
  await fakeServer(t);
  await openSection(t, "sync");
  await t.check("it says No server", (await panelText(t)).includes("No server"));
  await t.check("the switch can't be used", await panel(t).getByRole("switch", { name: "Sync this device" }).isDisabled());
  await t.check("there is no Wipe server database", (await button(t, "Wipe server database").count()) === 0);
  await button(t, "Wipe local database").click();
  await t.until("the local wipe says it can't be undone", async () => (await modalText(t)).includes("It can't be undone."));
  await t.page.keyboard.press("Escape");
  await t.until("Escape closes it", async () => (await t.count(".cds--modal.is-visible")) === 0);
  await t.page.mouse.move(t.vp.width - 1, t.vp.height - 1); // off the button, whose hover colours are not the subject
  await t.audit("sync, no server");
});

// ---------------------------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------------------------

/** The labels of the fields a connection's dialog shows, in order. */
const dialogLabels = (t) => modal(t).locator("label.cds--label, .cds--label").evaluateAll((els) => els.filter((e) => e.checkVisibility()).map((e) => e.textContent.trim()));
const expectedLabels = (kind) => ["Name", "Kind", ...kind.fields.map((f) => f.label), kind.password.label, ...(kind.schemas ? [kind.schemas.label] : []), "Time limit (seconds)"];

for (const vp of ["desktop", "phone"]) {
  test(`connections: add, edit, delete, every kind's own fields, secrets never shown, a refused save @ ${vp}`, async (t) => {
    await t.boot();
    const f = await fakeServer(t);
    await connected(t);
    await openSection(t, "connections");
    await t.until("the section loads", async () => (await panelText(t)).includes("No remote connections yet."));
    await t.audit("connections, none");
    // Every kind: its own fields in the dialog.
    await button(t, "Add connection").click();
    await t.until("Add connection opens a dialog", async () => (await modalText(t)).includes("Name"));
    await t.audit("add connection");
    const kindSelect = modal(t).getByLabel("Kind", { exact: true });
    for (const kind of KINDS) {
      await t.dialogStep(`Kind ${kind.label}`, () => kindSelect.selectOption(kind.id), { target: kindSelect });
      const labels = await dialogLabels(t);
      await t.check(`${kind.label} shows its own fields`, JSON.stringify(labels) === JSON.stringify(expectedLabels(kind)), `${labels.join(" | ")} ≠ ${expectedLabels(kind).join(" | ")}`);
    }
    await t.audit("add connection, the last kind (JSON)");
    // A secret field and a choice field.
    await kindSelect.selectOption("actual");
    await t.check("a secret field is a password box", (await modal(t).getByLabel("Encryption password", { exact: true }).getAttribute("type")) === "password");
    await kindSelect.selectOption("postgres");
    await t.check("TLS offers its three choices", JSON.stringify(await modal(t).getByLabel("TLS", { exact: true }).locator("option").allInnerTexts()) === JSON.stringify(["Off", "On, any certificate", "On, a trusted certificate"]));
    // Fill and add a Postgres connection.
    await modal(t).getByLabel("Name", { exact: true }).fill("CRM");
    await modal(t).getByLabel("Host", { exact: true }).fill("db.test");
    await modal(t).getByLabel("Port", { exact: true }).fill("5432");
    await modal(t).getByLabel("Database", { exact: true }).fill("crm");
    await modal(t).getByLabel("User", { exact: true }).fill("reader");
    await modal(t).getByLabel("TLS", { exact: true }).selectOption("require");
    await modal(t).getByLabel("Password", { exact: true }).fill("hunter2");
    await modal(t).getByLabel("Schemas", { exact: true }).fill("public, sales ,");
    const limit = modal(t).getByRole("spinbutton");
    await t.check("the time limit starts at 30", (await limit.inputValue()) === "30");
    await limit.fill("45");
    await t.audit("add connection, filled");
    // A server that refuses: the dialog stays and says why.
    f.failPut = { status: 400, error: "A connection named CRM exists already" };
    await button(t, "Add", modal(t)).click();
    await t.until("a refused save shows why, in the dialog", async () => (await modalText(t)).includes("Not saved") && (await modalText(t)).includes("A connection named CRM exists already"));
    await t.audit("add connection, refused");
    await t.check("the dialog kept what was typed", (await modal(t).getByLabel("Host", { exact: true }).inputValue()) === "db.test");
    f.failPut = null;
    await button(t, "Add", modal(t)).click();
    await t.until("Add closes the dialog", async () => (await t.count(".cds--modal.is-visible")) === 0);
    const put = f.puts[f.puts.length - 1];
    const sent = put.sources[0];
    await t.check("the server received the connection with its password and no other secret", put.sources.length === 1 && sent.name === "CRM" && sent.kind === "postgres" && sent.password === "hunter2" && sent.secrets === undefined, JSON.stringify(put));
    await t.check("its fields, schemas as a list and time limit", JSON.stringify(sent.fields) === JSON.stringify({ host: "db.test", port: "5432", database: "crm", user: "reader", ssl: "require" }) && JSON.stringify(sent.schemas) === JSON.stringify(["public", "sales"]) && sent.timeoutSeconds === 45, JSON.stringify(sent));
    await t.check("the rest of the server's settings went along", put.ai.url === "" && put.map?.style === "auto");
    const row = panel(t).locator("tbody tr").filter({ hasText: "CRM" });
    await t.check("the table lists it with its kind", (await row.count()) === 1 && (t.phone || (await row.innerText()).includes("PostgreSQL")));
    await t.audit("connections, one");
    // Edit: its values come back; the password is not among them.
    await button(t, "Edit CRM", row).click();
    await t.until("Edit opens its dialog", async () => (await modalText(t)).includes("Edit CRM") || (await modalText(t)).slice(0, 80));
    // The name links to the connection's address (?source=<id>).
    const id = decodeURIComponent(((await row.locator("a").first().getAttribute("href")) || "").match(/source=([^&]+)/)?.[1] || "");
    await t.check("its name links to its dialog's address", !!id && id !== "new", id);
    await t.check("its fields are filled in", (await modal(t).getByLabel("Host", { exact: true }).inputValue()) === "db.test" && (await modal(t).getByLabel("TLS", { exact: true }).inputValue()) === "require" && (await modal(t).getByLabel("Schemas", { exact: true }).inputValue()) === "public, sales" && (await limit.inputValue()) === "45");
    const password = modal(t).getByLabel("Password", { exact: true });
    await t.check("the password is not shown, only that it is set", (await password.inputValue()) === "" && (await password.getAttribute("placeholder")) === "Set: type to replace it");
    await t.audit("edit connection");
    // Cancel changes nothing.
    await modal(t).getByLabel("Name", { exact: true }).fill("Renamed but cancelled");
    const putsBefore = f.puts.length;
    await button(t, "Cancel", modal(t)).click();
    await t.until("Cancel closes it", async () => (await t.count(".cds--modal.is-visible")) === 0);
    await t.check("Cancel sent nothing and the name is as it was", f.puts.length === putsBefore && (await row.count()) === 1);
    // Rename keeps the password (not sent), changes the limit.
    await button(t, "Edit CRM", row).click();
    await t.until("dialog open", async () => (await t.count(".cds--modal.is-visible")) === 1);
    await modal(t).getByLabel("Name", { exact: true }).fill("Sales CRM");
    await limit.fill("60");
    await button(t, "Save", modal(t)).click();
    await t.until("Save closes the dialog and renames it", async () => (await t.count(".cds--modal.is-visible")) === 0 && (await panelText(t)).includes("Sales CRM"));
    const renamed = f.puts[f.puts.length - 1].sources[0];
    await t.check("renamed on the server, the password left alone, the same id", renamed.name === "Sales CRM" && renamed.password === undefined && renamed.id === id && renamed.timeoutSeconds === 60, JSON.stringify(renamed));
    // A second one with a secret field (Actual) and a calendar.
    await button(t, "Add connection").click();
    await t.until("dialog open", async () => (await t.count(".cds--modal.is-visible")) === 1);
    await modal(t).getByLabel("Kind", { exact: true }).selectOption("actual");
    await modal(t).getByLabel("Name", { exact: true }).fill("Budget");
    await modal(t).getByLabel("Address", { exact: true }).fill("https://actual.test");
    await modal(t).getByLabel("Budget sync ID", { exact: true }).fill("b-1");
    await modal(t).getByLabel("Encryption password", { exact: true }).fill("enc-pass");
    await modal(t).getByLabel("API key", { exact: true }).fill("k");
    await button(t, "Add", modal(t)).click();
    await t.until("both are listed", async () => (await panel(t).locator("tbody tr").count()) === 2);
    const budget = f.puts[f.puts.length - 1].sources.find((s) => s.name === "Budget");
    await t.check("the secret field is sent as a secret, not among the fields", budget.secrets?.encryption === "enc-pass" && budget.fields.encryption === undefined && budget.fields.budget === "b-1", JSON.stringify(budget));
    await button(t, "Edit Budget").click();
    await t.until("dialog open", async () => (await t.count(".cds--modal.is-visible")) === 1);
    const enc = modal(t).getByLabel("Encryption password", { exact: true });
    await t.check("the secret field shows only that it is set", (await enc.inputValue()) === "" && (await enc.getAttribute("placeholder")) === "Set: type to replace it");
    await t.page.keyboard.press("Escape");
    await t.until("Escape closes the dialog", async () => (await t.count(".cds--modal.is-visible")) === 0);
    // Sorted by Name, then by Kind.
    const names = () => panel(t).locator("tbody tr td:first-child").allInnerTexts();
    const first = (await names()).map((s) => s.trim());
    await t.check("until sorted the rows keep the server's order", first.join() === "Sales CRM,Budget", first.join());
    const sortByName = panel(t).locator("thead").getByRole("button", { name: /^Name/ });
    await sortByName.click();
    await t.until("the Name header sorts ascending", async () => (await names()).map((s) => s.trim()).join() === "Budget,Sales CRM");
    await sortByName.click();
    await t.until("again descending", async () => (await names()).map((s) => s.trim()).join() === "Sales CRM,Budget");
    // (The kind column is left out on a phone.)
    if (!t.phone) {
      await panel(t).locator("thead").getByRole("button", { name: /^Kind/ }).click();
      await t.until("the Kind header sorts by kind", async () => (await names()).map((s) => s.trim()).join() === "Budget,Sales CRM");
    }
    // Deep links: ?source=<id> opens it, ?source=new the empty one, an unknown id nothing.
    await t.open(settingsPath("connections") + `&source=${id}`);
    await t.until("?source=<id> opens that connection after loading", async () => (await modalText(t)).includes("Edit Sales CRM"));
    await t.check("with its values", (await modal(t).getByLabel("Database", { exact: true }).inputValue()) === "crm");
    await t.audit("connection opened by its address");
    await t.page.keyboard.press("Escape");
    await t.open(settingsPath("connections") + "&source=new");
    await t.until("?source=new opens an empty Add", async () => (await modalText(t)).includes("Name") && (await modal(t).getByLabel("Name", { exact: true }).inputValue()) === "");
    await t.page.keyboard.press("Escape");
    await t.open(settingsPath("connections") + "&source=nope");
    await t.check("an unknown ?source= opens nothing", (await t.count(".cds--modal.is-visible")) === 0);
    // Delete asks; Cancel keeps; Delete removes it on the server.
    await button(t, "Delete Budget").click();
    await t.until("Delete asks first", async () => (await modalText(t)).includes("Delete “Budget”?"));
    await t.audit("delete connection dialog");
    await button(t, "Cancel", modal(t)).click();
    await t.until("closed", async () => (await t.count(".cds--modal.is-visible")) === 0);
    await t.check("Cancel keeps both", (await panel(t).locator("tbody tr").count()) === 2 && f.settings.sources.length === 2);
    await button(t, "Delete Budget").click();
    await t.until("asked again", async () => (await modalText(t)).includes("Delete “Budget”?"));
    await button(t, "Delete", modal(t)).click();
    await t.until("the connection is gone from the table and the server", async () => (await panel(t).locator("tbody tr").count()) === 1 && f.settings.sources.length === 1);
    // A failing delete says so.
    f.failPut = { status: 500, error: "the database is read-only" };
    await button(t, "Delete Sales CRM").click();
    await t.until("asked", async () => (await modalText(t)).includes("Delete “Sales CRM”?"));
    await button(t, "Delete", modal(t)).click();
    await t.until("a refused delete is explained and the connection stays", async () => (await panelText(t)).includes("the database is read-only") && (await panel(t).locator("tbody tr").count()) === 1);
    await t.audit("delete refused");
    f.failPut = null;
    // Everything is still there after loading the page again.
    await openSection(t, "connections");
    await t.until("the connection comes back after a reload", async () => (await panelText(t)).includes("Sales CRM"));
  }, { viewport: vp });
}

test("connections: a connection that can't be read shows its problem and warnings; a server that can't answer", async (t) => {
  await t.boot();
  const f = await fakeServer(t);
  f.settings.sources = [
    pgSource({ problem: "password authentication failed for user \"reader\"" }),
    pgSource({ id: "src-two", name: "Warehouse", warnings: ["The user can write: give it a user that can only read."] }),
    pgSource({ id: "src-old", name: "Legacy", kind: "oracle", connector: undefined }),
  ];
  await connected(t);
  await openSection(t, "connections");
  await t.until("the problem is shown", async () => (await panelText(t)).includes("password authentication failed"));
  await t.check("the warning is shown", (await panelText(t)).includes("The user can write"));
  await t.check("an unknown kind is named as such", (await panelText(t)).includes("oracle (unknown)"));
  await t.audit("connections with a problem and a warning");
  await button(t, "Edit Legacy").click();
  await t.until("an unknown kind still opens", async () => (await modalText(t)).includes("Edit Legacy"));
  await t.check("the kind select offers its unknown kind", (await modal(t).getByLabel("Kind", { exact: true }).inputValue()) === "oracle");
  await t.audit("edit a connection of an unknown kind");
  await t.page.keyboard.press("Escape");
  // The server's settings can't be read.
  f.failGet = { status: 500, error: "the settings table is gone" };
  await openSection(t, "connections");
  await t.until("a failing server is explained", async () => (await panelText(t)).includes("Can't read the server's settings") && (await panelText(t)).includes("the settings table is gone"));
  await t.audit("connections, settings unreadable");
});

// ---------------------------------------------------------------------------------------------
// AI
// ---------------------------------------------------------------------------------------------

/** The language model at LLM: the models it lists and a scripted answer for the chat endpoint. */
async function fakeModel(t, { models = ["fake-model", "other-model"] } = {}) {
  const m = { calls: [], status: 200, models };
  await t.page.route(`${LLM}/**`, async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    if (req.url().endsWith("/models")) return route.fulfill({ status: 200, headers: CORS, json: { data: m.models.map((id) => ({ id })) } });
    let body = {};
    try {
      body = JSON.parse(req.postData() || "{}");
    } catch {}
    m.calls.push({ model: body.model, auth: req.headers().authorization || "" });
    if (m.status !== 200) return route.fulfill({ status: m.status, headers: CORS, json: { error: { message: "Incorrect API key provided" } } });
    return route.fulfill({ status: 200, headers: CORS, json: { choices: [{ message: { content: "ok" } }] } });
  });
  return m;
}

const results = async (t) => (await panel(t).locator(".cds--inline-notification").allInnerTexts()).map((s) => s.replace(/\s+/g, " ").trim());

for (const vp of ["desktop", "phone"]) {
  test(`ai: this device's own model: address, key, model lists, Save only when changed, Test, Requests @ ${vp}`, async (t) => {
    await t.boot();
    await fakeServer(t);
    const llm = await fakeModel(t);
    await openSection(t, "ai");
    const source = field(t, "Language model");
    const save = button(t, "Save");
    const test = button(t, "Test");
    await t.check("without a server the model comes from the server and says it needs one", (await source.inputValue()) === "server" && (await panelText(t)).includes("No server"));
    await t.check("nothing to save, nothing to test", (await save.isDisabled()) && (await test.isDisabled()));
    await t.audit("ai, no server");
    await source.selectOption("own");
    await t.until("the device's own model shows its boxes", async () => (await field(t, "Address").count()) === 1 && (await t.page.getByRole("combobox", { name: "Model for AI fields" }).count()) === 1);
    await t.check("choosing it is a change to save, no model to test yet", !(await save.isDisabled()) && (await test.isDisabled()));
    await t.check("its address and key are empty, the key is a password box", (await field(t, "Address").inputValue()) === "" && (await panel(t).locator('input[id$="-key"]').getAttribute("type")) === "password");
    await t.audit("ai, own model");
    await field(t, "Address").fill(LLM);
    await panel(t).locator('input[id$="-key"]').fill("sk-test");
    const fieldModel = t.page.getByRole("combobox", { name: "Model for AI fields" });
    const codeModel = t.page.getByRole("combobox", { name: "Model for writing components" });
    await t.until("the provider's models are offered", async () => (await panelText(t)).includes("2 models offered"), { timeout: 6000 });
    await fieldModel.click();
    await t.until("the model list opens with both models", async () => (await t.page.getByRole("listbox").getByRole("option").allInnerTexts()).map((s) => s.trim()).join() === "fake-model,other-model");
    await t.audit("ai, model list open");
    await t.page.getByRole("option", { name: "fake-model", exact: true }).click();
    await t.until("picking a model fills the box", async () => (await fieldModel.inputValue()) === "fake-model");
    await t.check("Test is possible now", !(await test.isDisabled()));
    await codeModel.click();
    await t.page.getByRole("option", { name: "other-model", exact: true }).click();
    await t.until("the component model is picked too", async () => (await codeModel.inputValue()) === "other-model");
    // Test: one request per model, with the key.
    await test.click();
    await t.until("Test reports each model", async () => (await results(t)).filter((r) => r.includes("replied: ok")).length === 2, { timeout: 8000 });
    const texts = await results(t);
    await t.check("both are named and marked as working", texts.some((r) => r.includes("Works") && r.includes("fake-model replied: ok")) && texts.some((r) => r.includes("other-model replied: ok")), texts.join(" / "));
    await t.check("the requests carried the model and the key", llm.calls.length === 2 && llm.calls.every((c) => c.auth === "Bearer sk-test") && llm.calls.map((c) => c.model).sort().join() === "fake-model,other-model", JSON.stringify(llm.calls));
    await t.audit("ai, test ok");
    // A provider that refuses.
    llm.status = 401;
    await test.click();
    await t.until("a refusing provider shows Failed with its message", async () => (await results(t)).some((r) => r.includes("Failed") && r.includes("401") && r.includes("Incorrect API key provided")), { timeout: 8000 });
    await t.audit("ai, test failed");
    llm.status = 200;
    // Save stores it on the device only.
    await save.click();
    await t.until("Save stores the settings on this device", async () => (await pref(t, "kubus.ai"))?.source === "own");
    const stored = await pref(t, "kubus.ai");
    await t.check("address, key and both models are stored", stored.baseUrl === LLM && stored.apiKey === "sk-test" && stored.fieldModel === "fake-model" && stored.codeModel === "other-model", JSON.stringify(stored));
    await t.check("saving leaves nothing to save and clears the test results", (await save.isDisabled()) && (await results(t)).length === 0);
    // Editing the key makes it saveable again, undoing it does not.
    await panel(t).locator('input[id$="-key"]').fill("sk-other");
    await t.check("a changed key can be saved", !(await save.isDisabled()));
    await panel(t).locator('input[id$="-key"]').fill("sk-test");
    await t.check("the saved key typed again leaves nothing to save", await save.isDisabled());
    // Requests: takes effect at once.
    const requests = switchOf(t, "Requests");
    await t.check("Requests are running", (await requests.getByRole("switch").getAttribute("aria-checked")) === "true" && !(await pref(t, "kubus.ai")).paused);
    await requests.locator(".cds--toggle__appearance").first().click();
    await t.until("pausing is stored at once", async () => (await pref(t, "kubus.ai")).paused === true);
    await t.check("pausing kept the rest", (await pref(t, "kubus.ai")).fieldModel === "fake-model");
    await t.audit("ai, requests paused");
    // Everything is there after a reload; the key is in this device's storage only.
    await openSection(t, "ai");
    await t.check("the choice, address and models are shown after a reload", (await source.inputValue()) === "own" && (await field(t, "Address").inputValue()) === LLM && (await fieldModel.inputValue()) === "fake-model" && (await codeModel.inputValue()) === "other-model");
    await t.check("Requests are still paused", (await requests.getByRole("switch").getAttribute("aria-checked")) === "false");
    await requests.locator(".cds--toggle__appearance").first().click();
    await t.until("running again is stored", async () => (await pref(t, "kubus.ai")).paused === false);
    // Back to the server's: no own boxes; Save stores the choice.
    await source.selectOption("server");
    await t.check("the own boxes are gone", (await field(t, "Address").count()) === 0);
    await save.click();
    await t.until("the choice of the server's is stored", async () => (await pref(t, "kubus.ai")).source === "server");
    await t.audit("ai, back to the server's");
  }, { viewport: vp, smoke: vp === "desktop" });
}

test("ai: the server's model: set up, key set and removed, offered to the devices, Test goes through the server", async (t) => {
  await t.boot();
  const f = await fakeServer(t);
  await connected(t);
  await openSection(t, "ai");
  const save = button(t, "Save");
  const test = button(t, "Test");
  await t.until("the server's boxes load", async () => (await field(t, "Address").count()) === 1);
  await t.check("the server is the default, with a warning that it offers no model", (await field(t, "Language model").inputValue()) === "server" && (await panelText(t)).includes("No model from the server"));
  await t.check("the key says None, no Remove key", (await panel(t).locator('input[id$="-server-key"]').getAttribute("placeholder")) === "None" && (await button(t, "Remove key").count()) === 0);
  await t.check("nothing to save or test", (await save.isDisabled()) && (await test.isDisabled()));
  await t.audit("ai, the server's, nothing set");
  await field(t, "Address").fill(LLM);
  await panel(t).locator('input[id$="-server-key"]').fill("server-key");
  await panel(t).locator('input[id$="-server-field"]').fill("fake-model");
  await t.check("a change to the server's model: Save on, Test off until saved, no warning while typing", !(await save.isDisabled()) && (await test.isDisabled()) && !(await panelText(t)).includes("No model from the server"));
  await t.audit("ai, the server's, filled");
  // A server that refuses: shown, nothing stored.
  f.failPut = { status: 400, error: "The address must be http(s)" };
  await save.click();
  await t.until("a refused save says why", async () => (await panelText(t)).includes("Not saved") && (await panelText(t)).includes("The address must be http(s)"));
  await t.check("the form keeps the typed values and Save stays possible", (await field(t, "Address").inputValue()) === LLM && !(await save.isDisabled()));
  await t.audit("ai, the server's, refused");
  f.failPut = null;
  const refused = f.puts.length;
  await save.click();
  await t.until("Save reaches the server", async () => f.puts.length === refused + 1 && f.settings.ai.url === LLM);
  const put = f.puts[refused];
  await t.check("the key travelled to the server, with the model and the rest of its settings", put.ai.key === "server-key" && put.ai.fieldModel === "fake-model" && put.ai.codeModel === "" && put.map?.style === "auto", JSON.stringify(put));
  await t.until("Saved is shown", async () => (await panelText(t)).includes("The server offers this model to every device now."));
  await t.check("the key is never shown again: only that it is set, with Remove key", (await panel(t).locator('input[id$="-server-key"]').inputValue()) === "" && (await panel(t).locator('input[id$="-server-key"]').getAttribute("placeholder")) === "Set: type to replace it" && (await button(t, "Remove key").count()) === 1);
  await t.check("nothing to save any more, the warning is gone, Test is possible", (await save.isDisabled()) && !(await panelText(t)).includes("No model from the server") && !(await test.isDisabled()));
  await t.check("the device stored no key of its own", (await rawPref(t, "kubus.ai") || "").indexOf("server-key") === -1);
  await t.audit("ai, the server's, saved");
  // Test goes through the server with this device's token, not the server's key.
  await test.click();
  await t.until("Test names the model the server offers", async () => (await results(t)).some((r) => r.includes("fake-model replied: ok")), { timeout: 8000 });
  await t.check("the request went to the server's proxy with the sync token", f.chats.length === 1 && f.chats[0].model === "fake-model" && f.chats[0].auth === `Bearer ${TOKEN}`, JSON.stringify(f.chats));
  // Remove key: a change, saved as an empty key.
  await button(t, "Remove key").click();
  await t.check("Remove key is a change to save and shows None", !(await save.isDisabled()) && (await panel(t).locator('input[id$="-server-key"]').getAttribute("placeholder")) === "None" && (await button(t, "Remove key").count()) === 0);
  await save.click();
  await t.until("the empty key is sent and the server no longer has one", async () => f.puts.length === refused + 2 && f.puts[refused + 1].ai.key === "" && f.settings.ai.keySet === false);
  // The code model: its own, sent along (once the form has taken the saved settings back in).
  await t.until("the form shows the saved settings: no key, nothing to save", async () => (await panel(t).locator('input[id$="-server-key"]').getAttribute("placeholder")) === "None" && (await save.isDisabled()));
  await panel(t).locator('input[id$="-server-code"]').fill("strong-model");
  await save.click();
  await t.until("the component model is saved", async () => f.puts.length === refused + 3 && f.puts[refused + 2].ai.codeModel === "strong-model");
  await t.check("a key left alone is not sent", f.puts[refused + 2].ai.key === undefined, JSON.stringify(f.puts[refused + 2].ai));
  // It is all there after a reload.
  await openSection(t, "ai");
  await t.until("the server's values come back", async () => (await field(t, "Address").inputValue()) === LLM && (await panel(t).locator('input[id$="-server-code"]').inputValue()) === "strong-model");
  // No model at all again: the warning is back.
  await field(t, "Address").fill("");
  await save.click();
  await t.until("with no address the server offers no model", async () => f.settings.ai.url === "" && (await panelText(t)).includes("No model from the server"), { timeout: 8000 });
  await t.audit("ai, the server's, cleared");
});

test("ai: a server that can't be read", async (t) => {
  await t.boot();
  const f = await fakeServer(t);
  f.failGet = { status: 500, error: "no settings today" };
  await connected(t);
  await openSection(t, "ai");
  await t.until("the server's settings can't be read", async () => (await panelText(t)).includes("Can't read the server's settings") && (await panelText(t)).includes("no settings today"));
  await t.audit("ai, server unreadable");
  await field(t, "Language model").selectOption("own");
  await t.check("the device's own model is still there", (await field(t, "Address").count()) === 1);
});

// ---------------------------------------------------------------------------------------------
// Maps
// ---------------------------------------------------------------------------------------------

test("maps: the style is this device's own without a server, the server's with one", async (t) => {
  await t.boot();
  const f = await fakeServer(t);
  await openSection(t, "maps");
  const style = field(t, "Map style");
  const options = await style.locator("option").allInnerTexts();
  await t.check("the five styles are offered", JSON.stringify(options) === JSON.stringify(["Automatic", "Light", "Dark", "Liberty", "Bright"]), options.join());
  await t.check("Automatic until one is chosen, the helper says it is this device's own", (await style.inputValue()) === "auto" && (await panelText(t)).includes("This device's own"));
  await t.audit("maps, device");
  for (const [value, text] of [["dark", "Dark"], ["liberty", "Liberty"], ["bright", "Bright"], ["positron", "Light"], ["auto", "Automatic"]]) {
    await style.selectOption(value);
    await t.until(`${text} is stored on the device`, async () => (await rawPref(t, "kubus.mapStyle")) === value);
  }
  await style.selectOption("liberty");
  await t.until("Liberty stored", async () => (await rawPref(t, "kubus.mapStyle")) === "liberty");
  await openSection(t, "maps");
  await t.check("it is still chosen after a reload", (await style.inputValue()) === "liberty");
  await t.check("no server was asked", f.log.length === 0, f.log.join());
  // With a server: its style, for every device.
  f.settings.map = { style: "dark" };
  await connected(t);
  await openSection(t, "maps");
  await t.until("the server's style is shown", async () => (await style.inputValue()) === "dark" && (await panelText(t)).includes("For every device connected to this server"));
  await t.audit("maps, server");
  await style.selectOption("bright");
  await t.until("the choice is saved on the server", async () => f.settings.map.style === "bright" && f.puts.length === 1);
  await t.check("the other settings went along unchanged", f.puts[0].ai.url === "" && f.puts[0].sources.length === 0);
  await t.until("the device keeps the last style known", async () => (await rawPref(t, "kubus.mapStyle")) === "bright");
  // Another device changed it meanwhile: this one shows the server's, not its own.
  f.settings.map = { style: "positron" };
  await t.page.evaluate(() => localStorage.setItem("kubus.mapStyle", "dark"));
  await openSection(t, "maps");
  await t.until("a reload shows the server's style", async () => (await style.inputValue()) === "positron");
  // A refused save.
  f.failPut = { status: 400, error: "No such style" };
  await style.selectOption("dark");
  await t.until("a refused save is explained", async () => (await panelText(t)).includes("Not saved") && (await panelText(t)).includes("No such style"));
  await t.check("and the server's style is unchanged", f.settings.map.style === "positron");
  await t.audit("maps, refused");
  f.failPut = null;
  // A server of an earlier version has no map style: the device's own.
  delete f.settings.map;
  await t.page.evaluate(() => localStorage.setItem("kubus.mapStyle", "bright"));
  await openSection(t, "maps");
  await t.until("an older server: the helper says so", async () => (await panelText(t)).includes("This server is of an earlier version"));
  const puts = f.puts.length;
  await style.selectOption("dark");
  await t.until("the style is the device's", async () => (await rawPref(t, "kubus.mapStyle")) === "dark");
  await t.check("the older server was not written to", f.puts.length === puts);
});

// ---------------------------------------------------------------------------------------------
// API tokens
// ---------------------------------------------------------------------------------------------

for (const vp of ["desktop"]) {
  test(`tokens: make, shown once, copy, revoke asks @ ${vp}`, async (t) => {
    await t.boot();
    const f = await fakeServer(t);
    await t.context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(t.page.url()).origin }).catch(() => {});
    await connected(t);
    await openSection(t, "tokens");
    await t.until("the list loads", async () => (await panelText(t)).includes("No API tokens yet."));
    await t.audit("tokens, none");
    // A name is needed.
    const make = button(t, "Make a token");
    await make.click();
    await t.until("an empty name is refused", async () => (await panelText(t)).includes("Give the token a name"));
    await t.check("nothing was made", f.tokens.length === 0);
    await t.audit("tokens, name missing");
    // A read token.
    await field(t, "Name").fill("Backup script");
    await make.click();
    await t.until("the new token is shown in a dialog", async () => (await modalText(t)).includes("API token Backup script"));
    const shown = (await modal(t).locator(".cds--snippet").innerText()).trim();
    await t.check("the token itself is in the dialog, and says it can only read", shown === f.madeTokens[0].token && (await modalText(t)).includes("It can only read.") && (await modalText(t)).includes("only this once"), shown);
    await t.audit("token made");
    // A stray click doesn't lose it.
    await t.page.mouse.click(4, t.vp.height - 4);
    await t.settle(150);
    await t.check("a click outside doesn't close it", (await t.count(".cds--modal.is-visible")) === 1);
    // Copy.
    await modal(t).getByRole("button", { name: "Copy the token" }).click();
    await t.until("Copied is shown", async () => (await t.page.getByText("Copied", { exact: true }).count()) > 0 || (await modalText(t)).includes("Copied"), { timeout: 3000 });
    const clip = await t.page.evaluate(() => navigator.clipboard.readText().catch(() => null));
    await t.check("the clipboard holds the token", clip === null || clip === shown, String(clip));
    await button(t, "Done", modal(t)).click();
    await t.until("Done closes it", async () => (await t.count(".cds--modal.is-visible")) === 0);
    const rows = panel(t).locator("tbody tr");
    await t.until("the token is listed by name and access, never used", async () => (await rows.count()) === 1 && /Backup script\s+Read\s+.*Never/s.test(await rows.first().innerText()));
    await t.check("the list does not hold the token itself", !(await panelText(t)).includes("kbs_"));
    await t.check("the form is empty again", (await field(t, "Name").inputValue()) === "");
    // A write token.
    await field(t, "Name").fill("Importer");
    await field(t, "Access").selectOption("write");
    await make.click();
    await t.until("the second token is shown", async () => (await modalText(t)).includes("API token Importer") && (await modalText(t)).includes("It can read and write."));
    await t.check("the server received its access", f.tokens[1].access === "write");
    await button(t, "Done", modal(t)).click();
    await t.until("both are listed", async () => (await rows.count()) === 2 && (await panelText(t)).includes("Read & write"));
    await t.audit("tokens, two");
    // Still there after a reload, and the token is never shown again.
    await openSection(t, "tokens");
    await t.until("the list comes back", async () => (await rows.count()) === 2);
    await t.check("without the token", !(await panelText(t)).includes("kbs_"));
    // Revoke asks.
    await button(t, "Revoke Backup script").click();
    await t.until("Revoke asks first", async () => (await modalText(t)).includes("Revoke Backup script?"));
    await t.audit("revoke token dialog");
    await button(t, "Cancel", modal(t)).click();
    await t.until("closed", async () => (await t.count(".cds--modal.is-visible")) === 0);
    await t.check("Cancel keeps it", (await rows.count()) === 2 && f.tokens.length === 2);
    await button(t, "Revoke Backup script").click();
    await t.until("asked again", async () => (await modalText(t)).includes("Revoke Backup script?"));
    await button(t, "Revoke", modal(t)).click();
    await t.until("revoked on the server and gone from the list", async () => (await rows.count()) === 1 && f.tokens.length === 1 && f.tokens[0].name === "Importer");
    await button(t, "Revoke Importer").click();
    await t.until("asked", async () => (await modalText(t)).includes("Revoke Importer?"));
    await button(t, "Revoke", modal(t)).click();
    await t.until("no tokens left", async () => (await panelText(t)).includes("No API tokens yet."));
    // A server that refuses.
    f.failTokens = { status: 403, error: "tokens are switched off" };
    await field(t, "Name").fill("Blocked");
    await make.click();
    await t.until("a refusal is explained", async () => (await panelText(t)).includes("API tokens") && (await panelText(t)).includes("tokens are switched off"));
    await t.check("no token dialog opened", (await t.count(".cds--modal.is-visible")) === 0);
    await t.audit("tokens, refused");
    f.failTokens = null;
  }, { viewport: vp });
}

test("tokens: a server that can't list them", async (t) => {
  await t.boot();
  const f = await fakeServer(t);
  f.failTokens = { status: 500, error: "the token table is locked" };
  await connected(t);
  await openSection(t, "tokens");
  await t.until("the failure is shown", async () => (await panelText(t)).includes("the token table is locked"));
  await t.check("Make a token waits for the list", await button(t, "Make a token").isDisabled());
  await t.audit("tokens, unreadable");
});

// ---------------------------------------------------------------------------------------------
// The source picker of a remote collection
// ---------------------------------------------------------------------------------------------

const CUSTOMERS = {
  columns: [
    { name: "id", type: "integer", kind: "number" },
    { name: "full_name", type: "text", kind: "string" },
    { name: "joined", type: "date", kind: "date" },
  ],
  key: ["id"],
  dropped: [{ name: "photo", type: "bytea" }],
};

for (const vp of ["desktop"]) {
  test(`source picker: a new remote collection reads a source's table @ ${vp}`, async (t) => {
    await t.boot();
    const f = await fakeServer(t);
    f.sources = [
      { name: "CRM", connector: "postgres", capabilities: { query: true, queryLanguage: "SQL" } },
      { name: "Broken", connector: "postgres", capabilities: { query: false }, problem: "connection refused" },
    ];
    f.tables = { CRM: [{ schema: "public", name: "customers", type: "table" }, { schema: "public", name: "open_orders", type: "view" }, { schema: "public", name: "orders", type: "table" }], Broken: [] };
    f.columns = { customers: CUSTOMERS, orders: { columns: [{ name: "order_no", type: "text", kind: "string" }], key: ["order_no"], dropped: [] } };
    await connected(t);
    await t.open("/remotes");
    await t.until("with sources offered, Remotes is in the side nav", async () => (await t.page.getByRole("link", { name: "Remotes", exact: true }).count()) > 0 || (await t.page.getByText("Remotes", { exact: true }).count()) > 0, { timeout: 6000 });
    await t.audit("remotes, none yet");
    await t.page.locator(".ws-pane--active").getByRole("button", { name: "New remote collection" }).first().click();
    const dropdown = t.page.getByRole("combobox", { name: "Source" });
    await t.until("the sources load", async () => ((await dropdown.innerText().catch(() => "")) || "").includes("Choose a source"));
    await t.check("no table to choose before a source", (await t.page.getByRole("combobox", { name: "Table" }).count()) === 0);
    await t.audit("new remote collection, no source");
    // Saving without a source or key says what is missing.
    await t.page.getByRole("button", { name: "Add collection", exact: true }).click();
    await t.until("a missing key is explained", async () => (await t.page.locator(".ws-pane--active").innerText()).includes("Choose the column that tells rows apart"));
    // Pick the source: the one with a problem names it.
    await dropdown.click();
    const optionTexts = (await t.page.getByRole("option").allInnerTexts()).map((s) => s.trim());
    await t.check("the sources are offered, a broken one with its problem", JSON.stringify(optionTexts) === JSON.stringify(["CRM", "Broken (connection refused)"]), optionTexts.join(" | "));
    await t.audit("source list open");
    await t.page.getByRole("option", { name: "CRM", exact: true }).click();
    const table = t.page.getByRole("combobox", { name: "Table" });
    await t.until("choosing the source offers its tables", async () => (await table.count()) === 1 && f.log.includes("GET /api/sources/CRM/tables"));
    await table.click();
    const tableOptions = (await t.page.getByRole("option").allInnerTexts()).map((s) => s.trim());
    await t.check("tables and views, schema first", JSON.stringify(tableOptions) === JSON.stringify(["public.customers", "public.open_orders (view)", "public.orders"]), tableOptions.join(" | "));
    await t.page.getByRole("option", { name: "public.customers", exact: true }).click();
    await t.until("the columns are read", async () => f.describes.length === 1);
    await t.check("it asked the source about that table", f.describes[0].source === "CRM" && f.describes[0].target.table.name === "customers" && f.describes[0].target.table.schema === "public", JSON.stringify(f.describes));
    const pane = t.page.locator(".ws-pane--active");
    await t.until("a field per column, the key chosen, the names follow the table", async () => {
      const text = await pane.innerText();
      return text.includes("Not read: photo (bytea).") && (await t.page.locator('input[value="full_name"]').count()) + (await t.page.locator('input[value="joined"]').count()) >= 0 && text.includes("id") || text.slice(0, 200);
    });
    await t.check("the collection is named after the table", (await pane.getByLabel("Name", { exact: true }).first().inputValue().catch(() => "")) === "Customer" || (await pane.locator("input[value='Customer']").count()) > 0);
    await t.check("the key is the primary key", ((await t.page.getByRole("combobox", { name: "Key" }).innerText()) || "").includes("id"));
    await t.audit("remote collection, table read");
    // The key can be another column.
    await t.page.getByRole("combobox", { name: "Key" }).click();
    await t.page.getByRole("option", { name: "full_name", exact: true }).click();
    await t.check("a column can be the key", ((await t.page.getByRole("combobox", { name: "Key" }).innerText()) || "").includes("full_name"));
    await t.page.getByRole("combobox", { name: "Key" }).click();
    await t.page.getByRole("option", { name: "id", exact: true }).click();
    // A table the source can't describe.
    await table.click();
    await t.page.getByRole("option", { name: "public.open_orders (view)", exact: true }).click();
    await t.until("a failing table is explained", async () => (await pane.innerText()).includes('relation "open_orders" does not exist'));
    await t.audit("remote collection, source error");
    // Another table that reads fine replaces the fields and clears the error; then back to the first.
    await table.click();
    await t.page.getByRole("option", { name: "public.orders", exact: true }).click();
    await t.until("a table that reads clears the error and brings its column", async () => !(await pane.innerText()).includes("does not exist") && (await pane.innerText()).includes("order_no"));
    await t.check("the collection follows the table", (await pane.locator("input[value='Order']").count()) > 0);
    await table.click();
    await t.page.getByRole("option", { name: "public.customers", exact: true }).click();
    await t.until("back to customers: its columns, not the orders'", async () => (await pane.innerText()).includes("full_name") && !(await pane.innerText()).includes("order_no"));
    // Add it.
    await t.page.getByRole("button", { name: "Add collection", exact: true }).click();
    await t.until("the collection is stored as remote with its key and columns", async () => {
      const c = await t.page.evaluate(async () => (await window.kubus.repo.listCollections()).find((x) => x.source)?.source ?? null);
      return (c && c.name === "CRM" && c.key === "id" && c.columns.length === 3 && c.target.table.name === "customers") || JSON.stringify(c);
    }, { timeout: 8000 });
    const made = await t.page.evaluate(async () => (await window.kubus.repo.listCollections()).find((x) => x.source));
    await t.check("named after its table, one field per column", made.name === "Customer" && made.pluralName === "Customers" && made.fields.filter((x) => x.column).length === 3, JSON.stringify({ n: made.name, p: made.pluralName, f: made.fields.map((x) => x.column) }));
    // Edit: the source can't be changed, the columns can be read again.
    await t.open(`/remotes/${made.id}/edit`);
    await t.until("the editor shows its source", async () => ((await dropdown.innerText().catch(() => "")) || "").includes("CRM"));
    await t.check("the source is fixed once made", await dropdown.isDisabled().catch(() => false) || (await dropdown.getAttribute("aria-disabled")) === "true");
    const again = t.page.getByRole("button", { name: "Read columns again", exact: true });
    await t.check("it offers Read columns again", (await again.count()) === 1);
    const describes = f.describes.length;
    await again.click();
    await t.until("it asks the source again", async () => f.describes.length === describes + 1);
    await t.audit("remote collection, editing");
  }, { viewport: vp });
}

test("source picker: a server that offers no sources, or can't be reached", async (t) => {
  await t.boot();
  const f = await fakeServer(t);
  await connected(t);
  await t.open("/collections");
  await t.check("with no sources there is no Remotes in the side nav", (await t.page.getByText("Remotes", { exact: true }).count()) === 0);
  await t.open("/remotes/new");
  const dropdown = t.page.getByRole("combobox", { name: "Source" });
  await t.until("it says the server offers none", async () => ((await dropdown.innerText().catch(() => "")) || "").includes("The server offers no sources"));
  await t.check("and can't be opened", await dropdown.isDisabled().catch(() => false) || (await dropdown.getAttribute("aria-disabled")) === "true");
  await t.audit("remote collection, no sources");
  // The server fails.
  f.unreachable = true;
  await t.open("/remotes/new");
  await t.until("an unreachable server is explained", async () => (await t.page.locator(".ws-pane--active").innerText()).includes("The Kubus server can't be reached"));
  await t.audit("remote collection, server unreachable");
  // No server at all.
  await t.page.evaluate(() => localStorage.removeItem("kubus.sync"));
  await t.open("/remotes/new");
  await t.until("without a server it points to Settings", async () => (await t.page.locator(".ws-pane--active").innerText()).includes("Remote collections are read through a Kubus server"));
});

// ---------------------------------------------------------------------------------------------
// Everything at every width
// ---------------------------------------------------------------------------------------------

for (const vp of ["phone-small", "laptop"]) {
  test(`settings: every section filled in, connected, audited @ ${vp}`, async (t) => {
    await t.boot();
    const f = await fakeServer(t);
    f.settings.ai = { url: LLM, fieldModel: "a-very-long-model-name-that-goes-on/and-on-and-on:latest", codeModel: "", keySet: true };
    f.settings.sources = [pgSource({ name: "A connection with a name that is rather long indeed" }), pgSource({ id: "s2", name: "Calendar", kind: "ics", fields: { address: "webcal://calendar.example.com/a/very/long/address/that/never/ends/basic.ics" }, schemas: [] })];
    f.tokens = [{ id: "tok-1", name: "A token with a rather long name for a script", access: "write", createdAt: new Date().toISOString(), lastUsedAt: new Date().toISOString() }];
    await connected(t, { originals: "opened" });
    await fakeModel(t);
    for (const [section, name] of SECTIONS) {
      await openSection(t, section);
      await t.until(`${name} loads`, async () => {
        const text = await panelText(t);
        return text.length > 40 && !/Loading/.test(text);
      });
      await t.audit(`${name}, connected`);
    }
    await openSection(t, "connections", `&source=${f.settings.sources[0].id}`);
    await t.until("a connection opens", async () => (await modalText(t)).includes("Edit A connection"));
    await t.until("focus is inside the dialog", () => t.page.evaluate(() => !!document.activeElement?.closest(".cds--modal.is-visible")));
    await t.audit("connection dialog");
    await t.page.keyboard.press("Escape");
    await t.until("Escape closes the connection dialog", async () => (await t.count(".cds--modal.is-visible")) === 0, { timeout: 8000 });
  }, { viewport: vp });
}
