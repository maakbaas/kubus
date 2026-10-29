// A table block's main path: the add row (columns keep their width), header sorting, hovering rows and
// toggling a checkbox move nothing, row actions.

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

/** Column widths unchanged, but for sub-pixel rounding (1px). */
const sameWidths = (a, b) => a.length === b.length && a.every((w, i) => Math.abs(w - b[i]) <= 1);

async function headerWidths(t, scope = ".items-table") {
  return t.page.evaluate((scope) => [...document.querySelectorAll(`${scope} thead th`)].map((th) => Math.round(th.getBoundingClientRect().width * 10) / 10), scope);
}

// A table that fits its pane, at two window sizes.
test("table: add row, sorting, hover, checkboxes, row actions @ desktop", async (t) => {
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
}, { viewport: "desktop", smoke: true });
