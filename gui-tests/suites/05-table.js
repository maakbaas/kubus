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
    // Row actions: no Duplicate (saves space; the table's rows have no overflow menu), then delete (asks first; cancel).
    await t.check("rows have no Duplicate button", (await t.page.locator(".items-table tbody").getByRole("button", { name: "Duplicate", exact: true }).count()) === 0);
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
    // A block shows 100 items at first (DEFAULT_LIMIT) and 100 more with each "Show more".
    const first = Math.min(n, 100);
    const rows = await t.count(".items-table tbody tr");
    await t.check(`the first ${first} of ${n} rows are listed (${rows})`, rows >= first && rows <= first + 1, `${rows} rows`);
    const more = t.page.locator(".ws-pane--active .block").first().getByRole("button", { name: "Show more", exact: true });
    for (let page = 1; page * 100 < n; page++) {
      await more.click();
      await t.until(`Show more lists ${Math.min(n, (page + 1) * 100)} rows`, async () => (await t.count(".items-table tbody tr")) >= Math.min(n, (page + 1) * 100));
    }
    await t.check(`all ${n} rows are listed, no Show more left`, (await t.count(".items-table tbody tr")) >= n && (await more.count()) === 0, `${await t.count(".items-table tbody tr")} rows`);
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
  test(`table: narrow panes scroll sideways, all columns together @ ${vp}`, async (t) => {
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
      await t.check("scrolled: the first column moves (none is pinned)", scrolled.after.first < scrolled.before.first - 1, JSON.stringify(scrolled));
      await t.check("scrolled: the other columns move", scrolled.after.second < scrolled.before.second - 1, JSON.stringify(scrolled));
      await t.check("scrolled: the start edge fades", scrolled.fade === true, JSON.stringify(scrolled));
      await t.audit(`table in a pane of ${Math.round(sizes[1] * 100)}%, scrolled to its end`);
    }
  }, { viewport: vp });
}

for (const vp of ["desktop", "phone"]) {
  test(`table: the header row stays in view while the pane scrolls down @ ${vp}`, async (t) => {
    await t.boot();
    const ids = await t.seed(profileSpec("long", { items: 60 }));
    await t.open(t.listPath(ids.collections.books));
    const at = () =>
      t.page.evaluate(() => {
        const pane = document.querySelector(".ws-pane--active .ws-pane__body");
        const scroller = document.querySelector(".ws-pane--active .items-table .cds--data-table-content");
        const th = scroller?.querySelector("thead th");
        const td = scroller?.querySelector("tbody tr td");
        if (!pane || !th || !td) return null;
        return { pane: pane.getBoundingClientRect().top, head: th.getBoundingClientRect().top, headLeft: th.getBoundingClientRect().left, cellLeft: td.getBoundingClientRect().left, scrollTop: pane.scrollTop };
      });
    const before = await at();
    await t.check("a table is shown", !!before, "no table");
    if (!before) return;
    await t.page.evaluate(() => {
      const pane = document.querySelector(".ws-pane--active .ws-pane__body");
      pane.scrollTop = pane.scrollHeight / 2;
    });
    await t.settle(150);
    const down = await at();
    await t.check("the pane scrolled down past the table's top", down.scrollTop > 0 && before.head - down.scrollTop < down.pane, JSON.stringify({ before, down }));
    // It stops a spacing-05 (16px) below the pane's top edge, as at rest (--table-head-gap).
    await t.check("scrolled down: the header row is at the pane's top (a spacing-05 below it)", Math.abs(down.head - (down.pane + 16)) <= 1, JSON.stringify({ before, down }));
    await t.audit("table scrolled down, header row held", { shotOnFail: true });
    // Sideways too (a phone): the header cells stay above their columns.
    await t.page.evaluate(() => {
      const scroller = document.querySelector(".ws-pane--active .items-table .cds--data-table-content");
      scroller.scrollLeft = scroller.scrollWidth;
    });
    await t.settle(150);
    const side = await at();
    await t.check("scrolled sideways: the header cells stay above their columns", Math.abs(side.headLeft - side.cellLeft) <= 1, JSON.stringify(side));
    await t.page.evaluate(() => (document.querySelector(".ws-pane--active .ws-pane__body").scrollTop = 0));
    await t.settle(150);
    const back = await at();
    await t.check("scrolled back up: the header row is in its place again", Math.abs(back.head - before.head) <= 1, JSON.stringify({ before, back }));
  }, { viewport: vp });
}

/** The editor of the cell being edited and the row's buttons: boxes, and whether they overlap. */
async function editorVsButtons(t) {
  return t.page.evaluate(() => {
    const cell = document.querySelector(".items-table td.cell--editing");
    const row = cell && cell.closest("tr");
    const input = cell && cell.querySelector("input, textarea, [contenteditable]");
    if (!row || !input) return null;
    const box = (el) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; };
    const editor = box(input);
    const buttons = [...row.querySelectorAll("td.row-actions button")].filter((b) => b.getClientRects().length && getComputedStyle(b).visibility !== "hidden");
    const hits = buttons.map((b) => ({ label: b.getAttribute("aria-label") || b.textContent.trim(), ...box(b) })).filter((b) => Math.min(editor.right, b.right) - Math.max(editor.left, b.left) > 1 && Math.min(editor.bottom, b.bottom) - Math.max(editor.top, b.top) > 1);
    return { editor, buttons: buttons.length, overlapping: hits.map((h) => h.label) };
  });
}

// A single-line editor in the last column sat over the row's open button (the title column is
// left out, so each row has one): on a phone the column is a sliver, and the editor reached over
// the actions cell. Short and long values; every row button must stay clear of it.
const LAST_COLUMNS = [["Place", "string"], ["Count", "number"], ["Day", "date"], ["When", "datetime"], ["Related", "item"]];
for (const vp of ["phone", "phone-small", "desktop"]) {
  test(`table: a cell editor in the last column never covers the row's buttons @ ${vp}`, async (t) => {
    await t.boot();
    const places = ["Oslo", "A place with a name that goes on and on and on and on, Lorem ipsum dolor sit amet", "Bern"];
    const fields = [{ key: "title", name: "Title", kind: "string" }, { key: "place", name: "Place", kind: "string" }, { key: "count", name: "Count", kind: "number" }, { key: "day", name: "Day", kind: "date" }, { key: "when", name: "When", kind: "datetime" }, { key: "tags", name: "Tags", kind: "string_list" }, { key: "ref", name: "Related", kind: "item", target: "notes" }];
    const spec = {
      collections: [{
        key: "notes", name: "Note", plural: "Notes", fields,
        items: places.map((place, k) => ({ key: `n${k}`, values: { title: `Note ${k}`, place, count: k + 1, day: `2024-05-0${k + 1}`, when: `2024-05-0${k + 1}T10:30:00`, tags: k === 1 ? ["a", "b"] : ["x"], ref: { ref: `notes/n${(k + 1) % 3}` } } })),
        // One view per kind, the title column left out (each row has an open button) and that kind last.
        views: LAST_COLUMNS.map(([name]) => ({ name, blocks: [{ kind: "table", layout: { fields: ["count", ...fields.filter((f) => f.name === name && f.key !== "count").map((f) => f.key)] } }] })),
      }],
    };
    const ids = await t.seed(spec);
    for (const [col, kind] of LAST_COLUMNS) {
      await t.open(`${t.listPath(ids.collections.notes)}?view=${ids.views[`notes/${col}`]}`);
      for (let row = 0; row < 3; row++) {
        const cell = t.page.locator(`.items-table .cell-editable[aria-label='Edit ${col}']`).nth(row);
        await cell.evaluate((el) => el.scrollIntoView({ block: "center", inline: "center" }));
        await t.wait(100);
        await cell.click({ position: { x: 3, y: 3 } });
        await t.wait(250);
        const s = await editorVsButtons(t);
        await t.check(`${col} (${kind}), row ${row}: the editor is open in a row with buttons`, !!s, JSON.stringify(s));
        if (s) await t.check(`${col} (${kind}), row ${row}: the editor covers none of the row's visible buttons`, s.overlapping.length === 0, `covers ${s.overlapping.join(", ")}: ${JSON.stringify(s)}`);
        const hidden = await t.page.evaluate(() => {
          const tr = document.querySelector(".items-table td.cell--editing")?.closest("tr");
          return [...(tr?.querySelectorAll("td.row-actions button") ?? [])].filter((b) => getComputedStyle(b).visibility !== "visible").map((b) => b.getAttribute("aria-label") ?? b.textContent);
        });
        await t.check(`${col} (${kind}), row ${row}: the row's buttons stay shown while it is edited`, hidden.length === 0, `hidden: ${hidden.join(", ")}`);
        // (A calendar is taller than a 320x568 window's room: its own finding, not this test's.)
        await t.audit(`${col} (${kind}), row ${row}: editing`, { shotOnFail: true, skip: vp === "phone-small" ? ["popover-in-viewport"] : [] });
        await escapeEditor(t);
        await t.settle(100);
      }
    }
  }, { viewport: vp });
}

// The same on the pages that list spaces and collections (a name / description edited in place
// beside "Switch to" / the row's other buttons).
for (const vp of ["phone", "phone-small", "desktop"]) {
  test(`spaces and collections lists: an editor never covers the row's buttons @ ${vp}`, async (t) => {
    await t.boot();
    const spec = profileSpec("typical", { items: 2 });
    spec.spaces = [{ key: "w", name: "Work" }, { key: "h", name: "A space with a long name for the narrow screen" }];
    spec.collections[0].description = "Short";
    await t.seed(spec);
    for (const [path, label] of [["/spaces", /^Rename /], ["/collections", /^Edit description of /]]) {
      await t.open(path);
      const cells = t.page.getByRole("button", { name: label }).filter({ visible: true });
      if (vp === "desktop") await t.until(`${path}: editable cells are listed`, async () => (await cells.count()) > 0);
      else await t.wait(500); // (the description column is left out of a phone's list)
      const n = await cells.count();
      for (let i = 0; i < Math.min(n, 3); i++) {
        const cell = cells.nth(i);
        await cell.evaluate((el) => el.scrollIntoView({ block: "center", inline: "center" }));
        await cell.click({ position: { x: 3, y: 3 } });
        await t.wait(250);
        const s = await editorVsButtons(t);
        await t.check(`${path}, row ${i}: the editor is open in a row with buttons`, !!s, JSON.stringify(s));
        if (s) await t.check(`${path}, row ${i}: the editor covers none of the row's visible buttons`, s.overlapping.length === 0, `${JSON.stringify(s)}`);
        await t.audit(`${path}, row ${i}: editing`, { shotOnFail: true });
        await escapeEditor(t);
        await t.settle(100);
      }
    }
  }, { viewport: vp });
}

for (const vp of ["desktop", "phone"]) {
  test(`table: a field's name can be hidden, its column sizes to the content @ ${vp}`, async (t) => {
    await t.boot();
    const spec = profileSpec("typical", { items: 6 });
    spec.collections[0].views = [{ name: "All", blocks: [{ kind: "table", layout: { fields: ["title", "done", "count"] } }] }];
    const ids = await t.seed(spec);
    const coll = ids.collections.books;
    const done = ids.fields["books.done"];
    const path = t.listPath(coll);
    // The header names shown (a hidden name stays in the DOM for screen readers and the sort button, visually hidden).
    const labels = () => t.page.evaluate(() => [...document.querySelectorAll(".items-table thead th")].map((h) => (h.classList.contains("cell--name-hidden") ? "" : h.querySelector(".cds--table-header-label")?.textContent.trim() ?? "")));
    const save = async () => { await t.openPanel(t.page.locator(".views-bar").first(), "Save changes to view"); await t.until("the view is saved", async () => !(await t.page.locator(".views-bar").first().innerText()).includes("*")); };
    const stored = () => t.page.evaluate(async (c) => (await window.kubus.repo.listViews(c, "default")).find((v) => v.name === "All").blocks[0].layout.hiddenLabels, coll);
    const header = () => t.page.locator(".block").first().locator(".section-header").first();
    await t.open(path);
    const wide = await t.page.evaluate(() => [...document.querySelectorAll(".items-table thead th")].find((h) => h.textContent.includes("Done")).getBoundingClientRect().width);
    await openTool(t, header(), "Fields");
    const row = t.page.locator(".cds--popover--open .field-order__row", { hasText: "Done" }).first();
    await t.check("the Fields popover offers the name toggle per field", (await t.page.locator(".cds--popover--open").getByRole("button", { name: "Hide field name" }).count()) >= 3);
    await row.getByRole("button", { name: "Hide field name" }).click();
    await t.until("the header label is gone, the column stays", async () => { const l = await labels(); return (l.length === 4 && l[1] === "" && l[0] !== "" && l[2] !== "") || JSON.stringify(l); });
    await t.check("the toggle now offers to show it", (await row.getByRole("button", { name: "Show field name" }).count()) === 1);
    await t.closeAll();
    await t.settle();
    const narrow = await t.page.evaluate(() => document.querySelectorAll(".items-table thead th")[1].getBoundingClientRect().width);
    await t.check("the column sizes to its checkbox, not to the header", narrow < wide - 8 && narrow < 80, `${wide} → ${narrow}`);
    await t.check("the column is still sortable and named", (await t.page.locator(".items-table thead th").nth(1).getByRole("button", { name: /Done/ }).count()) === 1);
    await t.audit("table with a hidden header label");
    await save();
    await t.check("hiding the name is stored with the view", JSON.stringify(await stored()) === JSON.stringify([done]), JSON.stringify(await stored()));
    await t.open(path);
    await t.until("it persists after reopening", async () => (await labels())[1] === "");
    // Show it again.
    await openTool(t, header(), "Fields");
    await t.page.locator(".cds--popover--open .field-order__row", { hasText: "Done" }).first().getByRole("button", { name: "Show field name" }).click();
    await t.until("showing it brings the header back", async () => (await labels())[1] === "Done");
    await t.closeAll(); // Save is held while the panel is open
    await save();
    await t.check("showing the name is stored", (await stored()).length === 0);
  }, { viewport: vp });
}
