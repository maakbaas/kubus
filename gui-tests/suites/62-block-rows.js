// Blocks side by side (views/BlockRows.tsx, domain/blockRows.ts) on a dashboard tab: as tall as each other on the desktop,
// a row's max height making a taller block scroll inside; on a phone stacked, each block its own height; Block settings'
// "Beside the block above" and the row's height, stored at once, the block moving once the panel closes.

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
          { id: "r-books", kind: "table", title: "Shelf", collection: "books", rowHeight: 10 },
          { id: "r-note", kind: "markdown", title: "Note", collection: "books", beside: true, options: { text: "Short." } },
          { id: "r-more", kind: "markdown", title: "More", collection: "books", options: { text: "Below." } },
          { id: "r-last", kind: "markdown", title: "Last", collection: "books", options: { text: "At the end." } },
        ],
      }],
    }],
  };
}

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

test("dashboard rows: Beside the block above and the row's height in Block settings, stored at once; the block moving once the panel closes @ desktop", async (t) => {
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
  await toolbarPanel(t).getByRole("combobox", { name: "Row height" }).selectOption("shortest");
  await t.until("the row's fit is stored on its first block (More)", async () => (await rStoredBlock(t, ids, "r-more"))?.rowFit === "shortest");
  const min = toolbarPanel(t).getByRole("spinbutton", { name: "Min height (rem)" });
  await min.fill("12");
  await min.press("Enter");
  await t.until("and its min height", async () => (await rStoredBlock(t, ids, "r-more"))?.rowHeight === 12);
  await t.escapeCloses("Escape closes Block settings");

  await blockSettings(t, "r-last");
  await t.popoverStep("untick it", () => box().click({ force: true }), { target: box(), scope: R_SHOWN });
  await t.until("stored: Last on a row of its own again, taking the row's settings with it", async () => {
    const b = await rStoredBlock(t, ids, "r-last");
    return b && !b.beside && b.rowHeight === 12 && b.rowFit === "shortest";
  });
  await t.escapeCloses("Escape closes Block settings");
  await t.until("closed: Last is below More again", async () => below(await rRect(t, "r-more"), await rRect(t, "r-last")));
  await blockSettings(t, "r-books");
  await t.check("the first block of the tab isn't offered it (nothing above it)", (await box().count()) === 0);
  await t.escapeCloses("Escape closes Block settings");
}, { viewport: "desktop" });
