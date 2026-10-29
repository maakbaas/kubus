// Several collections in one block: Invoices (native) and Shop sales (a remote table behind a faked server, routes on the
// test's browser context) read as one. The block's Collections picker (Block settings) takes more than one; their fields of
// one name are one column, Collection says which one a row is from, Created / Updated / Title stay; Fields → Merge fields
// merges two differently named fields by hand. Tables, groups, charts and stats work on it as on any collection: the rows
// of both parts in the order of the sort a page at a time (Show more asks the remote part only when its rows are used up),
// the group sizes and the total summed, the view's filter (its date period stepped) reaching both parts, read-only rows that
// open their own item or remote row, and a problem (not a crash) when a collection is deleted. Every step is followed by
// what the page shows and, where it is stored, what window.kubus.repo holds.

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
const OCTOBER = ["Cy", "Ivy", "Di", "Jo"];
const SEPTEMBER = ["Ada", "Gus", "Bo", "Hal"];
const NOVEMBER = ["Ed", "Kit", "Flo", "Lu"];

const PANE = ".ws-pane--active";

// ---- the faked server -----------------------------------------------------------------------------

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

/** Boots with Invoices (native) and Shop sales (remote), on the Invoices page; returns the ids and the fake server. */
async function world(t, { blocks = [{}], filters = [] } = {}) {
  await t.boot();
  const fake = await fakeShop(t);
  const ids = await t.seed({
    collections: [{
      key: "inv", name: "Invoice", plural: "Invoices", icon: "Receipt",
      fields: [{ key: "client", name: "Client", kind: "string" }, { key: "price", name: "Price", kind: "number" }, { key: "date", name: "Date", kind: "date" }],
      items: INVOICES.map(([client, price, date]) => ({ values: { client, price, date } })),
    }],
  });
  ids.sales = await makeSales(t);
  await setBlocks(t, ids, blocks, filters);
  await t.open(t.listPath(ids.collections.inv));
  return { ids, fake };
}

const COL = { source: "merged:collection", date: "merged:name:date", client: "merged:name:client", amount: "merged:m1", total: "merged:name:total", price: "merged:name:price" };
const BLOCK = { title: "", kind: "table", filters: null, sort: [{ fieldId: COL.date, direction: "asc" }], groupBy: null, layout: { fields: null, editable: true, hiddenLabels: [], hideEmpty: false }, collectionId: null, options: { titleLink: true, editable: true } };

/** Both collections in every block (`collectionIds`), each block as given over BLOCK; the Invoices view stores them. */
const setBlocks = (t, ids, blocks, filters = []) =>
  t.page.evaluate(
    async ([inv, sales, blocks, base, filters]) => {
      const repo = window.kubus.repo;
      const [view] = await repo.listViews(inv, "default");
      await repo.saveView({
        ...view,
        filters,
        blocks: blocks.map((b, i) => ({ ...base, id: `b${i}`, collectionIds: [inv, sales], ...b })),
      });
    },
    [ids.collections.inv, ids.sales, blocks, BLOCK, filters],
  );

/** The id of the field named `name` of a collection. */
const fieldId = (t, collectionId, name) =>
  t.page.evaluate(async ([c, n]) => (await window.kubus.repo.listCollections()).find((x) => x.id === c).fields.find((f) => f.name === n).id, [collectionId, name]);

/** The stored blocks of the Invoices view. */
const storedBlocks = (t, ids) => t.page.evaluate(async (c) => (await window.kubus.repo.listViews(c, "default"))[0].blocks, ids.collections.inv);

// ---- reading the page -----------------------------------------------------------------------------

const block = (t, i = 0) => t.page.locator(`${PANE} .block`).nth(i);
const headers = (t, i = 0) => block(t, i).locator("thead th").allInnerTexts().then((l) => l.map((s) => s.trim()).filter(Boolean));
/** Each row's cells of block i. */
const rows = (t, i = 0) =>
  t.page.evaluate((i) => [...document.querySelectorAll(`.ws-pane--active .block`)[i].querySelectorAll("tbody tr")].filter((r) => r.checkVisibility()).map((r) => [...r.querySelectorAll("td")].map((td) => td.innerText.trim())), i);
/** The first cell of each row (the title). */
const titles = async (t, i = 0) => (await rows(t, i)).map((r) => r[0]).filter(Boolean);

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

const panel = (t) => t.page.locator(".toolbar-popover__panel:visible").last();
const popover = (t) => t.page.locator(".cds--popover--open").last();
const dropdown = (t, scope, title) =>
  scope.locator(".cds--dropdown__wrapper, .cds--combo-box, .cds--list-box__wrapper, .cds--multi-select__wrapper").filter({ has: t.page.locator(".cds--label", { hasText: new RegExp(`^${title}$`) }) }).first();
async function choose(t, scope, title, option) {
  await dropdown(t, scope, title).locator(".cds--list-box__field").first().click();
  await t.settle(80);
  await t.page.getByRole("option", { name: option, exact: true }).filter({ visible: true }).first().click();
  await t.settle(80);
}
/** Block settings of block i: toggles the collection `name` in the Collections picker. */
async function toggleCollection(t, name, i = 0) {
  if (!(await popover(t).locator(".cds--multi-select").count())) await t.openPanel(header(t, i), "Block settings");
  await popover(t).locator(".cds--multi-select .cds--list-box__field").first().click();
  await t.settle(80);
  await t.page.getByRole("option", { name, exact: true }).filter({ visible: true }).first().click();
  await t.settle(300);
}
const header = (t, i = 0) => block(t, i).locator(".section-header").first();

const stat = (t, i = 0) => block(t, i).locator(".stat-block").innerText().then((s) => s.replace(/\s+/g, " ").trim(), () => "");
const chart = (t, i = 0) =>
  t.page.evaluate((i) => {
    const root = document.querySelectorAll(".ws-pane--active .block")[i].querySelector(".chart-block");
    if (!root) return null;
    const uniq = (l) => l.filter((v, k) => l.indexOf(v) === k);
    return {
      bars: root.querySelectorAll("path.bar").length,
      legend: uniq([...root.querySelectorAll(".legend-item p, .legend-item text")].map((e) => e.textContent.trim()).filter(Boolean)),
      xTicks: uniq([...root.querySelectorAll("g.axis.bottom g.tick text")].map((e) => e.textContent.trim())),
    };
  }, i);

// ---- tests ----------------------------------------------------------------------------------------

test("merged collections: the Collections picker reads two collections as one table, their columns merged by name", async (t) => {
  await t.boot();
  const fake = await fakeShop(t);
  const ids = await t.seed({
    collections: [{
      key: "inv", name: "Invoice", plural: "Invoices", icon: "Receipt",
      fields: [{ key: "client", name: "Client", kind: "string" }, { key: "price", name: "Price", kind: "number" }, { key: "date", name: "Date", kind: "date" }],
      items: INVOICES.map(([client, price, date]) => ({ values: { client, price, date } })),
    }],
  });
  ids.sales = await makeSales(t);
  await t.open(t.listPath(ids.collections.inv));
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

  const stored = (await storedBlocks(t, ids))[0];
  await t.check("the choice is stored with the block", JSON.stringify(stored.collectionIds) === JSON.stringify([ids.collections.inv, ids.sales]), JSON.stringify(stored.collectionIds));
  // Escape (which clears a Carbon multi-select) closes the panel and keeps the choice.
  await t.closeAll();
  await expectSet(t, "closing the panel keeps both collections", BY_DATE);
  await t.audit("a table of two collections");

  await t.open(t.listPath(ids.collections.inv));
  await expectSet(t, "after a reload", BY_DATE);
  await toggleCollection(t, "Shop sales");
  await expectTitles(t, "taking the shop out again: Invoices alone", ["Ada", "Bo", "Cy", "Di", "Ed", "Flo"]);
  await t.closeAll();
  await t.check("the choice is gone from the block", (await storedBlocks(t, ids))[0].collectionIds === undefined);
}, { smoke: true });

test("merged collections: sorted by date, Show more asks the remote part only when its rows are used up", async (t) => {
  const { fake } = await world(t, { blocks: [{ limit: 5 }] });
  await expectTitles(t, "the first five by date", BY_DATE.slice(0, 5));
  await t.check("the shop was asked once, for a page of five", fake.queries.length === 1 && fake.queries[0].limit === 5 && fake.queries[0].offset === 0 && fake.queries[0].counts === true, JSON.stringify(fake.queries.map((q) => [q.offset, q.limit])));
  await t.check("the sort reached the shop as its column", JSON.stringify(fake.queries[0].sort) === JSON.stringify([{ column: "ordered_at", direction: "asc" }]), JSON.stringify(fake.queries[0].sort));
  const more = block(t).getByRole("button", { name: "Show more" });
  await t.check("the count says five of twelve", /5 of 12/.test(await block(t).locator(".block-more").innerText()));
  await more.click();
  await expectTitles(t, "Show more: the next five, from both collections", BY_DATE.slice(0, 10));
  await t.check("the shop's first page covered them: not asked again", fake.queries.length === 1, String(fake.queries.length));
  await more.click();
  await expectTitles(t, "Show more again: the last two", BY_DATE);
  await t.check("the shop's last row came with a second page", fake.queries.length === 2 && fake.queries[1].offset === 5 && fake.queries[1].counts === false, JSON.stringify(fake.queries.map((q) => [q.offset, q.limit, q.counts])));
  await t.check("nothing more to show", (await block(t).getByRole("button", { name: "Show more" }).count()) === 0);
  await t.audit("a table of two collections, all rows shown");
});

test("merged collections: group by Collection, the sizes and the order of the groups", async (t) => {
  await world(t, { blocks: [{ groupBy: COL.source }] });
  const groups = () =>
    t.page.evaluate(() => [...document.querySelectorAll(".ws-pane--active .block .cds--accordion__item")].map((g) => [g.querySelector(".cds--accordion__heading").innerText.replace(/\s+/g, " ").trim(), [...g.querySelectorAll("tbody tr td:first-child")].map((td) => td.innerText.trim()).filter(Boolean)]));
  await t.until("two groups, each with its collection's six rows", async () => {
    const g = await groups();
    return (g.length === 2 && g[0][0] === "Invoices" && g[1][0] === "Shop sales" && g[0][1].length === 6 && g[1][1].length === 6) || JSON.stringify(g);
  }, { timeout: 10000 });
  const g = await groups();
  await t.check("each group lists its collection's rows in date order", JSON.stringify(g.map((x) => x[1])) === JSON.stringify([["Ada", "Bo", "Cy", "Di", "Ed", "Flo"], ["Gus", "Hal", "Ivy", "Jo", "Kit", "Lu"]]), JSON.stringify(g));
  await t.audit("grouped by Collection");
});

test("merged collections: a chart of Amount by month stacked by Collection, and a stat of the total", async (t) => {
  const merges = [{ id: "m1", name: "Amount", fields: [] }];
  const { ids, fake } = await world(t, { blocks: [] });
  merges[0].fields = [`${ids.sales}/${await fieldId(t, ids.sales, "Total")}`, `${ids.collections.inv}/${await fieldId(t, ids.collections.inv, "Price")}`];
  await setBlocks(t, ids, [
    { kind: "chart", options: { chart: "bar", stack: "stacked", x: { by: "field", field: COL.date, dateStep: "month" }, series: [{ id: "a", value: "sum", field: COL.amount, label: "", style: null, axis: "left", transform: "none", window: 3 }], splitBy: COL.source }, merges },
    { kind: "chart", options: { chart: "stat", series: [{ id: "a", value: "sum", field: COL.amount, label: "", style: null, axis: "left", transform: "none", window: 3 }] }, merges },
  ]);
  await t.open(t.listPath(ids.collections.inv));
  await t.until("the chart is drawn", async () => ((await chart(t, 0))?.bars ?? 0) > 0, { timeout: 20000 });
  await t.until("the chart has a bar for each month and collection", async () => {
    const c = await chart(t, 0);
    return (c.bars === 6 && c.legend.includes("Invoices") && c.legend.includes("Shop sales")) || JSON.stringify(c);
  }, { timeout: 10000 });
  await t.check("it loaded all the shop's rows in one page", fake.queries.some((q) => q.limit === 10000), JSON.stringify(fake.queries.map((q) => q.limit)));
  await t.until("the stat shows the total of both", async () => /935/.test(await stat(t, 1)) || (await stat(t, 1)), { timeout: 10000 });
  await t.audit("a chart and a stat over two collections", { skip: [] });
});

test("merged collections: the view's filter reaches both, its date period stepped by month", async (t) => {
  const { ids } = await world(t);
  const dateField = await fieldId(t, ids.collections.inv, "Date");
  const rule = { id: "period", fieldId: dateField, operator: "between", value: "2026-10-01..2026-10-31" };
  await setBlocks(t, ids, [{}], [rule]);
  await t.open(t.listPath(ids.collections.inv));
  await expectTitles(t, "October: both collections' rows of the month", OCTOBER);
  await t.openPanel(t.page.locator(`${PANE} .views-bar`), "Filter (1)");
  await panel(t).getByRole("button", { name: "Previous" }).click();
  await expectTitles(t, "the month before", SEPTEMBER);
  await panel(t).getByRole("button", { name: "Next" }).click();
  await panel(t).getByRole("button", { name: "Next" }).click();
  await expectTitles(t, "two months on", NOVEMBER);
  await t.closeAll();
  await t.audit("the view filtered to a month");
});

test("merged collections: Merge fields joins two differently named fields into one column", async (t) => {
  const { ids } = await world(t);
  await expectSet(t, "both collections", BY_DATE);
  let h = await headers(t);
  await t.check("Total and Price are two columns", h.includes("Total") && h.includes("Price") && !h.includes("Amount"), JSON.stringify(h));
  await t.openPanel(header(t), "Fields");
  await choose(t, popover(t), "Merge this field", "Total (Shop sales)");
  await dropdown(t, popover(t), "With this field").locator(".cds--list-box__field").first().click();
  await t.settle(80);
  const options = (await t.page.getByRole("option").filter({ visible: true }).allInnerTexts()).map((s) => s.trim());
  await t.check("only number fields of the other collection can be merged with a number", JSON.stringify(options) === JSON.stringify(["Price (Invoices)"]), JSON.stringify(options));
  await t.page.getByRole("option", { name: "Price (Invoices)", exact: true }).filter({ visible: true }).first().click();
  await popover(t).getByLabel("Column name").fill("Amount");
  await popover(t).getByRole("button", { name: "Merge", exact: true }).click();
  await t.closeAll();
  await t.until("one Amount column replaces Total and Price", async () => {
    h = await headers(t);
    return (h.includes("Amount") && !h.includes("Total") && !h.includes("Price")) || JSON.stringify(h);
  }, { timeout: 10000 });
  const all = await rows(t);
  const amounts = all.filter((r) => ["Ada", "Gus"].includes(r[0]));
  await t.check("it shows each collection's own number", amounts.some((r) => r.includes("120")) && amounts.some((r) => r.includes("25")), JSON.stringify(amounts));
  const merges = (await storedBlocks(t, ids))[0].merges;
  await t.check("the merge is stored with the block", merges?.length === 1 && merges[0].name === "Amount" && merges[0].fields.length === 2, JSON.stringify(merges));
  await t.audit("a column merged by hand");
  await t.open(t.listPath(ids.collections.inv));
  await t.until("after a reload", async () => (await headers(t)).includes("Amount"), { timeout: 10000 });
  await t.openPanel(header(t), "Fields");
  await popover(t).getByRole("button", { name: "Unmerge Amount" }).click();
  await t.closeAll();
  await t.until("taking it apart: Total and Price again", async () => {
    h = await headers(t);
    return (h.includes("Total") && h.includes("Price") && !h.includes("Amount")) || JSON.stringify(h);
  }, { timeout: 10000 });
});

test("merged collections: rows are read-only and open their own item or remote row", async (t) => {
  const { ids } = await world(t);
  await expectSet(t, "both collections", BY_DATE);
  await t.check("no add row and no row actions", (await block(t).locator("tbody tr button").count()) === 0 && (await block(t).getByLabel("Edit").count()) === 0 && (await block(t).getByLabel("Delete").count()) === 0);
  const href = (name) => block(t).locator("tbody a", { hasText: new RegExp(`^${name}$`) }).first().getAttribute("href");
  const inv = await href("Ada");
  await t.check("an invoice's row links to the invoice", /#\/collections\/[^/]+\/items\/[^/]+$/.test(inv) && inv.includes(ids.collections.inv), inv);
  const sale = await href("Gus");
  await t.check("a sale's row links to the remote row", sale.includes(`/collections/${ids.sales}/items/`), sale);
  await block(t).locator("tbody a", { hasText: /^Gus$/ }).first().click();
  await t.until("the remote row's page opens", async () => (await t.page.locator(`${PANE} .item-title, ${PANE} h1`).first().innerText().catch(() => "")).includes("Gus") || (await t.page.locator(`${PANE}`).innerText()).includes("Gus"), { timeout: 10000 });
});

test("merged collections: a deleted collection is a problem shown on the block, the other's rows stay", async (t) => {
  const { ids } = await world(t);
  await expectSet(t, "both collections", BY_DATE);
  await t.page.evaluate((id) => window.kubus.repo.deleteCollection(id), ids.sales);
  await t.until("the block says a collection was deleted", async () => /was deleted/.test(await block(t).innerText()), { timeout: 10000 });
  await expectSet(t, "the invoices are still listed", INVOICES.map((i) => i[0]));
  await t.audit("a block with a collection gone");
});
