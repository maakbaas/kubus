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

for (const vp of ["phone", "phone-small"]) {
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
      await t.page.locator(KB_PANEL).last().locator(".cds--dropdown").first().locator("button").first().click();
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
