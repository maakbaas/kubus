// Rarer paths of the shell and sync, each asserted by its result: a server whose database was
// wiped or replaced (the status button and Settings → Sync say so; connecting again asks before it
// replaces this device's data, or uploads to an empty server), a tab dropped on each edge of a pane
// (left, top, bottom: the split and where the tab lands), and a tag clicked in a component's
// frame (here, beside, in a new tab by the middle button).

const WS_KEY = "kubus.workspace.default";
const SERVER = "https://sync.test";
/** The stored layout: the root's direction and the panes' tab paths, in order. */
async function storedLayout(t) {
  return t.page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const out = { direction: null, panes: [] };
    const walk = (n) => {
      if (n.kind === "pane") out.panes.push(n.tabs.map((x) => x.path));
      else {
        out.direction ??= n.direction;
        n.children.forEach(walk);
      }
    };
    walk(JSON.parse(raw).root);
    return out;
  }, WS_KEY);
}

// ---- a server whose database was replaced ----------------------------------------------------

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

// ---- dropping a tab on a pane's edges ---------------------------------------------------------

for (const [edge, direction, draggedFirst] of [["left", "row", true], ["top", "column", true], ["bottom", "column", false], ["right", "row", false]]) {
  test(`a tab dropped on a pane's ${edge} edge splits it ${direction === "row" ? "side by side" : "one above the other"}`, async (t) => {
    await t.boot();
    const ids = await t.seed(profileSpec("typical", { items: 3 }));
    const books = ids.collections.books;
    const list = `/collections/${books}/items`;
    await t.seed({ prefs: { [WS_KEY]: wsLayout([["/collections", list]]) } });
    await t.open(list, { keepTabs: true });
    const tab = t.page.locator(".ws-pane__tabs .cds--tabs__nav-item").first();
    const body = t.page.locator(".ws-pane__frame").first();
    const bb = await body.boundingBox();
    const at = { left: { x: 10, y: bb.height / 2 }, right: { x: bb.width - 10, y: bb.height / 2 }, top: { x: bb.width / 2, y: 10 }, bottom: { x: bb.width / 2, y: bb.height - 10 } }[edge];
    await tab.dragTo(body, { targetPosition: at });
    await t.until("two panes", async () => (await t.count(".ws-pane")) === 2);
    const layout = await storedLayout(t);
    await t.check(`the split is ${direction === "row" ? "side by side" : "stacked"}`, layout.direction === direction, JSON.stringify(layout));
    await t.check(`the dropped tab (Collections) is in the ${draggedFirst ? "first" : "second"} pane, the other tab in the other`, layout.panes[draggedFirst ? 0 : 1].join() === "/collections" && layout.panes[draggedFirst ? 1 : 0].join() === list, JSON.stringify(layout));
    await t.until("both panes show their page", async () => (await t.page.locator(".ws-pane .page-header__title").filter({ visible: true }).count()) === 2);
    await t.audit(`after dropping on the ${edge} edge`);
    await t.page.reload();
    await t.page.waitForSelector(".ws-pane");
    await t.settle();
    await t.check("the arrangement is kept after a reload", JSON.stringify(await storedLayout(t)) === JSON.stringify(layout));
  });
}

// ---- a tag clicked in a component's frame -----------------------------------------------------

test("a #tag in a component's frame: click searches here, Ctrl+click beside, middle click in a new tab", async (t) => {
  await t.boot();
  const spec = {
    collections: [
      {
        key: "notes",
        name: "Note",
        plural: "Notes",
        fields: [
          { key: "name", name: "Name", kind: "string" },
          { key: "view", name: "View", kind: "component", code: "<p>{{ $item[\"Name\"] }} is filed under #reading today</p>", output: "html" },
        ],
        items: [{ values: { name: "A note" } }],
      },
    ],
  };
  const ids = await t.seed(spec);
  const path = t.itemPath(ids.collections.notes, ids.items["notes/i0"]);
  const frame = () => t.page.frameLocator(".ws-pane--active iframe").first();
  const tag = () => frame().locator(".kubus-tag");
  const open = async () => {
    await t.seed({ prefs: { [WS_KEY]: wsLayout([[path]]) } });
    await t.open(path, { keepTabs: true });
    await t.until("the frame shows the tag", async () => (await tag().count().catch(() => 0)) === 1, { timeout: 8000 });
  };
  const searchPaths = async () => ((await storedLayout(t)).panes || []).flat().filter((p) => p.startsWith("/search"));

  await open();
  await t.check("the tag is marked as a link", (await tag().getAttribute("role")) === "link" && (await tag().innerText()) === "#reading");
  await tag().click({ button: "middle" });
  await t.until("a middle click opens the search in a new tab", async () => (await searchPaths(t)).length === 1 && (await storedLayout(t)).panes[0].length === 2);
  await t.check("the search is for the tag", decodeURIComponent((await searchPaths(t))[0]).includes("#reading"), (await searchPaths(t))[0]);
  await t.audit("after a middle click on a tag");

  await open();
  await tag().click({ modifiers: ["Control"] });
  await t.until("Ctrl+click opens the search beside", async () => (await storedLayout(t)).panes.length === 2 && (await searchPaths(t)).length === 1);
  await t.audit("after Ctrl+click on a tag");

  await open();
  await tag().click();
  await t.until("a plain click goes to the search in this tab", async () => (await storedLayout(t)).panes.length === 1 && (await storedLayout(t)).panes[0].length === 1 && (await searchPaths(t)).length === 1);
});
