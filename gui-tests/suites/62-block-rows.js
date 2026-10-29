// Blocks side by side (views/BlockRows.tsx, domain/blockRows.ts): a dashboard tab's blocks in rows, as tall as each other
// on the desktop, a row's max height making a taller block scroll inside; on a phone the same tab stacked as before rows,
// each block its own height, nothing scrolling inside; a dashboard row collapsing as one; Block settings' "Beside the block
// above" (stored at once, the block moving once the panel closes) and the row's max height; a block dragged onto another's
// side; the divider resizing with its arrow keys; a collection view and an item page with "Full width" off stacked, on in rows.

const R_SHOWN = ".ws-pane--active .ws-tab-slot:not([hidden])";
const MANY = 30;

function rowsSpec() {
  return {
    collections: [
      {
        key: "books", name: "Book", plural: "Books", icon: "Book",
        fields: [{ key: "title", name: "Title", kind: "string" }, { key: "pages", name: "Pages", kind: "number" }],
        items: Array.from({ length: MANY }, (_, i) => ({ key: `b${i}`, values: { title: `Book ${String(i + 1).padStart(2, "0")}`, pages: 100 + i } })),
        views: [
          { name: "All", blocks: [{ id: "v-table", kind: "table", title: "List" }, { id: "v-text", kind: "markdown", title: "About", beside: true, options: { text: "Books on the shelf." } }] },
          { name: "Narrow", fullWidth: false, blocks: [{ id: "n-table", kind: "table", title: "List" }, { id: "n-text", kind: "markdown", title: "About", beside: true, options: { text: "Books on the shelf." } }] },
        ],
        itemViews: [{ name: "Wide", fullWidth: true, layout: { fields: ["title", "pages", "i-one", "i-two"], blocks: [
          { id: "i-one", kind: "markdown", title: "One", options: { text: "First." } },
          { id: "i-two", kind: "markdown", title: "Two", beside: true, options: { text: "Second." } },
        ] } }],
      },
    ],
    dashboards: [{
      key: "home", name: "Home", icon: "Dashboard",
      tabs: [{
        name: "Main",
        blocks: [
          // A row of two: a long table (capped at 10rem) beside a short text.
          { id: "r-books", kind: "table", title: "Shelf", collection: "books", rowMaxHeight: 10 },
          { id: "r-note", kind: "markdown", title: "Note", collection: "books", beside: true, options: { text: "Short." } },
          { id: "r-more", kind: "markdown", title: "More", collection: "books", options: { text: "Below." } },
          { id: "r-last", kind: "markdown", title: "Last", collection: "books", options: { text: "At the end." } },
        ],
      }],
    }],
  };
}

// --- helpers ----------------------------------------------------------------------------------

const rBlock = (t, id) => t.page.locator(`${R_SHOWN} .block[data-block-id="${id}"]`);
const rRect = (t, id) => rBlock(t, id).boundingBox();
const rCell = (t, id) => t.page.locator(`${R_SHOWN} .block-cell:has(> .block[data-block-id="${id}"])`).boundingBox();
const rBody = (t, id) => t.page.evaluate(([shown, id]) => {
  const body = document.querySelector(`${shown} .block[data-block-id="${id}"] > .block__body`);
  return body && { height: body.clientHeight, scroll: body.scrollHeight, overflow: getComputedStyle(body).overflowY };
}, [R_SHOWN, id]);
const rTab = (t, ids) => t.page.evaluate(async ([d]) => (await window.kubus.repo.listDashboardViews(d, "default"))[0], [ids.dashboards.home]);
const rStoredBlock = async (t, ids, id) => (await rTab(t, ids)).blocks.find((b) => b.id === id);
const sideBySide = (a, b) => !!a && !!b && Math.abs(a.y - b.y) <= 1 && b.x >= a.x + a.width;
const below = (a, b) => !!a && !!b && b.y >= a.y + a.height;
const REM = 16;

/** Opens a block's Block settings (its gear). */
async function blockSettings(t, id) {
  await t.openPanel(rBlock(t, id).locator(":scope > .section-header"), "Block settings");
}

// --- a dashboard on the desktop ------------------------------------------------------------------

test("dashboard rows: side by side and as tall as each other, the long table capped at the row's max height and scrolling inside @ desktop", async (t) => {
  await t.boot();
  const ids = await t.seed(rowsSpec());
  await t.open(`/dashboards/${ids.dashboards.home}`);
  await t.until("the blocks are in", async () => (await rBlock(t, "r-books").count()) === 1 && (await rBlock(t, "r-note").count()) === 1);
  const books = await rRect(t, "r-books");
  const note = await rRect(t, "r-note");
  await t.check("Shelf and Note stand side by side", sideBySide(books, note), JSON.stringify({ books, note }));
  const [c1, c2] = [await rCell(t, "r-books"), await rCell(t, "r-note")];
  await t.check("their cells are as tall as each other (the tallest's height)", Math.abs(c1.height - c2.height) <= 1, `${c1.height} / ${c2.height}`);
  await t.check("the two share the row equally", Math.abs(c1.width - c2.width) <= 2, `${c1.width} / ${c2.width}`);
  const body = await rBody(t, "r-books");
  await t.check("the table below its name is at most the row's max height (10rem), scrolling inside", body && Math.abs(body.height - 10 * REM) <= 1 && body.scroll > body.height && body.overflow === "auto", JSON.stringify(body));
  await t.check("More and Last are rows of their own below", below(c1, await rRect(t, "r-more")) && below(await rRect(t, "r-more"), await rRect(t, "r-last")));
  await t.check("a vertical line between the two (the divider) spans the row", await t.page.evaluate((shown) => {
    const d = document.querySelector(`${shown} .block-row__divider`);
    const row = d && d.parentElement.getBoundingClientRect();
    return !!d && Math.abs(d.getBoundingClientRect().height - row.height) <= 1 && d.getAttribute("role") === "separator";
  }, R_SHOWN));
  await t.audit("dashboard with a row of two", { shotOnFail: true });
}, { viewport: "desktop", smoke: true });

test("dashboard rows on a phone: stacked as before rows, each block its own height, nothing scrolling inside @ phone", async (t) => {
  await t.boot();
  const ids = await t.seed(rowsSpec());
  await t.open(`/dashboards/${ids.dashboards.home}`);
  await t.until("the blocks are in", async () => (await rBlock(t, "r-note").count()) === 1);
  await t.check("Note is below Shelf, not beside it", below(await rRect(t, "r-books"), await rRect(t, "r-note")));
  const body = await rBody(t, "r-books");
  await t.check("the table shows all its rows: the row's max height doesn't apply", body && body.scroll <= body.height + 1 && body.overflow === "visible", JSON.stringify(body));
  await t.check("the blocks take the page's whole width", await t.page.evaluate((shown) => {
    const cells = [...document.querySelectorAll(`${shown} .block-cell`)].map((c) => c.getBoundingClientRect().width);
    return cells.every((w) => Math.abs(w - cells[0]) <= 1);
  }, R_SHOWN));
  await t.audit("dashboard rows stacked on a phone", { shotOnFail: true });
}, { viewport: "phone" });

test("dashboard rows: a row collapses as one, stored on its first block @ desktop", async (t) => {
  await t.boot();
  const ids = await t.seed(rowsSpec());
  await t.open(`/dashboards/${ids.dashboards.home}`);
  await t.until("the blocks are in", async () => (await rBlock(t, "r-note").count()) === 1);
  await rBlock(t, "r-note").locator(".collapse-caret button").click();
  await t.until("both blocks of the row collapse (Note's caret)", async () => (await rBlock(t, "r-books").locator("table").count()) === 0 && (await t.page.locator(`${R_SHOWN} .block[data-block-id="r-note"] .block__body`).innerText()).trim() === "");
  await t.check("the row is stored collapsed under its first block", (await rTab(t, ids)).collapsed.blocks.includes("r-books"));
  await t.check("the next row is left alone", (await rBlock(t, "r-more").innerText()).includes("Below."));
  await rBlock(t, "r-books").locator(".collapse-caret button").click();
  await t.until("Shelf's caret expands the row again", async () => (await rBlock(t, "r-books").locator("table").count()) === 1 && (await rBlock(t, "r-note").innerText()).includes("Short."));
}, { viewport: "desktop" });

test("dashboard rows: Beside the block above and the row's max height in Block settings, stored at once; the block moving once the panel closes @ desktop", async (t) => {
  await t.boot();
  const ids = await t.seed(rowsSpec());
  await t.open(`/dashboards/${ids.dashboards.home}`);
  await t.until("the blocks are in", async () => (await rBlock(t, "r-last").count()) === 1);
  await blockSettings(t, "r-last");
  const box = () => toolbarPanel(t).getByRole("checkbox", { name: "Beside the block above" });
  await t.check("Block settings offers it, unticked", (await box().count()) === 1 && !(await box().isChecked()));
  await t.popoverStep("tick Beside the block above", () => box().click({ force: true }), { target: box(), scope: R_SHOWN });
  await t.until("stored: Last beside More", async () => (await rStoredBlock(t, ids, "r-last"))?.beside === true);
  await t.check("while the panel is open Last stays where it was", below(await rRect(t, "r-more"), await rRect(t, "r-last")));
  await t.escapeCloses("Escape closes Block settings");
  await t.until("closed: Last stands beside More", async () => sideBySide(await rRect(t, "r-more"), await rRect(t, "r-last")));

  await blockSettings(t, "r-last");
  const max = toolbarPanel(t).getByRole("spinbutton", { name: "Row's max height (rem)" });
  await max.fill("12");
  await max.press("Enter");
  await t.until("the row's max height is stored on its first block (More)", async () => (await rStoredBlock(t, ids, "r-more"))?.rowMaxHeight === 12);
  await t.escapeCloses("Escape closes Block settings");

  await blockSettings(t, "r-last");
  await t.popoverStep("untick it", () => box().click({ force: true }), { target: box(), scope: R_SHOWN });
  await t.until("stored: Last on a row of its own again, taking the row's max height with it", async () => {
    const b = await rStoredBlock(t, ids, "r-last");
    return b && !b.beside && b.rowMaxHeight === 12;
  });
  await t.escapeCloses("Escape closes Block settings");
  await t.until("Last is below More again", async () => below(await rRect(t, "r-more"), await rRect(t, "r-last")));
  await blockSettings(t, "r-books");
  await t.check("the first block of the tab isn't offered it (nothing above it)", (await box().count()) === 0);
  await t.escapeCloses("Escape closes Block settings");
}, { viewport: "desktop" });

test("dashboard rows: a block dragged by its name onto another's right side joins its row; the divider resizes with its arrow keys @ desktop", async (t) => {
  await t.boot();
  const ids = await t.seed(rowsSpec());
  await t.open(`/dashboards/${ids.dashboards.home}`);
  await t.until("the blocks are in", async () => (await rBlock(t, "r-last").count()) === 1);
  const more = await rRect(t, "r-more");
  await rBlock(t, "r-last").locator(".section-header__title").dragTo(rBlock(t, "r-more"), { targetPosition: { x: more.width - 10, y: more.height / 2 } });
  await t.until("stored: Last right after More, beside it", async () => {
    const tab = await rTab(t, ids);
    const order = tab.blocks.map((b) => b.id);
    return order.indexOf("r-last") === order.indexOf("r-more") + 1 && tab.blocks.find((b) => b.id === "r-last").beside === true;
  });
  await t.until("shown side by side", async () => sideBySide(await rRect(t, "r-more"), await rRect(t, "r-last")));

  const divider = t.page.locator(`${R_SHOWN} .block-row:has(.block[data-block-id="r-more"]) .block-row__divider`);
  await divider.focus();
  await divider.press("ArrowRight");
  await t.until("stored: More 55%, Last 45%", async () => {
    const tab = await rTab(t, ids);
    return tab.blocks.find((b) => b.id === "r-more").width === 55 && tab.blocks.find((b) => b.id === "r-last").width === 45;
  });
  await t.until("shown wider and narrower", async () => (await rCell(t, "r-more")).width > (await rCell(t, "r-last")).width + 20);

  // Dragged onto Shelf's top half: a row of its own above.
  await rBlock(t, "r-last").locator(".section-header__title").dragTo(rBlock(t, "r-books"), { targetPosition: { x: 40, y: 10 } });
  await t.until("stored: Last first, alone, More without a width again", async () => {
    const tab = await rTab(t, ids);
    const last = tab.blocks.find((b) => b.id === "r-last");
    return tab.blocks[0].id === "r-last" && !last.beside && last.width === undefined && tab.blocks.find((b) => b.id === "r-more").width === undefined;
  });
  await t.audit("dashboard after dragging", { shotOnFail: true });
}, { viewport: "desktop" });

// --- a collection view, an item page -----------------------------------------------------------------

test("rows follow Full width: a collection view's blocks beside each other only with it on; an item page's likewise @ desktop", async (t) => {
  await t.boot();
  const ids = await t.seed(rowsSpec());
  await t.open(`${t.listPath(ids.collections.books)}?view=${ids.views["books/All"]}`);
  await t.until("All's blocks are in", async () => (await rBlock(t, "v-text").count()) === 1);
  await t.check("All (full width): About beside List", sideBySide(await rRect(t, "v-table"), await rRect(t, "v-text")));
  await t.audit("collection view with a row", { shotOnFail: true });
  await t.open(`${t.listPath(ids.collections.books)}?view=${ids.views["books/Narrow"]}`);
  await t.until("Narrow's blocks are in", async () => (await rBlock(t, "n-text").count()) === 1);
  await t.check("Narrow (full width off): About below List", below(await rRect(t, "n-table"), await rRect(t, "n-text")));
  await t.audit("narrow collection view, stacked", { shotOnFail: true });

  await t.open(t.itemPath(ids.collections.books, ids.items["books/b0"]));
  await t.until("the item page's blocks are in", async () => (await rBlock(t, "i-two").count()) === 1);
  await t.check("the Wide item view: Two beside One", sideBySide(await rRect(t, "i-one"), await rRect(t, "i-two")));
  await t.audit("item page with a row", { shotOnFail: true });
}, { viewport: "desktop" });
