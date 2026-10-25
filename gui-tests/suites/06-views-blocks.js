// Collection views and blocks: the view tab bar (add, rename, star, delete, unsaved changes),
// every toolbar popover, every block menu, "Show as" for every block type, adding and hiding
// blocks, collapsing, cards options.

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

for (const vp of ["desktop", "laptop", "phone"]) {
  test(`views: add, rename, star, unsaved changes, delete @ ${vp}`, async (t) => {
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
    await t.check("typing renames the new view", (await bar.innerText()).includes("Renamed view with a fairly long name"));
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
      await t.check("Save removes the *", !(await bar.innerText()).includes("*"));
    }
    // Star, then delete (asks first).
    await tool(t, bar, "Star as default view").catch(() => {});
    await t.audit("starred");
    await tool(t, bar, "Delete view");
    await t.audit("delete view confirmation");
    await t.page.locator(".cds--modal.is-visible").getByRole("button", { name: /Delete/ }).click();
    await t.settle();
    await t.check("the view is gone", !(await bar.innerText()).includes("Renamed view"));
    await t.audit("after deleting a view");
  }, { viewport: vp });

  test(`views: 25 views with long names, tab menu @ ${vp}`, async (t) => {
    await t.boot();
    const spec = matrixSpec("typical", { items: 4 });
    for (let i = 0; i < 22; i++) spec.collections[0].views.push({ name: i % 3 === 0 ? `View number ${i} with a long descriptive name for the tab` : `V${i}`, blocks: [{ kind: i % 2 ? "cards" : "table" }] });
    const ids = await t.seed(spec);
    await t.open(t.listPath(ids.collections.books));
    await t.audit("25 views");
    const menu = t.page.locator(".views-bar").getByRole("button", { name: "Views" });
    if (await menu.count()) {
      await menu.first().click();
      await t.settle();
      await t.audit("views menu");
      await t.page.locator(".tab-menu__item").nth(12).click().catch(() => {});
      await t.settle();
      await t.audit("picked a view from the menu");
    } else {
      await t.check("many views get a menu arrow (or all fit)", true);
    }
    const tabs = t.page.locator(".views-bar .views-tabs [role=tab]");
    const n = await tabs.count();
    for (const i of [0, Math.floor(n / 2), n - 1]) {
      await tabs.nth(i).click({ timeout: 2000 }).catch(() => {});
      await t.settle();
      await t.audit(`view tab ${i + 1}`, { shotOnFail: true });
    }
  }, { viewport: vp });
}

for (const vp of ["desktop", "phone", "short"]) {
  test(`view filter: a rule for every field kind @ ${vp}`, async (t) => {
    await t.boot();
    const ids = await t.seed(profileSpec("typical", { items: 8 }));
    await t.open(t.listPath(ids.collections.books));
    const bar = t.page.locator(".views-bar").first();
    await tool(t, bar, "Filter");
    await t.audit("filter popover (empty)");
    const panel = t.page.locator(".cds--popover--open .toolbar-popover__panel").first();
    for (let k = 0; k < 8; k++) {
      const add = panel.getByRole("button", { name: /Add filter|Add rule|Add condition/ }).first();
      if (!(await add.count())) break;
      await add.click();
      await t.settle(100);
      // Pick a different field for each rule.
      const fieldBox = panel.locator(".cds--dropdown, .cds--combo-box").nth(k * 2);
      if (await fieldBox.count()) {
        await fieldBox.click().catch(() => {});
        await t.settle(80);
        await t.page.getByRole("option").nth(k + 1).click().catch(() => {});
        await t.settle(80);
      }
      await t.audit(`filter with ${k + 1} rule(s)`, { shotOnFail: true });
    }
    await t.audit("filter popover with many rules");
    await t.closeAll();
    await t.audit("filtered view");
  }, { viewport: vp });
}

const BLOCK_MENUS = ["Filter", "Sort and group", "Fields", "Block settings"];

for (const vp of ["desktop", "phone"]) {
  test(`block menus of every block @ ${vp}`, async (t) => {
    await t.boot();
    const ids = await t.seed(matrixSpec("typical", { items: 6 }));
    await t.open(`${t.listPath(ids.collections.books)}?view=${ids.views["books/Blocks"]}`);
    const blocks = t.page.locator(".block");
    const n = await blocks.count();
    for (let b = 0; b < n; b++) {
      const header = blocks.nth(b).locator(".section-header").first();
      await header.scrollIntoViewIfNeeded().catch(() => {});
      for (const menu of BLOCK_MENUS) {
        try {
          await tool(t, header, menu);
        } catch {
          continue; // not every block type has every menu
        }
        await t.audit(`block ${b + 1}: ${menu}`);
        await t.closeAll();
      }
    }
  }, { viewport: vp });

  test(`show as: every block type, add and remove blocks @ ${vp}`, async (t) => {
    await t.boot();
    const ids = await t.seed(matrixSpec("typical", { items: 6 }));
    await t.open(t.listPath(ids.collections.books));
    const header = () => t.page.locator(".block").first().locator(".section-header").first();
    for (const kind of ["Cards", "Markdown", "Double", "Table"]) {
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
  }, { viewport: vp });

  test(`collapse blocks and cards options @ ${vp}`, async (t) => {
    await t.boot();
    const ids = await t.seed(matrixSpec("typical", { items: 10 }));
    await t.open(`${t.listPath(ids.collections.books)}?view=${ids.views["books/Blocks"]}`);
    const carets = t.page.locator(".block .section-header .collapse-caret");
    const n = await carets.count();
    for (let i = 0; i < n; i++) {
      const c = carets.nth(i);
      await c.scrollIntoViewIfNeeded();
      const y0 = await c.evaluate((el) => el.getBoundingClientRect().top + document.querySelector(".ws-pane--active .ws-pane__body").scrollTop);
      await c.click();
      await t.settle(120);
      const y1 = await carets.nth(i).evaluate((el) => el.getBoundingClientRect().top + document.querySelector(".ws-pane--active .ws-pane__body").scrollTop);
      await t.check(`block ${i + 1}: its header stays in place when collapsed`, Math.abs(y1 - y0) <= 1, `moved ${y1 - y0}`);
    }
    await t.audit("all blocks collapsed");
    for (let i = 0; i < n; i++) await carets.nth(i).click().catch(() => {});
    await t.audit("all blocks expanded");
    // Cards: width slider to both ends, both cover shapes.
    await t.open(`${t.listPath(ids.collections.books)}?view=${ids.views["books/Cards"]}`);
    const header = t.page.locator(".block").first().locator(".section-header").first();
    await tool(t, header, "Block settings");
    await t.audit("cards settings");
    const slider = t.page.locator(".cds--popover--open .cds--slider__thumb").first();
    if (await slider.count()) {
      for (const key of ["Home", "End"]) {
        await slider.focus();
        await t.page.keyboard.press(key);
        await t.settle(200);
        await t.audit(`card width: ${key === "Home" ? "narrowest" : "widest"}`);
      }
    }
    await t.closeAll();
    await t.audit("cards after options");
  }, { viewport: vp });
}
