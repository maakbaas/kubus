// Things done together: an edit in one pane shows in the other at once; one click moves an edit
// from one field (saved) to the next (opened); an edit survives a window resize, a tab switch or
// the side nav toggling; a popover stays at its button while the layout around it changes.

/** The field's value box on the item page of the active pane, by the field's name. */
const valueOf = (t, name, pane = ".ws-pane--active") => t.page.locator(`${pane} .item-fields`).getByRole("button", { name: `Edit ${name}`, exact: true }).first();

for (const vp of ["desktop", "wide"]) {
  test(`same item in two panes: an edit shows in the other pane @ ${vp}`, async (t) => {
    await t.boot();
    const ids = await t.seed(profileSpec("typical", { items: 3 }));
    const item = t.itemPath(ids.collections.books, ids.items["books/i0"]);
    await t.seed({ prefs: { "kubus.workspace.default": wsLayout([[item], [t.listPath(ids.collections.books), item]], { active: 0 }) } });
    await t.open(item, { keepTabs: true });
    await t.audit("the item in two panes");
    // Each pane sits in its own split child: numbered here, so selectors can tell them apart.
    await t.page.evaluate(() => document.querySelectorAll(".ws-pane").forEach((p, i) => p.setAttribute("data-pane", String(i))));
    const left = '.ws-pane[data-pane="0"]';
    const right = '.ws-pane[data-pane="1"]';
    // Edit Count in the left pane; the right pane's Count updates, nothing else there moves.
    const count = valueOf(t, "Count", left);
    await count.click();
    await t.editorReady();
    await t.page.keyboard.press("Control+A");
    await t.page.keyboard.type("4242");
    await t.noShift("saving in one pane moves nothing in the other", async () => {
      await t.page.keyboard.press("Enter");
      await t.page.locator(`${right} .item-fields`).getByText("4242").first().waitFor({ timeout: 5000 }).catch(() => {});
    }, { scope: `${right} .ws-pane__body`, except: [`${right} .item-fields > *:has([aria-label="Edit Count"])`] });
    await t.until("the other pane shows the saved value", async () => (await t.page.locator(`${right} .item-fields`).innerText()).includes("4242") || "4242 not in the right pane");
    // The title, edited in the right pane, renames the tabs of both panes.
    await t.page.locator(`${right} .item-title`).first().click();
    await t.editorReady(".item-title--editing");
    await t.page.keyboard.press("Control+End");
    await t.page.keyboard.type(" renamed");
    await t.page.keyboard.press("Enter");
    await t.settle();
    await t.until("both panes' tabs show the new title", async () => {
      const tabs = await t.page.locator(".ws-pane__tabs .cds--tabs__nav-item--selected").allInnerTexts();
      return (tabs.length === 2 && tabs.every((x) => x.includes("renamed"))) || JSON.stringify(tabs);
    });
    await t.audit("after editing in both panes");
  }, { viewport: vp });
}

for (const vp of ["desktop", "phone"]) {
  test(`editing in place, then elsewhere: one click saves and opens the next @ ${vp}`, async (t) => {
    await t.boot();
    const ids = await t.seed(profileSpec("typical", { items: 3 }));
    await t.open(t.itemPath(ids.collections.books, ids.items["books/i0"]));
    // Count → Date with one click: Count saved, Date's editor open.
    await valueOf(t, "Count").click();
    await t.editorReady();
    await t.page.keyboard.press("Control+A");
    await t.page.keyboard.type("77");
    const date = valueOf(t, "Date");
    await date.scrollIntoViewIfNeeded();
    await date.click({ position: await t.visiblePoint(date) });
    await t.settle();
    await t.until("the first field is saved", async () => (await t.page.locator(".ws-pane--active .item-fields").innerText()).includes("77") || "77 not shown");
    await t.until("one click opened the next field's editor", async () => (await t.count(".field-editor")) === 1 || `${await t.count(".field-editor")} editors open`);
    await t.audit("moved from one field to the next");
    await t.page.keyboard.press("Escape");
    await t.page.keyboard.press("Escape");
    await t.settle();
    // A checkbox toggled while another field is edited: the edit is saved, the box toggles.
    await valueOf(t, "Count").click();
    await t.editorReady();
    await t.page.keyboard.press("Control+A");
    await t.page.keyboard.type("88");
    const done = t.page.locator(".ws-pane--active .item-fields .checklist-row", { hasText: "Done" }).first();
    await done.scrollIntoViewIfNeeded();
    const before = await done.locator("input, [role=checkbox], .toggle-input").first().evaluate((el) => el.checked ?? el.getAttribute("aria-checked") ?? el.getAttribute("aria-pressed"));
    await done.locator("label, .toggle-input").first().click();
    await t.until("the edit is saved when a checkbox is clicked", async () => (await t.page.locator(".ws-pane--active .item-fields").innerText()).includes("88") || `88 not shown; ${await t.count(".field-editor")} editors open`);
    await t.until("the checkbox toggled with that same click", async () => {
      const after = await done.locator("input, [role=checkbox], .toggle-input").first().evaluate((el) => el.checked ?? el.getAttribute("aria-checked") ?? el.getAttribute("aria-pressed"));
      return String(before) !== String(after) || `${before} → ${after}`;
    });
    await t.settle();
    // A field being edited while its neighbour collapses: the editor stays, nothing breaks.
    await valueOf(t, "Count").click();
    await t.editorReady();
    await t.page.locator(".ws-pane--active .item-fields .collapse-caret").first().click().catch(() => {});
    await t.settle();
    await t.audit("a field collapsed while another is edited");
    await t.closeAll();
  }, { viewport: vp, smoke: vp === "desktop" });
}

// The same under load (the page's CPU 4× slower): it once failed on a busy machine, when the save
// answered after the test had looked.
test("editing in place, then elsewhere, under load (CPU 4× slower)", (t) => __tests.find((x) => x.name === "editing in place, then elsewhere: one click saves and opens the next @ desktop").fn(t), { cpu: 4, smoke: true });

test("editing in place survives a window resize, a tab switch and the side nav", async (t) => {
  await t.boot();
  const ids = await t.seed(profileSpec("typical", { items: 3 }));
  const item = t.itemPath(ids.collections.books, ids.items["books/i0"]);
  await t.seed({ prefs: { "kubus.workspace.default": wsLayout([["/collections", item]]) } });
  await t.open(item, { keepTabs: true });
  const notes = valueOf(t, "Notes");
  await notes.click({ position: await t.visiblePoint(notes) });
  await t.page.waitForSelector(".ProseMirror");
  await t.page.keyboard.press("Control+End");
  await t.page.keyboard.type(" typed before resizing");
  for (const [w, h] of [[1024, 700], [700, 900], [1440, 900]]) {
    await t.page.setViewportSize({ width: w, height: h });
    await t.settle(200);
    await t.audit(`editor open at ${w}x${h}`, { shotOnFail: true });
    await t.check(`the editor is still open at ${w}x${h}`, (await t.count(".ProseMirror")) === 1);
  }
  // The side nav toggles: the editor keeps its text.
  await t.page.getByRole("button", { name: /^(Hide|Show) menu$/ }).filter({ visible: true }).first().click();
  await t.settle();
  await t.audit("side nav toggled while editing");
  // The toggle is a click outside the editor: what was typed is saved (or still being edited).
  await t.check("the typed text is kept", (await t.page.locator(".ws-pane--active .item-fields").innerText()).includes("typed before resizing"), "the typed text is gone");
  await t.page.getByRole("button", { name: /^(Hide|Show) menu$/ }).filter({ visible: true }).first().click();
  await t.settle();
  // Switching to the other tab and back: what was typed is kept (saved, or still in the editor).
  await t.page.locator(".ws-pane__tabs .cds--tabs__nav-item").first().click();
  await t.settle();
  await t.page.locator(".ws-pane__tabs .cds--tabs__nav-item").nth(1).click();
  await t.settle();
  await t.check("switching tabs keeps what was typed", (await t.page.locator(".ws-pane--active .item-fields").innerText()).includes("typed before resizing"), "the typed text is gone");
  await t.audit("back on the item's tab");
});

for (const vp of ["desktop", "laptop"]) {
  test(`a popover stays at its button while the layout changes around it @ ${vp}`, async (t) => {
    await t.boot();
    const ids = await t.seed(matrixSpec("typical", { items: 6 }));
    await t.open(t.listPath(ids.collections.books));
    const header = t.page.locator(".ws-pane--active .block .section-header").first();
    await header.getByRole("button", { name: "Sort and group", exact: true }).click();
    await t.settle();
    await t.audit("sort and group open");
    // The side nav hides and shows: the panel follows its button.
    for (const step of ["hidden", "shown again"]) {
      await t.page.getByRole("button", { name: /^(Hide|Show) menu$/ }).filter({ visible: true }).first().click();
      await t.settle(300);
      await t.audit(`side nav ${step} with a popover open`, { shotOnFail: true });
    }
    // The global search bar opens over the strip: the popover closes or stays at its button.
    await t.page.getByRole("button", { name: "Search", exact: true }).first().click();
    await t.settle();
    await t.audit("search bar opened with a popover open", { shotOnFail: true });
    await t.closeAll();
    // A popover open while the items change (a new item from another pane, through the change feed).
    await t.seed({ prefs: { "kubus.workspace.default": wsLayout([[t.listPath(ids.collections.books)], [`/collections/${ids.collections.books}/items/new`]], { active: 0 }) } });
    await t.open(t.listPath(ids.collections.books), { keepTabs: true });
    const left = t.page.locator(".ws-pane").first();
    await left.locator(".block .section-header").first().getByRole("button", { name: "Fields", exact: true }).click();
    await t.settle();
    const before = await t.rects(".toolbar-popover.cds--popover--open .toolbar-popover__panel");
    await t.page.evaluate(async (id) => {
      const repo = window.kubus.repo;
      const c = (await repo.listCollections()).find((x) => x.id === id);
      await repo.createItem(c, { [c.fields[0].id]: "Arrived while a popover was open" }, "default");
    }, ids.collections.books);
    await t.settle(300);
    const after = await t.rects(".toolbar-popover.cds--popover--open .toolbar-popover__panel");
    await t.check("the popover stays open while new items arrive", after.length === 1, `${after.length} open panels`);
    await t.check("the popover doesn't move while new items arrive", before.length === 1 && after.length === 1 && Math.abs(before[0].y - after[0].y) <= 1 && Math.abs(before[0].x - after[0].x) <= 1, `${JSON.stringify(before)} → ${JSON.stringify(after)}`);
    await t.audit("new item arrived under an open popover");
  }, { viewport: vp });
}

// What arranges a page is kept: after a reload it looks the same.
test("arrangement survives a reload: collapsed blocks and fields, side nav, split sizes", async (t) => {
  await t.boot();
  const ids = await t.seed(matrixSpec("typical", { items: 6 }));
  const blocks = `${t.listPath(ids.collections.books)}?view=${ids.views["books/Blocks"]}`;
  await t.open(blocks);
  await t.page.locator(".block .section-header .collapse-caret").first().click();
  await t.settle();
  const collapsed = await t.count(".block .collapse-caret__chevron--collapsed");
  await t.open(blocks, { keepTabs: true });
  await t.check("a collapsed block stays collapsed after a reload", (await t.count(".block .collapse-caret__chevron--collapsed")) === collapsed && collapsed > 0, `${collapsed} collapsed before`);
  const item = t.itemPath(ids.collections.books, ids.items["books/i0"]);
  await t.open(item);
  await t.page.locator(".item-fields .collapse-caret").first().click();
  await t.settle();
  const carets = () => t.page.locator(".item-fields .collapse-caret button").evaluateAll((bs) => bs.map((b) => b.getAttribute("aria-expanded")).join(","));
  const fieldsBefore = await carets();
  await t.open(item, { keepTabs: true });
  const fieldsAfter = await carets();
  await t.check("a collapsed field stays collapsed after a reload", fieldsAfter === fieldsBefore && fieldsBefore.includes("false"), `${fieldsBefore} → ${fieldsAfter}`);
  await t.audit("item page after a reload");
});
