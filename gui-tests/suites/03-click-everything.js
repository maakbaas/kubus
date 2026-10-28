// Click everything: on every page, every visible control is clicked (and every icon button
// hovered); what opens (a popover, menu, modal) is audited and its own controls are clicked in
// turn. After every click the layout audit must pass and no console error may appear.
// Destructive controls (delete / remove) are clicked to open their confirmation only; inside
// confirmations and menus they are not clicked.

const DESTRUCTIVE = /delete|remove|disconnect|discard|forget|clear/i;
const CRAWL_MAX = 70;
const CRAWL_MAX_INNER = 14;

/** Marks the visible controls of a layer with data-crawl and returns [{ i, name }]. */
async function crawlTargets(t, scope) {
  return t.page.evaluate((scope) => {
    for (const el of document.querySelectorAll("[data-crawl]")) el.removeAttribute("data-crawl");
    const SEL = "button, a[href], [role=tab], [role=menuitem], [role=option], [role=treeitem], [role=checkbox], [role=switch], input[type=checkbox], .cds--toggle__button, .cds--slider__thumb, .cell-editable, .view-field__value, [role=button]";
    const roots = scope === "page" ? [document.body] : [...document.querySelectorAll(scope)];
    const isFloating = (el) => !!el.closest(".cds--popover--open > .cds--popover, .cds--modal.is-visible, .cds--list-box__menu, [role=menu]");
    const out = [];
    const seen = new Set();
    for (const root of roots) {
      for (const el of root.querySelectorAll(SEL)) {
        if (seen.has(el)) continue;
        seen.add(el);
        if (!el.checkVisibility({ visibilityProperty: true, opacityProperty: true })) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 4 || r.height < 4 || r.bottom < 0 || r.top > innerHeight * 3) continue;
        if (scope === "page" && isFloating(el)) continue;
        // The side nav while collapsed is off screen (phones, or hidden): not there to click.
        if (el.closest(".cds--side-nav:not(.cds--side-nav--expanded)")) continue;
        if (el.closest("[data-crawl]") && !el.matches("[role=treeitem]")) continue; // nested in another target
        if (el.disabled || el.getAttribute("aria-disabled") === "true") continue;
        const by = (el.getAttribute("aria-labelledby") || "").split(/\s+/).map((id) => document.getElementById(id)?.textContent || "").join(" ");
        const desc = (el.getAttribute("aria-describedby") || "").split(/\s+/).map((id) => document.getElementById(id)?.textContent || "").join(" ");
        const name = (el.getAttribute("aria-label") || by || el.innerText || desc || el.title || el.getAttribute("href") || el.className || "").trim().replace(/\s+/g, " ").slice(0, 60);
        el.setAttribute("data-crawl", String(out.length));
        out.push({ i: out.length, name });
      }
    }
    return out;
  }, scope);
}

/** Selector of the floating layer that opened, if any. */
async function openLayer(t) {
  return t.page.evaluate(() => {
    if (document.querySelector(".cds--modal.is-visible")) return ".cds--modal.is-visible";
    if (document.querySelector(".cds--list-box__menu")) return ".cds--list-box__menu";
    if (document.querySelector(".cds--popover--open > .cds--popover .toolbar-popover__panel, .cds--popover--open > .cds--popover [role=menu], .cds--popover--open > .cds--popover input, .cds--popover--open > .cds--popover button")) return ".cds--popover--open > .cds--popover";
    if (document.querySelector("[role=menu]")) return "[role=menu]";
    return null;
  });
}

async function crawlPage(t, label, path) {
  await t.open(path);
  await t.audit(`${label}: as opened`);
  const urlOf = () => t.page.evaluate(() => document.querySelector(".ws-pane--active .cds--tabs__nav-item--selected")?.getAttribute("title") || "");
  const startTitle = await urlOf();
  const targets = (await crawlTargets(t, "page")).slice(0, CRAWL_MAX);
  let clicked = 0;
  for (const target of targets) {
    // Back to the page as opened when the last click changed it (navigated, closed a tab).
    let now = await crawlTargets(t, "page");
    if (!now[target.i] || now[target.i].name !== target.name || (await urlOf()) !== startTitle) {
      await t.open(path);
      now = await crawlTargets(t, "page");
      if (!now[target.i] || now[target.i].name !== target.name) continue; // not there any more
    }
    const loc = t.page.locator(`[data-crawl="${target.i}"]`);
    t.at(`${label} › click "${target.name}"`);
    try {
      await loc.scrollIntoViewIfNeeded({ timeout: 2000 });
      await loc.click({ timeout: 3000 }).catch(async () => {
        // A tooltip or a closing panel may still be in the way: once more after moving away.
        await t.closeAll();
        await t.page.mouse.move(1, 1);
        await t.wait(300);
        await loc.click({ timeout: 3000 });
      });
    } catch (e) {
      await t.check(`${label}: "${target.name}" can be clicked`, false, String(e.message).split("\n")[0]);
      continue;
    }
    clicked++;
    await t.settle(150);
    await t.audit(`${label}: after clicking "${target.name}"`, { shotOnFail: true });
    const layer = await openLayer(t);
    if (layer && !DESTRUCTIVE.test(target.name)) {
      const inner = (await crawlTargets(t, layer)).filter((x) => !DESTRUCTIVE.test(x.name)).slice(0, CRAWL_MAX_INNER);
      for (const it of inner) {
        // Reopen the layer for each inner control.
        if (!(await openLayer(t))) {
          await t.closeAll();
          if ((await urlOf()) !== startTitle) await t.open(path);
          const again = await crawlTargets(t, "page");
          if (!again[target.i] || again[target.i].name !== target.name) break;
          await t.page.locator(`[data-crawl="${target.i}"]`).click({ timeout: 3000 }).catch(() => {});
          await t.settle(150);
          const l2 = await openLayer(t);
          if (!l2) break;
          await crawlTargets(t, l2);
        } else {
          await crawlTargets(t, layer);
        }
        const innerLoc = t.page.locator(`[data-crawl="${it.i}"]`);
        if (!(await innerLoc.count())) continue;
        t.at(`${label} › "${target.name}" › "${it.name}"`);
        try {
          await innerLoc.click({ timeout: 2500 });
        } catch {
          continue; // covered or gone after reopening: not a failure of its own
        }
        await t.settle(150);
        await t.audit(`${label}: "${target.name}" › "${it.name}"`, { shotOnFail: true });
      }
    }
    await t.closeAll();
  }
  await t.check(`${label}: clicked ${clicked} of ${targets.length} controls`, clicked > 0 || targets.length === 0, "nothing could be clicked");
}

/** Hovers every icon button of a page: its tooltip must stay in the window and cover nothing important. */
async function hoverPage(t, label, path) {
  await t.open(path);
  const n = await t.page.evaluate(() => {
    let i = 0;
    for (const el of document.querySelectorAll(".cds--btn--icon-only")) {
      if (!el.checkVisibility()) continue;
      el.setAttribute("data-hover", String(i++));
    }
    return i;
  });
  for (let i = 0; i < Math.min(n, 40); i++) {
    const loc = t.page.locator(`[data-hover="${i}"]`);
    try {
      await loc.hover({ timeout: 2000 });
    } catch {
      continue;
    }
    await t.wait(250);
    const name = await loc.getAttribute("aria-label").catch(() => "") || (await loc.innerText().catch(() => "")) || `#${i}`;
    // Only what tooltips can break: staying in the window, overlapping and covering.
    await t.audit(`${label}: tooltip of "${name.trim().slice(0, 40)}"`, { settle: false, shotOnFail: true, skip: ["type-style", "theme-color", "compact-size", "native-control", "accessible-name", "duplicate-id", "icon-size", "nested-scroll", "text-clipped", "escapes-container"] });
  }
  await t.page.mouse.move(1, t.vp.height - 2);
}

function crawlSpec() {
  const spec = matrixSpec("typical", { items: 6 });
  spec.spaces = [{ key: "w", name: "Work" }];
  return spec;
}

const CRAWL_PAGES = [
  ["collections", () => "/collections"],
  ["collection table", (ids) => `/collections/${ids.collections.books}/items`],
  ["collection cards", (ids) => `/collections/${ids.collections.books}/items?view=${ids.views["books/Cards"]}`],
  ["collection blocks", (ids) => `/collections/${ids.collections.books}/items?view=${ids.views["books/Blocks"]}`],
  ["item page", (ids) => `/collections/${ids.collections.books}/items/${ids.items["books/i0"]}`],
  ["new item", (ids) => `/collections/${ids.collections.books}/items/new`],
  ["collection editor", (ids) => `/collections/${ids.collections.books}/edit`],
  ["components", () => "/components"],
  ["component editor", (ids) => `/components/${ids.components.double}`],
  ["spaces", () => "/spaces"],
  ["bookmarks", () => "/bookmarks"],
  ["settings server", () => "/settings?section=server"],
  ["settings sync", () => "/settings?section=sync"],
  ["settings AI", () => "/settings?section=ai"],
  ["search", () => "/search?q=the"],
];

for (const vp of ["desktop", "phone"]) {
  for (const [label, path] of CRAWL_PAGES) {
    test(`click everything: ${label} @ ${vp}`, async (t) => {
      await t.boot();
      const ids = await t.seed(crawlSpec());
      await crawlPage(t, label, path(ids));
    }, { viewport: vp, smoke: vp === "desktop" && label === CRAWL_PAGES[0][0] });
  }
  test(`hover every icon button @ ${vp}`, async (t) => {
    await t.boot();
    const ids = await t.seed(crawlSpec());
    for (const [label, path] of CRAWL_PAGES.slice(0, 9)) await hoverPage(t, label, path(ids));
  }, { viewport: vp });
}
