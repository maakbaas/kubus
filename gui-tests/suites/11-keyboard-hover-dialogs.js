// Keyboard, hover and dialogs. Tab walks through every page: each stop is in sight (not off screen,
// not under a sticky bar), is drawn with a focus indicator, is never a control that isn't shown
// (a closed side nav, a hidden tab) and focus never gets stuck. Dialogs keep focus inside while
// open and give it back to what opened them. Hovering any control moves nothing. Typing and
// choosing in dialogs moves neither the dialog nor the control in use.

/** Opens a block's Fields popover (through its "⋮" menu on phones). */
async function openFields(t) {
  const header = t.page.locator(".ws-pane--active .block .section-header").first();
  const direct = header.getByRole("button", { name: "Fields", exact: true }).filter({ visible: true });
  if (!(await direct.count())) {
    await header.getByRole("button", { name: "More actions" }).first().click();
    await t.settle(100);
  }
  await header.getByRole("button", { name: "Fields", exact: true }).filter({ visible: true }).first().click();
  await t.settle(150);
}

const KB_PAGES = [
  ["collections", () => "/collections"],
  ["collection table", (ids) => `/collections/${ids.collections.books}/items`],
  ["collection blocks", (ids) => `/collections/${ids.collections.books}/items?view=${ids.views["books/Blocks"]}`],
  ["item page", (ids) => `/collections/${ids.collections.books}/items/${ids.items["books/i0"]}`],
  ["new item", (ids) => `/collections/${ids.collections.books}/items/new`],
  ["collection editor", (ids) => `/collections/${ids.collections.books}/edit`],
  ["components", () => "/components"],
  ["component editor", (ids) => `/components/${ids.components.double}`],
  ["spaces", () => "/spaces"],
  ["bookmarks", () => "/bookmarks"],
  ["settings", () => "/settings?section=ai"],
];

/** Tabs through a page (up to `max` stops), checking every stop; Shift+Tab back a few. */
async function tabWalk(t, label, max = 45) {
  await t.page.mouse.move(1, t.vp.height - 2);
  // Start from the page, not the address bar: focus the pane's first element.
  await t.page.locator(".ws-pane--active .ws-pane__body").evaluate((el) => {
    el.setAttribute("tabindex", "-1");
    el.focus();
    el.removeAttribute("tabindex");
  });
  const problems = { sight: [], indicator: [], stuck: [], hidden: [] };
  const seen = [];
  let last = 0;
  for (let i = 0; i < max; i++) {
    await t.page.keyboard.press("Tab");
    await t.wait(60);
    const f = await t.focusInfo();
    if (f.none) continue;
    // A dialog opened (a Tab on something rarely opens one): stop walking the page.
    if (f.inDialog) break;
    if (f.id === last && f.what.includes("code-editor__input")) {
      // A code editor indents with Tab; Escape first lets the next Tab leave it.
      await t.page.keyboard.press("Escape");
      await t.page.keyboard.press("Tab");
      await t.wait(60);
      const g = await t.focusInfo();
      if (g.id === f.id) problems.stuck.push(`${f.what} (also after Escape)`);
      last = g.id;
      continue;
    }
    if (f.id === last) problems.stuck.push(f.what);
    last = f.id;
    seen.push(f.what);
    if (f.sideNav && t.vp.width < 1056 && !(await t.page.locator(".cds--side-nav--expanded").count())) problems.hidden.push(f.what);
    else if (!f.inSight) problems.sight.push(`${f.what}${f.under ? ` (under ${f.under})` : ""}`);
    if (f.indicator === false) problems.indicator.push(f.what);
  }
  const uniq = (a) => [...new Set(a)];
  await t.check(`${label}: every Tab stop is in sight`, problems.sight.length === 0, uniq(problems.sight).slice(0, 8).join("\n"));
  await t.check(`${label}: every Tab stop shows that it has focus`, problems.indicator.length === 0, uniq(problems.indicator).slice(0, 8).join("\n"));
  await t.check(`${label}: Tab never stops on a control that isn't shown (closed side nav)`, problems.hidden.length === 0, uniq(problems.hidden).slice(0, 8).join("\n"));
  await t.check(`${label}: Tab moves on every time (${seen.length} stops)`, problems.stuck.length === 0 && seen.length > 0, `${problems.stuck.length} presses kept the focus on: ${uniq(problems.stuck).join("; ")}`);
  // The page itself after the walk: tooltips of the last stop and focus rings stay in order.
  await t.audit(`${label}: after tabbing`, { focus: true, shotOnFail: true });
  // Shift+Tab walks back.
  const before = await t.focusInfo();
  await t.page.keyboard.press("Shift+Tab");
  await t.wait(60);
  const back = await t.focusInfo();
  await t.check(`${label}: Shift+Tab moves back`, back.id !== before.id, `focus stayed on ${back.what}`);
}

for (const vp of ["desktop"]) {
  test(`keyboard: Tab through every page @ ${vp}`, async (t) => {
    await t.boot();
    const ids = await t.seed(matrixSpec("typical", { items: 5 }));
    for (const [label, path] of KB_PAGES) {
      await t.open(path(ids));
      await tabWalk(t, label);
    }
  }, { viewport: vp, smoke: vp === "desktop" });
}

/** Opens a dialog with `open`, then checks focus is inside, Tab stays inside, Escape closes and focus returns. */
async function dialogKeys(t, label, open, { returnFocus = true } = {}) {
  await t.page.mouse.move(1, t.vp.height - 2);
  const opener = await open();
  await t.settle();
  const isOpen = (await t.count(".cds--modal.is-visible")) > 0;
  if (!(await t.check(`${label}: the dialog opens`, isOpen))) return;
  await t.audit(`${label}: dialog`, { focus: true });
  const inside = () => t.page.evaluate(() => !!document.activeElement?.closest(".cds--modal.is-visible"));
  await t.check(`${label}: focus moves into the dialog`, await inside(), "focus stayed outside");
  let out = 0;
  for (let i = 0; i < 12; i++) {
    await t.page.keyboard.press("Tab");
    await t.wait(40);
    if (!(await inside())) out++;
  }
  await t.check(`${label}: Tab keeps focus inside the dialog`, out === 0, `${out} of 12 Tabs left the dialog`);
  for (let i = 0; i < 4; i++) {
    await t.page.keyboard.press("Shift+Tab");
    await t.wait(40);
    if (!(await inside())) out++;
  }
  await t.check(`${label}: Shift+Tab keeps focus inside the dialog`, out === 0, `${out} Shift+Tabs left the dialog`);
  await t.page.keyboard.press("Escape");
  await t.settle();
  // A tooltip shown for the focused control (the close button's) takes the first Escape.
  if ((await t.count(".cds--modal.is-visible")) > 0 && (await t.page.evaluate(() => !!document.activeElement?.closest(".cds--popover-container")))) {
    await t.page.keyboard.press("Escape");
    await t.settle();
  }
  await t.check(`${label}: Escape closes the dialog`, (await t.count(".cds--modal.is-visible")) === 0);
  if (returnFocus && opener) {
    const back = await opener.evaluate((el) => el === document.activeElement || el.contains(document.activeElement)).catch(() => false);
    await t.check(`${label}: focus returns to what opened the dialog`, back, `focus is on ${(await t.focusInfo()).what}`);
  }
}

for (const vp of ["phone"]) {
  test(`dialogs: focus inside, Tab trapped, Escape returns focus @ ${vp}`, async (t) => {
    await t.boot();
    const ids = await t.seed(matrixSpec("typical", { items: 5 }));
    const books = ids.collections.books;
    // Delete an item: the confirmation.
    await t.open(t.itemPath(books, ids.items["books/i1"]));
    await dialogKeys(t, "delete item confirmation", async () => {
      let b = t.page.getByRole("button", { name: "Delete Book", exact: true }).filter({ visible: true }).first();
      if (!(await b.count())) {
        await t.page.locator(".ws-pane--active .page-header").getByRole("button", { name: "More actions" }).first().click();
        await t.settle(100);
        b = t.page.getByRole("button", { name: "Delete Book", exact: true }).filter({ visible: true }).first();
      }
      await b.focus();
      await t.page.keyboard.press("Enter");
      return b;
    }, { returnFocus: !t.phone });
    // New bookmark.
    await t.open("/bookmarks");
    await dialogKeys(t, "new bookmark", async () => {
      const b = t.page.getByRole("button", { name: "New bookmark" }).filter({ visible: true }).first();
      await b.focus();
      await t.page.keyboard.press("Enter");
      return b;
    });
    // Add field from a block's Fields popover (a dialog over a popover).
    await t.open(t.listPath(books));
    await dialogKeys(t, "add field over the fields popover", async () => {
      await openFields(t);
      const b = t.page.locator(".toolbar-popover.cds--popover--open").getByRole("button", { name: "Add field" });
      await b.focus();
      await t.page.keyboard.press("Enter");
      return b;
    });
    await t.check("closing the dialog keeps the popover it came from open", (await t.count(".toolbar-popover.cds--popover--open")) === 1);
    await t.closeAll();
  }, { viewport: vp });
}

/** Hovers each visible control of a page (up to `max`): nothing on the page may move. */
async function hoverNoShift(t, label, max = 30) {
  const n = await t.page.evaluate(() => {
    let i = 0;
    for (const el of document.querySelectorAll("[data-hover]")) el.removeAttribute("data-hover");
    const pane = document.querySelector(".ws-pane--active .ws-pane__body");
    for (const el of document.querySelectorAll(".ws-pane--active button, .ws-pane--active a[href], .ws-pane--active [role=tab], .ws-pane--active .cell-editable, .ws-pane--active .view-field__value, .ws-pane--active tbody tr, .ws-pane--active .item-card")) {
      if (!el.checkVisibility({ visibilityProperty: true, opacityProperty: true })) continue;
      const r = el.getBoundingClientRect();
      const p = pane.getBoundingClientRect();
      if (r.width < 4 || r.height < 4 || r.top < p.top || r.bottom > p.bottom) continue;
      // Not one scrolled out of sight sideways (a table's far columns): hovering it would scroll it into view, and that moves things.
      let hidden = false;
      for (let a = el.parentElement; a && !hidden; a = a.parentElement) {
        if (getComputedStyle(a).overflowX === "visible") continue;
        const ar = a.getBoundingClientRect();
        hidden = r.left < ar.left - 1 || r.right > ar.right + 1;
      }
      if (hidden) continue;
      el.setAttribute("data-hover", String(i++));
    }
    return i;
  });
  const moved = [];
  for (let i = 0; i < Math.min(n, max); i++) {
    const loc = t.page.locator(`[data-hover="${i}"]`);
    if (!(await loc.count())) continue;
    const name = ((await loc.getAttribute("aria-label").catch(() => "")) || (await loc.innerText().catch(() => "")) || `#${i}`).trim().replace(/\s+/g, " ").slice(0, 40);
    const ok = await t.noShift(`${label}: hovering "${name}" moves nothing`, async () => {
      await loc.hover({ timeout: 2000, position: { x: 3, y: 3 } }).catch(() => {});
      await t.wait(150);
    }, { scope: ".ws-pane--active .ws-pane__body", settle: false });
    if (!ok) moved.push(name);
    await t.page.mouse.move(1, t.vp.height - 2);
  }
  return moved;
}

for (const vp of ["desktop"]) {
  test(`hover: no control moves anything when hovered @ ${vp}`, async (t) => {
    await t.boot();
    const ids = await t.seed(matrixSpec("typical", { items: 5 }));
    for (const [label, path] of KB_PAGES.slice(0, 7)) {
      await t.open(path(ids));
      await hoverNoShift(t, label);
    }
  }, { viewport: vp });
}

// Dialogs in use: typing and choosing in them moves neither the dialog nor the control in use.
for (const vp of ["desktop"]) {
  test(`dialogs in use: add field, new bookmark @ ${vp}`, async (t) => {
    await t.boot();
    const ids = await t.seed(matrixSpec("typical", { items: 5 }));
    await t.open(t.listPath(ids.collections.books));
    await openFields(t);
    await t.page.locator(".toolbar-popover.cds--popover--open").getByRole("button", { name: "Add field" }).click();
    await t.settle();
    await t.audit("add field dialog");
    const modal = t.page.locator(".cds--modal.is-visible");
    const name = modal.getByRole("textbox").first();
    await name.click();
    await t.dialogStep("typing the field's name", () => t.page.keyboard.type("A new field", { delay: 20 }), { target: name });
    // Every field type: the dialog grows or shrinks below, never moves.
    const type = modal.locator(".cds--dropdown, .cds--list-box").first();
    for (const kind of ["Item", "Component", "Checkbox", "List of items", "Number", "String"]) {
      await type.click();
      await t.settle(100);
      const opt = t.page.getByRole("option", { name: kind, exact: true }).first();
      if (!(await opt.count())) {
        await t.page.keyboard.press("Escape");
        continue;
      }
      await t.dialogStep(`field type → ${kind}`, () => opt.click(), { target: type });
      await t.audit(`add field dialog: ${kind}`, { shotOnFail: true });
    }
    await t.page.keyboard.press("Escape");
    await t.settle();
    await t.closeAll();
    // New bookmark: pick a collection, a target, type a label.
    await t.open("/bookmarks");
    await t.page.getByRole("button", { name: "New bookmark" }).filter({ visible: true }).first().click();
    await t.settle();
    const bm = t.page.locator(".cds--modal.is-visible");
    const boxes = bm.locator(".cds--dropdown, .cds--combo-box, .cds--list-box");
    for (let i = 0; i < Math.min(await boxes.count(), 3); i++) {
      const box = boxes.nth(i);
      await box.click().catch(() => {});
      await t.settle(100);
      const opt = t.page.getByRole("option").nth(1);
      if (!(await opt.count())) {
        await t.page.keyboard.press("Escape");
        continue;
      }
      await t.dialogStep(`new bookmark: choice ${i + 1}`, () => opt.click(), { target: box });
    }
    const text = bm.getByRole("textbox").last();
    if (await text.count()) {
      await text.click();
      await t.dialogStep("new bookmark: typing a label", () => t.page.keyboard.type("A label for the bookmark", { delay: 20 }), { target: text });
    }
    await t.audit("new bookmark dialog filled");
    await t.closeAll();
  }, { viewport: vp });
}
