// Several collections in one dashboard block: Invoices (native) and Shop sales (a remote table behind a
// faked server) read as one table, their columns merged by name.

const URL = "https://shop.test";

const COLUMNS = [
  { name: "id", type: "integer", kind: "number" },
  { name: "total", type: "numeric", kind: "number" },
  { name: "ordered_at", type: "timestamptz", kind: "datetime" },
  { name: "customer", type: "text", kind: "string" },
];

const SALES = [
  [1, 25, "2026-09-10T12:00:00.000Z", "Gus"],
  [2, 60, "2026-09-21T12:00:00.000Z", "Hal"],
  [3, 15, "2026-10-05T12:00:00.000Z", "Ivy"],
  [4, 90, "2026-10-19T12:00:00.000Z", "Jo"],
  [5, 35, "2026-11-04T12:00:00.000Z", "Kit"],
  [6, 45, "2026-11-30T12:00:00.000Z", "Lu"],
].map(([id, total, ordered_at, customer]) => ({ id, total, ordered_at, customer }));

const INVOICES = [
  ["Ada", 120, "2026-09-05"],
  ["Bo", 80, "2026-09-20"],
  ["Cy", 300, "2026-10-02"],
  ["Di", 55, "2026-10-18"],
  ["Ed", 70, "2026-11-04"],
  ["Flo", 40, "2026-11-25"],
];

/** All twelve rows by date (on the same day the first collection's row first). */
const BY_DATE = ["Ada", "Gus", "Bo", "Hal", "Cy", "Ivy", "Di", "Jo", "Ed", "Kit", "Flo", "Lu"];

const PANE = ".ws-pane--active";

const day = (v) => (typeof v === "string" ? v.slice(0, 10) : "");

function holds(c, row) {
  if (c.and) return c.and.every((x) => holds(x, row));
  if (c.or) return c.or.some((x) => holds(x, row));
  const v = row[c.column] ?? null;
  switch (c.operator) {
    case "between": {
      const [a, b] = c.value.split("..");
      return !!day(v) && day(v) >= a.slice(0, 10) && day(v) <= b.slice(0, 10);
    }
    case "gt": return typeof v === "number" && v > Number(c.value);
    case "lt": return typeof v === "number" && v < Number(c.value);
    case "contains": return String(v ?? "").toLowerCase().includes(c.value.toLowerCase());
    case "is": return typeof v === "number" ? v === Number(c.value) : String(v ?? "").toLowerCase() === c.value.toLowerCase();
    case "isNot": return typeof v === "number" ? v !== Number(c.value) : String(v ?? "").toLowerCase() !== c.value.toLowerCase();
    default: return true;
  }
}

/** A Kubus server with one source ("Shop"), answering queries as a connector does: filter, sort, page, count. */
async function fakeShop(t) {
  const fake = { queries: [], rows: SALES };
  await t.context.route(`${URL}/api/**`, async (route) => {
    const req = route.request();
    const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS" };
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    const path = req.url().slice(URL.length);
    if (path === "/api/events") return route.fulfill({ status: 204, headers: cors });
    if (path === "/api/health") return route.fulfill({ status: 200, headers: cors, json: { ok: true } });
    if (path === "/api/sources") return route.fulfill({ status: 200, headers: cors, json: [{ name: "Shop", connector: "postgres" }] });
    if (/\/query$/.test(path)) {
      const q = JSON.parse(req.postData() || "{}");
      fake.queries.push(q);
      let rows = fake.rows.filter((r) => holds(q.filter ?? { and: [] }, r));
      const key = (r, s) => (s.column === "$title" ? (q.title || []).map((c) => String(r[c] ?? "").toLowerCase()).find(Boolean) ?? null : (r[s.column] ?? null));
      rows = [...rows].sort((a, b) => {
        for (const s of q.sort || []) {
          const ka = key(a, s);
          const kb = key(b, s);
          if (ka === kb) continue;
          if (ka === null) return 1;
          if (kb === null) return -1;
          return (ka < kb ? -1 : 1) * (s.direction === "desc" ? -1 : 1);
        }
        return a.id - b.id;
      });
      const page = rows.slice(q.offset, q.offset + q.limit);
      const out = { rows: page.map((r) => ({ key: String(r.id), values: q.columns.map((c) => r[c] ?? null) })), more: q.offset + q.limit < rows.length };
      if (q.counts) out.total = rows.length;
      return route.fulfill({ status: 200, headers: cors, json: out });
    }
    if (/\/row$/.test(path)) {
      const q = JSON.parse(req.postData() || "{}");
      const r = fake.rows.find((x) => String(x.id) === q.keyValue);
      return route.fulfill({ status: 200, headers: cors, json: { row: r ? { key: String(r.id), values: q.columns.map((c) => r[c] ?? null) } : null } });
    }
    return route.fulfill({ status: 404, headers: cors, json: { error: "Not found" } });
  });
  await t.page.evaluate((url) => localStorage.setItem("kubus.sync", JSON.stringify({ url, token: "tok", enabled: false, originals: "always" })), URL);
  return fake;
}

/** Stores the remote collection Shop sales (fields Total, Date, Client over the source's columns). */
const makeSales = (t) =>
  t.page.evaluate(
    async ([columns]) => {
      const repo = window.kubus.repo;
      const id = crypto.randomUUID();
      const names = { total: "Total", ordered_at: "Date", customer: "Client" };
      const fields = columns
        .filter((c) => c.name !== "id")
        .map((c) => ({ id: crypto.randomUUID(), name: names[c.name], kind: c.kind, targetCollectionId: null, componentId: null, code: null, output: null, frameRatio: null, choiceFilter: [], toggleIcon: null, strikeThrough: false, column: c.name }));
      const source = { name: "Shop", target: { table: { schema: "public", name: "sales" } }, key: "id", columns };
      await repo.saveCollection({ id, name: "Shop sale", pluralName: "Shop sales", icon: "DataBase", description: "", spaceIds: null, source, titleField: null, fields }, "default");
      return id;
    },
    [COLUMNS],
  );

const INVOICE_COLLECTION = {
  key: "inv", name: "Invoice", plural: "Invoices", icon: "Receipt",
  fields: [{ key: "client", name: "Client", kind: "string" }, { key: "price", name: "Price", kind: "number" }, { key: "date", name: "Date", kind: "date" }],
  items: INVOICES.map(([client, price, date]) => ({ values: { client, price, date } })),
};

/** The dashboard Sales with one tab, Overview, holding `blocks` (seeded through `spec.dashboards`, gui-tests/lib/data.js). */
const salesDashboard = (blocks = []) => [{ key: "sales", name: "Sales", tabs: [{ name: "Overview", blocks }] }];

const dashPath = (ids) => `/dashboards/${ids.dashboards.sales}`;

/** Boots with Invoices and Shop sales and the dashboard Sales, whose tab Overview has one block of Invoices alone; opens it. */
async function dashWorld(t) {
  await t.boot();
  const fake = await fakeShop(t);
  const ids = await t.seed({ collections: [INVOICE_COLLECTION], dashboards: salesDashboard([{ id: "b0", kind: "table", collection: "inv", sort: [{ field: "date" }] }]) });
  ids.sales = await makeSales(t);
  await t.open(dashPath(ids));
  return { ids, fake };
}

/** The dashboard's stored tab (its only one). */
const storedTab = (t, ids) => t.page.evaluate(async (d) => (await window.kubus.repo.listAllDashboardViews()).find((v) => v.dashboardId === d), ids.dashboards.sales);

const tabBlocks = async (t, ids) => (await storedTab(t, ids)).blocks;

const block = (t, i = 0) => t.page.locator(`${PANE} .block`).nth(i);

const headers = (t, i = 0) => block(t, i).locator("thead th").allInnerTexts().then((l) => l.map((s) => s.trim()).filter(Boolean));

/** Each row's cells of block i. */
const rows = (t, i = 0) =>
  t.page.evaluate((i) => [...document.querySelectorAll(`.ws-pane--active .block`)[i].querySelectorAll("tbody tr")].filter((r) => r.checkVisibility()).map((r) => [...r.querySelectorAll("td")].map((td) => td.innerText.trim())), i);

/** Each row's title: its linked cell (Title links to the item), wherever the title column is. */
const titles = (t, i = 0) =>
  t.page.evaluate((i) => [...document.querySelectorAll(`.ws-pane--active .block`)[i].querySelectorAll("tbody tr")].filter((r) => r.checkVisibility()).map((r) => r.querySelector("td a")?.innerText.trim()).filter(Boolean), i);

async function expectTitles(t, label, expected, i = 0) {
  let last = [];
  return t.until(label, async () => {
    last = await titles(t, i);
    return JSON.stringify(last) === JSON.stringify(expected) || `shows ${JSON.stringify(last)}, expected ${JSON.stringify(expected)}`;
  }, { timeout: 10000 });
}

const sortedTitles = async (t, i = 0) => (await titles(t, i)).sort();

async function expectSet(t, label, expected, i = 0) {
  let last = [];
  return t.until(label, async () => {
    last = await sortedTitles(t, i);
    return JSON.stringify(last) === JSON.stringify([...expected].sort()) || `shows ${JSON.stringify(last)}`;
  }, { timeout: 10000 });
}

/** Block settings of block i: toggles the collection `name` in the Collections picker. */
async function toggleCollection(t, name, i = 0) {
  if (!(await shownPopover(t).locator(".cds--multi-select").count())) await t.openPanel(header(t, i), "Block settings");
  const field = shownPopover(t).locator(".cds--multi-select .cds--list-box__field").first();
  // The menu stays open after a pick: open it only when it is closed.
  if ((await field.getAttribute("aria-expanded")) !== "true") {
    await field.click();
    await t.settle(80);
  }
  await t.page.getByRole("option", { name, exact: true }).filter({ visible: true }).first().click();
  await t.settle(300);
}

const header = (t, i = 0) => block(t, i).locator(".section-header").first();

test("merged collections: a dashboard block's Collections picker reads two collections as one table, their columns merged by name", async (t) => {
  const { ids, fake } = await dashWorld(t);
  await expectTitles(t, "Invoices alone: its six invoices", ["Ada", "Bo", "Cy", "Di", "Ed", "Flo"]);
  await t.check("it asked the shop nothing", fake.queries.length === 0);

  await toggleCollection(t, "Shop sales");
  await expectSet(t, "both collections' rows", BY_DATE);
  const h = await headers(t);
  await t.check("one column of each name they share, the fields only one has, and Collection", ["Client", "Date", "Price", "Total", "Collection"].every((n) => h.filter((x) => x === n).length === 1), JSON.stringify(h));
  await t.check("the shop was asked for the columns it has", fake.queries.length > 0 && [...fake.queries[0].columns].sort().join() === "customer,ordered_at,total", JSON.stringify(fake.queries[0]?.columns));
  const all = await rows(t);
  const ada = all.find((r) => r[0] === "Ada");
  const gus = all.find((r) => r[0] === "Gus");
  await t.check("a field only one collection has is empty for the other's rows", ada.includes("120") && !ada.includes("25") && gus.includes("25") && !gus.includes("120"), JSON.stringify([ada, gus]));
  await t.check("Collection names each row's collection", ada.includes("Invoices") && gus.includes("Shop sales"), JSON.stringify([ada, gus]));

  const stored = (await tabBlocks(t, ids))[0];
  await t.check("the choice is stored with the block, naming its first", JSON.stringify(stored.collectionIds) === JSON.stringify([ids.collections.inv, ids.sales]) && stored.collectionId === ids.collections.inv, JSON.stringify([stored.collectionId, stored.collectionIds]));
  // Escape closes the panel and keeps the choice.
  await t.closeAll();
  await expectSet(t, "closing the panel keeps both collections", BY_DATE);
  await t.audit("a dashboard table of two collections");

  await t.open(dashPath(ids));
  await expectSet(t, "after a reload", BY_DATE);
  // A dashboard has no collection of its own: either can be taken out.
  await toggleCollection(t, "Invoices");
  await expectSet(t, "taking Invoices out: the shop alone", ["Gus", "Hal", "Ivy", "Jo", "Kit", "Lu"]);
  await t.closeAll();
  const alone = (await tabBlocks(t, ids))[0];
  await t.check("the block names the shop alone", alone.collectionId === ids.sales && alone.collectionIds === undefined, JSON.stringify([alone.collectionId, alone.collectionIds]));
  await toggleCollection(t, "Invoices");
  await expectSet(t, "Invoices back", BY_DATE);
  await toggleCollection(t, "Shop sales");
  await expectSet(t, "taking the shop out again: Invoices alone", ["Ada", "Bo", "Cy", "Di", "Ed", "Flo"]);
  await t.closeAll();
  const one = (await tabBlocks(t, ids))[0];
  await t.check("the choice is gone from the block", one.collectionIds === undefined && one.collectionId === ids.collections.inv, JSON.stringify([one.collectionId, one.collectionIds]));
}, { smoke: true });
