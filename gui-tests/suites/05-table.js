// Table blocks: in-place cell editing (columns never resize), the add row, header sorting, row
// hover and actions, grouping, many columns, many rows, narrow panes.

/** Clicks a tool by its label, through the "More actions" menu when it is folded into one. */
async function openTool(t, scope, label) {
  const direct = scope.getByRole("button", { name: label, exact: true }).filter({ visible: true }).first();
  if (await direct.count()) {
    await direct.click();
  } else {
    await scope.getByRole("button", { name: "More actions" }).filter({ visible: true }).first().click();
    await t.settle(100);
    await t.page.getByRole("button", { name: label, exact: true }).filter({ visible: true }).last().click();
  }
  await t.settle(150);
}

/** A profile whose "All" view is a table of a few columns (all 15 make it scroll sideways on most screens). */
function narrowTableSpec(style, opts) {
  const spec = profileSpec(style, opts);
  spec.collections[0].views = [{ name: "All", blocks: [{ kind: "table", layout: { fields: ["title", "count", "date", "done", "fav", "ref", "tags"] } }] }];
  return spec;
}

/** Escape, twice when the first one only closed the date picker's calendar or a menu. */
async function escapeEditor(t) {
  await t.page.keyboard.press("Escape");
  await t.wait(150);
  if (await t.page.locator(".cell--editing").count()) {
    await t.page.keyboard.press("Escape");
    await t.wait(150);
  }
}

/** Column widths unchanged, but for sub-pixel rounding (1px). */
const sameWidths = (a, b) => a.length === b.length && a.every((w, i) => Math.abs(w - b[i]) <= 1);

async function headerWidths(t, scope = ".items-table") {
  return t.page.evaluate((scope) => [...document.querySelectorAll(`${scope} thead th`)].map((th) => Math.round(th.getBoundingClientRect().width * 10) / 10), scope);
}

for (const [style, vp] of [["typical", "desktop"], ["long", "desktop"], ["typical", "laptop"], ["long", "phone"], ["unicode", "wide"]]) {
  test(`table: edit cells in place, columns keep their width: ${style} @ ${vp}`, async (t) => {
    await t.boot();
    // Phones get every column (the table scrolls sideways); wider windows a few.
    const ids = await t.seed(vp === "phone" ? profileSpec(style, { items: 8 }) : narrowTableSpec(style, { items: 8 }));
    await t.open(t.listPath(ids.collections.books));
    await t.audit("table");
    const cells = t.page.locator(".items-table .cell-editable[aria-label^='Edit ']");
    const n = Math.min(await cells.count(), 6);
    await t.check("table has editable cells", n > 0, "no cell-editable elements");
    for (let i = 0; i < n; i++) {
      const cell = cells.nth(i);
      const name = (await cell.getAttribute("aria-label")) || `cell ${i}`;
      // Wholly in view (a table wider than a phone scrolls sideways): else focusing its editor
      // scrolls the rest of it in, which is the browser's doing, not a jump.
      await cell.evaluate((el) => el.scrollIntoView({ block: "center", inline: "center" }));
      await t.wait(100);
      const before = await headerWidths(t);
      await t.noShift(`${name}: opening the cell editor moves nothing`, async () => {
        await cell.click({ position: { x: 3, y: 3 } });
        await t.wait(250);
      }, { scope: ".ws-pane--active .ws-pane__body", except: [".cell--editing", ".cell-overlay", ".cell-inline-editor"] });
      const during = await headerWidths(t);
      await t.check(`${name}: columns keep their width while editing`, sameWidths(before, during), `${before.join(",")} → ${during.join(",")}`);
      await t.audit(`${name}: editing`, { shotOnFail: true });
      await escapeEditor(t);
      await t.settle(150);
      if (await t.page.locator(".cell--editing").count()) await t.fail(`${name}: Escape closes the cell editor`, "still editing");
      const after = await headerWidths(t);
      await t.check(`${name}: columns are back after Escape`, sameWidths(before, after), `${before.join(",")} → ${after.join(",")}`);
    }
    // Type into a number cell and save with Enter.
    const count = t.page.locator(".items-table .cell-editable[aria-label='Edit Count']").first();
    if (await count.count()) {
      await count.click();
      await t.wait(200);
      await t.page.keyboard.press("Control+A");
      await t.page.keyboard.type("987654");
      await t.page.keyboard.press("Enter");
      await t.settle();
      await t.until("number cell saves with Enter", async () => (await t.page.locator(".items-table").innerText()).includes("987654"));
      await t.audit("after saving a cell");
    }
  }, { viewport: vp });
}

// A table that fits its pane, at two window sizes.
for (const vp of ["desktop", "laptop"]) {
  test(`table: add row, sorting, hover, checkboxes, row actions @ ${vp}`, async (t) => {
    await t.boot();
    const ids = await t.seed(narrowTableSpec("typical", { items: 6 }));
    await t.open(t.listPath(ids.collections.books));
    // Add row.
    const plus = t.page.getByRole("button", { name: "Add Book" }).filter({ visible: true }).first();
    const before = await headerWidths(t);
    await plus.click();
    await t.settle();
    await t.audit("add row open");
    if (!t.phone) await t.check("columns keep their width when the add row opens", sameWidths(before, await headerWidths(t)), `${before} → ${await headerWidths(t)}`);
    await t.page.keyboard.type("A brand new book from the add row");
    await t.page.keyboard.press("Enter");
    await t.settle();
    await t.until("Enter in the add row creates the item", async () => (await t.page.locator(".items-table").innerText()).includes("A brand new book from the add row"));
    await t.audit("after adding a row");
    await t.closeAll();
    await t.page.keyboard.press("Escape");
    // Header sorting.
    const headers = t.page.locator(".items-table thead .cds--table-sort");
    const hn = Math.min(await headers.count(), 8);
    for (let i = 0; i < hn; i++) {
      await headers.nth(i).click().catch(() => {});
      await t.settle(120);
      await t.audit(`sorted by column ${i + 1}`, { shotOnFail: true });
      await headers.nth(i).click().catch(() => {});
      await t.settle(120);
    }
    // Hovering rows shows their actions without moving anything.
    const rows = t.page.locator(".items-table tbody tr");
    if (!t.phone) {
      for (const i of [0, 2]) {
        await t.noShift(`hovering row ${i + 1} moves nothing`, async () => {
          await rows.nth(i).hover();
          await t.wait(200);
        }, { scope: ".ws-pane--active .ws-pane__body" });
      }
    }
    // Checkboxes toggle in place.
    const box = t.page.locator(".items-table .cell-checkbox").first();
    await t.noShift("toggling a checkbox cell moves nothing", async () => {
      await box.locator("label, input").first().click({ force: true });
      await t.wait(200);
    }, { scope: ".ws-pane--active .ws-pane__body" });
    // Row actions: duplicate, then delete (asks first; cancel).
    const dup = t.page.locator(".items-table tbody").getByRole("button", { name: "Duplicate", exact: true }).first();
    if (await dup.count()) {
      const rowsBefore = await rows.count();
      await dup.click();
      await t.settle();
      await t.check("Duplicate adds a row", (await rows.count()) === rowsBefore + 1, `${rowsBefore} → ${await rows.count()}`);
    }
    const del = t.page.locator(".items-table tbody").getByRole("button", { name: "Delete", exact: true }).first();
    if (await del.count()) {
      await rows.first().hover();
      await del.click();
      await t.settle();
      await t.audit("delete confirmation");
      await t.check("Delete asks first", (await t.count(".cds--modal.is-visible")) === 1);
      await t.closeAll();
    }
    // The view's search filters rows.
    await openTool(t, t.page.locator(".views-bar").first(), "Search Books");
    await t.settle();
    // A title found in no other value (titles also appear in other books' tags and references).
    await t.page.keyboard.type("brand new book");
    await t.settle(300);
    await t.audit("view search");
    const found = await t.count(".items-table tbody tr:not(.table-add-row)");
    await t.check("search narrows the rows to the match", found === 1, `${found} rows`);
  }, { viewport: vp, smoke: vp === "desktop" });
}

for (const vp of ["desktop", "phone"]) {
  test(`table: grouped, groups collapse and expand @ ${vp}`, async (t) => {
    await t.boot();
    const spec = matrixSpec("typical", { items: 14 });
    const ids = await t.seed(spec);
    await t.open(`${t.listPath(ids.collections.books)}?view=${ids.views["books/Grouped"]}`);
    await t.audit("grouped");
    const heads = t.page.locator(".table-groups .cds--accordion__heading");
    const n = await heads.count();
    for (let i = 0; i < n; i++) {
      const before = await heads.nth(i).boundingBox();
      await heads.nth(i).click();
      await t.settle(150);
      const after = await heads.nth(i).boundingBox();
      await t.check(`group ${i + 1}: its heading stays in place when toggled`, Math.abs(before.y - after.y) <= 1, `moved ${after.y - before.y}`);
      await t.audit(`group ${i + 1} toggled`);
    }
  }, { viewport: vp });
}

for (const vp of ["wide", "desktop", "laptop", "tablet", "phone"]) {
  test(`table: many columns (60 fields) @ ${vp}`, async (t) => {
    await t.boot();
    const ids = await t.seed(profileSpec("typical", { items: 10, fieldsExtra: 46, longNames: vp === "desktop" }));
    await t.open(t.listPath(ids.collections.books));
    await t.audit("60 columns");
    const fits = await t.page.evaluate(() => {
      const pane = document.querySelector(".ws-pane--active .ws-pane__body");
      const table = document.querySelector(".items-table table, .items-table");
      return { pane: pane.clientWidth, table: table ? table.getBoundingClientRect().width : 0 };
    });
    await t.check(`table fits its pane (${Math.round(fits.table)} ≤ ${fits.pane})`, fits.table <= fits.pane + 1, JSON.stringify(fits));
    await t.page.locator(".ws-pane--active .ws-pane__body").evaluate((el) => (el.scrollTop = el.scrollHeight));
    await t.audit("scrolled to the end");
  }, { viewport: vp });
}

// Time budgets are relative to the machine: the same page with 20 rows, timed first, sets the
// pace (a development build on a slow CPU takes seconds for what a fast one does in one). Many
// rows may take proportionally longer, never more (nothing grows worse than linearly), with
// some slack; a hard ceiling catches hangs.
/** Opens a page and waits for its first table row; returns the milliseconds it took. */
async function timeOpen(t, path) {
  const started = Date.now();
  await t.open(path, { settle: false });
  await t.page.waitForSelector(".items-table tbody tr", { timeout: 120000 });
  const ms = Date.now() - started;
  await t.settle();
  return ms;
}
/** Types a search into the view's search box; returns the milliseconds until the page settles. */
async function timeSearch(t) {
  const t0 = Date.now();
  await t.page.getByRole("button", { name: "Search Books" }).first().click();
  await t.page.keyboard.type("Hyperion", { delay: 30 });
  await t.settle(200, 60000);
  const ms = Date.now() - t0;
  await t.page.getByRole("button", { name: "Close search" }).first().click().catch(() => {});
  return ms;
}

for (const n of [200, 1000]) {
  test(`table: ${n} rows load and scroll`, async (t) => {
    await t.boot();
    const small = await t.seed(profileSpec("typical", { items: 20, authors: 20 }));
    const spec = profileSpec("typical", { items: 0, authors: 20 });
    spec.collections[0].items = allKindItems(n, "typical", { target: "authors", targetCount: 20, image: null });
    const ids = await t.seed(spec);
    const pace = await timeOpen(t, t.listPath(small.collections.books));
    const paceSearch = await timeSearch(t);
    const ms = await timeOpen(t, t.listPath(ids.collections.books));
    const limit = Math.min(pace * (n / 20) * 1.25, 120000);
    await t.check(`${n} rows show within ${(limit / 1000).toFixed(1)}s, ${n / 20}× the 20-row time and some (${(ms / 1000).toFixed(1)}s)`, ms <= limit, `${ms}ms; 20 rows took ${pace}ms`);
    await t.audit(`${n} rows`);
    const rows = await t.count(".items-table tbody tr");
    await t.check(`all ${n} rows are listed (${rows})`, rows >= n, `${rows} rows`);
    for (const pos of [0.5, 1]) {
      await t.page.locator(".ws-pane--active .ws-pane__body").evaluate((el, pos) => (el.scrollTop = el.scrollHeight * pos), pos);
      await t.audit(`scrolled to ${pos * 100}%`, { shotOnFail: true });
    }
    // Typing a search over many rows stays responsive: proportional to the rows as well.
    const sms = await timeSearch(t);
    const slimit = Math.min(paceSearch * (n / 20) * 1.25, 120000);
    await t.check(`searching ${n} rows takes at most ${n / 20}× the 20-row search and some (${(sms / 1000).toFixed(1)}s)`, sms <= slimit, `${sms}ms; 20 rows took ${paceSearch}ms`);
  }, { heavy: true });
}

for (const vp of ["desktop", "wide"]) {
  test(`table: narrow panes scroll sideways, the first column staying put @ ${vp}`, async (t) => {
    await t.boot();
    const ids = await t.seed(profileSpec("long", { items: 6 }));
    const list = t.listPath(ids.collections.books);
    for (const sizes of [[0.5, 0.5], [0.75, 0.25], [0.85, 0.15]]) {
      await t.seed({ prefs: { "kubus.workspace.default": wsLayout([["/collections"], [list]], { sizes, active: 1 }) } });
      await t.open(list, { keepTabs: true });
      await t.audit(`table in a pane of ${Math.round(sizes[1] * 100)}%`);
      const scrolled = await t.page.evaluate(() => {
        const scroller = document.querySelector(".ws-pane--active .items-table .cds--data-table-content");
        if (!scroller || scroller.scrollWidth <= scroller.clientWidth + 1) return null;
        const first = () => scroller.querySelector("tbody tr td")?.getBoundingClientRect().left;
        const second = () => scroller.querySelector("tbody tr td:nth-child(2)")?.getBoundingClientRect().left;
        const before = { first: first(), second: second() };
        scroller.scrollLeft = scroller.scrollWidth;
        return { before, after: { first: first(), second: second() } };
      });
      if (!scrolled) continue;
      await t.settle(150);
      scrolled.fade = await t.page.evaluate(() => document.querySelector(".ws-pane--active .table-wrap")?.hasAttribute("data-more-start"));
      await t.check("scrolled: the first column stays put", Math.abs(scrolled.after.first - scrolled.before.first) <= 1, JSON.stringify(scrolled));
      await t.check("scrolled: the other columns move", scrolled.after.second < scrolled.before.second - 1, JSON.stringify(scrolled));
      await t.check("scrolled: the start edge fades", scrolled.fade === true, JSON.stringify(scrolled));
      await t.audit(`table in a pane of ${Math.round(sizes[1] * 100)}%, scrolled to its end`);
    }
  }, { viewport: vp });
}
