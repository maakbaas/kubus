// Backup (Settings): Download backup gives a real SQLite file with the data and images in it; Restore
// from backup asks first, Cancel changes nothing, restoring brings the data back and leaves sync off.

const SRV = "https://srv.test";

const TOKEN = "secret-token";

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

const panel = (t) => t.page.locator(".ws-pane--active .settings-panel:visible");

const panelText = async (t) => (await panel(t).innerText().catch(() => "")) || "";

const modalText = async (t) => (await shownModal(t).innerText().catch(() => "")) || "";

const button = (t, name, scope = panel(t)) => scope.getByRole("button", { name, exact: true });

const switchOf = (t, label) => panel(t).locator(".cds--toggle").filter({ hasText: label });

const settingsPath = (section) => `/settings?section=${section}`;

/** Opens a section in a fresh load. */
async function openSection(t, section, extra = "") {
  await t.open(settingsPath(section) + extra);
}

/** Makes the page keep the files it is handed to download (their blobs and names) in window.__downloads. */
async function captureDownloads(t) {
  await t.page.evaluate(() => {
    if (window.__capturing) return;
    window.__capturing = true;
    window.__downloads = [];
    const blobs = {};
    const create = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (blob) => {
      const url = create(blob);
      blobs[url] = blob;
      return url;
    };
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (this.download) window.__downloads.push({ name: this.download, blob: blobs[this.href] });
      return click.call(this);
    };
  });
}

/** The last downloaded file as base64 (to hand back to the page after it has reloaded), with its name and size. */
async function lastDownload(t) {
  return t.page.evaluate(async () => {
    const d = window.__downloads[window.__downloads.length - 1];
    if (!d) return null;
    const bytes = new Uint8Array(await d.blob.arrayBuffer());
    let text = "";
    for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return { name: d.name, size: bytes.length, b64: btoa(text), header: text.slice(0, 16), type: d.blob.type };
  });
}

/**
 * Hands the page's Restore from backup a file made from `b64` (a backup, base64) changed by `how`: "same", "text"
 * (a text file), "empty", "damaged" (the header kept, every page ruined), "newer" (made by a newer app: user_version 99),
 * "foreign" (SQLite, but its tables are not Kubus's: their names changed to others of the same length).
 */
async function pickBackup(t, b64, how, name = "kubus-backup.sqlite") {
  await t.page.evaluate(
    ({ b64, how, name }) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      let out = bytes;
      if (how === "text") out = new TextEncoder().encode("Shopping list\n- milk\n- eggs\n");
      if (how === "empty") out = new Uint8Array(0);
      if (how === "damaged") {
        out = bytes.slice();
        out.fill(0xab, 100);
      }
      if (how === "newer") {
        out = bytes.slice();
        new DataView(out.buffer).setUint32(60, 99);
      }
      if (how === "foreign") {
        out = bytes.slice();
        const from = new TextEncoder().encode("collections");
        const to = new TextEncoder().encode("collectionz");
        for (let i = 0; i + from.length <= out.length; i++) if (from.every((b, k) => out[i + k] === b)) out.set(to, i);
      }
      const input = document.querySelector(".ws-pane--active .settings-panel input[type=file]");
      const dt = new DataTransfer();
      dt.items.add(new File([out], name, { type: "application/octet-stream" }));
      input.files = dt.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    },
    { b64, how, name },
  );
}

/** What the repository holds, for comparing before and after: names, counts, titles and the bytes of every image. */
const fingerprint = (t) =>
  t.page.evaluate(async () => {
    const repo = window.kubus.repo;
    const collections = await repo.listCollections();
    const counts = await repo.countItemsByCollection(null);
    const out = { spaces: (await repo.listSpaces()).map((s) => s.name), collections: [], images: 0 };
    for (const c of collections) {
      const items = await repo.listItems(c, "default");
      const image = c.fields.find((f) => f.kind === "image");
      for (const i of items) {
        const id = image && i.values[image.id];
        if (id) out.images += (await repo.getFile(id))?.data?.length ?? 0;
      }
      out.collections.push({ name: c.name, fields: c.fields.length, items: counts[c.id] ?? 0, titles: items.map((i) => String(i.values[c.fields[0].id] ?? "")).sort() });
    }
    return JSON.stringify(out);
  });

const todayName = () => {
  const d = new Date();
  return `kubus-backup-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}.sqlite`;
};

test("backup: Download backup saves a SQLite file named by the day, with the data and the images in it @ desktop", async (t) => {
  await t.boot();
  await fakeServer(t);
  await t.seed(profileSpec("typical", { items: 3 }));
  await openSection(t, "backup");
  await captureDownloads(t);
  const text = await panelText(t);
  await t.check("it says what a backup includes and what it does not", text.includes("Included:") && text.includes("Not included:") && text.includes("AI key") && text.includes("images stored on this device"), text.slice(0, 400));
  const restores = await panel(t).getByRole("button", { name: /Restore from backup/ }).count();
  await t.check("it offers Download backup and Restore from backup…", (await button(t, "Download backup").count()) === 1 && restores >= 1 && (await panel(t).locator("input[type=file]").count()) === 1, String(restores));
  await t.audit("backup section");
  const downloading = t.page.waitForEvent("download", { timeout: 10000 });
  await button(t, "Download backup").click();
  const download = await downloading.catch(() => null);
  await t.check("the browser downloads a file", !!download);
  await t.check("it is named kubus-backup-<today>.sqlite", download?.suggestedFilename() === todayName(), String(download?.suggestedFilename()));
  const file = await lastDownload(t);
  await t.check("the page handed it over as a SQLite file", file?.name === todayName() && file.header === "SQLite format 3\u0000", JSON.stringify({ name: file?.name, header: file?.header }));
  await t.check("it is a real database, not a stub (whole pages, with the images)", file.size >= 8192 && file.size % 512 === 0, String(file.size));
  // The seeded items' titles are in the file's pages as text.
  const titles = JSON.parse(await fingerprint(t)).collections.flatMap((c) => c.titles).filter((x) => x.length > 3);
  await t.check("there are titles to look for", titles.length >= 3);
  const missing = await t.page.evaluate(
    async ({ b64, titles }) => {
      const text = atob(b64);
      return titles.filter((x) => !text.includes(unescape(encodeURIComponent(x))));
    },
    { b64: file.b64, titles },
  );
  await t.check("the file holds the items' titles", missing.length === 0, JSON.stringify(missing.slice(0, 5)));
  await t.check("the button is usable again and nothing is shown as failed", !(await button(t, "Download backup").isDisabled()) && !(await panelText(t)).includes("The backup failed"));
}, { viewport: "desktop", smoke: true });

test("backup: Restore from backup asks first, Cancel changes nothing, restoring brings the data back and leaves sync off @ desktop", async (t) => {
  await t.boot();
  const f = await fakeServer(t);
  await t.seed(profileSpec("typical", { items: 3 }));
  const original = await fingerprint(t);
  await t.check("there is data to back up", JSON.parse(original).collections.length >= 2 && JSON.parse(original).images > 0, original.slice(0, 200));
  await openSection(t, "backup");
  await captureDownloads(t);
  await button(t, "Download backup").click();
  await t.until("the backup is downloaded", async () => (await t.page.evaluate(() => window.__downloads.length)) === 1);
  const { b64 } = await lastDownload(t);
  // A fresh device: the data wiped, the page loaded again.
  await t.page.evaluate(() => window.kubus.repo.wipeLocal());
  await openSection(t, "backup");
  await t.check("the wipe left an empty database", JSON.parse(await fingerprint(t)).collections.length === 0);
  // This device is connected to a server and syncing when the file is restored.
  await connected(t, { enabled: true });
  await openSection(t, "backup");
  await t.page.evaluate(() => (window.__marker = "same page"));
  await t.until("the empty device synced with the server first", () => f.syncs.length >= 1, { timeout: 10000 });
  const synced = f.syncs.length;
  // Choosing a file asks before anything changes.
  await pickBackup(t, b64, "same");
  await t.until("restoring asks Replace all data on this device?", async () => (await modalText(t)).includes("Replace all data on this device?"));
  const asked = await modalText(t);
  await t.check("it names the file and says it can't be undone", asked.includes("kubus-backup.sqlite") && asked.includes("can't be undone"), asked);
  await t.check("it is a danger dialog with Replace all data and Cancel", (await shownModal(t).locator(".cds--btn--danger").count()) === 1 && (await button(t, "Replace all data", shownModal(t)).count()) === 1 && (await button(t, "Cancel", shownModal(t)).count()) === 1);
  await t.audit("restore: replace all data?");
  await button(t, "Cancel", shownModal(t)).click();
  await t.until("Cancel closes it", async () => (await t.count(".cds--modal.is-visible")) === 0);
  await t.check("Cancel: nothing restored, the page not reloaded", JSON.parse(await fingerprint(t)).collections.length === 0 && (await t.page.evaluate(() => window.__marker)) === "same page");
  await t.check("Cancel: sync still on", (await pref(t, "kubus.sync")).enabled === true);
  // Escape cancels too; then restore for real.
  await pickBackup(t, b64, "same");
  await t.until("asked again", async () => (await modalText(t)).includes("Replace all data on this device?"));
  await t.until("focus is inside the dialog", () => t.page.evaluate(() => !!document.activeElement?.closest(".cds--modal.is-visible")));
  await t.page.keyboard.press("Escape");
  await t.until("Escape closes it", async () => (await t.count(".cds--modal.is-visible")) === 0);
  await t.check("Escape: nothing restored", JSON.parse(await fingerprint(t)).collections.length === 0);
  await pickBackup(t, b64, "same");
  await t.until("asked once more", async () => (await modalText(t)).includes("Replace all data on this device?"));
  await button(t, "Replace all data", shownModal(t)).click();
  await t.until("the app reloaded with the data back, exactly as it was", async () => {
    if ((await t.page.evaluate(() => window.__marker).catch(() => "gone")) === "same page") return "not reloaded yet";
    const now = await fingerprint(t).catch(() => "");
    return now === original || `different: ${now.slice(0, 200)}`;
  }, { timeout: 20000 });
  // The restore did not push itself over the server, and sync is off until it is switched on again.
  const kept = await pref(t, "kubus.sync");
  await t.check("sync is off, the server's address and token kept", kept.enabled === false && kept.url === SRV && kept.token === TOKEN, JSON.stringify(kept));
  await t.check("the restored data was not sent to the server", f.syncs.slice(synced).every((s) => !(s.tables.items > 0)), JSON.stringify(f.syncs.slice(synced)));
  await openSection(t, "sync");
  await t.check("the Sync tab shows it off", (await switchOf(t, "Sync this device").getByRole("switch").getAttribute("aria-checked")) === "false");
  await t.audit("sync tab after a restore");
  // Switching it on is a first connection: it asks, and an empty server receives the restored data.
  await switchOf(t, "Sync this device").locator(".cds--toggle__appearance").first().click();
  await t.until("switching sync on asks first", async () => (await modalText(t)).includes("Connect to this server?"));
  await button(t, "Connect", shownModal(t)).click();
  await t.until("the empty server receives the restored items", () => f.syncs.some((s) => (s.tables.items || 0) >= 3) || JSON.stringify(f.syncs.slice(synced)), { timeout: 10000 });
  await t.check("what the device holds is still the backup", (await fingerprint(t)) === original);
}, { viewport: "desktop" });
