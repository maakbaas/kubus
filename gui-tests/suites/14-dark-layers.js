// Every floating layer in the dark theme: toolbar popovers, "⋮" menus, dropdown menus, tooltips
// and dialogs drawn on the g100 theme, each audited (contrast and theme colours included) while
// open, with a control inside it hovered.

/** Opens a panel, audits it with its first control hovered, closes it. */
async function auditPanel(t, label, scope, button) {
  try {
    await t.openPanel(scope, button);
  } catch {
    return t.fail(`${label}: can be opened`, `no "${button}" button`);
  }
  await t.audit(`${label} open`);
  const first = t.page.locator(".toolbar-popover.cds--popover--open .toolbar-popover__panel").last().locator("button, input, select").first();
  if (await first.count()) {
    await first.hover().catch(() => {});
    await t.wait(200);
    await t.audit(`${label} with a control hovered`, { settle: false });
  }
  await t.closeAll();
}

for (const vp of ["desktop"]) {
  test(`dark theme: every popover, menu and dialog @ ${vp}`, async (t) => {
    await t.boot();
    const spec = matrixSpec("typical", { items: 6 });
    spec.spaces = [{ key: "w", name: "Work" }];
    const ids = await t.seed(spec);
    const books = ids.collections.books;
    // Collection page: the view's panels and every block menu.
    await t.open(`${t.listPath(books)}?view=${ids.views["books/Blocks"]}`);
    const bar = t.page.locator(".ws-pane--active .views-bar").first();
    for (const b of ["Filter", "View settings"]) await auditPanel(t, `view ${b}`, bar, b);
    // The table block (the first is a Markdown block, which has no filter or fields).
    const header = t.page.locator(".ws-pane--active .block:has(.items-table) .section-header").first();
    for (const b of ["Filter", "Sort and group", "Fields", "Block settings"]) await auditPanel(t, `block ${b}`, header, b);
    // A dropdown menu inside a panel (Show as).
    await t.openPanel(header, "Block settings");
    await t.page.locator(".toolbar-popover.cds--popover--open .cds--dropdown button").first().click();
    await t.settle();
    await t.audit("Show as menu");
    await t.closeAll();
    // Add block menu.
    await t.openPanel(bar, "View settings");
    await t.page.locator(".toolbar-popover.cds--popover--open").getByRole("button", { name: "Add block" }).click();
    await t.settle();
    await t.audit("Add block menu");
    await t.closeAll();
    // Tooltips of the views bar's icons.
    const icons = bar.locator(".cds--btn--icon-only").filter({ visible: true });
    for (let i = 0; i < Math.min(await icons.count(), 4); i++) {
      await icons.nth(i).hover();
      await t.wait(300);
      await t.audit(`tooltip ${i + 1} of the views bar`, { settle: false });
    }
    await t.page.mouse.move(1, t.vp.height - 2);
    // Item page: layout, details (with the space dropdown), a delete confirmation.
    await t.open(t.itemPath(books, ids.items["books/i0"]));
    const ph = t.page.locator(".ws-pane--active .page-header").first();
    await auditPanel(t, "page layout", ph, "Page layout");
    await t.openPanel(ph, "Details");
    const space = t.page.locator(".toolbar-popover.cds--popover--open .cds--dropdown button").first();
    if (await space.count()) {
      await space.click();
      await t.settle();
      await t.audit("space dropdown in details");
    }
    await t.closeAll();
    await t.openPanel(ph, "Delete Book").catch(() => {});
    await t.settle();
    await t.audit("delete confirmation");
    await t.closeAll();
    // Field dialogs: add field (every field type's inputs), its type menu.
    await t.open(t.listPath(books));
    await t.openPanel(t.page.locator(".ws-pane--active .block .section-header").first(), "Fields");
    await t.page.locator(".toolbar-popover.cds--popover--open").getByRole("button", { name: "Add field" }).click();
    await t.settle();
    await t.audit("add field dialog");
    await t.page.locator(".cds--modal.is-visible .cds--dropdown button, .cds--modal.is-visible .cds--list-box__field").first().click();
    await t.settle();
    await t.audit("field type menu");
    await t.closeAll();
    // Bookmarks: new bookmark dialog; search bar; sync popover; space switcher.
    await t.open("/bookmarks");
    await t.page.getByRole("button", { name: "New bookmark" }).filter({ visible: true }).first().click();
    await t.settle();
    await t.audit("new bookmark dialog");
    await t.closeAll();
    await t.page.getByRole("button", { name: "Search", exact: true }).first().click();
    await t.page.keyboard.type("the");
    await t.settle(400);
    await t.audit("search bar with results");
    await t.closeAll();
    await t.page.locator("button.sync-status").first().click();
    await t.settle();
    await t.audit("sync popover");
    await t.closeAll();
    // Markdown editor's link popover and a chip's code dialog.
    await t.open(t.itemPath(books, ids.items["books/i0"]));
    const notes = t.page.getByRole("button", { name: "Edit Notes", exact: true }).first();
    await notes.click({ position: await t.visiblePoint(notes) });
    await t.page.waitForSelector(".ProseMirror");
    const link = t.page.locator(".ProseMirror a").first();
    if (await link.count()) {
      await link.hover();
      await t.wait(500);
      await t.audit("markdown link popover");
    }
    await t.page.keyboard.press("Escape");
  }, { viewport: vp, dark: true });
}
