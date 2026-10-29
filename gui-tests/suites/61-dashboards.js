// Dashboards: pages of blocks of any collections (domain/dashboards.ts, pages/DashboardsPage.tsx, pages/DashboardPage.tsx).
// Made from the list page (the side nav's Dashboards node opens it) in the active space only, named in Dashboard settings
// (name, icon, description, spaces: listed only where chosen) and deleted; tabs as a collection's views ("+", rename, *,
// Save, star, delete), per space (another space shows copies, stored there once one changes); blocks of one collection and
// of several read as one (native and remote), added from the empty state, a block whose collection was deleted; the tab's
// filter over all its blocks: the filter bar's period stepping every block with a date field while one without is left
// alone, a rule on one collection's field narrowing only its blocks; a bookmarked tab (side nav, Bookmarks page); global
// search finding the dashboard and a Markdown block (opened at the block); tab history; phones, 320 px, dark, keyboard.
// Every step is followed by what the page shows and, where it is stored, what window.kubus.repo holds.

const D_PANE = ".ws-pane--active";
const D_SHOWN = ".ws-pane--active .ws-tab-slot:not([hidden])";
const D_URL = "https://dash-shop.test";

const thisMonth = periodDays("month", 0);
const lastMonth = periodDays("month", -1);
// Books read this month and last month (the first day of each, so they stay inside however far into the month it is).
const BOOKS_READ = [
  ["Dune", thisMonth[0]],
  ["Emma", thisMonth[0]],
  ["Hamlet", lastMonth[0]],
  ["Ulysses", lastMonth[1]],
  ["Undated", null],
];
const PEOPLE_BORN = [
  ["Ada", `${thisMonth[0]}T09:00:00.000Z`],
  ["Bob", `${lastMonth[0]}T09:00:00.000Z`],
];
const NOTES = ["Groceries", "Ideas", "Plans"];

function dashboardSpec({ tabs, extraSpace = true } = {}) {
  return {
    spaces: extraSpace ? [{ key: "work", name: "Work" }] : [],
    collections: [
      {
        key: "books", name: "Book", plural: "Books", icon: "Book",
        fields: [{ key: "title", name: "Title", kind: "string" }, { key: "read", name: "Read", kind: "date" }, { key: "pages", name: "Pages", kind: "number" }],
        items: BOOKS_READ.map(([title, read], i) => ({ key: title.toLowerCase(), values: { title, read, pages: 100 * (i + 1) } })),
      },
      {
        key: "people", name: "Person", plural: "People", icon: "User",
        fields: [{ key: "name", name: "Name", kind: "string" }, { key: "born", name: "Born", kind: "datetime" }],
        items: PEOPLE_BORN.map(([name, born]) => ({ values: { name, born } })),
      },
      // No date field: the dashboard's period leaves it alone.
      {
        key: "notes", name: "Note", plural: "Notes", icon: "Notebook",
        fields: [{ key: "text", name: "Text", kind: "string" }],
        items: NOTES.map((text) => ({ values: { text } })),
      },
    ],
    dashboards: [{
      key: "health", name: "Health", icon: "Activity", description: "How the week goes",
      tabs: tabs || [
        {
          name: "Daily",
          isDefault: true,
          blocks: [
            { id: "b-books", kind: "table", title: "Books", collection: "books", layout: { fields: ["title", "read"] } },
            { id: "b-people", kind: "table", title: "People", collection: "people" },
            { id: "b-notes", kind: "table", title: "Notes", collection: "notes" },
            { id: "b-text", kind: "markdown", title: "Thoughts", collection: "books", options: { text: "A zebrafish swims through the **week**." } },
          ],
        },
        // The filter bar on, this month's period on Date: every dated block follows it.
        { name: "Month", filterBar: true, filters: [{ id: "d-period", field: "$date", operator: "between", value: "month+0" }], blocks: [
          { id: "m-books", kind: "table", title: "Books", collection: "books", layout: { fields: ["title", "read"] } },
          { id: "m-people", kind: "table", title: "People", collection: "people" },
          { id: "m-notes", kind: "table", title: "Notes", collection: "notes" },
        ] },
      ],
    }],
  };
}

// --- helpers ----------------------------------------------------------------------------------

const dPath = (ids, tab) => `/dashboards/${ids.dashboards.health}${tab ? `?view=${ids.dashboardViews[`health/${tab}`]}` : ""}`;
const dViewsBar = (t) => t.page.locator(`${D_SHOWN} .views-bar`).first();
const dHeader = (t) => t.page.locator(`${D_SHOWN} .page-header`).first();
const dFilterBar = (t) => t.page.locator(`${D_SHOWN} .filter-bar`);
const dTabNames = async (t) => (await t.page.locator(`${D_SHOWN} .views-bar [role=tab]`).allInnerTexts()).map((s) => s.replace(/\s+/g, " ").trim());
const dActiveTab = async (t) => (await t.page.locator(`${D_SHOWN} .views-bar [role=tab][aria-selected=true]`).innerText()).replace(/\s+/g, " ").trim();
const dTitle = async (t) => (await t.page.locator(`${D_SHOWN} .page-header__title`).first().innerText()).trim();
const dNav = (t) => t.page.locator(".nav-tree[aria-label=Navigation]");
const dBlock = (t, name) => t.page.locator(`${D_SHOWN} .block`).filter({ has: t.page.locator(".section-header", { hasText: name }) }).first();
/** The first cells of a block's table rows (its titles), as shown. */
const dRows = (t, name) => dBlock(t, name).evaluate((b) => [...b.querySelectorAll("tbody tr")].filter((r) => r.checkVisibility()).map((r) => (r.querySelector("td")?.innerText || "").trim()).filter(Boolean)).catch(() => null);
const dSame = (a, b) => !!a && JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
async function dExpectRows(t, label, name, expected) {
  let last = null;
  return t.until(`${label}: ${name} shows ${expected.join(", ") || "nothing"}`, async () => {
    last = await dRows(t, name);
    return dSame(last, expected) || `shows ${JSON.stringify(last)}`;
  }, { timeout: 8000 });
}
const storedDashboards = (t) => t.page.evaluate(() => window.kubus.repo.listDashboards());
const storedTabs = (t, dashboardId, spaceId = "default") => t.page.evaluate(async ([d, s]) => (await window.kubus.repo.listAllDashboardViews()).filter((v) => v.dashboardId === d && v.spaceId === s).sort((a, b) => a.position - b.position), [dashboardId, spaceId]);
const confirmDialog = async (t) => {
  await shownModal(t).getByRole("button", { name: /^(Delete|Remove)/ }).click();
  await t.settle();
};
const inTitles = (rows, wanted) => wanted.every((w) => rows.includes(w));
/** Each shown row of a block as its whole text (a block of several collections: whichever column comes first). */
const dRowTexts = (t, name) => dBlock(t, name).evaluate((b) => [...b.querySelectorAll("tbody tr")].filter((r) => r.checkVisibility()).map((r) => r.innerText.replace(/\s+/g, " ").trim())).catch(() => null);
/** Waits until the block shows one row for each of these names (and no other row). */
async function dExpectRowsWith(t, label, name, expected) {
  let last = null;
  return t.until(`${label}: ${name} shows ${expected.join(", ")}`, async () => {
    last = await dRowTexts(t, name);
    return (!!last && last.length === expected.length && expected.every((e) => last.filter((r) => r.includes(e)).length === 1)) || `shows ${JSON.stringify(last)}`;
  }, { timeout: 8000 });
}
const sameSet = (a, b) => JSON.stringify([...(a || [])].sort()) === JSON.stringify([...b].sort());
/** A remote source's filter as the faked server reads it (between on a date, and / or). */
function dHolds(c, row) {
  if (!c) return true;
  if (c.and) return c.and.every((x) => dHolds(x, row));
  if (c.or) return c.or.some((x) => dHolds(x, row));
  if (c.operator !== "between") return true;
  const v = String(row[c.column] ?? "").slice(0, 10);
  const [a, b] = String(c.value).split("..");
  return !!v && v >= a.slice(0, 10) && v <= b.slice(0, 10);
}

// --- making one ---------------------------------------------------------------------------------

test("dashboards: made from the list page in the active space, named in Dashboard settings, listed in the side nav @ desktop", async (t) => {
  await t.boot();
  const ids = await t.seed(dashboardSpec());
  await t.open("/collections");
  await t.check("the side nav has a Dashboards node, between Bookmarks and Collections", await t.page.evaluate(() => {
    const labels = [...document.querySelectorAll(".nav-tree[aria-label=Navigation] > li > .cds--tree-node__label .cds--tree-node__label__text, .nav-tree[aria-label=Navigation] > [role=treeitem] > div .cds--tree-node__label__text")].map((e) => e.textContent.trim());
    const at = (n) => labels.indexOf(n);
    return at("Dashboards") > at("Bookmarks") && at("Dashboards") < at("Collections");
  }));
  await dNav(t).getByText("Dashboards", { exact: true }).first().click();
  await t.until("the node opens the list page", async () => (await dTitle(t)) === "Dashboards");
  await t.check("the seeded dashboard is listed with its description", (await t.page.locator(`${D_SHOWN} tbody`).innerText()).includes("Health") && (await t.page.locator(`${D_SHOWN} tbody`).innerText()).includes("How the week goes"));
  await t.audit("dashboards list", { shotOnFail: true });

  await t.page.locator(D_SHOWN).getByRole("button", { name: "New dashboard" }).filter({ visible: true }).first().click();
  await t.until("New dashboard opens the new one", async () => (await dTitle(t)) === "Dashboard");
  const made = (await storedDashboards(t)).find((d) => d.name === "Dashboard");
  await t.check("it is stored in the active space only", !!made && JSON.stringify(made.spaceIds) === JSON.stringify(["default"]), JSON.stringify(made));
  await t.check("with one empty tab", JSON.stringify((await storedTabs(t, made.id)).map((v) => [v.name, v.blocks.length])) === JSON.stringify([["Dashboard", 0]]));
  const name = toolbarPanel(t).getByRole("textbox", { name: "Name" });
  await t.until("Dashboard settings is open with the name selected", async () => (await name.count()) === 1 && (await t.page.evaluate(() => document.activeElement?.selectionStart === 0 && document.activeElement?.selectionEnd === document.activeElement?.value.length && document.activeElement?.value === "Dashboard")));
  await t.check("the empty tab says so and offers Add block", (await t.page.locator(`${D_SHOWN} .empty-state`).innerText()).includes("No blocks yet") && (await t.page.locator(`${D_SHOWN} .empty-state`).getByRole("button", { name: "Add block" }).count()) === 1);
  await t.audit("new dashboard, settings open", { shotOnFail: true });
  await t.page.keyboard.type("Money");
  await t.page.keyboard.press("Enter");
  await t.until("the name is stored when left", async () => (await storedDashboards(t)).some((d) => d.id === made.id && d.name === "Money"));
  const description = toolbarPanel(t).getByRole("textbox", { name: "Description (optional)" });
  await description.fill("Where it goes");
  await description.blur();
  await t.until("the description is stored when left", async () => (await storedDashboards(t)).some((d) => d.id === made.id && d.description === "Where it goes"));
  await t.escapeCloses("Escape closes Dashboard settings");
  await t.until("the header shows the name and the description", async () => (await dTitle(t)) === "Money" && (await dHeader(t).innerText()).includes("Where it goes"));
  await t.until("the side nav lists it under Dashboards", async () => (await dNav(t).innerText()).includes("Money"));


  // Spaces: only Work. It leaves the default space's nav and list, and shows in Work's.
  await t.openPanel(dHeader(t), "Dashboard settings");
  await pickOption(t, toolbarPanel(t), "Spaces", "Work");
  await t.until("the spaces are stored at once", async () => sameSet((await storedDashboards(t)).find((d) => d.id === made.id).spaceIds, ["default", ids.spaces.work]));
  await t.page.getByRole("option", { name: "Space", exact: true }).filter({ visible: true }).first().click();
  await t.settle(200);
  await t.until("…and Work alone", async () => JSON.stringify((await storedDashboards(t)).find((d) => d.id === made.id).spaceIds) === JSON.stringify([ids.spaces.work]));
  await t.closeAll();
  await t.until("no longer in this space's side nav", async () => !(await dNav(t).innerText()).includes("Money"));
  await t.page.evaluate((w) => localStorage.setItem("kubus.space", JSON.stringify(w)), ids.spaces.work);
  await t.open("/dashboards");
  await t.check("in Work it is listed (and Health, shown in every space, too)", (await dNav(t).innerText()).includes("Money") && (await t.page.locator(`${D_SHOWN} tbody`).innerText()).includes("Health"));

  // Delete (asks first): gone from the list and the nav.
  await t.open(`/dashboards/${made.id}`);
  await dHeader(t).getByRole("button", { name: "Delete dashboard" }).click();
  await t.settle(150);
  await t.audit("delete dashboard confirmation");
  await confirmDialog(t);
  await t.until("deleting it opens the list, without it", async () => (await dTitle(t)) === "Dashboards" && !(await t.page.locator(D_SHOWN).innerText()).includes("Money"));
  await t.check("it is gone from the database", !(await storedDashboards(t)).some((d) => d.id === made.id));
}, { viewport: "desktop", smoke: true });

// --- tabs ----------------------------------------------------------------------------------------

test("dashboards: tabs as views: +, rename, * and Save, star, delete, the Fields are editable switch @ desktop", async (t) => {
  await t.boot();
  const ids = await t.seed(dashboardSpec());
  await t.open(dPath(ids));
  await t.check("the starred tab opens", (await dActiveTab(t)) === "Daily", await dActiveTab(t));
  await t.check("no filter bar on a tab without Show filter bar", (await dFilterBar(t).count()) === 0);
  await dExpectRows(t, "no filter", "Books", BOOKS_READ.map(([b]) => b));
  await t.audit("dashboard tab", { shotOnFail: true });

  // +: a copy of what is shown, named New, with Tab settings open and its name selected.
  await dViewsBar(t).getByRole("button", { name: "Add tab" }).click();
  await t.until("+ adds New and opens it", async () => (await dTabNames(t)).join() === "Daily,Month,New" && (await dActiveTab(t)) === "New");
  const tabName = toolbarPanel(t).getByRole("textbox", { name: "Tab name" });
  await t.until("Tab settings is open with the name selected", async () => (await tabName.count()) === 1 && (await t.page.evaluate(() => document.activeElement?.value === "New")));
  await t.page.keyboard.type("Weekly");
  await t.page.keyboard.press("Enter");
  await t.until("renamed, stored", async () => (await storedTabs(t, ids.dashboards.health)).some((v) => v.name === "Weekly"));
  await t.check("the copy has the shown tab's blocks", (await storedTabs(t, ids.dashboards.health)).find((v) => v.name === "Weekly").blocks.length === 4);
  const filterBarBox = toolbarPanel(t).getByRole("checkbox", { name: "Show filter bar" });
  const fullWidthBox = toolbarPanel(t).getByRole("checkbox", { name: "Full width" });
  await t.check("Tab settings has Show filter bar (off) and Full width (on)", (await filterBarBox.count()) === 1 && !(await filterBarBox.isChecked()) && (await fullWidthBox.isChecked()));
  await t.audit("tab settings", { shotOnFail: true });

  // Fields are editable: a change to save (*).
  await toolbarPanel(t).getByRole("checkbox", { name: "Fields are editable" }).click({ force: true });
  await t.settle(150);
  await t.check("the tab is marked changed while its panel is open… (Save waits for it to close)", (await dActiveTab(t)) === "Weekly *", await dActiveTab(t));
  await t.escapeCloses("Escape closes Tab settings");
  const save = dViewsBar(t).getByRole("button", { name: "Save changes to tab" });
  await t.until("Save changes appears once the panel is closed", async () => (await save.count()) === 1);
  await save.click();
  await t.until("Save stores it and the * goes", async () => (await dActiveTab(t)) === "Weekly" && (await storedTabs(t, ids.dashboards.health)).find((v) => v.name === "Weekly").editable === false);

  // Star, then delete (asks first; the last tab can't be deleted).
  await dViewsBar(t).getByRole("button", { name: "Star as default tab" }).click();
  await t.until("starred", async () => (await storedTabs(t, ids.dashboards.health)).find((v) => v.name === "Weekly").isDefault === true);
  await t.open(dPath(ids));
  await t.check("the starred tab opens", (await dActiveTab(t)) === "Weekly");
  await dViewsBar(t).getByRole("button", { name: "Delete tab" }).click();
  await t.settle(150);
  await confirmDialog(t);
  await t.until("deleted: the other tabs are left", async () => (await dTabNames(t)).join() === "Daily,Month");
  await t.page.getByRole("tab", { name: "Month" }).click();
  await t.settle(150);
  await dViewsBar(t).getByRole("button", { name: "Delete tab" }).click();
  await confirmDialog(t);
  await t.until("one tab left", async () => (await dTabNames(t)).join() === "Daily");
  await t.check("…which can't be deleted", (await dViewsBar(t).getByRole("button", { name: "Delete tab" }).count()) === 0);
}, { viewport: "desktop", smoke: true });

test("dashboards: tabs are per space: another space shows copies, stored there once one changes @ desktop", async (t) => {
  await t.boot();
  const ids = await t.seed(dashboardSpec());
  await t.page.evaluate((w) => localStorage.setItem("kubus.space", JSON.stringify(w)), ids.spaces.work);
  await t.open(dPath(ids));
  await t.check("Work shows the default space's tabs", (await dTabNames(t)).join() === "Daily,Month", JSON.stringify(await dTabNames(t)));
  await t.check("…without storing them", (await storedTabs(t, ids.dashboards.health, ids.spaces.work)).length === 0);
  await t.check("…and the blocks show Work's items (none of the default space's)", !((await dRows(t, "Books")) || []).some((r) => BOOKS_READ.some(([b]) => r === b)));
  await t.openPanel(dViewsBar(t), "Tab settings");
  await toolbarPanel(t).getByRole("textbox", { name: "Tab name" }).fill("Work day");
  await t.page.keyboard.press("Enter");
  await t.until("a rename stores Work's own tabs, all of them", async () => (await storedTabs(t, ids.dashboards.health, ids.spaces.work)).map((v) => v.name).join() === "Work day,Month");
  await t.check("the default space's tabs are untouched", (await storedTabs(t, ids.dashboards.health)).map((v) => v.name).join() === "Daily,Month");
  await t.closeAll();
  await t.check("the renamed tab stays shown", (await dActiveTab(t)) === "Work day");
  // A link to the default space's tab opens Work's copy of it, as long as Work had none of its own; it has now: the default tab.
  await t.open(dPath(ids, "Month"));
  await t.check("a tab id of another space opens the starred or first tab", (await dActiveTab(t)) === "Work day");
}, { viewport: "desktop" });

// --- blocks ----------------------------------------------------------------------------------------

test("dashboards: blocks of one collection and of several, added from the empty state, a deleted collection @ desktop", async (t) => {
  await t.boot();
  const ids = await t.seed(dashboardSpec({ tabs: [{ name: "Empty", blocks: [] }] }));
  await t.open(dPath(ids));
  const empty = t.page.locator(`${D_SHOWN} .empty-state`);
  await t.check("an empty tab says so", (await empty.innerText()).includes("No blocks yet"));
  await empty.getByRole("button", { name: "Add block" }).click();
  await t.settle(100);
  await t.page.getByRole("menuitem", { name: "Table" }).click();
  await t.until("Add block adds a table of the space's first collection", async () => (await t.page.locator(`${D_SHOWN} .block`).count()) === 1 && (await dRows(t, "Table"))?.length === BOOKS_READ.length);
  const tabs = await storedTabs(t, ids.dashboards.health);
  await t.check("stored at once, naming its collection", tabs[0].blocks.length === 1 && tabs[0].blocks[0].collectionId === ids.collections.books, JSON.stringify(tabs[0].blocks));
  await t.check("no change to save", (await dActiveTab(t)) === "Empty");

  // Block settings → Collections: no collection is forced in, and Backlinks isn't offered.
  const header = dBlock(t, "Table").locator(".section-header").first();
  await t.openPanel(header, "Block settings");
  await shownPopover(t).locator(".cds--multi-select .cds--list-box__field").first().click();
  await t.settle(80);
  const offered = await menuOptions(t);
  await t.check("the Collections picker offers every collection, no Backlinks", inTitles(offered, ["Books", "People", "Notes"]) && !offered.includes("Backlinks"), JSON.stringify(offered));
  await t.page.getByRole("option", { name: "People", exact: true }).filter({ visible: true }).first().click();
  await t.settle(300);
  await dExpectRowsWith(t, "two collections: their rows as one table", "Table", [...BOOKS_READ.map(([b]) => b), ...PEOPLE_BORN.map(([p]) => p)]);
  let block = (await storedTabs(t, ids.dashboards.health))[0].blocks[0];
  await t.check("stored: its first collection and both", block.collectionId === ids.collections.books && JSON.stringify(block.collectionIds) === JSON.stringify([ids.collections.books, ids.collections.people]), JSON.stringify(block));
  // Books out: People alone (no home collection kept).
  await t.page.getByRole("option", { name: "Books", exact: true }).filter({ visible: true }).first().click();
  await t.settle(300);
  await t.until("Books taken out: People alone", async () => dSame(await dRows(t, "Table"), PEOPLE_BORN.map(([p]) => p)) || JSON.stringify(await dRows(t, "Table")));
  block = (await storedTabs(t, ids.dashboards.health))[0].blocks[0];
  await t.check("stored as People's block", block.collectionId === ids.collections.people && !block.collectionIds, JSON.stringify(block));
  await t.closeAll();

  // A second block of Notes, then Notes deleted: a warning instead of the block.
  await t.openPanel(dViewsBar(t), "Tab settings");
  await toolbarPanel(t).getByRole("button", { name: "Add block" }).click();
  await t.settle(100);
  await t.page.getByRole("menuitem", { name: "Cards" }).click();
  await t.settle(200);
  await t.closeAll();
  await t.until("the new block lists the last block's collection (People)", async () => (await storedTabs(t, ids.dashboards.health))[0].blocks[1]?.collectionId === ids.collections.people);
  await t.page.evaluate(async (id) => window.kubus.repo.deleteCollection(id), ids.collections.people);
  await t.until("a block whose collection was deleted shows a warning", async () => (await t.page.locator(`${D_SHOWN} .cds--inline-notification`, { hasText: "Block without collection" }).count()) === 2);
  await t.audit("blocks without collection", { shotOnFail: true });
  await t.page.locator(`${D_SHOWN} .cds--inline-notification`, { hasText: "Block without collection" }).first().getByRole("button").first().click();
  await t.settle(150);
  await confirmDialog(t);
  await t.until("closing the warning removes the block", async () => (await storedTabs(t, ids.dashboards.health))[0].blocks.length === 1);
}, { viewport: "desktop", smoke: true });

test("dashboards: a block of a remote collection and one reading it with a native one @ desktop", async (t) => {
  await t.boot();
  const sales = [
    { id: 1, total: 25, ordered_at: `${thisMonth[0]}T12:00:00.000Z`, customer: "Gus" },
    { id: 2, total: 60, ordered_at: `${lastMonth[0]}T12:00:00.000Z`, customer: "Hal" },
  ];
  await t.context.route(`${D_URL}/api/**`, async (route) => {
    const req = route.request();
    const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS" };
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    const path = req.url().slice(D_URL.length);
    if (path === "/api/events") return route.fulfill({ status: 204, headers: cors });
    if (path === "/api/health") return route.fulfill({ status: 200, headers: cors, json: { ok: true } });
    if (path === "/api/sources") return route.fulfill({ status: 200, headers: cors, json: [{ name: "Shop", connector: "postgres" }] });
    if (/\/query$/.test(path)) {
      const q = JSON.parse(req.postData() || "{}");
      // Only the date period matters here: a between on ordered_at.
      const rows = sales.filter((r) => dHolds(q.filter, r));
      const page = rows.slice(q.offset, q.offset + q.limit);
      return route.fulfill({ status: 200, headers: cors, json: { rows: page.map((r) => ({ key: String(r.id), values: q.columns.map((c) => r[c] ?? null) })), more: false, ...(q.counts ? { total: rows.length } : {}) } });
    }
    return route.fulfill({ status: 404, headers: cors, json: { error: "Not found" } });
  });
  await t.page.evaluate((url) => localStorage.setItem("kubus.sync", JSON.stringify({ url, token: "tok", enabled: false, originals: "always" })), D_URL);
  const ids = await t.seed(dashboardSpec({ tabs: [{ name: "Shop", blocks: [] }] }));
  const salesId = await t.page.evaluate(async () => {
    const id = crypto.randomUUID();
    const columns = [{ name: "id", type: "integer", kind: "number" }, { name: "total", type: "numeric", kind: "number" }, { name: "ordered_at", type: "timestamptz", kind: "datetime" }, { name: "customer", type: "text", kind: "string" }];
    const names = { total: "Total", ordered_at: "Ordered", customer: "Title" };
    const fields = columns.filter((c) => c.name !== "id").map((c) => ({ id: crypto.randomUUID(), name: names[c.name], kind: c.kind, targetCollectionId: null, componentId: null, code: null, output: null, frameRatio: null, choiceFilter: [], toggleIcon: null, strikeThrough: false, column: c.name }));
    await window.kubus.repo.saveCollection({ id, name: "Sale", pluralName: "Sales", icon: "DataBase", description: "", spaceIds: null, source: { name: "Shop", target: { table: { schema: "public", name: "sales" } }, key: "id", columns }, titleField: null, fields }, "default");
    return id;
  });
  const [tab] = await storedTabs(t, ids.dashboards.health);
  const block = (id, title, more) => ({ id, title, kind: "table", filters: null, sort: [{ fieldId: "$title", direction: "asc" }], groupBy: null, layout: { fields: null, editable: true, hiddenLabels: [], hideEmpty: false }, options: { titleLink: true, editable: true }, ...more });
  await t.page.evaluate(async (tab) => window.kubus.repo.saveDashboardView(tab), {
    ...tab, filterBar: true, filters: [{ id: "p", fieldId: "$date", operator: "between", value: "month+0" }],
    blocks: [block("r1", "Sales", { collectionId: salesId }), block("r2", "Both", { collectionId: ids.collections.books, collectionIds: [ids.collections.books, salesId] })],
  });
  await t.open(dPath(ids));
  await dExpectRows(t, "this month", "Sales", ["Gus"]);
  await dExpectRowsWith(t, "this month, read as one", "Both", ["Dune", "Emma", "Gus"]);
  await t.check("the tab bar offers reading the remote collections again", (await dViewsBar(t).getByRole("button", { name: "Read the remote collections again" }).count()) + (await dViewsBar(t).getByRole("button", { name: "More actions" }).count()) > 0);
  await dFilterBar(t).getByRole("button", { name: "Previous", exact: true }).click();
  await dExpectRows(t, "last month", "Sales", ["Hal"]);
  await dExpectRowsWith(t, "last month, read as one", "Both", ["Hamlet", "Ulysses", "Hal"]);
  await t.audit("remote and merged blocks on a dashboard", { shotOnFail: true });
}, { viewport: "desktop" });

// --- the filter ------------------------------------------------------------------------------------

test("dashboards: the filter bar's period steps every block with a date field, a rule on a field narrows its collection's blocks @ desktop", async (t) => {
  await t.boot();
  const ids = await t.seed(dashboardSpec());
  await t.open(dPath(ids, "Month"));
  await t.check("the tab with Show filter bar shows the bar", (await dFilterBar(t).count()) === 1);
  await dExpectRows(t, "this month", "Books", ["Dune", "Emma"]);
  await dExpectRows(t, "this month", "People", ["Ada"]);
  await dExpectRows(t, "a block without a date field is left alone", "Notes", NOTES);
  await t.audit("dashboard filter bar", { shotOnFail: true });
  const before = await dFilterBar(t).evaluate((bar) => [...bar.querySelectorAll("button")].map((b) => Math.round(b.getBoundingClientRect().left)));
  await dFilterBar(t).getByRole("button", { name: "Previous", exact: true }).click();
  await dExpectRows(t, "‹: last month", "Books", ["Hamlet", "Ulysses"]);
  await dExpectRows(t, "‹: last month", "People", ["Bob"]);
  await dExpectRows(t, "‹: still all notes", "Notes", NOTES);
  const after = await dFilterBar(t).evaluate((bar) => [...bar.querySelectorAll("button")].map((b) => Math.round(b.getBoundingClientRect().left)));
  await t.check("stepping moves none of the bar's buttons", JSON.stringify(before) === JSON.stringify(after), `${before} → ${after}`);
  await t.check("a step is an unsaved change (*)", (await dActiveTab(t)) === "Month *");
  // The Filter button sits on the bar: a rule on Books' Title narrows only Books.
  await dFilterBar(t).getByRole("button", { name: /^Filter/ }).click();
  await t.settle(150);
  await t.check("the panel goes by Date (each block's)", (await toolbarPanel(t).innerText()).includes("Date"), await toolbarPanel(t).innerText());
  await toolbarPanel(t).getByRole("button", { name: "Add filter" }).click();
  await t.settle(100);
  const rule = toolbarPanel(t).locator(".query-editor__rule").last();
  await rule.getByLabel("Field", { exact: true }).selectOption({ label: "Title" });
  await rule.getByLabel("Condition", { exact: true }).selectOption({ label: "contains" });
  await rule.getByLabel("Value", { exact: true }).fill("Ham");
  await t.settle(300);
  await t.escapeCloses("Escape closes the Filter panel");
  await dExpectRows(t, "Title contains Ham", "Books", ["Hamlet"]);
  await dExpectRows(t, "…People keep their own", "People", ["Bob"]);
  await dExpectRows(t, "…Notes keep theirs", "Notes", NOTES);
  await dViewsBar(t).getByRole("button", { name: "Save changes to tab" }).click();
  await t.until("Save stores the filter", async () => (await storedTabs(t, ids.dashboards.health)).find((v) => v.name === "Month").filters.length === 2);
  await t.open(dPath(ids, "Month"));
  await dExpectRows(t, "after a reload", "Books", ["Hamlet"]);

  // Show filter bar off: the Filter button goes back into the tab bar once the panel closes.
  await t.openPanel(dViewsBar(t), "Tab settings");
  const box = toolbarPanel(t).getByRole("checkbox", { name: "Show filter bar" });
  await t.popoverStep("untick Show filter bar", () => box.click({ force: true }), { target: box, scope: ".views-bar" });
  await t.until("stored off", async () => (await storedTabs(t, ids.dashboards.health)).find((v) => v.name === "Month").filterBar === undefined);
  await t.escapeCloses("Escape closes Tab settings");
  await t.until("no bar, the Filter button in the tab bar", async () => (await dFilterBar(t).count()) === 0 && (await dViewsBar(t).getByRole("button", { name: /^Filter/ }).count()) === 1);
}, { viewport: "desktop", smoke: true });

// --- bookmarks, search, links, history ---------------------------------------------------------------

test("dashboards: a bookmarked tab in the side nav and on the Bookmarks page; search finds the dashboard and a Markdown block @ desktop", async (t) => {
  await t.boot();
  const ids = await t.seed(dashboardSpec());
  await t.open(dPath(ids, "Month"));
  await dViewsBar(t).getByRole("button", { name: "Bookmark" }).click();
  await t.until("the tab is bookmarked: listed under Bookmarks as Dashboard / Tab", async () => (await t.page.locator(".nav-tree li", { hasText: "Bookmarks" }).first().innerText()).includes("Health / Month"));
  await t.check("the bookmark is the dashboard's", await t.page.evaluate(async (d) => (await window.kubus.repo.listBookmarks("default")).some((b) => b.kind === "dashboard" && b.dashboardId === d), ids.dashboards.health));
  await t.open("/bookmarks");
  await t.check("the Bookmarks page says what it is", (await t.page.locator(`${D_SHOWN} tbody`).innerText()).includes("Tab of Health"));
  await t.page.locator(`${D_SHOWN} tbody`).getByRole("link", { name: "Health / Month" }).click();
  await t.until("the bookmark opens the tab", async () => (await dTitle(t)) === "Health" && (await dActiveTab(t)) === "Month");
  await t.check("…and its nav node is the selected one", (await t.page.locator(".nav-tree [aria-selected=true]").innerText()).includes("Health / Month"));

  await t.open("/search?q=health");
  await t.until("search lists the dashboard", async () => (await t.page.locator(D_SHOWN).innerText()).includes("1 dashboard"));
  await t.open("/search?q=zebrafish");
  await t.until("search finds the tab's Markdown block", async () => (await t.page.locator(D_SHOWN).innerText()).includes("1 Markdown block") && (await t.page.locator(D_SHOWN).innerText()).includes("Health › Daily"));
  await t.audit("search with a dashboard's Markdown block", { shotOnFail: true });
  await t.page.locator(`${D_SHOWN} .search-hit`, { hasText: "Thoughts" }).first().click();
  await t.until("a hit opens the dashboard at the block", async () => (await dTitle(t)) === "Health" && (await dActiveTab(t)) === "Daily" && (await t.page.locator(`${D_SHOWN} [data-block-id="b-text"].link-target`).count()) === 1);

  // Tab history: the list page, the dashboard; back and forward.
  await dNav(t).getByText("Dashboards", { exact: true }).first().click();
  await t.until("the list", async () => (await dTitle(t)) === "Dashboards");
  await t.page.keyboard.press("Alt+ArrowLeft");
  await t.until("back: the dashboard", async () => (await dTitle(t)) === "Health");
  await t.page.keyboard.press("Alt+ArrowRight");
  await t.until("forward: the list", async () => (await dTitle(t)) === "Dashboards");
}, { viewport: "desktop" });

// --- sizes, dark, keyboard ----------------------------------------------------------------------------

for (const vp of ["phone", "phone-small", "laptop", "wide"]) {
  test(`dashboards: the list, a tab of blocks and the filter bar @ ${vp}`, async (t) => {
    await t.boot();
    const ids = await t.seed(dashboardSpec());
    await t.open("/dashboards");
    await t.audit("dashboards list");
    await t.open(dPath(ids));
    await t.audit("dashboard tab");
    await t.openPanel(dViewsBar(t), "Tab settings");
    await t.audit("tab settings");
    await t.closeAll();
    await t.openPanel(dHeader(t), "Dashboard settings");
    await t.audit("dashboard settings");
    await t.closeAll();
    await t.open(dPath(ids, "Month"));
    await dExpectRows(t, "this month", "Books", ["Dune", "Emma"]);
    await t.audit("dashboard filter bar");
  }, { viewport: vp, smoke: vp === "phone" });
}

test("dashboards: dark theme @ desktop", async (t) => {
  await t.boot();
  const ids = await t.seed(dashboardSpec());
  await t.open(dPath(ids, "Month"));
  await t.audit("dashboard, dark");
  await t.openPanel(dHeader(t), "Dashboard settings");
  await t.audit("dashboard settings, dark");
}, { viewport: "desktop", dark: true });

test("dashboards: keyboard: Tab reaches the tab bar's buttons, Escape closes the panels and gives focus back @ desktop", async (t) => {
  await t.boot();
  const ids = await t.seed(dashboardSpec());
  await t.open(dPath(ids));
  const settings = dHeader(t).getByRole("button", { name: "Dashboard settings" });
  await settings.focus();
  await t.page.keyboard.press("Enter");
  await t.settle(150);
  await t.check("Enter opens Dashboard settings", (await toolbarPanel(t).getByRole("textbox", { name: "Name" }).count()) === 1);
  await t.escapeCloses("Escape closes Dashboard settings, focus back on its button");
  const tabSettings = dViewsBar(t).getByRole("button", { name: "Tab settings" });
  await tabSettings.focus();
  await t.page.keyboard.press("Enter");
  await t.settle(150);
  await t.check("Enter opens Tab settings", (await toolbarPanel(t).getByRole("textbox", { name: "Tab name" }).count()) === 1);
  await t.escapeCloses("Escape closes Tab settings, focus back on its button");
}, { viewport: "desktop" });
