// The shell's behaviour (suite 02 holds its layout rules): opening in a new tab / beside, tab history
// and what a reload keeps, closing, Spaces (made, renamed, switched, deleted, what they filter, an item
// moved), Bookmarks (the button on an item and a view, the side nav, the Bookmarks page), Help's
// tabs and deep links, "/" and pages that do not exist. Each step is followed by what it did: the
// page, the stored layout (localStorage), or the stored data (window.kubus.repo).

const WS_KEY = "kubus.workspace.default";

/** The stored layout of a space as the panes' tab paths (+ which tab of each is active). */
async function storedPanes(t, key = WS_KEY) {
  return t.page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const out = [];
    const walk = (n) => (n.kind === "pane" ? out.push({ paths: n.tabs.map((x) => x.path), active: n.tabs.findIndex((x) => x.id === n.activeTabId) }) : n.children.forEach(walk));
    walk(JSON.parse(raw).root);
    return out;
  }, key);
}

const tabLabels = (t) => t.page.locator(".ws-pane__tabs .cds--tabs__nav-item .cds--tabs__nav-item-label").allInnerTexts();
// Tabs stay mounted while hidden: only the shown tab's page counts.
const SHOWN = ".ws-pane--active .ws-tab-slot:not([hidden])";
const title = async (t) => (await t.page.locator(`${SHOWN} .page-header__title`).first().innerText()).trim();
const spaceNames = (t) => t.page.evaluate(async () => (await window.kubus.repo.listSpaces()).map((s) => s.name));
const bookmarkLabels = (t, spaceId = "default") => t.page.evaluate(async (s) => (await window.kubus.repo.listBookmarks(s)).map((b) => b.label), spaceId);
const rowTexts = (t) => t.page.locator(`${SHOWN} .items-table tbody tr:not(.table-add-row) td:nth-child(2)`).allInnerTexts();

/** The side nav's tree is there on phones only after the menu toggle. */
async function showNav(t) {
  if (!(await t.page.locator(".cds--side-nav--expanded, .app-content--nav-docked").count())) await t.page.getByRole("button", { name: "Show menu" }).first().click();
  await t.settle();
}
async function hideNav(t) {
  if (t.phone && (await t.page.locator(".cds--side-nav--expanded").count())) await t.page.getByRole("button", { name: "Hide menu" }).filter({ visible: true }).first().click();
  await t.settle();
}

/** Picks a space in the switcher dropdown. */
async function switchSpace(t, name) {
  if (t.phone) await showNav(t);
  await t.page.locator(".side-nav-space .cds--dropdown button").first().click();
  await t.page.getByRole("option", { name }).click();
  await t.settle();
  await hideNav(t);
}

// ---- Tabs: where a link opens ----------------------------------------------------------------

test("open in a new tab, beside, here: click, Ctrl+click, middle click", async (t) => {
  await t.boot();
  const ids = await t.seed(profileSpec("typical", { items: 4 }));
  const books = ids.collections.books;
  await t.open(t.listPath(books));
  // The title links (the table has links to authors too).
  const titleLinks = t.page.locator(`${SHOWN} .items-table tbody tr:not(.table-add-row) a[href*="/${books}/items/"]`);
  const link = (n) => titleLinks.nth(n);
  const names = await titleLinks.allInnerTexts();
  const hrefs = await titleLinks.evaluateAll((as) => as.map((a) => a.getAttribute("href").slice(1)));

  // Ctrl+click on a wide window: the item opens in a pane to the right; the list stays where it was.
  await link(0).click({ modifiers: ["Control"] });
  await t.until("Ctrl+click splits off a pane beside", async () => (await t.count(".ws-pane")) === 2);
  let panes = await storedPanes(t);
  await t.check("the right pane holds the item, the left one the list", panes.length === 2 && panes[0].paths[0] === t.listPath(books) && panes[1].paths[0] === hrefs[0], JSON.stringify(panes));
  await t.audit("an item opened beside");

  // A second Ctrl+click reuses the pane to the right (no third pane); its tab shows the new item.
  await link(1).click({ modifiers: ["Control"] });
  await t.until("the pane to the right shows the second item", async () => (await storedPanes(t))[1].paths[0] === hrefs[1]);
  await t.check("still two panes, one tab each", (await t.count(".ws-pane")) === 2 && (await t.count(".ws-pane__tabs .cds--tabs__nav-item")) === 2);

  // Middle click: a new tab (in the pane clicked in, after its tabs), the pane stays as it was.
  await link(2).click({ button: "middle" });
  await t.until("middle click adds a tab to the list's pane", async () => (await storedPanes(t))[0].paths.length === 2);
  panes = await storedPanes(t);
  await t.check("the new tab is the item, and it is the active one", panes[0].paths[1] === hrefs[2] && panes[0].active === 1, JSON.stringify(panes));
  await t.until("its tab is named after the item", async () => (await tabLabels(t)).some((x) => x.includes(names[2])), { timeout: 5000 });

  // A plain click goes into the active tab: no new tab, no new pane.
  await t.go(t.listPath(books));
  await t.page.locator(`${SHOWN} .items-table tbody tr:not(.table-add-row) a[href*="/${books}/items/"]`).first().click();
  await t.until("a plain click opens the item in the tab", async () => (await title(t)).includes(names[0]));
  panes = await storedPanes(t);
  await t.check("tabs unchanged by a plain click", panes[0].paths.length === 2 && panes[0].paths[1] === hrefs[0], JSON.stringify(panes));
  await t.audit("after plain, Ctrl and middle clicks");
}, { smoke: true });

test("Ctrl+click on a narrow window opens a new tab instead of a pane", async (t) => {
  await t.boot();
  const ids = await t.seed(profileSpec("typical", { items: 3 }));
  const books = ids.collections.books;
  await t.open(t.listPath(books));
  const first = t.page.locator(`${SHOWN} .items-table tbody tr:not(.table-add-row) a[href*="/${books}/items/"]`).first();
  const href = (await first.getAttribute("href")).slice(1);
  await first.click({ modifiers: ["Control"] });
  await t.until("a second tab opens in the same pane", async () => (await storedPanes(t))[0].paths.length === 2);
  const panes = await storedPanes(t);
  await t.check("one pane, the item as the active second tab", panes.length === 1 && panes[0].active === 1 && panes[0].paths[1] === href, JSON.stringify(panes));
  await t.audit("new tab on a laptop");
}, { viewport: "laptop" });

test("side nav links: click goes to the active tab, middle click opens a tab; + opens Collections", async (t) => {
  await t.boot();
  const ids = await t.seed(profileSpec("typical", { items: 2 }));
  await t.open("/help");
  const nav = t.page.locator(".nav-tree[aria-label=Navigation]");
  await nav.getByText("Authors", { exact: true }).first().click();
  await t.until("a click shows the collection in the same tab", async () => (await title(t)).includes("Authors"));
  await t.check("still one tab", (await tabLabels(t)).length === 1, (await tabLabels(t)).join("|"));

  await nav.getByText("Books", { exact: true }).first().click({ button: "middle" });
  await t.until("a middle click opens a second tab", async () => (await tabLabels(t)).length === 2);
  await t.until("the new tab is active and shows Books", async () => (await title(t)).includes("Books"));
  const panes = await storedPanes(t);
  await t.check("stored: Authors then Books, Books active", panes[0].paths[0] === t.listPath(ids.collections.authors) && panes[0].paths[1] === t.listPath(ids.collections.books) && panes[0].active === 1, JSON.stringify(panes));

  await t.page.getByRole("button", { name: "New tab" }).first().click();
  await t.until("+ adds a third tab on the collections overview", async () => (await tabLabels(t)).length === 3 && (await title(t)) === "Collections");
  await t.check("it is stored as the active one", (await storedPanes(t))[0].active === 2);
  // Clicking an inactive tab makes it the active one and shows its page.
  await t.page.locator(".ws-pane__tabs .cds--tabs__nav-item").first().click();
  await t.until("clicking the first tab shows its page", async () => (await title(t)).includes("Authors"));
  await t.check("the stored active tab follows", (await storedPanes(t))[0].active === 0);
  await t.audit("three tabs");
});

// ---- Tabs: history, closing, what a reload keeps ---------------------------------------------

test("each tab has its own history: Alt+arrows, mouse buttons, and a reload keeps tabs", async (t) => {
  await t.boot();
  const ids = await t.seed(profileSpec("typical", { items: 3 }));
  const books = ids.collections.books;
  await t.open("/help");
  await t.page.getByRole("button", { name: "New tab" }).first().click();
  await t.settle();
  // Tab 2 walks through three pages (side nav links push onto its history).
  const nav = t.page.locator(".nav-tree[aria-label=Navigation]");
  await nav.getByText("Books", { exact: true }).first().click();
  await t.until("tab 2 shows Books", async () => (await title(t)).includes("Books"));
  await nav.getByText("Authors", { exact: true }).first().click();
  await t.until("tab 2 shows Authors", async () => (await title(t)).includes("Authors"));
  await t.go("/help");
  await t.until("tab 2 shows Help", async () => (await title(t)) === "Help");

  await t.page.keyboard.press("Alt+ArrowLeft");
  await t.until("Alt+Left: Authors", async () => (await title(t)).includes("Authors"));
  await t.page.keyboard.press("Alt+ArrowLeft");
  await t.until("Alt+Left again: Books", async () => (await title(t)).includes("Books"));
  await t.check("the stored path follows the history", (await storedPanes(t))[0].paths[1] === t.listPath(books), JSON.stringify(await storedPanes(t)));
  // The mouse's back / forward buttons are buttons 3 and 4 of a mouseup.
  const mouse = (button) => t.page.evaluate((button) => window.dispatchEvent(new MouseEvent("mouseup", { button, cancelable: true })), button);
  await mouse(4);
  await t.until("mouse forward: Authors", async () => (await title(t)).includes("Authors"));
  await mouse(3);
  await t.until("mouse back: Books", async () => (await title(t)).includes("Books"));
  // Back at the start of the history does nothing more than stay put. (Tab 2 began at the collections overview.)
  await mouse(3);
  await t.until("back once more: the collections overview", async () => (await title(t)) === "Collections");
  await mouse(3);
  await t.settle();
  await t.check("back at the first entry stays on it", (await title(t)) === "Collections");

  // Tab 1 has its own history, untouched by all that: nothing to go back to.
  await t.page.locator(".ws-pane__tabs .cds--tabs__nav-item").first().click();
  await t.until("tab 1 is active", async () => (await storedPanes(t))[0].active === 0 && (await title(t)) === "Help");
  // (Focus on a tab: Carbon's tab list would take Alt+Left as "previous tab" too, so focus leaves it.)
  await t.page.evaluate(() => document.activeElement?.blur());
  await t.page.keyboard.press("Alt+ArrowLeft");
  await t.settle();
  // Tab 1 began at the collections overview, then went to Help: back is that, in tab 1 only.
  await t.until("tab 1 went back in its own history", async () => (await title(t)) === "Collections" && (await storedPanes(t))[0].active === 0);
  await t.check("only tab 1 moved: Collections, with tab 2 where it was", JSON.stringify((await storedPanes(t))[0].paths) === JSON.stringify(["/collections", "/collections"]), JSON.stringify(await storedPanes(t)));
  await t.page.evaluate(() => document.activeElement?.blur());
  await t.page.keyboard.press("Alt+ArrowRight");
  await t.until("Alt+Right returns tab 1 to Help", async () => (await title(t)) === "Help");

  // With focus on a tab, Alt+arrows are still only history: Carbon's tab list must not also switch tabs.
  await t.page.locator(".ws-pane__tabs .cds--tabs__nav-item").first().focus();
  await t.page.keyboard.press("Alt+ArrowLeft");
  await t.settle();
  await t.check("Alt+Left on a focused tab goes back in the history and keeps the tab", (await title(t)) === "Collections" && (await storedPanes(t))[0].active === 0, JSON.stringify(await storedPanes(t)));
  await t.page.locator(".ws-pane__tabs .cds--tabs__nav-item").first().focus();
  await t.page.keyboard.press("Alt+ArrowRight");
  await t.until("Alt+Right on a focused tab goes forward, still tab 1", async () => (await title(t)) === "Help" && (await storedPanes(t))[0].active === 0);

  // A reload: the tabs, their pages and the active one come back.
  await t.page.locator(".ws-pane__tabs .cds--tabs__nav-item").nth(1).click();
  await t.go(t.itemPath(books, ids.items["books/i1"]));
  const before = await storedPanes(t);
  await t.open(t.itemPath(books, ids.items["books/i1"]), { keepTabs: true });
  const after = await storedPanes(t);
  await t.check("the stored layout is the same after a reload", JSON.stringify(after) === JSON.stringify(before) && after[0].paths.length === 2, `${JSON.stringify(before)} / ${JSON.stringify(after)}`);
  await t.until("the second tab is active and shows its item", async () => (await t.count(".ws-pane__tabs .cds--tabs__nav-item--selected")) === 1 && (await t.page.locator(".ws-pane__tabs .cds--tabs__nav-item--selected").first().innerText()).trim().length > 0);
  await t.check("the item page is shown", (await t.count(`${SHOWN} .item-title`)) > 0);
  await t.audit("after the reload");
});

test("closing tabs: the neighbour takes over, a split collapses, the layout is stored", async (t) => {
  await t.boot();
  const ids = await t.seed(profileSpec("typical", { items: 2 }));
  const books = ids.collections.books;
  const paths = ["/collections", t.listPath(books), "/help", "/settings"];
  await t.seed({ prefs: { [WS_KEY]: wsLayout([paths.slice(0, 3), [paths[3]]]) } });
  await t.open("/collections", { keepTabs: true });
  await t.check("two panes, three tabs and one", (await t.count(".ws-pane")) === 2 && (await t.count(".ws-pane__tabs .cds--tabs__nav-item")) === 4);

  // Close the active tab of the left pane (Help, the last): the one before it (Books) becomes active.
  const left = t.page.locator(".ws-pane").first();
  await left.locator(".cds--tabs__nav-item--selected .cds--tabs__nav-item--close-icon, .cds--tabs__nav-item--selected [aria-label*='Close' i]").first().click().catch(async () => {
    await left.locator(".cds--tabs__nav-item--close-icon").nth(2).click();
  });
  await t.until("the left pane has two tabs", async () => (await storedPanes(t))[0].paths.length === 2);
  let panes = await storedPanes(t);
  await t.check("the tab before it is the active one", panes[0].active === 1 && panes[0].paths[1] === paths[1], JSON.stringify(panes));
  await t.until("the pane shows that page", async () => (await t.page.locator(".ws-pane").first().locator(".ws-tab-slot:not([hidden]) .page-header__title").first().innerText()).includes("Books"));

  // Close the right pane's only tab: the pane goes and the split with it.
  await t.page.locator(".ws-pane").nth(1).locator(".cds--tabs__nav-item--close-icon").first().click();
  await t.until("one pane is left", async () => (await t.count(".ws-pane")) === 1);
  await t.check("no split, the stored layout is one pane", (await t.count(".ws-split")) === 0 && (await storedPanes(t)).length === 1, JSON.stringify(await storedPanes(t)));
  await t.audit("split collapsed");

  // Close both remaining tabs: the empty workspace, and it is what a reload shows.
  for (let left = 2; left > 0; left--) {
    await t.page.locator(".cds--tabs__nav-item--close-icon").filter({ visible: true }).first().click();
    await t.until("a tab went", async () => (await t.count(".ws-pane__tabs .cds--tabs__nav-item")) === left - 1);
  }
  await t.until("the empty workspace", async () => (await t.page.getByText("open a new tab").count()) === 1);
  await t.check("stored: a pane without tabs", JSON.stringify(await storedPanes(t)) === JSON.stringify([{ paths: [], active: -1 }]), JSON.stringify(await storedPanes(t)));
  await t.page.reload();
  await t.page.waitForSelector(".ws-pane");
  await t.settle();
  await t.check("a reload keeps it empty", (await t.page.getByText("open a new tab").count()) === 1 && (await t.count(".ws-pane__tabs .cds--tabs__nav-item")) === 0);
  await t.page.getByText("open a new tab").click();
  await t.until("the link opens the collections overview", async () => (await tabLabels(t)).length === 1 && (await title(t)) === "Collections");
  await t.audit("a tab again");
});

test("tabs on a phone: only the active pane, opening from the nav, the tab menu lists all", async (t) => {
  await t.boot();
  const ids = await t.seed(profileSpec("long", { items: 3 }));
  const books = ids.collections.books;
  await t.seed({ prefs: { [WS_KEY]: wsLayout([["/help"], ["/collections", t.listPath(books)]]) } });
  await t.open("/help", { keepTabs: true });
  await t.check("one pane shows", (await t.page.locator(".ws-pane").filter({ visible: true }).count()) === 1);
  await t.audit("phone, two panes stored");
  await t.page.getByRole("button", { name: "New tab" }).filter({ visible: true }).first().click();
  await t.until("a new tab opens in the active pane", async () => (await storedPanes(t))[0].paths.length === 2);
  await t.check("it is the pane with Help, and the other pane is untouched", (await storedPanes(t))[0].paths[0] === "/help" && (await storedPanes(t))[1].paths.length === 2);
  await t.audit("phone, new tab");
}, { viewport: "phone" });

// ---- Spaces ----------------------------------------------------------------------------------

for (const vp of ["desktop", "phone"]) {
  test(`Spaces page: new, rename in place, switch, delete @ ${vp}`, async (t) => {
    await t.boot();
    const spec = profileSpec("typical", { items: 3 });
    spec.spaces = [{ key: "w", name: "Work" }];
    spec.collections[1].items = []; // authors: none, so the counts below are the books' only
    const ids = await t.seed(spec);
    // One book belongs to Work: it is what the delete question counts.
    await t.page.evaluate(([item, space]) => window.kubus.repo.moveItem(item, space), [ids.items["books/i0"], ids.spaces.w]);
    await t.open("/spaces");
    const rows = () => t.page.locator(".ws-pane--active tbody tr");
    await t.check("the spaces are listed", (await rows().count()) === 2 && (await rows().allInnerTexts()).join("|").includes("Work"), (await rows().allInnerTexts()).join("|"));
    const disabledIn = async (name) => (await rows().filter({ hasText: name }).locator("button:disabled").count()) >= 1;
    await t.check("the shown space can't be switched to again", await disabledIn("Space"));
    await t.audit("spaces");

    // New space: made with the next free name and its name opens for editing.
    await t.page.getByRole("button", { name: "New space" }).filter({ visible: true }).first().click();
    await t.until("a third space with a name to type over", async () => (await spaceNames(t)).includes("Space 2") && (await t.count(".ws-pane--active tbody .field-editor, .ws-pane--active tbody input")) > 0);
    await t.page.keyboard.press("Control+A");
    await t.page.keyboard.type("Garden");
    await t.page.keyboard.press("Enter");
    await t.until("the name is stored", async () => (await spaceNames(t)).includes("Garden"));
    await t.check("the old name is gone", !(await spaceNames(t)).includes("Space 2"));
    // Rename a row by clicking its name; Escape leaves the name alone.
    await t.page.getByRole("button", { name: "Rename Work" }).click();
    await t.editorReady("tbody .field-editor, tbody input");
    await t.page.keyboard.press("Control+A");
    await t.page.keyboard.type("Jobs");
    await t.page.keyboard.press("Escape");
    await t.settle();
    await t.check("Escape keeps the name", (await spaceNames(t)).includes("Work") && !(await spaceNames(t)).includes("Jobs"), (await spaceNames(t)).join("|"));
    await t.page.getByRole("button", { name: "Rename Work" }).click();
    await t.editorReady("tbody .field-editor, tbody input");
    await t.page.keyboard.press("Control+A");
    await t.page.keyboard.type("Jobs");
    await t.page.keyboard.press("Enter");
    await t.until("Enter stores it", async () => (await spaceNames(t)).includes("Jobs"));
    await t.audit("renamed");

    // Switch from the row: the switcher and the stored choice follow.
    await t.page.getByRole("button", { name: "Switch to Jobs" }).click();
    await t.until("the switcher shows Jobs", async () => { await showNav(t); const x = (await t.page.locator(".side-nav-space").innerText()).includes("Jobs"); await hideNav(t); return x; });
    // Each space has its own tabs: the Spaces page is shown again in this one.
    await t.go("/spaces");
    await t.check("the choice is remembered on this device", (await t.page.evaluate(() => localStorage.getItem("kubus.space"))) === JSON.stringify(ids.spaces.w));
    await t.check("its own switch button is now disabled, the other's is not", (await disabledIn("Jobs")) && !(await disabledIn("Garden")));

    // Delete: cancel keeps it; confirming says what goes, removes it, and (as it was shown) opens another.
    await t.page.getByRole("button", { name: "Delete Jobs" }).click();
    await t.settle();
    const dialog = t.page.locator(".cds--modal.is-visible");
    await t.check("the question names the space and counts its items", (await dialog.innerText()).includes("Delete space “Jobs”?") && (await dialog.innerText()).includes("its 1 item"), await dialog.innerText());
    await t.audit("delete question");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await t.settle();
    await t.check("Cancel keeps it", (await spaceNames(t)).includes("Jobs"));
    await t.page.getByRole("button", { name: "Delete Jobs" }).click();
    await t.settle();
    await t.page.locator(".cds--modal.is-visible").getByRole("button", { name: "Delete" }).click();
    await t.until("the space is deleted", async () => !(await spaceNames(t)).includes("Jobs"));
    const items = await t.page.evaluate(async (c) => (await window.kubus.repo.listItems((await window.kubus.repo.listCollections()).find((x) => x.id === c), "default")).length, ids.collections.books);
    await t.check("its items went with it, the others stay", items === 2, `${items} books in the default space`);
    await t.go("/spaces");
    await t.until("another space is shown (the first)", async () => (await rows().count()) === 2);
    await t.check("the stored choice moved on to an existing space", await t.page.evaluate(async () => (await window.kubus.repo.listSpaces()).some((s) => localStorage.getItem("kubus.space") === JSON.stringify(s.id))));
    await t.audit("after the delete");
    // Down to one space: it can't be deleted.
    await t.page.getByRole("button", { name: "Delete Garden" }).click();
    await t.page.locator(".cds--modal.is-visible").getByRole("button", { name: "Delete" }).click();
    await t.until("one space is left", async () => (await spaceNames(t)).length === 1);
    await t.check("the only space has its delete disabled", (await rows().locator("button:disabled").count()) >= 1);
  }, { viewport: vp });
}

test("space switcher: what each space shows, Manage spaces, one workspace per space", async (t) => {
  await t.boot();
  const spec = profileSpec("typical", { items: 4 });
  spec.spaces = [{ key: "w", name: "Work" }];
  // Authors only live in Work; Books are in both spaces, with different items.
  spec.collections[1].spaces = ["w"];
  spec.collections[1].space = "w";
  spec.collections[1].items = spec.collections[1].items.slice(0, 2).map((it) => ({ ...it, space: "w" }));
  spec.collections[0].spaces = null;
  const ids = await t.seed(spec);
  const books = ids.collections.books;
  await t.page.evaluate(([item, space]) => window.kubus.repo.moveItem(item, space), [ids.items["books/i0"], ids.spaces.w]);
  const navHas = async (name) => (await t.page.locator(".nav-tree[aria-label=Navigation]").innerText()).includes(name);

  await t.open(t.listPath(books));
  const defaultRows = await rowTexts(t);
  await t.check("the default space lists three books", defaultRows.length === 3, defaultRows.join("|"));
  await showNav(t);
  await t.check("the nav has no Authors in this space", !(await navHas("Authors")) && (await navHas("Books")));
  await hideNav(t);
  await t.go("/help"); // this space's workspace: Help

  await switchSpace(t, /Work/);
  await showNav(t);
  await t.until("the nav lists Authors here", async () => navHas("Authors"));
  await hideNav(t);
  await t.check("the choice is stored", (await t.page.evaluate(() => localStorage.getItem("kubus.space"))) === JSON.stringify(ids.spaces.w));
  // Each space has its own tabs: Work starts with a fresh one (not Help).
  await t.until("Work has its own workspace, not the Help tab", async () => (await title(t)) !== "Help");
  await t.check("two layouts are stored", (await t.page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("kubus.workspace.")).length)) === 2);
  await t.go(t.listPath(books));
  await t.until("Work lists its one book", async () => (await rowTexts(t)).length === 1);
  await t.check("it is the moved one", (await t.count(`${SHOWN} .items-table a[href$="/${ids.items["books/i0"]}"]`)) === 1);
  await t.audit("the Work space");

  // Reload: the space stays chosen.
  await t.open(t.listPath(books), { keepTabs: true });
  await showNav(t);
  await t.check("Work is still the shown space after a reload", (await t.page.locator(".side-nav-space").innerText()).includes("Work"));
  await hideNav(t);

  // Manage spaces: the last entry opens the Spaces page in the active tab.
  if (t.phone) await showNav(t);
  await t.page.locator(".side-nav-space .cds--dropdown button").first().click();
  await t.audit("the switcher's menu with Manage spaces");
  await t.page.getByRole("option", { name: "Manage spaces" }).click();
  await t.until("the Spaces page opens", async () => (await title(t)) === "Spaces");
  await t.check("the switcher still shows Work", (await t.page.locator(".side-nav-space").innerText()).includes("Work"));
  // Back to the default space: its workspace (the Help tab) is back.
  await switchSpace(t, /^Space$/);
  await t.until("the default space's tab is back", async () => (await title(t)) === "Help");
});

test("an item moved to another space shows there, and not here", async (t) => {
  await t.boot();
  const spec = profileSpec("typical", { items: 3 });
  spec.spaces = [{ key: "w", name: "Work" }];
  const ids = await t.seed(spec);
  const books = ids.collections.books;
  const item = ids.items["books/i0"];
  await t.open(t.itemPath(books, item));
  const itemTitle = await title(t);
  await t.openPanel(t.page.locator(`${SHOWN} .page-header`), "Details");
  await t.page.locator(".toolbar-popover.cds--popover--open .cds--dropdown button").first().click();
  await t.page.getByRole("option", { name: /Work/ }).click();
  await t.until("the item is stored in Work", async () => (await t.page.evaluate(async ([c, id]) => { const repo = window.kubus.repo; const coll = (await repo.listCollections()).find((x) => x.id === c); return (await repo.getItem(coll, id))?.spaceId; }, [books, item])) === ids.spaces.w);
  await t.page.keyboard.press("Escape");
  await t.go(t.listPath(books));
  await t.until("the default space's list lost it", async () => (await t.count(`${SHOWN} .items-table a[href$="/${item}"]`)) === 0 && (await rowTexts(t)).length === 2);
  await switchSpace(t, /Work/);
  await t.go(t.listPath(books));
  await t.until("Work's list has it", async () => (await t.count(`${SHOWN} .items-table a[href$="/${item}"]`)) === 1 && (await rowTexts(t)).length === 1);
  await t.audit("the moved item in Work");
});

// ---- Bookmarks -------------------------------------------------------------------------------

for (const vp of ["desktop", "phone"]) {
  test(`bookmarks: the button on an item and on a view, the side nav, removing @ ${vp}`, async (t) => {
    await t.boot();
    const ids = await t.seed(profileSpec("typical", { items: 3 }));
    const books = ids.collections.books;
    const item = t.itemPath(books, ids.items["books/i0"]);
    await t.open(item);
    const header = t.page.locator(`${SHOWN} .page-header`);
    const itemTitle = await title(t);
    const button = async (name) => (await t.openPanelless(header, name));
    t.openPanelless = async (scope, name) => {
      const btn = scope.getByRole("button", { name, exact: true }).filter({ visible: true }).first();
      if (await btn.count()) return btn;
      await scope.getByRole("button", { name: "More actions" }).filter({ visible: true }).first().click();
      await t.settle(100);
      return t.page.getByRole("button", { name, exact: true }).filter({ visible: true }).first();
    };
    await t.check("an unbookmarked item offers Bookmark, not pressed", (await (await button("Bookmark")).getAttribute("aria-pressed")) === "false");
    await (await button("Bookmark")).click();
    await t.until("the item is bookmarked, labelled with its title", async () => (await bookmarkLabels(t)).includes(itemTitle));
    await t.settle();
    await t.check("the button now offers Remove bookmark, pressed", (await (await button("Remove bookmark")).getAttribute("aria-pressed")) === "true");
    if (t.phone) await t.page.keyboard.press("Escape");
    await showNav(t);
    await t.until("the side nav lists it under Bookmarks", async () => (await t.page.locator(".nav-tree li", { hasText: "Bookmarks" }).first().innerText()).includes(itemTitle));
    await hideNav(t);
    await t.audit("item bookmarked");

    // A reload: still bookmarked, and the button shows it.
    await t.open(item);
    await t.check("after a reload the button still shows Remove bookmark", (await (await button("Remove bookmark")).count()) === 1);
    if (t.phone) await t.page.keyboard.press("Escape");

    // A view: the collection's "All" view is stored first, then bookmarked as "Books / All".
    await t.go(t.listPath(books));
    const bar = t.page.locator(`${SHOWN} .views-bar`).first();
    const viewButton = async (name) => {
      const b = bar.getByRole("button", { name, exact: true }).filter({ visible: true }).first();
      if (await b.count()) return b;
      await bar.getByRole("button", { name: "More actions" }).filter({ visible: true }).first().click();
      await t.settle(100);
      return t.page.getByRole("button", { name, exact: true }).filter({ visible: true }).first();
    };
    await (await viewButton("Bookmark")).click();
    await t.until("the view is bookmarked as Books / <view>", async () => (await bookmarkLabels(t)).some((l) => l.startsWith("Books / ")));
    const stored = await t.page.evaluate(async () => (await window.kubus.repo.listBookmarks("default")).map((b) => b.kind));
    await t.check("in the order they were added: the item, then the view", stored.join() === "item,view", stored.join());
    if (t.phone) await t.page.keyboard.press("Escape");
    await t.audit("a view bookmarked");

    // The bookmark in the side nav opens the item in the active tab.
    await t.go("/help");
    await showNav(t);
    await t.page.locator(".nav-tree[aria-label=Navigation]").getByText(itemTitle, { exact: true }).first().click();
    await t.until("the nav bookmark opens the item", async () => (await title(t)) === itemTitle);
    await hideNav(t);

    // Remove again from the item: gone from the store and the nav.
    await (await button("Remove bookmark")).click();
    await t.until("the item's bookmark is removed", async () => !(await bookmarkLabels(t)).includes(itemTitle));
    await t.check("the view's bookmark stays", (await bookmarkLabels(t)).length === 1);
    if (t.phone) await t.page.keyboard.press("Escape");
    await t.check("the button offers Bookmark again", (await (await button("Bookmark")).getAttribute("aria-pressed")) === "false");
    if (t.phone) await t.page.keyboard.press("Escape");
  }, { viewport: vp });
}

test("a bookmark's label follows the item's title", async (t) => {
  await t.boot();
  const spec = profileSpec("typical", { items: 2 });
  spec.bookmarks = [{ kind: "item", collection: "books", item: "books/i0", label: "stale label" }];
  const ids = await t.seed(spec);
  const books = ids.collections.books;
  await t.open(t.itemPath(books, ids.items["books/i0"]));
  const itemTitle = await title(t);
  await t.until("opening the item refreshes the label", async () => (await bookmarkLabels(t)).join() === itemTitle, { timeout: 8000 });
});

for (const vp of ["desktop", "phone"]) {
  test(`Bookmarks page: list, open, sort, add, remove, per space @ ${vp}`, async (t) => {
    await t.boot();
    const spec = matrixSpec("typical", { items: 4 });
    spec.spaces = [{ key: "w", name: "Work" }];
    const ids = await t.seed(spec);
    const books = ids.collections.books;
    await t.open("/bookmarks");
    const rows = () => t.page.locator(".ws-pane--active tbody tr");
    await t.check("the two seeded bookmarks are listed", (await rows().count()) === 2, (await rows().allInnerTexts()).join("|"));
    const text = (await rows().allInnerTexts()).join("\n");
    if (!t.phone) await t.check("an item's bookmark names its collection, a view's says View of", text.includes("Book") && text.includes("View of Books"), text);
    await t.audit("bookmarks");

    // Sorting by name reverses with a second click.
    const names = async () => rows().locator("td:first-child").allInnerTexts();
    await t.page.getByRole("columnheader", { name: /Name/ }).click();
    const asc = await names();
    await t.page.getByRole("columnheader", { name: /Name/ }).click();
    const desc = await names();
    await t.check("the Name header sorts both ways", asc.length === 2 && asc[0] === desc[1] && asc[1] === desc[0] && asc[0] !== asc[1], `${asc} / ${desc}`);

    // The name opens it (in the tab).
    await rows().filter({ hasText: "First book" }).getByRole("link").click();
    await t.until("the link opens the item", async () => (await t.count(`${SHOWN} .item-title`)) > 0);
    await t.go("/bookmarks");

    // New bookmark: a collection, then one of its views or items that isn't bookmarked yet.
    await t.page.getByRole("button", { name: "New bookmark" }).filter({ visible: true }).first().click();
    await t.settle();
    const modal = t.page.locator(".cds--modal.is-visible");
    await t.check("Add is disabled until a target is chosen", await modal.getByRole("button", { name: "Add" }).isDisabled());
    await t.audit("new bookmark dialog");
    await modal.getByRole("combobox", { name: "Collection" }).or(modal.locator("#bookmark-item")).first().click();
    await t.page.getByRole("option", { name: /^Books$/ }).click();
    await t.settle();
    await modal.getByRole("combobox", { name: "View or item" }).click();
    const options = await t.page.getByRole("option").allInnerTexts();
    await t.check("it offers the other views and items, not the bookmarked ones", options.some((o) => o.startsWith("View: ")) && !options.includes("View: Cards") && !options.includes("First book") && options.length >= 4, options.join("|"));
    await t.page.getByRole("option", { name: "View: Grouped" }).click();
    await modal.getByRole("button", { name: "Add" }).click();
    await t.until("the new bookmark is stored and listed", async () => (await bookmarkLabels(t)).includes("Books / Grouped") && (await rows().count()) === 3);
    await t.check("the dialog closed", (await t.count(".cds--modal.is-visible")) === 0);

    // Remove one from the table.
    await t.page.getByRole("button", { name: "Remove bookmark Books / Grouped" }).click();
    await t.until("it is removed", async () => !(await bookmarkLabels(t)).includes("Books / Grouped") && (await rows().count()) === 2);

    // Another space has its own (empty) bookmarks.
    await switchSpace(t, /Work/);
    await t.go("/bookmarks");
    await t.until("Work has none", async () => (await t.page.getByText("No bookmarks yet.").count()) === 1 || (await rows().count()) === 0);
    await t.check("nothing is stored for Work", (await bookmarkLabels(t, ids.spaces.w)).length === 0);
    await t.audit("no bookmarks");
    await switchSpace(t, /^Space$/);
    await t.go("/bookmarks");
    await t.until("the default space's bookmarks are back", async () => (await rows().count()) === 2);
    // Remove both: the empty state.
    for (let left = 2; left > 0; left--) {
      await t.page.getByRole("button", { name: /^Remove bookmark / }).first().click();
      await t.until("one bookmark fewer", async () => (await bookmarkLabels(t)).length === left - 1);
    }
    await t.until("the empty state shows", async () => (await t.page.locator(`${SHOWN} .empty-state`).count()) === 1);
    await t.audit("all removed");
  }, { viewport: vp });
}

// ---- Help ------------------------------------------------------------------------------------

for (const vp of ["desktop", "phone"]) {
  test(`Help: every tab, deep link, stored with the tab @ ${vp}`, async (t) => {
    await t.boot();
    await t.seed(profileSpec("typical", { items: 2 }));
    await t.open("/help");
    const tabs = t.page.locator(".ws-pane--active .help-page .cds--tabs [role=tab]");
    await t.until("Help has Components and API tabs", async () => (await tabs.allInnerTexts()).join("|") === "Components|API");
    const selected = async () => (await t.page.locator(".ws-pane--active .help-page [role=tab][aria-selected=true]").innerText()).trim();
    const body = async () => (await t.page.locator(".ws-pane--active .help-page [role=tabpanel]:not([hidden])").innerText()).trim();
    await t.until("Components is first, with its text", async () => (await selected()) === "Components" && /\$item/.test(await body()));
    const components = await body();
    await t.audit("help: components");
    await tabs.nth(1).click();
    await t.until("the API tab shows the API text", async () => (await selected()) === "API" && (await body()) !== components && /api\/v1|\/api/i.test(await body()));
    await t.check("the tab's path carries the section", (await storedPanes(t))[0].paths[0] === "/help?section=api", JSON.stringify(await storedPanes(t)));
    await t.audit("help: API");
    // Back in the tab's history: the history entry was replaced, so Alt+Left leaves Help rather than flipping tabs.
    await tabs.nth(0).click();
    await t.until("Components again", async () => (await selected()) === "Components" && (await storedPanes(t))[0].paths[0] === "/help?section=components");

    // Deep links: ?section=api opens the API; an unknown section falls back to the first.
    await t.open("/help?section=api");
    await t.until("?section=api opens the API tab", async () => (await selected()) === "API");
    await t.open("/help?section=nothing");
    await t.until("an unknown section opens the first tab", async () => (await selected()) === "Components");
    // A link from another page (a plain in-app link) opens the section; a reload keeps it.
    await t.go("/help?section=api");
    await t.until("navigating to the deep link switches the tab", async () => (await selected()) === "API");
    await t.open("/help?section=api", { keepTabs: true });
    await t.until("a reload shows the tab that was stored", async () => (await selected()) === "API");
  }, { viewport: vp });
}

// ---- "/", pages that do not exist --------------------------------------------------------------

test("/ redirects to the collections; unknown pages and ids show Not found with a way back", async (t) => {
  await t.boot();
  const ids = await t.seed(profileSpec("typical", { items: 2 }));
  const books = ids.collections.books;
  const bad = "00000000-0000-4000-8000-00000000dead";
  await t.open("/");
  await t.check("/ lands on the collections overview", (await title(t)) === "Collections");
  await t.check("and the tab's stored path is /collections", (await storedPanes(t))[0].paths[0] === "/collections", JSON.stringify(await storedPanes(t)));

  const cases = [
    ["an unknown route", "/nowhere/at/all"],
    ["a collection that does not exist (list)", `/collections/${bad}/items`],
    ["a collection that does not exist (edit)", `/collections/${bad}/edit`],
    ["an item of a missing collection", `/collections/${bad}/items/${bad}`],
    ["an item that does not exist", `/collections/${books}/items/${bad}`],
    ["a component that does not exist", `/components/${bad}`],
    ["an item id that is not an id", `/collections/${books}/items/not-an-id`],
    ["a collection id that is not an id", "/collections/not-an-id/items"],
  ];
  for (const [label, path] of cases) {
    await t.open(path);
    await t.until(`${label}: Not found`, async () => (await title(t)) === "Not found" || (await title(t)));
    await t.check(`${label}: the page says so and offers the way back`, (await t.page.locator(".ws-pane--active").innerText()).includes("This page or item does not exist") && (await t.page.getByRole("link", { name: "Back to collections" }).count()) + (await t.page.getByRole("button", { name: "Back to collections" }).count()) > 0, await title(t));
    await t.audit(label);
  }
  // The way back opens the overview in the same tab, and the tab keeps its history.
  await t.page.getByText("Back to collections").first().click();
  await t.until("Back to collections opens the overview", async () => (await title(t)) === "Collections");
  await t.check("in the same tab", (await tabLabels(t)).length === 1);
  await t.page.keyboard.press("Alt+ArrowLeft");
  await t.until("Alt+Left returns to the missing page", async () => (await title(t)) === "Not found");
  // An item deleted while its page is open: the page turns into Not found.
  await t.go(t.itemPath(books, ids.items["books/i0"]));
  await t.until("the item opens", async () => (await t.count(`${SHOWN} .item-title`)) > 0);
  await t.page.evaluate(async (id) => window.kubus.repo.deleteItem(id), ids.items["books/i0"]);
  await t.until("deleting it elsewhere turns the page into Not found", async () => (await title(t)) === "Not found");
  await t.audit("the open item deleted");
}, { smoke: true });

test("Not found on a phone", async (t) => {
  await t.boot();
  await t.seed(profileSpec("typical", { items: 1 }));
  await t.open("/nowhere");
  await t.check("it says Not found", (await title(t)) === "Not found");
  await t.audit("not found on a phone");
}, { viewport: "phone" });
