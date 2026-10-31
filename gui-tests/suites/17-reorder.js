// Reordering a collection's fields in its editor's Fields popover (ui/useReorder.tsx): by keyboard, by dragging the handle
// and as a selected group; Delete asks first.

/** The rows of the reorderable list in `scope` (a selector), by their name: a first input's value, else their text. */
const rowNames = (t, scope) =>
  t.page.evaluate((scope) => {
    const root = [...document.querySelectorAll(scope)].pop();
    if (!root) return [];
    const rows = [...root.querySelectorAll("[data-reorder-row]")];
    return rows.map((r) => {
      const input = r.querySelector("input[type=text], input:not([type])");
      return ((input && input.value) || r.textContent || "").trim().replace(/\s+/g, " ").slice(0, 40);
    });
  }, scope);

/** Handle of the i-th row in `scope`. */
const handleOf = (t, scope, i) => t.page.locator(scope).last().locator("[data-reorder-row]").nth(i).locator("[data-reorder-handle]");

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const moved = (list, from, to) => {
  const out = [...list];
  const [x] = out.splice(from, 1);
  out.splice(to, 0, x);
  return out;
};

/** Keyboard: ArrowDown / ArrowUp on a row's handle move it; focus stays on its handle. */
async function keyboardReorder(t, label, scope) {
  await t.until(`${label}: has rows to reorder`, async () => (await rowNames(t, scope)).length >= 3 || `${(await rowNames(t, scope)).length} rows`);
  const start = await rowNames(t, scope);
  await handleOf(t, scope, 0).focus();
  await t.page.keyboard.press("ArrowDown");
  await t.settle(100);
  await t.until(`${label}: ArrowDown moves the row down`, async () => same(await rowNames(t, scope), moved(start, 0, 1)) || JSON.stringify(await rowNames(t, scope)));
  const focus = await t.page.evaluate(() => {
    const row = document.activeElement?.closest("[data-reorder-row]");
    return row ? [...row.parentElement.children].filter((r) => r.hasAttribute("data-reorder-row")).indexOf(row) : -1;
  });
  await t.check(`${label}: focus follows the moved row's handle`, focus === 1, `focus on row ${focus}`);
  await t.page.keyboard.press("ArrowDown");
  await t.page.keyboard.press("ArrowUp");
  await t.page.keyboard.press("ArrowUp");
  await t.until(`${label}: back up again with ArrowUp`, async () => same(await rowNames(t, scope), start) || JSON.stringify(await rowNames(t, scope)));
  // At the top, ArrowUp does nothing.
  await t.page.keyboard.press("ArrowUp");
  await t.settle(100);
  await t.check(`${label}: ArrowUp on the first row changes nothing`, same(await rowNames(t, scope), start));
}

/** Drag: the first row's handle dragged below the third row. Checks during the drag, then the drop. */
async function dragReorder(t, label, scope) {
  const start = await rowNames(t, scope);
  const handle = handleOf(t, scope, 0);
  await handle.scrollIntoViewIfNeeded();
  const hb = await handle.boundingBox();
  const rows = t.page.locator(scope).last().locator("[data-reorder-row]");
  const r2 = await rows.nth(2).boundingBox();
  const others = async () => Promise.all([1, 2, 3].map(async (i) => (i < start.length ? (await rows.nth(i).boundingBox())?.y : null)));
  const before = await others();
  await t.page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await t.page.mouse.down();
  const targetY = r2.y + r2.height * 0.75;
  for (let k = 1; k <= 6; k++) await t.page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2 + ((targetY - hb.y - hb.height / 2) * k) / 6);
  await t.settle(100);
  const during = await t.page.evaluate((scope) => {
    const root = [...document.querySelectorAll(scope)].pop();
    const line = root.querySelector("[data-drop-before], [data-drop-after]");
    const dragging = root.querySelectorAll("[data-dragging]").length;
    // The line is drawn by a row (::after across it): within the rows of its list (which may
    // overhang the list a little, as their selection outline does).
    const lr = line ? line.getBoundingClientRect() : null;
    const rows = line ? [...line.parentElement.children].filter((r) => r.hasAttribute("data-reorder-row")).map((r) => r.getBoundingClientRect()) : [];
    const rr = rows.length ? { left: Math.min(...rows.map((r) => r.left)), right: Math.max(...rows.map((r) => r.right)), top: Math.min(...rows.map((r) => r.top)), bottom: Math.max(...rows.map((r) => r.bottom)) } : root.getBoundingClientRect();
    return { line: !!line, inside: !!lr && lr.left >= rr.left - 1 && lr.right <= rr.right + 1 && lr.top >= rr.top - 2 && lr.bottom <= rr.bottom + 2, dragging };
  }, scope);
  await t.check(`${label}: while dragging, a line shows where the row lands, inside the list`, during.line && during.inside, JSON.stringify(during));
  await t.check(`${label}: the dragged row is marked as dragging`, during.dragging === 1, `${during.dragging} rows dragging`);
  const mid = await others();
  await t.check(`${label}: rows not dragged stay put during the drag`, same(before, mid), `${JSON.stringify(before)} → ${JSON.stringify(mid)}`);
  // Mid-drag the dragged row passes over the others by design.
  await t.audit(`${label}: dragging`, { settle: false, skip: ["text-overlap", "controls-overlap", "occluded"] });
  await t.page.mouse.up();
  await t.settle();
  await t.until(`${label}: dropped below the third row, the order changes once`, async () => same(await rowNames(t, scope), moved(start, 0, 2)) || JSON.stringify(await rowNames(t, scope)));
  const after = await t.page.evaluate(() => document.querySelectorAll("[data-dragging], [data-drop-before], [data-drop-after]").length + (document.body.hasAttribute("data-reordering") ? 1 : 0));
  await t.check(`${label}: nothing is left marked after the drop`, after === 0, `${after} marks left`);
}

/** A group: the first two rows selected (click, Shift+click on handles), moved down together by keyboard. */
async function groupReorder(t, label, scope) {
  const start = await rowNames(t, scope);
  await handleOf(t, scope, 0).click();
  await handleOf(t, scope, 1).click({ modifiers: ["Shift"] });
  await t.settle(100);
  const sel = await t.page.locator(scope).last().locator("[data-reorder-row][data-selected]").count();
  await t.check(`${label}: click and Shift+click select two rows`, sel === 2, `${sel} selected`);
  await handleOf(t, scope, 1).focus();
  await t.page.keyboard.press("ArrowDown");
  await t.until(`${label}: the selected group moves down together`, async () => same(await rowNames(t, scope), [start[2], start[0], start[1], ...start.slice(3)]) || JSON.stringify(await rowNames(t, scope)));
  await t.page.keyboard.press("Escape");
  await t.settle(100);
  await t.check(`${label}: Escape clears the selection`, (await t.page.locator(scope).last().locator("[data-reorder-row][data-selected]").count()) === 0);
}

test("collection editor: reorder fields by keyboard, drag and as a group; Delete asks @ desktop", async (t) => {
  await t.boot();
  const ids = await t.seed(profileSpec("typical", { items: 2 }));
  await t.open(`/collections/${ids.collections.books}/edit`);
  // The fields are ordered and removed in the header's Fields popover.
  const header = t.page.locator(".ws-pane--active .page-header").first();
  const scope = ".cds--popover--open .field-order";
  const openFields = async () => {
    if (!(await t.page.locator(scope).count())) await t.openPanel(header, "Fields");
  };
  await openFields();
  await keyboardReorder(t, "fields", scope);
  await dragReorder(t, "fields", scope);
  await groupReorder(t, "fields", scope);
  // Delete with a row selected asks first; Cancel keeps it. (Escape above closed the popover too.)
  await openFields();
  const n = (await rowNames(t, scope)).length;
  await handleOf(t, scope, 0).click();
  await t.page.keyboard.press("Delete");
  await t.until("Delete with a row selected asks first", async () => /Delete 1 field\?/.test(await t.page.locator(".cds--modal.is-visible").innerText().catch(() => "")));
  await t.audit("delete fields confirmation");
  await t.page.locator(".cds--modal.is-visible").getByRole("button", { name: /Cancel/ }).click();
  await t.settle();
  await openFields();
  await t.check("Cancel keeps the field", (await rowNames(t, scope)).length === n);
}, { viewport: "desktop", smoke: true });
