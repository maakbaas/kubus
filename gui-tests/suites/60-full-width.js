// "Full width" on collection views (View settings) and item views (the item page's Page layout): the
// defaults unchanged (a collection view at the pane's width, an item page in its 700px column), the
// checkbox stored with the view at once (no * on the tab, nothing to save), read back after a reload,
// the page's width changing as it is clicked (the panel open: the page is seen changing),
// a virtual view (the collection's "All", the "Default" item view) stored by it; the narrow and the
// wide page audited on phones (390 px, 320 px), on the desktop and in the dark theme.

function widthSpec() {
  return {
    collections: [
      {
        key: "books", name: "Book", plural: "Books", icon: "Book",
        fields: [
          { key: "title", name: "Title", kind: "string" },
          { key: "pages", name: "Pages", kind: "number" },
          { key: "notes", name: "Notes", kind: "markdown" },
        ],
        items: [
          { key: "dune", values: { title: "Dune", pages: 412, notes: "A desert planet." } },
          { key: "emma", values: { title: "Emma", pages: 474, notes: "Matchmaking." } },
          { key: "ulysses", values: { title: "Ulysses", pages: 730, notes: "One day in Dublin." } },
        ],
        views: [
          { name: "All", blocks: [{ kind: "table" }] },
          // Stored narrow: shown in the item page's column.
          { name: "Narrow", fullWidth: false, blocks: [{ kind: "table" }, { kind: "cards" }] },
        ],
      },
      // Item views stored: one wide, one as before (the default).
      {
        key: "people", name: "Person", plural: "People", icon: "User",
        fields: [{ key: "name", name: "Name", kind: "string" }, { key: "bio", name: "Bio", kind: "markdown" }],
        items: [{ key: "ada", values: { name: "Ada Lovelace", bio: "Wrote the first program." } }],
        itemViews: [{ name: "Wide", fullWidth: true }, { name: "Plain" }],
      },
    ],
  };
}

// --- helpers ----------------------------------------------------------------------------------

const viewsBarOf = (t) => t.page.locator(".ws-pane--active .views-bar").first();
const pageHeaderOf = (t) => t.page.locator(".ws-pane--active .page-header").first();
const activeTabText = async (t) => (await t.page.locator(".ws-pane--active .views-bar [role=tab][aria-selected=true]").innerText()).replace(/\s+/g, " ").trim();
const PANE = ".ws-pane--active .ws-pane__body";

/** The page's box (`selector`) against the room it has (its parent's content box): its width, and its gaps left and right. */
const boxIn = (t, selector) =>
  t.page.evaluate(([selector, pane]) => {
    const el = document.querySelector(`${pane} ${selector}`);
    // The box the page is laid out in: its parent's content box.
    const body = el && el.parentElement;
    if (!body) return null;
    const cs = getComputedStyle(body);
    const b = body.getBoundingClientRect();
    const left = b.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft);
    const right = b.left + parseFloat(cs.borderLeftWidth) + body.clientWidth - parseFloat(cs.paddingRight);
    const r = el.getBoundingClientRect();
    return { width: r.width, room: right - left, gapLeft: r.left - left, gapRight: right - r.right };
  }, [selector, PANE]);
/** At the pane's whole width. */
const isWide = (box) => !!box && Math.abs(box.width - box.room) <= 1;
/** In the 700px column, centred (the whole room when the pane is narrower). */
const isNarrow = (box) => !!box && box.width <= 700.5 && (box.room <= 701 ? Math.abs(box.width - box.room) <= 1 : Math.abs(box.gapLeft - box.gapRight) <= 1);
const boxText = (box) => (box ? `${Math.round(box.width)}px of ${Math.round(box.room)}px (gaps ${Math.round(box.gapLeft)} / ${Math.round(box.gapRight)})` : "no page");

const COLLECTION_PAGE = ".view-page";
const ITEM_PAGE = ".form-page.item-view";

const storedView = (t, collectionId, name) => t.page.evaluate(async ([cid, name]) => (await window.kubus.repo.listViews(cid, "default")).find((v) => v.name === name), [collectionId, name]);
const storedItemViews = (t, collectionId) => t.page.evaluate(async (cid) => (await window.kubus.repo.listCollections()).find((c) => c.id === cid).itemViews, collectionId);

const viewPath = (t, ids, name) => `${t.listPath(ids.collections.books)}?view=${ids.views[`books/${name}`]}`;

// --- defaults -----------------------------------------------------------------------------------

test("defaults: a collection view at the pane's width, an item page in its 700px column, the boxes as they say @ desktop", async (t) => {
  await t.boot();
  const ids = await t.seed(widthSpec());
  await t.open(t.listPath(ids.collections.books));
  let box = await boxIn(t, COLLECTION_PAGE);
  await t.check("the All view (stored without the setting) uses the pane's width", isWide(box), boxText(box));
  await t.check("it is not marked narrow", (await t.page.locator(`${PANE} .view-page--narrow`).count()) === 0);
  await t.openPanel(viewsBarOf(t), "View settings");
  const wide = toolbarPanel(t).getByRole("checkbox", { name: "Full width" });
  await t.check("View settings offers Full width, ticked", (await wide.count()) === 1 && (await wide.isChecked()));
  await t.audit("collection view, View settings open", { shotOnFail: true });
  await t.escapeCloses("Escape closes View settings");

  await t.open(t.itemPath(ids.collections.books, ids.items["books/dune"]));
  box = await boxIn(t, ITEM_PAGE);
  await t.check("an item page (the virtual Default item view) keeps to the 700px column, centred", isNarrow(box) && box.width > 600, boxText(box));
  await t.check("not marked full", (await t.page.locator(`${PANE} .item-view--full`).count()) === 0);
  await t.openPanel(pageHeaderOf(t), "Page layout");
  const full = toolbarPanel(t).getByRole("checkbox", { name: "Full width" });
  await t.check("Page layout offers Full width, not ticked", (await full.count()) === 1 && !(await full.isChecked()));
  await t.audit("item page, Page layout open", { shotOnFail: true });
  await t.escapeCloses("Escape closes Page layout");
  await t.check("only looking stored nothing (the Default item view is still virtual)", (await storedItemViews(t, ids.collections.books)).every((v) => v.id === "default"));
}, { viewport: "desktop", smoke: true });

// --- a collection view ---------------------------------------------------------------------------

test("Full width in View settings: stored at once without a *, the width changing as it is clicked, kept after a reload @ desktop", async (t) => {
  await t.boot();
  const ids = await t.seed(widthSpec());
  await t.open(t.listPath(ids.collections.books));
  await t.openPanel(viewsBarOf(t), "View settings");
  const box = () => toolbarPanel(t).getByRole("checkbox", { name: "Full width" });
  // Unticked: the page takes the column at once, the panel open.
  await box().click({ force: true });
  await t.until("stored with the view: fullWidth false", async () => (await storedView(t, ids.collections.books, "All")).fullWidth === false);
  await t.check("the box shows it unticked", !(await box().isChecked()));
  await t.check("no change to save: no * on the tab, no Save", (await activeTabText(t)) === "All" && (await viewsBarOf(t).getByRole("button", { name: "Save changes to view" }).count()) === 0);
  await t.until("at once, the panel open: the view keeps to the 700px column, centred", async () => isNarrow(await boxIn(t, COLLECTION_PAGE)) || boxText(await boxIn(t, COLLECTION_PAGE)));
  await t.escapeCloses("Escape closes View settings");
  const page = await boxIn(t, COLLECTION_PAGE);
  await t.check("the header, the tabs and the block are all inside the column", await t.page.evaluate(([pane, l, r]) => {
    const parts = [".page-header", ".views-bar", ".block"].map((s) => document.querySelector(`${pane} ${s}`));
    return parts.every((p) => p && p.getBoundingClientRect().left >= l - 1 && p.getBoundingClientRect().right <= r + 1);
  }, [PANE, (await t.page.locator(`${PANE} ${COLLECTION_PAGE}`).boundingBox()).x, (await t.page.locator(`${PANE} ${COLLECTION_PAGE}`).boundingBox()).x + page.width]));
  await t.audit("collection view, narrow", { shotOnFail: true });
  await t.open(t.listPath(ids.collections.books));
  await t.check("after a reload it is still narrow", isNarrow(await boxIn(t, COLLECTION_PAGE)), boxText(await boxIn(t, COLLECTION_PAGE)));
  // And on again.
  await t.openPanel(viewsBarOf(t), "View settings");
  await t.check("the box is unticked after the reload", !(await box().isChecked()));
  await box().click({ force: true });
  await t.until("stored: fullWidth true", async () => (await storedView(t, ids.collections.books, "All")).fullWidth === true);
  await t.until("at once: the pane's width again", async () => isWide(await boxIn(t, COLLECTION_PAGE)) || boxText(await boxIn(t, COLLECTION_PAGE)));
  await t.escapeCloses("Escape closes View settings");
  await t.check("still no change to save", (await activeTabText(t)) === "All");
}, { viewport: "desktop", smoke: true });

test("Full width keeps a view's unsaved changes and is per view: a view stored narrow, another view's tabs @ desktop", async (t) => {
  await t.boot();
  const ids = await t.seed(widthSpec());
  await t.open(viewPath(t, ids, "Narrow"));
  await t.check("the Narrow view (stored off) is in the column", isNarrow(await boxIn(t, COLLECTION_PAGE)), boxText(await boxIn(t, COLLECTION_PAGE)));
  await t.page.getByRole("tab", { name: "All" }).click();
  await t.until("switching to All: the pane's width", async () => isWide(await boxIn(t, COLLECTION_PAGE)) || boxText(await boxIn(t, COLLECTION_PAGE)));
  // An unsaved change (search is not one; the editable checkbox is), then Full width: the change stays unsaved, the width stored.
  await t.openPanel(viewsBarOf(t), "View settings");
  await toolbarPanel(t).getByRole("checkbox", { name: "Fields are editable" }).click({ force: true });
  await t.settle(100);
  await t.check("the view is changed (*)", (await activeTabText(t)) === "All *");
  await toolbarPanel(t).getByRole("checkbox", { name: "Full width" }).click({ force: true });
  await t.until("Full width stored off", async () => (await storedView(t, ids.collections.books, "All")).fullWidth === false);
  const stored = await storedView(t, ids.collections.books, "All");
  await t.check("the unsaved change wasn't stored with it", stored.editable === true && (await activeTabText(t)) === "All *");
  await t.until("narrow at once", async () => isNarrow(await boxIn(t, COLLECTION_PAGE)) || boxText(await boxIn(t, COLLECTION_PAGE)));
  await t.escapeCloses("Escape closes View settings");
  await t.page.getByRole("tab", { name: "Narrow" }).click();
  await t.until("the Narrow view stays narrow", async () => isNarrow(await boxIn(t, COLLECTION_PAGE)) || boxText(await boxIn(t, COLLECTION_PAGE)));
  await t.check("and its stored setting is untouched", (await storedView(t, ids.collections.books, "Narrow")).fullWidth === false);
}, { viewport: "desktop" });

// --- an item view ----------------------------------------------------------------------------------

test("Full width in Page layout: the virtual Default item view stored by it, no *, wide as it is clicked, kept after a reload @ desktop", async (t) => {
  await t.boot();
  const ids = await t.seed(widthSpec());
  const path = t.itemPath(ids.collections.books, ids.items["books/dune"]);
  await t.open(path);
  await t.openPanel(pageHeaderOf(t), "Page layout");
  const box = () => toolbarPanel(t).getByRole("checkbox", { name: "Full width" });
  await box().click({ force: true });
  await t.until("the Default item view is stored with fullWidth true", async () => {
    const views = await storedItemViews(t, ids.collections.books);
    return (views.length === 1 && views[0].name === "Default" && views[0].fullWidth === true) || JSON.stringify(views.map((v) => [v.id, v.fullWidth]));
  });
  await t.check("the box shows it ticked", await box().isChecked());
  await t.check("no change to save: no * on the tab, no Save", (await activeTabText(t)) === "Default" && (await viewsBarOf(t).getByRole("button", { name: "Save changes to view" }).count()) === 0);
  await t.until("at once: the item page at the pane's width", async () => isWide(await boxIn(t, ITEM_PAGE)) || boxText(await boxIn(t, ITEM_PAGE)));
  await t.escapeCloses("Escape closes Page layout");
  await t.audit("item page, full width", { shotOnFail: true });
  await t.open(path);
  await t.check("after a reload it is still wide", isWide(await boxIn(t, ITEM_PAGE)), boxText(await boxIn(t, ITEM_PAGE)));
  await t.open(t.itemPath(ids.collections.books, ids.items["books/emma"]));
  await t.check("and so is another item's page (same item view)", isWide(await boxIn(t, ITEM_PAGE)), boxText(await boxIn(t, ITEM_PAGE)));
  // And off again.
  await t.openPanel(pageHeaderOf(t), "Page layout");
  await box().click({ force: true });
  await t.until("stored: fullWidth false", async () => (await storedItemViews(t, ids.collections.books))[0].fullWidth === false);
  await t.until("at once: back in the column", async () => isNarrow(await boxIn(t, ITEM_PAGE)) || boxText(await boxIn(t, ITEM_PAGE)));
  await t.escapeCloses("Escape closes Page layout");
  await t.open(`/collections/${ids.collections.books}/items/new`);
  await t.check("a new item's page is always in the column", isNarrow(await boxIn(t, ".form-page")), boxText(await boxIn(t, ".form-page")));
}, { viewport: "desktop", smoke: true });

test("item views keep their own width: Wide (stored on) and Plain (as before) switched by tab @ desktop", async (t) => {
  await t.boot();
  const ids = await t.seed(widthSpec());
  await t.open(t.itemPath(ids.collections.people, ids.items["people/ada"]));
  await t.check("the Wide item view (starred) is at the pane's width", (await activeTabText(t)) === "Wide" && isWide(await boxIn(t, ITEM_PAGE)), boxText(await boxIn(t, ITEM_PAGE)));
  await t.page.getByRole("tab", { name: "Plain" }).click();
  await t.until("Plain: the 700px column", async () => isNarrow(await boxIn(t, ITEM_PAGE)) || boxText(await boxIn(t, ITEM_PAGE)));
  await t.openPanel(pageHeaderOf(t), "Page layout");
  await t.check("Plain's box is unticked", !(await toolbarPanel(t).getByRole("checkbox", { name: "Full width" }).isChecked()));
  await t.escapeCloses("Escape closes Page layout");
  await t.page.getByRole("tab", { name: "Wide" }).click();
  await t.until("Wide again: the pane's width", async () => isWide(await boxIn(t, ITEM_PAGE)) || boxText(await boxIn(t, ITEM_PAGE)));
  const views = await storedItemViews(t, ids.collections.people);
  await t.check("nothing stored by switching", views[0].fullWidth === true && !("fullWidth" in views[1]));
}, { viewport: "desktop" });

// --- sizes and the dark theme -----------------------------------------------------------------------

for (const vp of ["phone", "phone-small"]) {
  test(`a narrow collection view and a full-width item page on a phone: the whole room, the toggle through the ⋮ menu @ ${vp}`, async (t) => {
    await t.boot();
    const ids = await t.seed(widthSpec());
    await t.open(viewPath(t, ids, "Narrow"));
    let page = await boxIn(t, COLLECTION_PAGE);
    await t.check("narrower than 700px, the narrow view takes the whole room", isNarrow(page) && isWide(page), boxText(page));
    await t.audit("narrow collection view", { shotOnFail: true });
    await t.openPanel(viewsBarOf(t), "View settings");
    await t.check("View settings has Full width, unticked", !(await toolbarPanel(t).getByRole("checkbox", { name: "Full width" }).isChecked()));
    await t.popoverStep("tick Full width", () => toolbarPanel(t).getByRole("checkbox", { name: "Full width" }).click({ force: true }), { target: toolbarPanel(t).getByRole("checkbox", { name: "Full width" }) });
    await t.until("stored on", async () => (await storedView(t, ids.collections.books, "Narrow")).fullWidth === true);
    await t.audit("View settings open on a phone", { shotOnFail: true });
    await t.escapeCloses("Escape closes View settings");
    page = await boxIn(t, COLLECTION_PAGE);
    await t.check("the same room at full width", isWide(page), boxText(page));

    await t.open(t.itemPath(ids.collections.people, ids.items["people/ada"]));
    page = await boxIn(t, ITEM_PAGE);
    await t.check("the Wide item page takes the whole room", isWide(page), boxText(page));
    await t.audit("full-width item page", { shotOnFail: true });
    await t.openPanel(pageHeaderOf(t), "Page layout");
    await t.check("Page layout has Full width, ticked", await toolbarPanel(t).getByRole("checkbox", { name: "Full width" }).isChecked());
    await t.audit("Page layout open on a phone", { shotOnFail: true });
    await t.escapeCloses("Escape closes Page layout");
  }, { viewport: vp, smoke: vp === "phone-small" });
}

for (const vp of ["laptop", "wide"]) {
  test(`the narrow and the wide pages centred and audited @ ${vp}`, async (t) => {
    await t.boot();
    const ids = await t.seed(widthSpec());
    await t.open(viewPath(t, ids, "Narrow"));
    await t.check("the narrow view is in the centred column", isNarrow(await boxIn(t, COLLECTION_PAGE)), boxText(await boxIn(t, COLLECTION_PAGE)));
    await t.audit("narrow collection view", { shotOnFail: true });
    await t.open(t.itemPath(ids.collections.people, ids.items["people/ada"]));
    await t.check("the Wide item page uses the pane's width", isWide(await boxIn(t, ITEM_PAGE)), boxText(await boxIn(t, ITEM_PAGE)));
    await t.audit("full-width item page", { shotOnFail: true });
  }, { viewport: vp });
}

test("dark theme: a narrow collection view and a full-width item page with their panels open @ desktop", async (t) => {
  await t.boot();
  const ids = await t.seed(widthSpec());
  await t.open(viewPath(t, ids, "Narrow"));
  await t.check("the narrow view is in the column", isNarrow(await boxIn(t, COLLECTION_PAGE)));
  await t.audit("dark: narrow collection view", { shotOnFail: true });
  await t.openPanel(viewsBarOf(t), "View settings");
  await t.audit("dark: View settings open", { shotOnFail: true });
  await t.escapeCloses("Escape closes View settings");
  await t.open(t.itemPath(ids.collections.people, ids.items["people/ada"]));
  await t.check("the Wide item page is at the pane's width", isWide(await boxIn(t, ITEM_PAGE)));
  await t.audit("dark: full-width item page", { shotOnFail: true });
  await t.openPanel(pageHeaderOf(t), "Page layout");
  await t.audit("dark: Page layout open", { shotOnFail: true });
  await t.escapeCloses("Escape closes Page layout");
}, { viewport: "desktop", dark: true });
