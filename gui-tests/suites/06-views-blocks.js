// Collection views and blocks: the view tab bar (add, rename, star, unsaved changes, delete) and "Show as"
// for every block type, adding and removing blocks.

async function tool(t, scope, label) {
  const direct = scope.getByRole("button", { name: label, exact: true }).filter({ visible: true }).first();
  if (await direct.count()) {
    await direct.click();
    // A panel that closed again at once (its block re-rendered): open it once more.
    await t.settle(150);
    if ((await direct.getAttribute("aria-expanded", { timeout: 500 }).catch(() => null)) === "false") await direct.click();
  } else {
    const more = scope.getByRole("button", { name: "More actions" }).filter({ visible: true }).first();
    if (!(await more.count())) throw new Error(`no "${label}" and no "More actions"`);
    await more.click();
    await t.settle(100);
    await t.page.getByRole("button", { name: label, exact: true }).filter({ visible: true }).last().click();
  }
  await t.settle(150);
}

test("views: add, rename, star, unsaved changes, delete @ desktop", async (t) => {
  await t.boot();
  const ids = await t.seed(matrixSpec("typical", { items: 6 }));
  await t.open(t.listPath(ids.collections.books));
  const bar = t.page.locator(".views-bar").first();
  await t.audit("views bar");
  // "+": a new view, with View settings open and its name selected.
  await tool(t, bar, "Add view");
  await t.settle();
  await t.audit("new view: settings open");
  await t.page.keyboard.type("Renamed view with a fairly long name");
  await t.page.keyboard.press("Enter");
  await t.closeAll();
  await t.settle();
  await t.until("typing renames the new view", async () => (await bar.innerText()).includes("Renamed view with a fairly long name"));
  await t.audit("renamed");
  // Unsaved change: a filter rule; the tabs must not move when "*" and Save / Discard appear.
  const tabsBefore = await t.rects(".views-bar .views-tabs [role=tab]");
  await tool(t, t.page.locator(".block").first(), "Sort and group");
  await t.audit("sort and group popover");
  await t.closeAll();
  await tool(t, bar, "Filter");
  await t.page.locator(".cds--popover--open").getByRole("button", { name: /Add filter/ }).first().click();
  await t.settle();
  await t.closeAll();
  await t.settle();
  const changed = (await bar.innerText()).includes("*");
  await t.check("a changed view is marked with *", changed, "no * in the views bar");
  const tabsAfter = await t.rects(".views-bar .views-tabs [role=tab]");
  await t.check("the view tabs keep their place when Save / Discard appear", tabsBefore.length === tabsAfter.length && tabsBefore.every((r, i) => Math.abs(r.x - tabsAfter[i].x) <= 1), `${JSON.stringify(tabsBefore.map((r) => Math.round(r.x)))} → ${JSON.stringify(tabsAfter.map((r) => Math.round(r.x)))}`);
  await t.audit("view with unsaved changes");
  if (changed) {
    await tool(t, bar, "Save changes to view").catch(() => t.fail("Save changes to view is offered", "no Save button"));
    await t.until("Save removes the *", async () => !(await bar.innerText()).includes("*"));
  }
  // Star, then delete (asks first).
  await tool(t, bar, "Star as default view").catch(() => {});
  await t.audit("starred");
  await tool(t, bar, "Delete view");
  await t.audit("delete view confirmation");
  await t.page.locator(".cds--modal.is-visible").getByRole("button", { name: /Delete/ }).click();
  await t.settle();
  await t.until("the view is gone", async () => !(await bar.innerText()).includes("Renamed view"));
  await t.audit("after deleting a view");
}, { viewport: "desktop" });

test("show as: every block type, add and remove blocks @ desktop", async (t) => {
  await t.boot();
  const ids = await t.seed(matrixSpec("typical", { items: 6 }));
  await t.open(t.listPath(ids.collections.books));
  const header = () => t.page.locator(".block").first().locator(".section-header").first();
  for (const kind of ["Cards", "Chart", "Markdown", "Double", "Table"]) {
    await tool(t, header(), "Block settings");
    const showAs = t.page.locator(".cds--popover--open").getByRole("combobox").first();
    if (!(await showAs.count())) {
      await t.fail(`Show as ${kind}`, "no Show as control in Block settings");
      await t.closeAll();
      continue;
    }
    await showAs.click();
    await t.settle(100);
    await t.audit(`Show as menu (${kind})`);
    const option = t.page.getByRole("option", { name: new RegExp(kind) }).first();
    if (await option.count()) await option.click();
    await t.closeAll();
    await t.settle();
    await t.audit(`shown as ${kind}`);
  }
  // Add a block of every kind from View settings.
  const bar = t.page.locator(".views-bar").first();
  for (let i = 0; i < 4; i++) {
    await tool(t, bar, "View settings");
    // "Add block" is a menu button: a menu of the block types and the components that fit.
    await t.page.locator(".cds--popover--open").getByRole("button", { name: "Add block" }).first().click();
    await t.settle(100);
    await t.audit(`add block menu (${i + 1})`);
    await t.page.getByRole("menuitem").nth(i).click().catch(() => {});
    await t.closeAll();
    await t.settle();
  }
  await t.audit("five blocks");
  const count = await t.count(".block");
  await t.check(`blocks were added (${count})`, count >= 4, `${count} blocks`);
  // Hide every block's header (tag icon in View settings), then show them again.
  await tool(t, bar, "View settings");
  const tags = t.page.locator(".cds--popover--open").getByRole("button", { name: /header|name/i });
  const tn = await tags.count();
  for (let i = 0; i < tn; i++) await tags.nth(i).click().catch(() => {});
  await t.closeAll();
  await t.settle();
  await t.audit("headers hidden");
  // Remove a block (asks first).
  await tool(t, bar, "View settings");
  const remove = t.page.locator(".cds--popover--open").getByRole("button", { name: /Remove/ }).first();
  if (await remove.count()) {
    await remove.click();
    await t.settle();
    await t.audit("remove block confirmation");
    await t.closeAll();
  }
}, { viewport: "desktop" });
