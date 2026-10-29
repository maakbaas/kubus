// Dashboards (domain/dashboards.ts, pages/DashboardsPage.tsx, pages/DashboardPage.tsx): made from the list
// page in the active space, named in Dashboard settings, listed in the side nav; blocks of one collection
// and of several, added from the empty state, a block whose collection was deleted.

const D_SHOWN = ".ws-pane--active .ws-tab-slot:not([hidden])";

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

const dPath = (ids, tab) => `/dashboards/${ids.dashboards.health}${tab ? `?view=${ids.dashboardViews[`health/${tab}`]}` : ""}`;

const dViewsBar = (t) => t.page.locator(`${D_SHOWN} .views-bar`).first();

const dHeader = (t) => t.page.locator(`${D_SHOWN} .page-header`).first();

const dActiveTab = async (t) => (await t.page.locator(`${D_SHOWN} .views-bar [role=tab][aria-selected=true]`).innerText()).replace(/\s+/g, " ").trim();

const dTitle = async (t) => (await t.page.locator(`${D_SHOWN} .page-header__title`).first().innerText()).trim();

const dNav = (t) => t.page.locator(".nav-tree[aria-label=Navigation]");

const dBlock = (t, name) => t.page.locator(`${D_SHOWN} .block`).filter({ has: t.page.locator(".section-header", { hasText: name }) }).first();

/** The first cells of a block's table rows (its titles), as shown. */
const dRows = (t, name) => dBlock(t, name).evaluate((b) => [...b.querySelectorAll("tbody tr")].filter((r) => r.checkVisibility()).map((r) => (r.querySelector("td")?.innerText || "").trim()).filter(Boolean)).catch(() => null);

const dSame = (a, b) => !!a && JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

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
