// The collection view's filter bar ("Show filter bar" in View settings): stored with the view, kept after
// a reload, the view's Filter button moving onto the bar.

// Published is `pub` days from today (none: empty).
const BOOKS = [
  { title: "Alpha", pub: 0 },
  { title: "Bravo", pub: -1 },
  { title: "Charlie", pub: -3 },
  { title: "Delta", pub: -8 },
  { title: "Echo", pub: -20 },
  { title: "Foxtrot", pub: -45 },
  { title: "Golf", pub: -100 },
  { title: "Hotel", pub: -400 },
  { title: "India", pub: 1 },
  { title: "Juliet", pub: 10 },
  { title: "Kilo", pub: -15 },
  { title: "Lima", pub: -33 },
  { title: "Mike", pub: -65 },
  { title: "November", pub: null },
];

const pubDay = (b) => (b.pub === null ? null : dayStr(b.pub));

function barSpec() {
  return {
    collections: [
      {
        key: "books", name: "Book", plural: "Books", icon: "Book",
        fields: [
          { key: "title", name: "Title", kind: "string" },
          { key: "pub", name: "Published", kind: "date" },
          { key: "logged", name: "Logged", kind: "datetime" },
        ],
        items: BOOKS.map((b) => ({ values: { title: b.title, pub: pubDay(b), logged: new Date().toISOString() } })),
        views: [
          { name: "All", blocks: [{ kind: "table" }] },
          // Two blocks, the bar on: every block follows the view's period.
          { name: "Both", filterBar: true, blocks: [{ kind: "table" }, { kind: "cards" }] },
        ],
      },
      // No date field: a period goes by Updated.
      {
        key: "notes", name: "Note", plural: "Notes", icon: "Book",
        fields: [{ key: "title", name: "Title", kind: "string" }],
        items: [{ values: { title: "One" } }, { values: { title: "Two" } }],
        views: [{ name: "All", filterBar: true, blocks: [{ kind: "table" }] }],
      },
    ],
  };
}

const FILTER = /^Filter( \(\d+\))?$/;

const barOf = (t) => t.page.locator(".ws-pane--active .filter-bar");

const toolbarOf = (t) => t.page.locator(".ws-pane--active .views-bar").first();

const barButton = (t, name) => barOf(t).getByRole("button", { name, exact: true });

const activeTab = async (t) => (await t.page.locator(".ws-pane--active .views-bar [role=tab][aria-selected=true]").innerText()).replace(/\s+/g, " ").trim();

const storedView = (t, collectionId, name = "All") => t.page.evaluate(async ([cid, name]) => (await window.kubus.repo.listViews(cid, "default")).find((v) => v.name === name), [collectionId, name]);

const bookPath = (t, ids, view = "All") => `${t.listPath(ids.collections.books)}${view === "All" ? "" : `?view=${ids.views[`books/${view}`]}`}`;

test("Show filter bar: stored with the view, kept after a reload, the Filter button moves onto the bar @ desktop", async (t) => {
  await t.boot();
  const ids = await t.seed(barSpec());
  await t.open(bookPath(t, ids));
  await t.check("no bar by default, the Filter button is in the views bar", (await barOf(t).count()) === 0 && (await toolbarOf(t).getByRole("button", { name: FILTER }).count()) === 1);
  await t.openPanel(toolbarOf(t), "View settings");
  const box = toolbarPanel(t).getByRole("checkbox", { name: "Show filter bar" });
  await t.check("View settings offers Show filter bar, off", (await box.count()) === 1 && !(await box.isChecked()));
  await t.popoverStep("tick Show filter bar", () => box.click({ force: true }), { target: box, scope: ".views-bar" });
  await t.until("the bar shows at once", async () => (await barOf(t).count()) === 1);
  await t.check("while the panel is open the Filter button stays in the views bar (the buttons after it don't move)", (await toolbarOf(t).getByRole("button", { name: FILTER }).count()) === 1 && (await barButton(t, "Filter").count()) === 0);
  await t.until("it is stored with the view", async () => (await storedView(t, ids.collections.books)).filterBar === true);
  await t.check("which is not a change to save", (await activeTab(t)) === "All" && (await toolbarOf(t).getByRole("button", { name: "Save changes to view" }).count()) === 0);
  await t.audit("filter bar on, View settings open", { shotOnFail: true });
  await t.escapeCloses("Escape closes View settings");
  await t.until("the Filter button moves onto the bar once the panel is closed", async () => (await barOf(t).getByRole("button", { name: FILTER }).count()) === 1 && (await toolbarOf(t).getByRole("button", { name: FILTER }).count()) === 0);
  await t.check("the bar sits just below the tab strip, the Filter button last on its right edge", await t.page.evaluate(() => {
    const bar = document.querySelector(".ws-pane--active .filter-bar");
    const views = document.querySelector(".ws-pane--active .views-bar");
    const buttons = [...bar.querySelectorAll("button")].filter((b) => !b.closest(".filter-bar__kind"));
    const last = buttons[buttons.length - 1];
    return !!bar && views.getBoundingClientRect().bottom <= bar.getBoundingClientRect().top + 1 && bar.getBoundingClientRect().top - views.getBoundingClientRect().bottom < 40 && Math.abs(last.getBoundingClientRect().right - bar.getBoundingClientRect().right) < 1;
  }));
  await t.audit("filter bar, no period", { shotOnFail: true });
  await t.open(bookPath(t, ids));
  await t.check("after a reload the bar and its Filter button are still there", (await barOf(t).count()) === 1 && (await barOf(t).getByRole("button", { name: FILTER }).count()) === 1 && (await toolbarOf(t).getByRole("button", { name: FILTER }).count()) === 0);
  await t.page.getByRole("tab", { name: "Both" }).click();
  await t.until("the Both view (made with the bar) shows its bar too", async () => (await barOf(t).count()) === 1);
  await t.page.getByRole("tab", { name: "All" }).click();
  // Off again: stays while the panel is open, goes (the Filter button back) when it closes.
  await t.openPanel(toolbarOf(t), "View settings");
  const off = toolbarPanel(t).getByRole("checkbox", { name: "Show filter bar" });
  await t.check("the box is ticked", await off.isChecked());
  await t.popoverStep("untick Show filter bar", () => off.click({ force: true }), { target: off, scope: ".views-bar" });
  await t.until("stored off (the key is gone)", async () => (await storedView(t, ids.collections.books)).filterBar === undefined);
  await t.check("the Filter button isn't anywhere twice nor missing while the panel is open", (await barOf(t).getByRole("button", { name: FILTER }).count()) + (await toolbarOf(t).getByRole("button", { name: FILTER }).count()) === 1);
  await t.escapeCloses("Escape closes View settings");
  await t.until("no bar, the Filter button back in the views bar", async () => (await barOf(t).count()) === 0 && (await toolbarOf(t).getByRole("button", { name: FILTER }).count()) === 1);
  await t.open(bookPath(t, ids));
  await t.check("and so after a reload", (await barOf(t).count()) === 0 && (await storedView(t, ids.collections.books)).filterBar === undefined);
}, { viewport: "desktop", smoke: true });
