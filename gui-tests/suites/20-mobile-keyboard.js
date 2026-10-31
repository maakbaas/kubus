// The on-screen keyboard. On a phone a field in a popover is tapped and the keyboard comes up
// (t.keyboardUp: Android makes the window shorter, iOS only the visual viewport): the popover stays
// open, the field keeps focus (the same element, so the keyboard stays), the panel stays on its side
// of its button (flipping moved the field away from under the finger, and on iOS the keyboard
// closed again at once), the panel fits in what the keyboard leaves and scrolls inside, the field is
// in sight, and typing still works. Then the keyboard goes down and all that still holds.

/** Marks the focused element and describes the open panel, its button and the field. */
async function kbState(t, panelSel) {
  return t.page.evaluate((panelSel) => {
    const focus = document.activeElement;
    const marked = focus && focus.hasAttribute("data-kb-field");
    const panel = [...document.querySelectorAll(panelSel)].filter((p) => p.getClientRects().length).pop();
    const root = panel && panel.closest(".cds--popover-container");
    const button = root && [...root.querySelectorAll("button")].find((b) => !b.closest(".cds--popover-content"));
    const r = (el) => {
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, height: b.height };
    };
    // The panel's box as it is drawn: its own scroll box (the caret-less content around it adds nothing).
    return { open: !!panel, focusKept: !!marked, focusTag: focus ? focus.tagName.toLowerCase() : "none", panel: r(panel), button: r(button), field: r(focus), value: focus && "value" in focus ? focus.value : "", scrollY: window.scrollY, paneScroll: document.querySelector(".ws-pane--active .ws-pane__body")?.scrollTop ?? 0 };
  }, panelSel);
}

/**
 * Focuses `field` (a locator in an open panel), brings the keyboard up the given way, types, and
 * takes the keyboard down, checking the rules above at each stage.
 */
async function withKeyboard(t, label, field, panelSel, style) {
  await field.click();
  await t.settle(100);
  await field.evaluate((el) => el.setAttribute("data-kb-field", ""));
  const a = await kbState(t, panelSel);
  await t.require(`${label}: the field has focus before the keyboard`, a.open && a.focusKept, `open ${a.open}, focus on ${a.focusTag}`);
  const below = (s) => s.panel.top >= s.button.top;
  const judge = async (stage, s, area) => {
    const problems = [];
    if (!s.open) problems.push("the popover closed");
    else {
      if (!s.focusKept) problems.push(`focus left the field (now on ${s.focusTag}): the keyboard would close`);
      // Unless its side has no room left for the field (padding, field, padding: 64px, plus the caret's 10).
      const room = a.button ? (below(a) ? area.bottom - a.button.bottom : a.button.top - area.top) : 0;
      if (s.button && a.button && below(s) !== below(a) && room >= 90) problems.push(`the panel flipped ${below(a) ? "from below to above" : "from above to below"} its button (${Math.round(room)}px room on its side)`);
      if (s.panel.bottom > area.bottom + 1 || s.panel.top < area.top - 1) problems.push(`the panel (${Math.round(s.panel.top)}–${Math.round(s.panel.bottom)}) runs outside what can be seen (${area.top}–${area.bottom})`);
      if (s.focusKept && (s.field.bottom > Math.min(area.bottom, s.panel.bottom) + 1 || s.field.top < Math.max(area.top, s.panel.top) - 1)) problems.push(`the field (${Math.round(s.field.top)}–${Math.round(s.field.bottom)}) is out of sight`);
      if (s.scrollY !== 0) problems.push(`the document scrolled by ${s.scrollY}`);
      if (Math.abs(s.paneScroll - a.paneScroll) > 1) problems.push(`the page behind scrolled by ${s.paneScroll - a.paneScroll}`);
    }
    await t.check(`${label}: ${stage}`, problems.length === 0, problems.join("; "));
  };
  await t.keyboardUp(0.45, style);
  await judge(`${style} keyboard up: open, focused, on its side, in sight`, await kbState(t, panelSel), t.keyboard);
  await t.audit(`${label}: with the keyboard up`, { skip: ["page-overflow"] });
  await t.page.keyboard.type("Kb");
  await t.settle(100);
  const typed = await kbState(t, panelSel);
  await t.check(`${label}: typing with the keyboard up reaches the field`, typed.focusKept && /Kb$/.test(typed.value), `value "${typed.value}", focus on ${typed.focusTag}`);
  await judge("after typing", typed, t.keyboard);
  await t.keyboardDown();
  await judge("keyboard down again", await kbState(t, panelSel), { top: 0, bottom: t.vp.height });
}

const KB_PANEL = ".toolbar-popover.cds--popover--open .toolbar-popover__panel";

function kbSpec() {
  const spec = matrixSpec("typical", { items: 10 });
  spec.spaces = [{ key: "w", name: "Work" }];
  return spec;
}

for (const vp of ["phone"]) {
  for (const style of ["android", "ios"]) {
    test(`block settings name with the keyboard (${style}) @ ${vp}`, async (t) => {
      await t.boot();
      const ids = await t.seed(kbSpec());
      await t.open(t.listPath(ids.collections.books));
      const header = t.page.locator(".ws-pane--active .block").first().locator(".section-header").first();
      await t.openPanel(header, "Block settings");
      const name = t.page.locator(KB_PANEL).last().getByRole("textbox", { name: "Name" });
      await withKeyboard(t, "table block name", name, KB_PANEL, style);
      // A taller panel: cards have more options (cover, width) than a table.
      await t.page.keyboard.press("Escape");
      await t.settle(100);
      const panel = t.page.locator(KB_PANEL).last();
      if (!(await panel.count())) await t.openPanel(header, "Block settings");
      // By its label: a block of a collection with list fields has a Collection dropdown before it.
      await t.page.locator(KB_PANEL).last().locator(".cds--dropdown__wrapper", { hasText: "Show as" }).locator(".cds--dropdown button").first().click();
      await t.settle(100);
      await t.page.getByRole("option", { name: /Cards/ }).first().click();
      await t.settle();
      await withKeyboard(t, "cards block name", t.page.locator(KB_PANEL).last().getByRole("textbox", { name: "Name" }), KB_PANEL, style);
    }, { viewport: vp, smoke: vp === "phone" });

    test(`view settings name with the keyboard (${style}) @ ${vp}`, async (t) => {
      await t.boot();
      const ids = await t.seed(kbSpec());
      await t.open(`${t.listPath(ids.collections.books)}?view=${ids.views["books/Blocks"]}`);
      await t.openPanel(t.page.locator(".ws-pane--active .views-bar").first(), "View settings");
      const name = t.page.locator(KB_PANEL).last().getByRole("textbox", { name: "View name" });
      await withKeyboard(t, "view name", name, KB_PANEL, style);
    }, { viewport: vp });

    test(`icon picker search with the keyboard (${style}) @ ${vp}`, async (t) => {
      await t.boot();
      const ids = await t.seed(kbSpec());
      await t.open(`/collections/${ids.collections.books}/edit`);
      await t.page.locator(".title-edit").getByRole("button").first().click();
      await t.settle();
      const search = t.page.locator(".icon-picker .cds--search-input").first();
      await withKeyboard(t, "icon search", search, ".icon-picker.cds--popover--open .icon-picker__panel", style);
    }, { viewport: vp });
  }
}

// Touch lands where things are drawn. Rotating a phone (and back), with or without the keyboard up
// (and, on iOS, a visual viewport panned by it), must leave every control hit-testable at its own
// centre, the workspace over exactly the window and nothing stale (the keyboard's inset, a scrolled
// window) shifting what is drawn from what is touched.

/** Interactive elements in view, each with the element a touch at its centre reaches. */
async function hitReport(t) {
  return t.page.evaluate(() => {
    const out = { bad: [], tested: 0 };
    const sel = ".ws-pane--active a[href], .ws-pane--active button, .ws-pane--active [role=button], .ws-pane--active input:not([type=hidden]), .ws-pane--active tr[tabindex]";
    for (const el of document.querySelectorAll(sel)) {
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4 || !el.getClientRects().length || !el.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true }) || el.closest("[inert], [aria-hidden=true]")) continue;
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
      // Clipped by a scrolling / clipping ancestor (a pane, a scrolling strip): not reachable there by design.
      let clipped = false;
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const o = getComputedStyle(p);
        if (/(auto|scroll|hidden|clip)/.test(o.overflowX + o.overflowY)) {
          const b = p.getBoundingClientRect();
          if (x < b.left || x > b.right || y < b.top || y > b.bottom) { clipped = true; break; }
        }
      }
      if (clipped) continue;
      out.tested++;
      const hit = document.elementFromPoint(x, y);
      if (!hit || !(el === hit || el.contains(hit) || hit.contains(el) || (el.id && hit.closest(`label[for="${CSS.escape(el.id)}"]`)))) {
        out.bad.push(`${el.tagName.toLowerCase()}[${(el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 24)}] at ${Math.round(x)},${Math.round(y)} hits ${hit ? hit.tagName.toLowerCase() + "." + String(hit.className).slice(0, 30) : "nothing"}`);
      }
    }
    const ws = document.querySelector(".app-content--workspace")?.getBoundingClientRect();
    const vv = window.visualViewport;
    out.state = {
      scrollX: window.scrollX, scrollY: window.scrollY,
      workspace: ws ? { top: Math.round(ws.top), left: Math.round(ws.left), width: Math.round(ws.width), height: Math.round(ws.height) } : null,
      inner: { w: innerWidth, h: innerHeight },
      inset: document.documentElement.style.getPropertyValue("--keyboard-inset"),
      // What the inset must be right now: the part of the window the visual viewport leaves uncovered.
      expectedInset: vv ? Math.max(0, Math.round(innerHeight - vv.height - vv.offsetTop)) + "px" : "0px",
      vvTop: vv ? vv.offsetTop : 0, vvPageTop: vv ? vv.pageTop : 0,
    };
    return out;
  });
}

async function judgeHits(t, label) {
  const r = await hitReport(t);
  const s = r.state;
  const problems = [];
  if (r.tested < 3) problems.push(`only ${r.tested} controls tested`);
  if (r.bad.length) problems.push(`touch misses: ${r.bad.slice(0, 4).join("; ")}`);
  if (s.scrollX || s.scrollY || s.vvPageTop) problems.push(`window scrolled (${s.scrollX}, ${s.scrollY}; page top ${s.vvPageTop})`);
  if (!s.workspace || s.workspace.top !== 0 || s.workspace.left !== 0 || s.workspace.height !== s.inner.h) problems.push(`workspace ${JSON.stringify(s.workspace)} is not the window ${JSON.stringify(s.inner)}`);
  if (s.inset !== s.expectedInset) problems.push(`keyboard inset "${s.inset}" is stale (the window leaves ${s.expectedInset} covered)`);
  await t.check(`${label}: touch hits the control drawn there`, problems.length === 0, problems.join("; "));
}

for (const vp of ["phone"]) {
  for (const style of [null, "android", "ios", "ios-panned"]) {
    test(`hit-testing matches after rotating and back${style ? ` with the ${style} keyboard` : ""} @ ${vp}`, async (t) => {
      await t.boot();
      const ids = await t.seed(kbSpec());
      await t.open(t.listPath(ids.collections.books));
      const { width: w, height: h } = t.vp;
      await judgeHits(t, "portrait");
      // The keyboard comes up (a field has focus), the phone turns, turns back, the keyboard goes.
      const up = async () => {
        if (!style) return;
        await t.keyboardUp(0.45, style === "android" ? "android" : "ios");
        if (style === "ios-panned") {
          // iOS pans the visual viewport to keep the focused field in view.
          await t.page.evaluate(() => {
            Object.defineProperty(window.visualViewport, "offsetTop", { configurable: true, get: () => 60 });
            window.visualViewport.dispatchEvent(new Event("scroll"));
          });
          await t.settle(100);
        }
      };
      await up();
      await judgeHits(t, `portrait, keyboard ${style || "none"}`);
      if (style) await t.keyboardDown();
      if (style === "ios-panned") await t.page.evaluate(() => { delete window.visualViewport.offsetTop; window.visualViewport.dispatchEvent(new Event("scroll")); });
      for (const [label, size] of [["landscape", { width: h, height: w }], ["portrait again", { width: w, height: h }]]) {
        if (style && style !== "android") await up();
        await t.page.setViewportSize(size);
        await t.page.evaluate(() => window.dispatchEvent(new Event("orientationchange")));
        await t.settle(300);
        await judgeHits(t, label);
        await t.audit(`${label}`, { skip: ["page-overflow"] });
        if (style && style !== "android") {
          await t.keyboardDown();
          if (style === "ios-panned") await t.page.evaluate(() => { delete window.visualViewport.offsetTop; window.visualViewport.dispatchEvent(new Event("scroll")); });
          await t.settle(150);
        }
      }
      await judgeHits(t, "back in portrait, keyboard gone");
    }, { viewport: vp, smoke: vp === "phone" && !style });
  }
}

// The whole iOS sequence for a field near the bottom of the screen in a popover. iOS doesn't shrink
// the window for its keyboard: on focus it pans the visual viewport down (offsetTop, pageTop; the
// pan is reported before the smaller height) by as much as the field needs to be above the
// keyboard, and the fixed layers, the popover with them, move up off its top. Whatever then hides
// the field (visibility on an ancestor: Carbon's autoAlign hides a popover whose button is out of
// the visual viewport), blurs it, re-creates it, or scrolls the window (undoing the pan) makes iOS
// dismiss the keyboard at once. Emulated here: the visual viewport's offsets and height are set and
// their events fired in iOS's order; window.scrollTo / scroll / scrollBy and the root's scrollTop
// are recorded and, as on iOS, end the pan. After it: the same field node is connected, focused
// and visible, never blurred, the popover open, the field within the visual viewport, and nothing
// scrolled the window. Then "Done": the field blurs, the keyboard goes, the pan is left, and the
// window is put back at 0,0 (keyboardInset.ts) so touch lands where things are drawn.

/** Installs the emulated iOS viewport and the probes on the focused field; returns the pan iOS would use. */
async function iosFocus(t, field, fraction = 0.45) {
  await field.tap();
  await t.settle(100);
  return t.page.evaluate((fraction) => {
    const vv = window.visualViewport;
    const inner = window.innerHeight;
    const S = { height: inner, offsetTop: 0, scrollY: 0 };
    const node = document.activeElement;
    const probe = { node, S, scrolls: [], blurs: 0, focusouts: 0, inner, keyboard: Math.round(inner * fraction) };
    window.__ios = probe;
    Object.defineProperty(vv, "height", { configurable: true, get: () => S.height });
    Object.defineProperty(vv, "offsetTop", { configurable: true, get: () => S.offsetTop });
    Object.defineProperty(vv, "pageTop", { configurable: true, get: () => S.offsetTop + S.scrollY });
    Object.defineProperty(window, "scrollY", { configurable: true, get: () => S.scrollY });
    Object.defineProperty(window, "pageYOffset", { configurable: true, get: () => S.scrollY });
    // A programmatic scroll of the window ends iOS's reveal-pan (and the keyboard with it).
    const unpan = () => {
      S.offsetTop = 0;
      S.scrollY = 0;
      queueMicrotask(() => vv.dispatchEvent(new Event("scroll")));
    };
    for (const name of ["scrollTo", "scroll", "scrollBy"]) {
      window[name] = (...a) => {
        probe.scrolls.push(`${name}(${a.map((x) => JSON.stringify(x)).join(", ")})`);
        unpan();
      };
    }
    for (const el of [document.documentElement, document.body]) {
      Object.defineProperty(el, "scrollTop", { configurable: true, get: () => 0, set: (v) => { probe.scrolls.push(`${el.tagName.toLowerCase()}.scrollTop = ${v}`); unpan(); } });
    }
    if (node) {
      node.addEventListener("blur", () => probe.blurs++);
      node.addEventListener("focusout", () => probe.focusouts++);
    }
    const r = node ? node.getBoundingClientRect() : { bottom: 0 };
    // iOS reveals the field just above the keyboard, panning at most the keyboard's height.
    return { tag: node ? node.tagName.toLowerCase() : "none", number: !!node && node.type === "number", pan: Math.max(0, Math.min(probe.keyboard, Math.ceil(r.bottom + 12 - (inner - probe.keyboard)))), fieldBottom: r.bottom, inner };
  }, fraction);
}

/** One iOS step: the given viewport values, then its events, then two frames. */
async function iosStep(t, values, events) {
  await t.page.evaluate(async ({ values, events }) => {
    Object.assign(window.__ios.S, values);
    for (const e of events) (e === "window-scroll" ? window : window.visualViewport).dispatchEvent(new Event(e === "window-scroll" ? "scroll" : e));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  }, { values, events });
}

/** What the probes saw, and the field and the popover now. */
async function iosState(t, contentSel) {
  return t.page.evaluate((contentSel) => {
    const p = window.__ios;
    const node = p.node;
    const content = node && node.closest(contentSel);
    const vv = window.visualViewport;
    const r = node ? node.getBoundingClientRect() : null;
    return {
      connected: !!node && node.isConnected,
      focused: !!node && document.activeElement === node,
      focusTag: document.activeElement ? document.activeElement.tagName.toLowerCase() : "none",
      open: !!content && !!content.closest(".cds--popover--open"),
      contentVisibility: content ? getComputedStyle(content).visibility : "none",
      visible: !!node && node.checkVisibility({ visibilityProperty: true, opacityProperty: true }),
      field: r && { top: Math.round(r.top), bottom: Math.round(r.bottom) },
      area: { top: vv.offsetTop, bottom: vv.offsetTop + vv.height },
      scrolls: [...p.scrolls], blurs: p.blurs, focusouts: p.focusouts,
      inset: document.documentElement.style.getPropertyValue("--keyboard-inset"),
    };
  }, contentSel);
}

/** Puts the iOS viewport back as it was (the probes stay, unused). */
async function iosReset(t) {
  await t.page.evaluate(() => {
    for (const k of ["height", "offsetTop", "pageTop"]) delete window.visualViewport[k];
    delete window.scrollY;
    delete window.pageYOffset;
    for (const name of ["scrollTo", "scroll", "scrollBy"]) delete window[name];
    for (const el of [document.documentElement, document.body]) delete el.scrollTop;
    window.visualViewport.dispatchEvent(new Event("resize"));
  });
  await t.settle(100);
}

/**
 * Taps `field` (in an open popover whose content matches `contentSel`), runs iOS's keyboard
 * sequence, checks the rules above, types, then "Done" and the window put back.
 */
async function iosKeyboard(t, label, field, contentSel) {
  const f = await iosFocus(t, field);
  await t.require(`${label}: the tapped field has focus`, /^(input|textarea)$/.test(f.tag), `focus on ${f.tag}`);
  const inner = f.inner;
  const height = inner - Math.round(inner * 0.45);
  // (1) focus (done); (2) iOS pans first, the height still the old one; (3) the keyboard's height
  // arrives (an animation step, then the end); (4) a last scroll as the pan settles.
  await iosStep(t, { offsetTop: f.pan }, ["scroll", "window-scroll"]);
  await iosStep(t, { height: Math.round((inner + height) / 2) }, ["resize"]);
  await iosStep(t, { height }, ["resize", "scroll"]);
  await t.settle(400); // past keyboardInset's settle time
  const s = await iosState(t, contentSel);
  const problems = [];
  if (!s.connected) problems.push("the field was removed (re-created)");
  if (!s.focused) problems.push(`focus left the field (now on ${s.focusTag})`);
  if (s.blurs || s.focusouts) problems.push(`the field blurred ${s.blurs}× (focusout ${s.focusouts}×)`);
  if (!s.open) problems.push("the popover closed");
  if (!s.visible || s.contentVisibility !== "visible") problems.push(`the field is hidden (popover visibility: ${s.contentVisibility})`);
  if (s.scrolls.length) problems.push(`the window was scrolled while iOS panned it: ${s.scrolls.join("; ")}`);
  if (s.field && (s.field.top < s.area.top - 1 || s.field.bottom > s.area.bottom + 1)) problems.push(`the field (${s.field.top}–${s.field.bottom}) is outside the visual viewport (${s.area.top}–${s.area.bottom})`);
  await t.check(`${label}: iOS keyboard up (pan ${f.pan}px, field bottom ${Math.round(f.fieldBottom)} of ${inner}): the keyboard stays`, problems.length === 0, problems.join("; "));
  const keys = f.number ? "7" : "Ki";
  await t.page.keyboard.type(keys);
  await t.settle(100);
  const typed = await t.page.evaluate(() => { const n = window.__ios.node; return { focused: document.activeElement === n, value: n && "value" in n ? n.value : "" }; });
  await t.check(`${label}: typing reaches the field`, typed.focused && typed.value.endsWith(keys), `value "${typed.value}", focused ${typed.focused}`);
  // "Done": the field blurs, the keyboard goes down, the pan is left behind.
  await t.page.evaluate(() => window.__ios.node.blur());
  await iosStep(t, { height: inner }, ["resize"]);
  await t.settle(400);
  const down = await iosState(t, contentSel);
  await t.check(`${label}: after "Done" the window is put back at 0,0`, down.area.top === 0 && down.inset === "0px", `visual viewport top ${down.area.top}, inset ${down.inset}, scrolls: ${down.scrolls.join("; ") || "none"}`);
  await iosReset(t);
}

/** The lowest text field in sight in the open toolbar panel, after scrolling the panel to its end. */
async function lowestField(t) {
  const index = await t.page.evaluate(({ sel, fieldsSel }) => {
    const panel = [...document.querySelectorAll(sel)].filter((p) => p.getClientRects().length).pop();
    if (!panel) return -1;
    const fields = [...panel.querySelectorAll(fieldsSel)];
    const usable = (f) => f.getBoundingClientRect().height > 0 && f.checkVisibility() && !f.disabled && !f.readOnly;
    // The last one (the lowest), scrolled within the panel to its bottom edge.
    const best = fields.findLastIndex(usable);
    if (best < 0) return -1;
    panel.scrollTop += fields[best].getBoundingClientRect().bottom - panel.getBoundingClientRect().bottom + 8;
    return best;
  }, { sel: KB_PANEL, fieldsSel: TEXT_FIELDS });
  return index < 0 ? null : t.page.locator(KB_PANEL).last().locator(TEXT_FIELDS).nth(index);
}

/** Scrolls the pane so the `n`th block's header sits at `at` of the window's height (as far as it scrolls). */
async function headerAt(t, n, at) {
  await t.page.evaluate(({ n, at }) => {
    const body = document.querySelector(".ws-pane--active .ws-pane__body");
    const header = document.querySelectorAll(".ws-pane--active .block")[n]?.querySelector(".section-header");
    if (!body || !header) return;
    body.scrollTop += header.getBoundingClientRect().top - innerHeight * at;
  }, { n, at });
  await t.settle(150);
}

const TEXT_FIELDS = "input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=hidden]), textarea";
const POPOVER_CONTENT = ".toolbar-popover > .cds--popover > .cds--popover-content";

for (const vp of ["phone"]) {
  test(`iOS keyboard sequence: the lowest field of panels below their button @ ${vp}`, async (t) => {
    await t.boot();
    const ids = await t.seed(kbSpec());
    await t.open(`${t.listPath(ids.collections.books)}?view=${ids.views["books/Cards"]}`);
    const header = () => t.page.locator(".ws-pane--active .block").first().locator(".section-header").first();
    for (const [label, open] of [
      ["cards block settings", () => t.openPanel(header(), "Block settings")],
      ["block filter value", async () => {
        await t.openPanel(header(), "Filter");
        await t.page.locator(KB_PANEL).last().getByRole("button", { name: "Add filter" }).click();
        await t.settle(150);
      }],
      ["view settings", () => t.openPanel(t.page.locator(".ws-pane--active .views-bar").first(), "View settings")],
    ]) {
      await open();
      const field = await lowestField(t);
      await t.require(`${label}: a text field in the panel`, !!field);
      await iosKeyboard(t, label, field, POPOVER_CONTENT);
      await closePanels(t);
    }
  }, { viewport: vp, smoke: vp === "phone" });

  test(`iOS keyboard sequence: panels above a button near the bottom @ ${vp}`, async (t) => {
    await t.boot();
    const ids = await t.seed(kbSpec());
    await t.open(`${t.listPath(ids.collections.books)}?view=${ids.views["books/Blocks"]}`);
    // The table block (the second): its header near the bottom of the screen, its panels above it (or beside).
    for (const [label, button] of [["block settings", "Block settings"], ["block filter value", "Filter"]]) {
      await headerAt(t, 1, 0.8);
      const header = t.page.locator(".ws-pane--active .block").nth(1).locator(".section-header").first();
      await t.openPanel(header, button);
      if (button === "Filter") {
        await t.page.locator(KB_PANEL).last().getByRole("button", { name: "Add filter" }).click();
        await t.settle(150);
      }
      const { b, p } = await kbState(t, KB_PANEL).then((s) => ({ b: s.button && { y: s.button.top }, p: s.panel && { y: s.panel.top, bottom: s.panel.bottom } }));
      await t.require(`${label}: the button is near the bottom, the panel beside or above it`, !!b && !!p && b.y > t.vp.height * 0.6 && p.y < b.y, `panel ${JSON.stringify(p)}, button ${JSON.stringify(b)}`);
      const field = await lowestField(t);
      await t.require(`${label}: a text field in the panel`, !!field);
      await iosKeyboard(t, label, field, POPOVER_CONTENT);
      await closePanels(t);
    }
  }, { viewport: vp });

  test(`iOS keyboard sequence: icon picker search @ ${vp}`, async (t) => {
    await t.boot();
    const ids = await t.seed(kbSpec());
    await t.open(`/collections/${ids.collections.books}/edit`);
    await t.page.locator(".title-edit").getByRole("button").first().click();
    await t.settle();
    await iosKeyboard(t, "icon search", t.page.locator(".icon-picker .cds--search-input").first(), ".icon-picker > .cds--popover > .cds--popover-content");
  }, { viewport: vp });
}

/** Escape until no toolbar panel is open (a dropdown's menu first, then the panel). */
async function closePanels(t) {
  for (let i = 0; i < 3 && (await t.page.locator(KB_PANEL).count()); i++) {
    await t.page.keyboard.press("Escape");
    await t.settle(150);
  }
}
