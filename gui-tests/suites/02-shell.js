// The shell: side nav, space switcher, global search, sync status, tab strips, panes and splits.

/** Checks the tab-width rules of every tab strip (docs/views-and-workspace.md, "Tab width"). */
async function checkTabRules(t, label) {
  const problems = await t.page.evaluate(() => {
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
    const out = [];
    for (const strip of document.querySelectorAll(".ws-pane__tabs")) {
      if (!strip.checkVisibility()) continue;
      const list = strip.querySelector(".cds--tab--list");
      if (!list) continue;
      const items = [...strip.querySelectorAll(".cds--tabs__nav-item")].filter((i) => i.checkVisibility());
      // Clipped: even at their least width the tabs don't fit; the list then shows the active tab
      // (and a menu arrow lists them all).
      const clipped = list.scrollWidth > list.clientWidth + 1;
      const info = items.map((item) => {
        const l = item.querySelector(".cds--tabs__nav-item-label");
        return { item, w: item.getBoundingClientRect().width, cut: l.scrollWidth > l.clientWidth + 1, text: l.textContent, lw: l.clientWidth, selected: item.classList.contains("cds--tabs__nav-item--selected") };
      });
      for (const i of info) {
        if (i.w > 16 * rem + 1) out.push(`tab "${i.text}" is ${Math.round(i.w)}px wide, more than 16rem`);
        if (i.cut && i.lw < 6 * rem - 1 && !clipped) out.push(`tab "${i.text}" is cut to ${Math.round(i.lw)}px of text, less than 6rem`);
      }
      const cut = info.filter((i) => i.cut);
      if (cut.length && !clipped) {
        // Cut only when needed: the strip has no room left that would let them grow.
        const listRect = list.getBoundingClientRect();
        const used = info.reduce((a, i) => a + i.w, 0);
        const free = listRect.width - used;
        if (free > 24) out.push(`${cut.length} tab(s) cut while ${Math.round(free)}px of the tab list is free`);
        // Longest cut first: an uncut tab is never wider than a cut one.
        const cutW = Math.min(...cut.map((i) => i.w));
        for (const i of info) if (!i.cut && i.w > cutW + 2) out.push(`uncut tab "${i.text}" (${Math.round(i.w)}px) is wider than cut tabs (${Math.round(cutW)}px)`);
      }
      // The active tab is shown whole within the strip.
      const active = info.find((i) => i.selected);
      if (active) {
        const r = active.item.getBoundingClientRect();
        const lr = list.getBoundingClientRect();
        if (r.left < lr.left - 1 || r.right > lr.right + 1) out.push(`active tab "${active.text}" is scrolled out of the strip`);
      }
    }
    return out;
  });
  await t.check(`${label}: tab width rules`, problems.length === 0, problems.join("\n"));
}

const SHELL_VPS = ["desktop", "phone"];

for (const vp of SHELL_VPS) {
  test(`side nav: toggle, branches, many long collections @ ${vp}`, async (t) => {
    await t.boot();
    await t.seed(profileSpec("long", { items: 3, collectionsExtra: 40 }));
    await t.open("/collections");
    await t.audit("start");
    const toggle = () => t.page.getByRole("button", { name: /^(Hide|Show) menu$/ }).filter({ visible: true }).first();
    // Phones and narrow windows: the nav is an overlay, opened from the toggle.
    await toggle().click();
    await t.settle();
    await t.audit("after toggling the menu");
    const expanded = await t.page.locator(".cds--side-nav--expanded").count();
    await t.check("menu toggles its expanded state", t.vp.width >= 1056 ? expanded === 0 : expanded === 1, `expanded navs: ${expanded}`);
    if (t.vp.width < 1056) {
      // Collapse each branch, then expand them again.
      for (const pass of ["collapsed", "expanded again"]) {
        for (const name of ["Bookmarks", "Collections"]) {
          await t.page.locator(".nav-tree > li", { hasText: name }).first().locator(".cds--tree-parent-node__toggle").first().click().catch(() => {});
          await t.settle(100);
        }
        await t.audit(`branches ${pass}`);
      }
      // Overlay click closes it.
      await t.page.mouse.click(t.vp.width - 10, t.vp.height / 2);
      await t.settle();
      await t.check("clicking beside the overlay nav closes it", (await t.page.locator(".cds--side-nav--expanded").count()) === 0);
    } else {
      await toggle().click();
      await t.settle();
      await t.audit("menu shown again");
      // Scroll the long tree to the bottom: footer stays pinned, nothing overflows.
      await t.page.locator(".side-nav-tree").evaluate((el) => (el.scrollTop = el.scrollHeight));
      await t.audit("tree scrolled to the end");
    }
    // Open a collection from the nav.
    if (t.vp.width < 1056) await toggle().click();
    await t.page.locator(".nav-tree").getByText("Authors", { exact: true }).first().click();
    await t.settle();
    await t.check("nav link opens the collection", (await t.page.locator(".page-header__title", { hasText: "Authors" }).count()) > 0);
    await t.audit("collection opened from the nav");
  }, { viewport: vp });
}

test("side nav: resize gutter limits and reset", async (t) => {
  await t.boot();
  await t.seed(profileSpec("typical", { items: 2 }));
  await t.open("/collections");
  const gutter = t.page.getByRole("separator", { name: "Resize menu" });
  const navWidth = () => t.page.locator(".cds--side-nav").evaluate((el) => el.getBoundingClientRect().width);
  const before = await navWidth();
  const box = await gutter.boundingBox();
  for (const [x, expect, label] of [[800, 32 * 16, "dragged far right: capped at 32rem"], [50, 12 * 16, "dragged far left: at least 12rem"], [300, 300, "dragged to 300px"]]) {
    Object.assign(box, await gutter.boundingBox());
    await t.page.mouse.move(box.x + box.width / 2, box.y + 200);
    await t.page.mouse.down();
    await t.page.mouse.move(x, box.y + 210, { steps: 6 });
    await t.page.mouse.up();
    await t.settle();
    const w = await navWidth();
    await t.check(`${label} (${Math.round(w)}px)`, Math.abs(w - expect) <= 3, `nav is ${w}px, expected ${expect}px`);
    await t.audit(label);
  }
  await t.page.getByRole("separator", { name: "Resize menu" }).dblclick();
  await t.settle();
  const reset = await navWidth();
  await t.check("double click resets the width", Math.abs(reset - before) <= 2, `${reset} vs ${before}`);
  // Remembered across reloads.
  await t.page.mouse.move((await gutter.boundingBox()).x + 2, box.y + 200);
  await t.page.mouse.down();
  await t.page.mouse.move(400, box.y + 200, { steps: 4 });
  await t.page.mouse.up();
  await t.open("/collections", { keepTabs: true });
  await t.check("nav width is remembered", Math.abs((await navWidth()) - 400) <= 3, `${await navWidth()}`);
});

for (const vp of ["phone"]) {
  test(`space switcher, global search, sync status @ ${vp}`, async (t) => {
    await t.boot();
    await t.seed({ ...profileSpec("long", { items: 6 }), spaces: [{ key: "w", name: "Work space with a rather long name for the switcher" }, { key: "p", name: "Private" }, { key: "x", name: "日本語スペース 🚀" }] });
    await t.open("/collections");
    if (t.phone) await t.page.getByRole("button", { name: "Show menu" }).first().click();
    await t.settle();
    // The space dropdown.
    await t.page.locator(".side-nav-search .cds--dropdown button").first().click();
    await t.settle();
    await t.audit("space menu open");
    await t.page.getByRole("option", { name: /Work space/ }).click();
    await t.settle();
    await t.audit("switched to a space with a long name");
    await t.until("switched space shows its (empty) collections list", async () => (await t.page.locator(".side-nav-search").innerText()).includes("Work space"));
    // Back to the default space.
    if (t.phone && !(await t.page.locator(".cds--side-nav--expanded").count())) await t.page.getByRole("button", { name: "Show menu" }).first().click();
    await t.page.locator(".side-nav-search .cds--dropdown button").first().click();
    await t.page.getByRole("option", { name: /^Space$/ }).click();
    await t.settle();
    if (t.phone && (await t.page.locator(".cds--side-nav--expanded").count())) await t.page.getByRole("button", { name: "Hide menu" }).first().click();

    // Global search: open, type, results, close with Escape.
    await t.page.getByRole("button", { name: "Search", exact: true }).first().click();
    await t.settle();
    await t.audit("search bar open (empty)");
    await t.page.keyboard.type("Proceedings");
    await t.settle(400);
    await t.audit("search with long results");
    await t.until("search shows results", async () => (await t.page.locator(".ws-pane--active .ws-tab-slot:not([hidden])").innerText()).includes("Proceedings"));
    await t.page.keyboard.press("Control+A");
    await t.page.keyboard.type("zzzz-nothing");
    await t.settle(400);
    await t.audit("search without results");
    await t.page.keyboard.press("Escape");
    await t.settle();
    await t.audit("search closed");

    // Sync status popover.
    await t.page.locator("button.sync-status").first().click();
    await t.settle();
    await t.audit("sync status popover");
    await t.closeAll();
  }, { viewport: vp });
}

for (const vp of ["desktop", "phone"]) {
  test(`many tabs with long titles @ ${vp}`, async (t) => {
    await t.boot();
    const ids = await t.seed(profileSpec("long", { items: 10 }));
    const books = ids.collections.books;
    const paths = ["/collections", `/collections/${books}/items`, "/components", "/help", "/settings", ...Array.from({ length: 10 }, (_, i) => t.itemPath(books, ids.items[`books/i${i}`]))];
    for (const count of [2, 4, 8, 15]) {
      await t.seed({ prefs: { "kubus.workspace.default": wsLayout([paths.slice(0, count)]) } });
      await t.open(paths[count - 1], { keepTabs: true });
      await t.wait(300);
      await t.audit(`${count} tabs`);
      await checkTabRules(t, `${count} tabs`);
    }
    // Click through the tabs: the strip must not jump around (active tab whole, the rest keeps place unless clipped).
    const tabs = t.page.locator(".ws-pane__tabs .cds--tabs__nav-item");
    const n = await tabs.count();
    for (const i of [0, Math.floor(n / 2), n - 1]) {
      await tabs.nth(i).click().catch(() => {});
      await t.settle();
      await checkTabRules(t, `tab ${i + 1} of ${n} selected`);
    }
    await t.audit("after switching tabs");
    // The menu arrow lists every tab when they are clipped.
    const menu = t.page.getByRole("button", { name: "Open pages" });
    if (await menu.count()) {
      await menu.first().click();
      await t.settle();
      await t.audit("open pages menu");
      await t.closeAll();
    }
    // Close tabs one by one with their close button until a few remain.
    for (let k = 0; k < 6; k++) {
      await t.page.locator(".cds--tabs__nav-item--close-icon").first().click().catch(() => {});
      await t.settle(120);
    }
    await t.audit("after closing six tabs");
    await checkTabRules(t, "after closing six tabs");
  }, { viewport: vp });
}

test("tabs: new, middle click close, close all, history", async (t) => {
  await t.boot();
  const ids = await t.seed(profileSpec("typical", { items: 4 }));
  await t.open("/collections");
  await t.page.getByRole("button", { name: "New tab" }).first().click();
  await t.settle();
  await t.check("+ opens a new tab", (await t.count(".ws-pane__tabs .cds--tabs__nav-item")) === 2);
  // Middle click closes a tab: the new one (it opened Home), the collections page stays.
  await t.page.locator(".ws-pane__tabs .cds--tabs__nav-item").last().click({ button: "middle" });
  await t.settle();
  await t.check("middle click closes the tab", (await t.count(".ws-pane__tabs .cds--tabs__nav-item")) === 1);
  // Navigate within the tab, then back / forward with Alt+arrows.
  await t.page.getByRole("link", { name: "Books" }).first().click();
  await t.settle();
  const linkText = (await t.page.locator(".items-table a.cds--link").first().innerText()).trim();
  await t.page.locator(".items-table a.cds--link").first().click();
  await t.until("the link opens its item in the tab", async () => (await t.page.locator(".page-header__title").first().innerText()).includes(linkText) || "not yet");
  const itemTitle = await t.page.locator(".page-header__title").first().innerText();
  await t.page.keyboard.press("Alt+ArrowLeft");
  await t.settle();
  await t.until("Alt+Left goes back in the tab", async () => (await t.page.locator(".page-header__title").first().innerText()).includes("Books"));
  await t.page.keyboard.press("Alt+ArrowRight");
  await t.settle();
  await t.until("Alt+Right goes forward", async () => (await t.page.locator(".page-header__title").first().innerText()) === itemTitle || (await t.page.locator(".page-header__title").first().innerText()));
  // Close every tab: an empty workspace with a way back.
  await t.page.locator(".cds--tabs__nav-item--close-icon").first().click();
  await t.settle();
  await t.audit("empty workspace");
  await t.check("empty workspace offers a new tab", (await t.page.getByText("open a new tab").count()) === 1);
  await t.page.getByText("open a new tab").click();
  await t.settle();
  await t.check("the link opens a tab", (await t.count(".ws-pane__tabs .cds--tabs__nav-item")) === 1);
});

for (const vp of ["desktop"]) {
  test(`split panes: 2, 3 and 4 panes @ ${vp}`, async (t) => {
    await t.boot();
    const ids = await t.seed(profileSpec("long", { items: 8 }));
    const books = ids.collections.books;
    const item = t.itemPath(books, ids.items["books/i0"]);
    const layouts = [
      ["two side by side", wsLayout([[`/collections/${books}/items`], [item]])],
      ["three side by side", wsLayout([[`/collections/${books}/items`], [item], ["/collections"]])],
      ["two stacked", wsLayout([[`/collections/${books}/items`], [item]], { direction: "column" })],
      ["four side by side, uneven", wsLayout([[`/collections/${books}/items`], [item, "/help"], ["/collections"], [`/collections/${books}/edit`]], { sizes: [0.55, 0.15, 0.15, 0.15] })],
    ];
    for (const [label, layout] of layouts) {
      await t.seed({ prefs: { "kubus.workspace.default": layout } });
      await t.open(item, { keepTabs: true });
      await t.wait(300);
      await t.audit(label);
      await checkTabRules(t, label);
    }
  }, { viewport: vp });
}

test("split panes: divider drag keeps the minimum pane width", async (t) => {
  await t.boot();
  const ids = await t.seed(profileSpec("typical", { items: 6 }));
  const books = ids.collections.books;
  await t.seed({ prefs: { "kubus.workspace.default": wsLayout([[`/collections/${books}/items`], [t.itemPath(books, ids.items["books/i0"])]]) } });
  await t.open(t.itemPath(books, ids.items["books/i0"]), { keepTabs: true });
  const divider = t.page.locator(".ws-split > .ws-divider").first();
  const box = await divider.boundingBox();
  for (const [x, label] of [[t.vp.width - 5, "dragged to the right edge"], [5, "dragged to the left edge"], [t.vp.width / 2, "dragged to the middle"]]) {
    await t.page.mouse.move(box.x + box.width / 2, box.y + 300);
    await t.page.mouse.down();
    await t.page.mouse.move(x, box.y + 300, { steps: 8 });
    await t.page.mouse.up();
    await t.settle();
    const widths = await t.page.locator(".ws-split > .ws-split__child").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().width));
    const min = await t.page.locator(".ws-split").first().evaluate((el) => parseFloat(getComputedStyle(el).getPropertyValue("--pane-min-width")) || 0);
    await t.check(`${label}: panes keep their minimum width (${widths.map(Math.round).join(" / ")}, min ${min})`, widths.every((w) => w >= Math.min(min, t.vp.width * 0.1) - 2), `widths ${widths}`);
    await t.audit(label);
  }
  await divider.dblclick();
  await t.settle();
  const widths = await t.page.locator(".ws-split > .ws-split__child").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().width));
  await t.check("double click on the divider shares the room equally", Math.abs(widths[0] - widths[1]) <= 3, `${widths}`);
});

test("tabs: drag a tab onto a pane's edge splits it, onto the centre merges", async (t) => {
  await t.boot();
  const ids = await t.seed(profileSpec("typical", { items: 3 }));
  const books = ids.collections.books;
  await t.seed({ prefs: { "kubus.workspace.default": wsLayout([["/collections", `/collections/${books}/items`]]) } });
  await t.open(`/collections/${books}/items`, { keepTabs: true });
  const tab = t.page.locator(".ws-pane__tabs .cds--tabs__nav-item").first();
  const body = t.page.locator(".ws-pane__frame").first();
  const bb = await body.boundingBox();
  await tab.dragTo(body, { targetPosition: { x: bb.width - 10, y: bb.height / 2 } });
  await t.settle();
  await t.check("dropping on the right edge splits into two panes", (await t.count(".ws-pane")) === 2, `${await t.count(".ws-pane")} panes`);
  await t.audit("after splitting by drag");
  const tab2 = t.page.locator(".ws-pane").nth(1).locator(".cds--tabs__nav-item").first();
  const first = t.page.locator(".ws-pane__frame").first();
  const fb = await first.boundingBox();
  await tab2.dragTo(first, { targetPosition: { x: fb.width / 2, y: fb.height / 2 } });
  await t.settle();
  await t.check("dropping on the centre merges back into one pane", (await t.count(".ws-pane")) === 1, `${await t.count(".ws-pane")} panes`);
  await t.audit("after merging by drag");
});
