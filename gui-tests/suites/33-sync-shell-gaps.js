// A server whose database was replaced or wiped: sync pauses until asked, connecting again asks before it
// replaces this device's data, or uploads to an empty server.

const SERVER = "https://sync.test";

/**
 * A fake Kubus server at SERVER: POST /api/sync keeps the rows it is sent and answers with the rows
 * changed since the cursor, as the database `fake.database`; a device that last synced with another
 * database gets a 409 (wiped or replaced), `empty` saying whether the server holds anything.
 */
async function fakeServer(t) {
  const fake = { requests: [], seq: 0, store: [], database: { id: "db-one", createdAt: "2026-10-01T00:00:00.000Z" }, wiped: false };
  await t.context.route(`${SERVER}/api/**`, async (route) => {
    const req = route.request();
    const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET, POST, OPTIONS" };
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    if (req.url().endsWith("/api/events")) return route.fulfill({ status: 204, headers: cors });
    if (req.url().endsWith("/api/health")) return route.fulfill({ status: 200, headers: cors, json: { ok: true } });
    if (!req.url().endsWith("/api/sync")) return route.fulfill({ status: 404, headers: cors, json: { error: "Not found" } });
    let body = { since: 0, changes: {} };
    try {
      body = JSON.parse(req.postData() || "{}");
    } catch {}
    if (body.database && body.database !== fake.database.id) {
      return route.fulfill({ status: 409, headers: cors, json: { error: "The server's database was wiped or replaced", database: fake.database, empty: fake.store.length === 0 } });
    }
    fake.requests.push({ since: body.since, tables: Object.fromEntries(Object.entries(body.changes || {}).map(([k, v]) => [k, v.length])) });
    for (const [table, list] of Object.entries(body.changes || {})) for (const row of list) fake.store.push({ seq: ++fake.seq, table, row });
    const changes = {};
    for (const e of fake.store) if (e.seq > (body.since || 0)) (changes[e.table] ||= []).push(e.row);
    return route.fulfill({ status: 200, headers: cors, json: { cursor: fake.seq, changes, database: fake.database } });
  });
  return fake;
}

/** This device is connected and syncing with the fake server, which holds its data. */
async function connected(t, fake) {
  await t.page.evaluate((c) => localStorage.setItem("kubus.sync", JSON.stringify(c)), { url: SERVER, token: "secret-token", enabled: true, originals: "always" });
  await t.open("/settings?section=sync");
  const modal = shownModal(t);
  await t.until("the first connection asks", async () => (await modal.innerText().catch(() => "")).includes("Connect to this server?") || (await t.page.getByRole("button", { name: "Up to date" }).count()) > 0, { timeout: 10000 }).catch(() => {});
  if (await modal.count()) await modal.getByRole("button", { name: "Connect" }).click();
  await t.until("this device's data reaches the server", () => fake.requests.some((r) => (r.tables.items || 0) > 0), { timeout: 15000 });
  await t.until("up to date", async () => (await t.page.getByRole("button", { name: "Up to date" }).count()) > 0, { timeout: 10000 });
}

const touch = (t) =>
  t.page.evaluate(async () => {
    const repo = window.kubus.repo;
    const c = (await repo.listCollections())[0];
    const space = (await repo.listSpaces())[0];
    await repo.createItem(c, { [c.fields[0].id]: "Made later " + Math.random() }, space.id);
  });

const itemCount = (t) =>
  t.page.evaluate(async () => {
    const repo = window.kubus.repo;
    const c = (await repo.listCollections())[0];
    return (await repo.listItems(c, "default")).length;
  });

for (const scenario of ["another database", "an empty server"]) {
  test(`a replaced server pauses sync until asked: ${scenario}`, async (t) => {
    await t.boot();
    const fake = await fakeServer(t);
    await t.seed(profileSpec("typical", { items: 3 }));
    await connected(t, fake);
    const empty = scenario === "an empty server";
    // The server is wiped (empty), or replaced by another database (it holds rows).
    fake.database = { id: "db-two", createdAt: "2026-10-05T00:00:00.000Z" };
    if (empty) fake.store = [];
    await touch(t);
    const button = t.page.getByRole("button", { name: "Server database replaced" }).first();
    await t.until("the status button says the server database was replaced", async () => (await button.count()) === 1, { timeout: 15000 });
    await button.click();
    await t.settle();
    const panel = t.page.locator(".toolbar-popover.cds--popover--open");
    const text = await panel.innerText();
    await t.check("the popover says what happened and that sync is paused", text.includes("The server's database was wiped or replaced") && text.includes("Sync is paused"), text);
    await t.check("it names when the new database was made", /database made/.test(text), text);
    await t.check(empty ? "an empty server: connecting again uploads this device's data" : "a server with data: connecting again replaces this device's data", empty ? text.includes("It is empty: connecting again uploads") && text.includes("Upload this device's data") : text.includes("replaces this device's data with the server's") && text.includes("Download the server's data"), text);
    await t.check("Configure sync is beside it", (await panel.getByRole("button", { name: "Configure sync" }).count()) === 1);
    await t.audit("server replaced: the status popover");
    await t.escapeCloses("Escape closes the popover");

    // Settings → Sync shows the same.
    await t.open("/settings?section=sync");
    const pane = t.page.locator(".ws-pane--active");
    await t.until("Settings → Sync shows it", async () => (await pane.innerText()).includes("The server's database was wiped or replaced"));
    await t.audit("server replaced: Settings → Sync");

    const connect = pane.getByRole("button", { name: empty ? "Upload this device's data" : "Download the server's data" });
    const before = await itemCount(t);
    if (!empty) {
      // Replacing this device's data asks first; Cancel keeps everything and the pause.
      await connect.click();
      await t.until("it asks before replacing", async () => (await shownModal(t).innerText().catch(() => "")).includes("Replace this device's data?"));
      await t.audit("Replace this device's data? dialog");
      await shownModal(t).getByRole("button", { name: "Cancel" }).click();
      await t.until("Cancel closes it", async () => (await t.count(".cds--modal.is-visible")) === 0);
      await t.check("…and nothing changed: still paused, same items", (await pane.innerText()).includes("The server's database was wiped or replaced") && (await itemCount(t)) === before);
      await connect.click();
      await t.until("asked again", async () => (await shownModal(t).count()) === 1);
      await shownModal(t).getByRole("button", { name: "Replace" }).click();
    } else {
      await connect.click();
    }
    await t.until("sync is on the new database again", async () => !(await pane.innerText()).includes("The server's database was wiped or replaced"), { timeout: 15000 });
    if (empty) await t.until("this device's data is uploaded to the empty server", () => fake.store.some((e) => e.table === "items"), { timeout: 10000 });
    await t.until("the status button is up to date", async () => (await t.page.getByRole("button", { name: "Up to date" }).count()) > 0, { timeout: 15000 });
    await t.check("this device kept its items", (await itemCount(t)) >= (empty ? before : 3));
    await t.audit("after connecting again");
  }, { smoke: scenario === "another database" });
}
