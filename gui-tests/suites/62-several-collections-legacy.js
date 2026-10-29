// Several collections in one block are for dashboards (views/BlockView.tsx BlockMenus): a block of a collection view
// lists the view's collection (no picker), an item page's block one collection (a single Collection dropdown, Backlinks
// included). A block of several made before in a collection view or on an item page (seeded here: a "legacy" block)
// keeps showing all their rows; its Collections picker lists only its own collections, with the helper text, and can only
// remove them (a collection view's own can't be). Block settings → Move to a dashboard (views/MoveToDashboardModal.tsx)
// takes a block to a dashboard's starred (else first) tab, with the filter it built on made part of its own, or to a new
// dashboard; the view's last block is copied; rules on the page's item ($item) are warned about. Every step is followed by
// what the page shows and, where it is stored, what window.kubus.repo holds.

const L_SHOWN = ".ws-pane--active .ws-tab-slot:not([hidden])";
const L_HELP = "Several collections in one block are for dashboards. Here they can only be removed.";
const L_BOOKS = ["Dune", "Emma"];
const L_PEOPLE = ["Ada", "Bob"];
const L_NOTES = ["Groceries", "Ideas"];

function legacySpec({ viewBlocks, pageBlocks, dashboards } = {}) {
  return {
    collections: [
      {
        key: "book", name: "Book", plural: "Books", icon: "Book",
        fields: [{ key: "title", name: "Title", kind: "string" }, { key: "author", name: "Author", kind: "item", target: "person" }],
        items: L_BOOKS.map((title) => ({ key: title.toLowerCase(), values: { title, author: { ref: "person/ada" } } })),
        views: [{
          name: "All",
          blocks: viewBlocks || [
            // Made before blocks of several were for dashboards: Books and People read as one.
            { id: "legacy", kind: "table", title: "Mixed", collections: ["book", "person"] },
            { id: "plain", kind: "table", title: "Plain" },
          ],
        }],
      },
      {
        key: "person", name: "Person", plural: "People", icon: "User",
        fields: [{ key: "name", name: "Name", kind: "string" }],
        items: L_PEOPLE.map((name) => ({ key: name.toLowerCase(), values: { name } })),
        itemViews: [{
          name: "Page",
          layout: {
            fields: ["name", "page-legacy", "page-notes"],
            blocks: pageBlocks || [
              { id: "page-legacy", kind: "table", title: "Reading", collection: "book", collections: ["book", "note"] },
              { id: "page-notes", kind: "table", title: "Notes", collection: "note" },
            ],
          },
        }],
      },
      {
        key: "note", name: "Note", plural: "Notes", icon: "Notebook",
        fields: [{ key: "text", name: "Text", kind: "string" }],
        items: L_NOTES.map((text) => ({ values: { text } })),
      },
    ],
    dashboards: dashboards ?? [{ key: "home", name: "Home", tabs: [{ name: "Start", blocks: [{ id: "d-notes", kind: "table", title: "On the dashboard", collection: "note" }] }, { name: "Later", isDefault: true, blocks: [] }] }],
  };
}

// --- helpers ----------------------------------------------------------------------------------

const lBlock = (t, name) => t.page.locator(`${L_SHOWN} .block`).filter({ has: t.page.locator(".section-header", { hasText: name }) }).first();
const lHeader = (t, name) => lBlock(t, name).locator(".section-header").first();
/** The first cells of a block's table rows (its titles), as shown. */
const lRows = (t, name) => lBlock(t, name).evaluate((b) => [...b.querySelectorAll("tbody tr")].filter((r) => r.checkVisibility()).map((r) => (r.querySelector("td")?.innerText || "").trim()).filter(Boolean)).catch(() => null);
const lSame = (a, b) => !!a && JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
async function lExpectRows(t, label, name, expected) {
  let last = null;
  return t.until(`${label}: ${name} shows ${expected.join(", ") || "nothing"}`, async () => {
    last = await lRows(t, name);
    return lSame(last, expected) || `shows ${JSON.stringify(last)}`;
  }, { timeout: 8000 });
}
const lViewBlocks = (t, ids) => t.page.evaluate(async (c) => (await window.kubus.repo.listViews(c, "default"))[0].blocks, ids.collections.book);
const lPageBlocks = (t, ids) => t.page.evaluate(async (c) => (await window.kubus.repo.listCollections()).find((x) => x.id === c).itemViews[0].layout.blocks, ids.collections.person);
const lTabs = (t, dashboardId) => t.page.evaluate(async (d) => (await window.kubus.repo.listAllDashboardViews()).filter((v) => v.dashboardId === d && v.spaceId === "default").sort((a, b) => a.position - b.position), dashboardId);
const adaPage = (t, ids) => t.itemPath(ids.collections.person, ids.items["person/ada"]);
/** Opens the Collections multi-select of the open Block settings and returns what it lists (and which are disabled). */
async function lPickerOptions(t) {
  await collectionsPicker(shownPopover(t)).locator(".cds--list-box__field").first().click();
  await t.settle(80);
  return t.page.evaluate(() => [...document.querySelectorAll("[role=option]")].filter((o) => o.checkVisibility()).map((o) => ({ name: o.innerText.trim(), disabled: o.getAttribute("aria-disabled") === "true" || o.classList.contains("cds--list-box__menu-item--disabled") })));
}
const lOption = (t, name) => t.page.getByRole("option", { name, exact: true }).filter({ visible: true }).first();

// --- tests ------------------------------------------------------------------------------------

test("several collections, legacy: a collection view's block of two still shows both; its picker lists only them and only removes", async (t) => {
  await t.boot();
  const ids = await t.seed(legacySpec());
  await t.open(t.listPath(ids.collections.book));
  await lExpectRows(t, "the legacy block", "Mixed", [...L_BOOKS, ...L_PEOPLE]);
  await lExpectRows(t, "the plain block beside it", "Plain", L_BOOKS);

  // A plain block of a collection view has no collection picker at all.
  await t.openPanel(lHeader(t, "Plain"), "Block settings");
  await t.check("a plain block: no Collections picker and no Collection dropdown", (await collectionsPicker(shownPopover(t)).count()) === 0 && (await collectionDropdown(t, shownPopover(t)).count()) === 0);
  await t.check("it offers Move to a dashboard", (await shownPopover(t).getByRole("button", { name: "Move to a dashboard" }).count()) === 1);
  await t.closeAll();

  await t.openPanel(lHeader(t, "Mixed"), "Block settings");
  await t.check("the legacy block's picker says why it only removes", (await shownPopover(t).innerText()).includes(L_HELP), await shownPopover(t).innerText());
  const options = await lPickerOptions(t);
  await t.check("it lists only its own two collections", lSame(options.map((o) => o.name), ["Books", "People"]), JSON.stringify(options));
  await t.check("the view's own collection can't be taken out", options.find((o) => o.name === "Books")?.disabled === true && options.find((o) => o.name === "People")?.disabled === false, JSON.stringify(options));
  await t.audit("a legacy block's Collections picker", { shotOnFail: true });
  // Clicking the view's own does nothing.
  await lOption(t, "Books").click({ force: true }).catch(() => {});
  await t.settle(200);
  await t.check("Books stays", JSON.stringify((await lViewBlocks(t, ids)).find((b) => b.id === "legacy")?.collectionIds) === JSON.stringify([ids.collections.book, ids.collections.person]));
  await lOption(t, "People").click();
  await t.settle(300);
  await lExpectRows(t, "People taken out", "Mixed", L_BOOKS);
  const block = (await lViewBlocks(t, ids)).find((b) => b.title === "Mixed" || b.id === "legacy") ?? (await lViewBlocks(t, ids))[0];
  await t.check("stored as a plain block of the view's collection", block.collectionIds === undefined && block.collectionId === null, JSON.stringify(block));
  await t.closeAll();
  await t.openPanel(lHeader(t, "Mixed"), "Block settings");
  await t.check("now a plain block: no picker", (await collectionsPicker(shownPopover(t)).count()) === 0 && !(await shownPopover(t).innerText()).includes(L_HELP));
  await t.closeAll();
}, { smoke: true });

test("several collections, legacy: an item page's block of two still shows both; either can be removed", async (t) => {
  await t.boot();
  const ids = await t.seed(legacySpec());
  await t.open(adaPage(t, ids));
  await lExpectRows(t, "the legacy block", "Reading", [...L_BOOKS, ...L_NOTES]);
  await t.openPanel(lHeader(t, "Reading"), "Block settings");
  await t.check("the helper text", (await shownPopover(t).innerText()).includes(L_HELP));
  const options = await lPickerOptions(t);
  await t.check("it lists only Books and Notes, none disabled (an item page has no collection of its own here)", lSame(options.map((o) => o.name), ["Books", "Notes"]) && options.every((o) => !o.disabled), JSON.stringify(options));
  await lOption(t, "Books").click();
  await t.settle(300);
  await lExpectRows(t, "Books taken out: Notes alone", "Reading", L_NOTES);
  const block = (await lPageBlocks(t, ids)).find((b) => b.id === "page-legacy") ?? (await lPageBlocks(t, ids))[0];
  await t.check("stored as a block of Notes", block.collectionId === ids.collections.note && block.collectionIds === undefined, JSON.stringify(block));
  await t.closeAll();
  // One collection now: the single Collection dropdown.
  await t.openPanel(lHeader(t, "Reading"), "Block settings");
  await t.check("one collection: the Collection dropdown, no multi-select", (await collectionDropdown(t, shownPopover(t)).count()) === 1 && (await collectionsPicker(shownPopover(t)).count()) === 0);
  await t.closeAll();
});

test("several collections: an item page's block picks one Collection, Backlinks included", async (t) => {
  await t.boot();
  const ids = await t.seed(legacySpec());
  await t.open(adaPage(t, ids));
  await lExpectRows(t, "the Notes block", "Notes", L_NOTES);
  await t.openPanel(lHeader(t, "Notes"), "Block settings");
  const dropdown = collectionDropdown(t, shownPopover(t));
  await t.check("a single Collection dropdown showing Notes", (await dropdown.count()) === 1 && (await dropdown.innerText()).includes("Notes"), await dropdown.innerText().catch(() => ""));
  await dropdown.locator(".cds--list-box__field").first().click();
  await t.settle(80);
  const offered = await menuOptions(t);
  await t.check("it offers every collection and Backlinks", ["Books", "People", "Notes", "Backlinks"].every((o) => offered.includes(o)), JSON.stringify(offered));
  await t.audit("an item page block's Collection dropdown", { shotOnFail: true });
  await lOption(t, "Books").click();
  await t.settle(300);
  // Books refer to People: the new block lists the books by this person (both, by Ada).
  await t.until("stored: a block of Books, linked to the page's item", async () => {
    const b = (await lPageBlocks(t, ids)).find((x) => x.collectionId === ids.collections.book && !x.collectionIds);
    return (!!b && (b.filters || []).length === 1) || JSON.stringify(await lPageBlocks(t, ids));
  });
  await t.closeAll();
  await t.openPanel(lHeader(t, "Notes"), "Block settings");
  await pickOption(t, shownPopover(t), "Collection", "Backlinks");
  await t.settle(300);
  await t.until("stored: the Backlinks collection", async () => (await lPageBlocks(t, ids)).some((b) => b.collectionId === "$backlinks") || JSON.stringify((await lPageBlocks(t, ids)).map((b) => b.collectionId)));
  await t.closeAll();
  await t.openPanel(lHeader(t, "Notes"), "Block settings");
  await t.check("a Backlinks block isn't offered Move to a dashboard", (await shownPopover(t).getByRole("button", { name: "Move to a dashboard" }).count()) === 0);
  await t.closeAll();
});

test("several collections: Move to a dashboard takes a legacy block to the starred tab, with the view's filter as its own", async (t) => {
  await t.boot();
  const ids = await t.seed(legacySpec());
  // The view's filter: titles containing "u" (Dune; on the merged block, the Title column only Books have).
  await t.page.evaluate(async ([c, f]) => {
    const repo = window.kubus.repo;
    const [view] = await repo.listViews(c, "default");
    await repo.saveView({ ...view, filters: [{ id: "vf", fieldId: f, operator: "contains", value: "u" }] });
  }, [ids.collections.book, ids.fields["book.title"]]);
  await t.open(t.listPath(ids.collections.book));
  await lExpectRows(t, "the view's filter", "Mixed", ["Dune"]);
  await t.openPanel(lHeader(t, "Mixed"), "Block settings");
  await shownPopover(t).getByRole("button", { name: "Move to a dashboard" }).click();
  await t.settle(200);
  await t.until("the dialog opens", async () => (await shownModal(t).count()) === 1);
  const text = await shownModal(t).innerText();
  await t.check("it says where the block goes, with the view's filter", /starred tab/.test(text) && /the view's filter made part of its own/.test(text), text);
  await t.check("Move, not Copy (the view has another block)", (await shownModal(t).getByRole("button", { name: "Move", exact: true }).count()) === 1);
  await t.check("the Dashboard dropdown starts on Home and offers New dashboard", (await dropdownOf(t, shownModal(t), "Dashboard").innerText()).includes("Home"));
  await dropdownOf(t, shownModal(t), "Dashboard").locator(".cds--list-box__field").first().click();
  await t.settle(80);
  await t.check("the space's dashboards and New dashboard", JSON.stringify(await menuOptions(t)) === JSON.stringify(["Home", "New dashboard"]), JSON.stringify(await menuOptions(t)));
  await lOption(t, "Home").click();
  await t.audit("the Move to a dashboard dialog", { shotOnFail: true });
  await shownModal(t).getByRole("button", { name: "Move", exact: true }).click();
  await t.until("the dashboard opens", async () => (await t.page.locator(`${L_SHOWN} .page-header__title`).first().innerText().catch(() => "")).includes("Home"), { timeout: 10000 });
  await lExpectRows(t, "on the dashboard, as before", "Mixed", ["Dune"]);
  const tabs = await lTabs(t, ids.dashboards.home);
  const later = tabs.find((v) => v.name === "Later");
  const moved = later.blocks[later.blocks.length - 1];
  await t.check("on the starred tab, last", later.isDefault && moved?.title === "Mixed" && tabs.find((v) => v.name === "Start").blocks.length === 1, JSON.stringify(tabs.map((v) => [v.name, v.blocks.length])));
  await t.check("naming its first collection, both kept", moved.collectionId === ids.collections.book && JSON.stringify(moved.collectionIds) === JSON.stringify([ids.collections.book, ids.collections.person]), JSON.stringify(moved));
  await t.check("the view's filter is its first rule", (moved.filters || []).length === 1 && moved.filters[0].value === "u" && moved.filters[0].id !== "vf", JSON.stringify(moved.filters));
  const left = await lViewBlocks(t, ids);
  await t.check("taken out of the view", left.length === 1 && left[0].id === "plain", JSON.stringify(left.map((b) => b.id)));
});

test("several collections: Move to a dashboard copies the view's last block, to a new dashboard", async (t) => {
  await t.boot();
  const ids = await t.seed(legacySpec({ viewBlocks: [{ id: "only", kind: "table", title: "Only", collections: ["book", "person"] }], dashboards: [] }));
  await t.open(t.listPath(ids.collections.book));
  await lExpectRows(t, "the legacy block", "Only", [...L_BOOKS, ...L_PEOPLE]);
  await t.openPanel(lHeader(t, "Only"), "Block settings");
  await shownPopover(t).getByRole("button", { name: "Move to a dashboard" }).click();
  await t.settle(200);
  await t.until("the dialog opens", async () => (await shownModal(t).count()) === 1);
  await t.check("the last block is copied", /last block here, so it is copied/.test(await shownModal(t).innerText()) && (await shownModal(t).getByRole("button", { name: "Copy", exact: true }).count()) === 1);
  await t.check("no dashboard yet: New dashboard", (await dropdownOf(t, shownModal(t), "Dashboard").innerText()).includes("New dashboard"));
  await shownModal(t).getByRole("button", { name: "Copy", exact: true }).click();
  await t.until("the new dashboard opens", async () => (await t.page.locator(`${L_SHOWN} .page-header__title`).first().innerText().catch(() => "")).includes("Dashboard"), { timeout: 10000 });
  await lExpectRows(t, "the copy on it", "Only", [...L_BOOKS, ...L_PEOPLE]);
  const made = await t.page.evaluate(() => window.kubus.repo.listDashboards());
  await t.check("a dashboard named Dashboard, in this space only", made.length === 1 && made[0].name === "Dashboard" && JSON.stringify(made[0].spaceIds) === JSON.stringify(["default"]), JSON.stringify(made));
  const tabs = await lTabs(t, made[0].id);
  await t.check("its first tab holds the block", tabs.length === 1 && tabs[0].blocks.length === 1 && tabs[0].blocks[0].title === "Only", JSON.stringify(tabs));
  await t.check("the view keeps its block", (await lViewBlocks(t, ids)).map((b) => b.id).join() === "only");
  await t.audit("a dashboard made by Move to a dashboard");
});

test("several collections: moving an item page's block warns about its rules on the page's item", async (t) => {
  await t.boot();
  const ids = await t.seed(legacySpec({
    pageBlocks: [
      // Books by this person: Author is this item.
      { id: "by", kind: "table", title: "By this person", collection: "book", filters: [{ field: "book.author", operator: "is", value: "$item" }] },
      { id: "page-notes", kind: "table", title: "Notes", collection: "note" },
    ],
  }));
  await t.open(adaPage(t, ids));
  await lExpectRows(t, "Ada's books", "By this person", L_BOOKS);
  await t.openPanel(lHeader(t, "By this person"), "Block settings");
  await shownPopover(t).getByRole("button", { name: "Move to a dashboard" }).click();
  await t.settle(200);
  await t.until("the dialog opens", async () => (await shownModal(t).count()) === 1);
  await t.check("it warns that rules on this item don't filter there", (await shownModal(t).innerText()).includes("Rules on this item"), await shownModal(t).innerText());
  await t.audit("Move to a dashboard with a warning", { shotOnFail: true });
  await shownModal(t).getByRole("button", { name: "Move", exact: true }).click();
  await t.until("the dashboard opens", async () => (await t.page.locator(`${L_SHOWN} .page-header__title`).first().innerText().catch(() => "")).includes("Home"), { timeout: 10000 });
  // "Author is this item" without a page's item is a rule without a value: it doesn't filter.
  await t.check("stored with its rule", JSON.stringify(((await lTabs(t, ids.dashboards.home)).find((v) => v.isDefault)?.blocks.at(-1)?.filters || []).map((r) => r.value)) === JSON.stringify(["$item"]));
  await lExpectRows(t, "no page's item on a dashboard: every book", "By this person", L_BOOKS);
  await t.open(adaPage(t, ids));
  await t.until("taken out of the page", async () => (await lPageBlocks(t, ids)).map((b) => b.id).join() === "page-notes" || JSON.stringify((await lPageBlocks(t, ids)).map((b) => b.id)));
});

for (const [label, opts] of [["phone", { viewport: "phone" }], ["dark theme", { dark: true }]]) {
  test(`several collections: a legacy block and the Move dialog, audited @ ${label}`, async (t) => {
    await t.boot();
    const ids = await t.seed(legacySpec());
    await t.open(t.listPath(ids.collections.book));
    await lExpectRows(t, "the legacy block", "Mixed", [...L_BOOKS, ...L_PEOPLE]);
    await t.audit(`a legacy block, ${label}`);
    await t.openPanel(lHeader(t, "Mixed"), "Block settings");
    await t.audit(`a legacy block's settings, ${label}`);
    await shownPopover(t).getByRole("button", { name: "Move to a dashboard" }).click();
    await t.settle(200);
    await t.until("the dialog opens", async () => (await shownModal(t).count()) === 1);
    await t.audit(`the Move to a dashboard dialog, ${label}`);
    await t.closeAll();
  }, opts);
}
