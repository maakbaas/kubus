// Popovers in use. Every toolbar popover is opened and its own controls are used the way a person
// would: typing a character at a time, toggling, picking options, adding and removing rows, opening
// a dialog from it. After each step (t.popoverStep) the popover is still open, its button and the
// edge its panel hangs from haven't moved, the control used is still under the pointer and the bars
// behind the panel kept their place. Escape closes each one and gives focus back to its button
// (t.escapeCloses); opening and closing one repeatedly leaves nothing behind.

/** The bars behind a page's popovers: page header and view tabs (what changes beneath them is content). */
const BARS = ".ws-pane--active .views-bar, .ws-pane--active .page-header";

/** Opens a toolbar popover by its button's label (through "More actions" when folded into it). */
async function openPopover(t, scope, label) {
  let btn = scope.getByRole("button", { name: label, exact: true }).filter({ visible: true }).first();
  if (!(await btn.count())) {
    const more = scope.getByRole("button", { name: "More actions" }).filter({ visible: true }).first();
    if (!(await more.count())) throw new TestFailure(`no "${label}" button and no "More actions"`);
    await more.click();
    await t.settle(100);
    btn = t.page.getByRole("button", { name: label, exact: true }).filter({ visible: true }).last();
  }
  await btn.click();
  await t.settle(150);
  if ((await btn.getAttribute("aria-expanded").catch(() => null)) !== "true") {
    await btn.click();
    await t.settle(150);
  }
  await t.require(`"${label}" opens`, (await btn.getAttribute("aria-expanded").catch(() => null)) === "true", "its button doesn't say it is expanded");
  return btn;
}

/** The open toolbar popover's panel. */
const openPanel = (t) => t.page.locator(".toolbar-popover.cds--popover--open .toolbar-popover__panel").last();

/** Picks an option of a Carbon Select in the panel by its index, as one popover step. */
async function pickSelect(t, label, select, index, opts = {}) {
  if (await select.isDisabled()) return;
  const n = await select.locator("option:not([disabled])").count();
  if (!n) return;
  const value = await select.locator("option:not([disabled])").nth(index % n).getAttribute("value");
  await t.popoverStep(label, () => select.selectOption(value), { target: select, scope: BARS, ...opts });
}

/** Types text into an input one character at a time: the first character on its own, then the rest. */
async function typeSteps(t, label, input, text, opts = {}) {
  await input.click();
  await t.popoverStep(`${label}: first character`, () => t.page.keyboard.type(text[0]), { target: input, scope: BARS, ...opts });
  if (text.length > 1) await t.popoverStep(`${label}: the rest`, () => t.page.keyboard.type(text.slice(1), { delay: 25 }), { target: input, scope: BARS, ...opts });
}

/** Opening and closing a popover 8 more times (after a first time) leaves no elements behind. */
async function noLeak(t, label, open) {
  await open();
  await t.page.keyboard.press("Escape");
  await t.settle(100);
  await t.page.mouse.move(1, t.vp.height - 2);
  await t.settle(100);
  const before = await t.nodeCount();
  for (let i = 0; i < 8; i++) {
    await open();
    await t.page.keyboard.press("Escape");
    await t.settle(60);
  }
  await t.page.mouse.move(1, t.vp.height - 2);
  await t.settle(150);
  const after = await t.nodeCount();
  const pass = after - before <= 20;
  await t.check(`${label}: opening and closing 8 times leaves nothing behind (${before} → ${after} elements)`, pass, `${after - before} elements more`);
}

function popoverSpec() {
  const spec = matrixSpec("typical", { items: 10 });
  spec.spaces = [{ key: "w", name: "Work" }];
  return spec;
}

const POP_VPS = ["desktop", "laptop", "phone", "short"];

for (const vp of POP_VPS) {
  test(`view filter in use: rules for every field kind @ ${vp}`, async (t) => {
    await t.boot();
    const ids = await t.seed(popoverSpec());
    await t.open(t.listPath(ids.collections.books));
    const bar = t.page.locator(".ws-pane--active .views-bar").first();
    await openPopover(t, bar, /^Filter/);
    await t.audit("filter popover open");
    const panel = openPanel(t);
    const add = panel.getByRole("button", { name: "Add filter" });
    await t.popoverStep("add a first rule", () => add.click(), { scope: BARS });
    const rule = panel.locator(".query-editor__rule").first();
    for (const field of ["Count", "Date", "Done", "Related", "Tags", "Notes", "Title"]) {
      const fieldSel = rule.locator("select").nth(0);
      const value = await fieldSel.locator("option", { hasText: new RegExp(`^${field}$`) }).first().getAttribute("value").catch(() => null);
      if (!value) {
        await t.fail(`a filter rule can use the field ${field}`, "not among the rule's fields");
        continue;
      }
      await t.popoverStep(`rule field → ${field}`, () => fieldSel.selectOption(value), { target: fieldSel, scope: BARS });
      await pickSelect(t, `rule condition of ${field} → the second`, rule.locator("select").nth(1), 1);
      const text = rule.locator("input.cds--text-input");
      if (await text.count()) await typeSteps(t, `${field} value`, text.first(), field === "Count" ? "42" : field === "Date" ? "2020-01-01" : "Neuro");
      else if ((await rule.locator("select").count()) > 2) await pickSelect(t, `${field} value → an item`, rule.locator("select").nth(2), 1);
    }
    await t.popoverStep("add a second rule", () => add.click(), { scope: BARS });
    await t.popoverStep("add a third rule", () => add.click(), { scope: BARS });
    await t.audit("filter popover with three rules");
    const remove = panel.getByRole("button", { name: "Remove filter" });
    await t.popoverStep("remove the last rule", () => remove.last().click(), { scope: BARS });
    await t.popoverStep("remove the first rule", () => remove.first().click(), { scope: BARS });
    await t.audit("filter popover after removing rules");
    await t.escapeCloses("filter popover");
    await t.check("the changed view offers Save once the popover is closed", (await t.page.getByRole("button", { name: "Save changes to view" }).count()) > 0 || (await bar.innerText()).includes("*"));
    await t.audit("filtered view, popover closed");
    await noLeak(t, "filter popover", () => openPopover(t, bar, /^Filter/));
  }, { viewport: vp, smoke: vp === "desktop" });

  test(`block popovers in use: sort and group, fields, block settings @ ${vp}`, async (t) => {
    await t.boot();
    const ids = await t.seed(popoverSpec());
    await t.open(t.listPath(ids.collections.books));
    const header = () => t.page.locator(".ws-pane--active .block").first().locator(".section-header").first();
    // Sort and group: every select, every option position.
    await openPopover(t, header(), "Sort and group");
    await t.audit("sort and group open");
    const selects = openPanel(t).locator("select");
    for (let i = 0; i < 4; i++) for (const k of [1, 2, 0]) await pickSelect(t, `sort and group select ${i + 1} → option ${k + 1}`, selects.nth(i), k);
    await pickSelect(t, "group by the second groupable field", selects.nth(2), 1);
    await t.audit("sort and group, grouped");
    await t.escapeCloses("sort and group");
    // Fields: hide and show each field.
    await openPopover(t, header(), "Fields");
    await t.audit("fields open");
    const boxes = openPanel(t).locator(".field-order__row .cds--checkbox-label");
    const n = Math.min(await boxes.count(), 8);
    for (let i = 0; i < n; i++) await t.popoverStep(`field ${i + 1}: hide`, () => boxes.nth(i).click(), { target: boxes.nth(i), scope: BARS });
    for (let i = 0; i < n; i++) await t.popoverStep(`field ${i + 1}: show`, () => boxes.nth(i).click(), { target: boxes.nth(i), scope: BARS });
    // A dialog from the panel ("Add field"): cancelling it returns to the open panel.
    const addField = openPanel(t).getByRole("button", { name: "Add field" });
    if (await addField.count()) {
      await addField.click();
      await t.settle();
      await t.audit("add field dialog over the fields popover");
      await t.page.locator(".cds--modal.is-visible").getByRole("button", { name: /Cancel/ }).click().catch(() => t.page.keyboard.press("Escape"));
      await t.settle();
      await t.check("cancelling the dialog keeps the fields popover open", (await t.count(".toolbar-popover.cds--popover--open")) === 1, `${await t.count(".toolbar-popover.cds--popover--open")} open popovers`);
    }
    await t.escapeCloses("fields");
    // Block settings: its options, then Show as cards and the cards' options.
    await openPopover(t, header(), "Block settings");
    await t.audit("block settings open");
    const checks = openPanel(t).locator(".cds--checkbox-label");
    for (let i = 0; i < (await checks.count()); i++) {
      await t.popoverStep(`table option ${i + 1}: toggle`, () => checks.nth(i).click(), { target: checks.nth(i), scope: BARS });
      await t.popoverStep(`table option ${i + 1}: toggle back`, () => checks.nth(i).click(), { target: checks.nth(i), scope: BARS });
    }
    const name = openPanel(t).getByRole("textbox", { name: "Name" });
    await typeSteps(t, "block name", name, "My table");
    await t.popoverStep("Enter stores the block name", () => t.page.keyboard.press("Enter"), { target: name, scope: BARS });
    const showAs = openPanel(t).locator(".cds--dropdown").first().locator("button").first();
    await t.popoverStep("open Show as", () => showAs.click(), { target: showAs, scope: BARS });
    await t.audit("Show as menu");
    await t.popoverStep("Show as → Cards", () => t.page.getByRole("option", { name: /Cards/ }).first().click(), { scope: BARS });
    await t.audit("block settings of cards");
    const slider = openPanel(t).locator(".cds--slider__thumb").first();
    if (await slider.count()) {
      await slider.focus();
      // The thumb moves with the value: no target to hold still.
      for (const key of ["ArrowRight", "ArrowRight", "ArrowLeft", "Home", "End"]) await t.popoverStep(`card width: ${key}`, () => t.page.keyboard.press(key), { scope: BARS });
    }
    for (const [i, label] of ["Cover", "Cover shape"].entries()) {
      const sel = openPanel(t).getByRole("combobox", { name: label, exact: true });
      if (await sel.count()) for (const k of [0, 1, 2]) await pickSelect(t, `${label} → option ${k + 1}`, sel, k + i);
    }
    await t.audit("cards settings after changes");
    await t.escapeCloses("block settings");
    await noLeak(t, "block settings", () => openPopover(t, header(), "Block settings"));
  }, { viewport: vp, smoke: vp === "desktop" });

  test(`view settings in use: rename, headers, add and remove blocks @ ${vp}`, async (t) => {
    await t.boot();
    const ids = await t.seed(popoverSpec());
    await t.open(`${t.listPath(ids.collections.books)}?view=${ids.views["books/Blocks"]}`);
    const bar = t.page.locator(".ws-pane--active .views-bar").first();
    await openPopover(t, bar, "View settings");
    await t.audit("view settings open");
    const panel = openPanel(t);
    const name = panel.getByRole("textbox", { name: "View name" });
    await name.click();
    await t.page.keyboard.press("End");
    await typeSteps(t, "view name", name, " with more words");
    await t.popoverStep("Enter renames the view", () => t.page.keyboard.press("Enter"), { target: name, scope: ".ws-pane--active .page-header" });
    const tags = panel.getByRole("button", { name: /block header/ });
    const tn = await tags.count();
    for (let i = 0; i < tn; i++) await t.popoverStep(`block ${i + 1}: hide its header`, () => tags.nth(i).click(), { target: tags.nth(i), scope: BARS });
    for (let i = 0; i < tn; i++) await t.popoverStep(`block ${i + 1}: show its header`, () => tags.nth(i).click(), { target: tags.nth(i), scope: BARS });
    const addBlock = panel.getByRole("button", { name: "Add block" });
    await t.popoverStep("open the Add block menu", () => addBlock.click(), { target: addBlock, scope: BARS });
    await t.audit("add block menu");
    await t.page.getByRole("menuitem").first().click();
    await t.settle();
    await t.check("adding a block keeps View settings open", (await t.count(".toolbar-popover.cds--popover--open")) === 1);
    const removes = panel.getByRole("button", { name: "Remove block" });
    await t.popoverStep("remove a block (asks first)", () => removes.last().click(), { scope: BARS, keepOpen: true });
    await t.audit("remove block confirmation");
    await t.page.locator(".cds--modal.is-visible").getByRole("button", { name: /Cancel/ }).click().catch(() => t.page.keyboard.press("Escape"));
    await t.settle();
    await t.check("cancelling the confirmation keeps View settings open", (await t.count(".toolbar-popover.cds--popover--open")) === 1);
    await t.escapeCloses("view settings");
    await noLeak(t, "view settings", () => openPopover(t, bar, "View settings"));
  }, { viewport: vp, smoke: vp === "desktop" });

  test(`item page popovers in use: page layout, details @ ${vp}`, async (t) => {
    await t.boot();
    const ids = await t.seed(popoverSpec());
    await t.open(t.itemPath(ids.collections.books, ids.items["books/i0"]));
    const header = t.page.locator(".ws-pane--active .page-header").first();
    await openPopover(t, header, "Page layout");
    await t.audit("page layout open");
    const panel = openPanel(t);
    const checks = panel.locator(".cds--checkbox-label");
    const n = Math.min(await checks.count(), 10);
    // Unchecking a field takes it off the page below the panel: only the bars must hold still.
    for (let i = 0; i < n; i++) await t.popoverStep(`layout option ${i + 1}: toggle`, () => checks.nth(i).click(), { target: checks.nth(i), scope: BARS });
    for (let i = 0; i < n; i++) await t.popoverStep(`layout option ${i + 1}: toggle back`, () => checks.nth(i).click(), { target: checks.nth(i), scope: BARS });
    const tags = panel.getByRole("button", { name: /field name|block header/ });
    for (let i = 0; i < Math.min(await tags.count(), 4); i++) await t.popoverStep(`name toggle ${i + 1}`, () => tags.nth(i).click(), { target: tags.nth(i), scope: BARS });
    await t.audit("page layout after changes");
    await t.escapeCloses("page layout");
    await openPopover(t, header, "Details");
    await t.audit("details open");
    // A dropdown inside the panel: Escape closes the dropdown only, the second one the panel.
    const space = openPanel(t).locator(".cds--dropdown button").first();
    if (await space.count()) {
      await t.popoverStep("open the space dropdown", () => space.click(), { target: space, scope: BARS });
      await t.audit("space dropdown in details");
      await t.page.keyboard.press("Escape");
      await t.settle(100);
      await t.check("Escape in the dropdown closes only the dropdown", (await t.count(".toolbar-popover.cds--popover--open")) === 1 && (await t.count(".cds--list-box--expanded")) === 0, `${await t.count(".toolbar-popover.cds--popover--open")} popovers, ${await t.count(".cds--list-box--expanded")} open dropdowns`);
    }
    await t.escapeCloses("details");
    await noLeak(t, "page layout", () => openPopover(t, header, "Page layout"));
  }, { viewport: vp, smoke: vp === "desktop" });
}

for (const vp of ["desktop", "phone"]) {
  test(`icon picker in use: typing filters the grid in place @ ${vp}`, async (t) => {
    await t.boot();
    const ids = await t.seed(popoverSpec());
    await t.open(`/collections/${ids.collections.books}/edit`);
    const btn = t.page.locator(".title-edit").getByRole("button").first();
    await btn.click();
    await t.settle();
    await t.audit("icon picker open");
    const search = t.page.locator(".icon-picker .cds--search-input, .icon-picker input").first();
    await search.click();
    for (const [i, ch] of [..."arrow"].entries()) await t.popoverStep(`typing "${"arrow".slice(0, i + 1)}"`, () => t.page.keyboard.type(ch), { target: search, scope: ".ws-pane--active .form-page > :not(.title-edit)" });
    await t.popoverStep("clearing the search", async () => {
      await t.page.keyboard.press("Control+A");
      await t.page.keyboard.press("Backspace");
    }, { target: search });
    await t.popoverStep("a search without matches", () => t.page.keyboard.type("zzzznothing"), { target: search });
    await t.audit("icon picker without matches");
    await t.page.keyboard.press("Control+A");
    await t.page.keyboard.type("book");
    await t.settle(300);
    await t.page.locator(".icon-grid button").first().click();
    await t.settle();
    await t.check("picking an icon closes the picker", (await t.count(".icon-picker.cds--popover--open")) === 0);
  }, { viewport: vp });
}

// Popovers together with everything else.
for (const vp of ["desktop", "phone"]) {
  test(`popovers and the rest: one at a time, click-through, scroll, resize @ ${vp}`, async (t) => {
    await t.boot();
    const ids = await t.seed(popoverSpec());
    await t.open(t.listPath(ids.collections.books));
    const bar = t.page.locator(".ws-pane--active .views-bar").first();
    const header = () => t.page.locator(".ws-pane--active .block").first().locator(".section-header").first();
    // One at a time: opening another closes the first.
    await openPopover(t, bar, /^Filter/);
    // On phones the first one's "⋮" menu covers the block's "⋮": closed first, as a tap would.
    if (t.phone) await t.closeAll();
    await openPopover(t, header(), "Sort and group");
    await t.check("opening a second popover closes the first", (await t.count(".toolbar-popover.cds--popover--open")) === 1, `${await t.count(".toolbar-popover.cds--popover--open")} open`);
    await t.audit("second popover open");
    // Click-through: a click on a table cell while a popover is open closes it and edits the cell.
    if (!t.phone) {
      const cell = t.page.locator(".ws-pane--active .items-table .cell-editable[aria-label='Edit Count']").first();
      await cell.click();
      await t.settle();
      await t.check("one click outside an open popover closes it and starts editing the cell", (await t.count(".toolbar-popover.cds--popover--open")) === 0 && (await t.count(".cell--editing")) === 1, `${await t.count(".toolbar-popover.cds--popover--open")} open popovers, ${await t.count(".cell--editing")} cells editing`);
      await t.page.keyboard.press("Escape");
      await t.settle();
    }
    // Scrolling the pane under an open popover: the panel stays at its button (or closes).
    await openPopover(t, header(), "Fields");
    await t.page.locator(".ws-pane--active .ws-pane__body").evaluate((el) => (el.scrollTop += 120));
    await t.settle();
    await t.audit("pane scrolled under an open popover");
    await t.closeAll();
    await t.page.locator(".ws-pane--active .ws-pane__body").evaluate((el) => (el.scrollTop = 0));
    // Resizing the window with a popover open: the panel stays in the window and at its button.
    await openPopover(t, bar, "View settings");
    for (const [w, h] of t.phone ? [[320, 568], [430, 932], [390, 844]] : [[1024, 600], [760, 900], [1440, 900]]) {
      await t.page.setViewportSize({ width: w, height: h });
      await t.settle(200);
      await t.audit(`window resized to ${w}x${h} with a popover open`, { shotOnFail: true });
    }
    await t.closeAll();
    // An item page: a popover open while editing a field in place: opening it ends the edit cleanly.
    await t.open(t.itemPath(ids.collections.books, ids.items["books/i0"]));
    const edit = t.page.getByRole("button", { name: "Edit Count", exact: true }).first();
    await edit.click();
    await t.settle();
    await openPopover(t, t.page.locator(".ws-pane--active .page-header").first(), "Details");
    await t.audit("details opened while a field was being edited");
    await t.check("opening a popover ends the edit in place", (await t.count(".field-editor")) === 0, "the field editor is still open");
    await t.closeAll();
  }, { viewport: vp });
}

// Popovers in two panes side by side: each works on its own pane, no ids collide.
test("popovers in two panes of the same page", async (t) => {
  await t.boot();
  const ids = await t.seed(popoverSpec());
  const list = t.listPath(ids.collections.books);
  await t.seed({ prefs: { "kubus.workspace.default": wsLayout([[list], [list]]) } });
  await t.open(list, { keepTabs: true });
  await t.audit("same page in two panes");
  for (const pane of [0, 1]) {
    const p = t.page.locator(".ws-pane").nth(pane);
    await p.locator(".views-bar").click({ position: { x: 2, y: 2 } }).catch(() => {});
    await openPopover(t, p.locator(".views-bar").first(), /^Filter/);
    const add = openPanel(t).getByRole("button", { name: "Add filter" });
    await t.popoverStep(`pane ${pane + 1}: add a rule`, () => add.click());
    await t.audit(`pane ${pane + 1}: filter popover`);
    await t.escapeCloses(`pane ${pane + 1}: filter popover`);
  }
  const marks = await t.page.locator(".views-bar").evaluateAll((bars) => bars.map((b) => b.innerText.includes("*")));
  await t.check("each pane keeps its own unsaved filter", marks.length === 2 && marks.every(Boolean), JSON.stringify(marks));
});
