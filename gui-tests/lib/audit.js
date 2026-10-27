// ---------------------------------------------------------------------------------------------
// The layout audit: every rule below is a pass/fail criterion checked on the page as it is now.
// `__audit` runs inside the browser (page.evaluate); it returns one entry per violation:
// { rule, message, target } where `target` is a short CSS-ish path of the offending element.
//
// Rules (ids are what reports and `skip` lists use):
//   page-scroll          the window itself never scrolls: panes scroll, the page doesn't
//   pane-h-overflow      a pane body never scrolls sideways
//   escapes-container    an element sticks out of the box that clips or scrolls it (cut off / overflow)
//   text-clipped         text cut off without an ellipsis (sideways or vertically)
//   text-overlap         two pieces of text drawn over each other
//   occluded             a control is covered by something else at its centre (can't be clicked)
//   controls-overlap     two controls overlap each other
//   tiny-target          a control smaller than 16px
//   compact-size         a Carbon control not in its smallest size (buttons, inputs: 2rem; modals: xs)
//   ghost-with-text      a borderless (ghost) button with a text label
//   accessible-name      a control without an accessible name
//   spellcheck           spell-check underlines enabled somewhere
//   popover-in-viewport  an open popover / menu / modal / tooltip reaching outside the window
//   popover-overflow     an open popover whose content overflows it sideways
//   filter-ancestor      a CSS filter on an ancestor of an open floating panel (Safari 26)
//   theme-color          a colour that is no Carbon theme token value
//   tab-strip            the top tab strip isn't sticky at top 0 with a solid background
//   toolbar-align        icon buttons in one row not vertically centred on one line
//   nested-scroll        a scrolling box inside another scrolling box (markdown editors etc.)
//   duplicate-id         two elements share an id (breaks labels; the same page is open in two tabs)
//   broken-image         an image that failed to load
//   native-control       a native control / hand-rolled widget instead of a Carbon component
//   icon-size            an icon in an icon-only button that isn't 16px
//   empty-page           a pane shows no content at all
//   status-bar-meta      the iOS translucent status bar meta tag is present
//   popover-detached     an open popover's panel doesn't hang at its button
//   aria-expanded        a popover button's aria-expanded disagrees with its popover being open
//   contrast             text with less than WCAG AA contrast against what is behind it
//   focus-hidden         the focused element is out of sight (behind a sticky bar, scrolled away); only
//                        with { focus: true }, right after focus moved
// ---------------------------------------------------------------------------------------------

/** Every pass/fail criterion of the suite, by id (the report lists them; failures are grouped by them). */
const CRITERIA = {
  "page-scroll": "The window itself never scrolls: panes scroll, the page doesn't.",
  "pane-h-overflow": "A pane body never scrolls sideways.",
  "escapes-container": "No element sticks out of the box that clips or scrolls it (cut off, or forcing a scrollbar).",
  "text-clipped": "Text is never cut off without an ellipsis, sideways or vertically.",
  "text-overlap": "No two pieces of text are drawn over each other.",
  occluded: "Every control can be clicked: nothing else covers its centre (floating panels excepted).",
  "controls-overlap": "No two controls overlap.",
  "tiny-target": "Controls are at least 16×16px (links in running text excepted).",
  "compact-size": "Carbon controls use their smallest size: buttons and inputs 32px, modals xs.",
  "ghost-with-text": "Buttons with a text label are never ghost (borderless).",
  "accessible-name": "Every control and image has an accessible name.",
  spellcheck: "No spell-check underlines anywhere (<html spellcheck=false>, Markdown editor too).",
  "popover-in-viewport": "Open popovers, menus, modals and calendars stay inside the window.",
  "popover-overflow": "Open popovers don't overflow sideways.",
  "filter-ancestor": "No CSS filter on an ancestor of an open floating panel (Safari 26).",
  "theme-color": "Every colour is a Carbon theme token value (no custom colours).",
  "tab-strip": "The top tab strip sits at the window's top with a solid background; nothing is above it.",
  "toolbar-align": "Icon buttons in one toolbar row are vertically centred on one line.",
  "nested-scroll": "No scrolling box inside another scrolling box (editors grow with their content).",
  "duplicate-id": "Element ids are unique (labels point at the right input; a page can be open twice).",
  "broken-image": "No image fails to load.",
  "native-control": "No native control or hand-rolled widget outside Carbon components.",
  "icon-size": "Icons in icon-only buttons are 16px.",
  "empty-page": "A shown tab never renders blank.",
  "status-bar-meta": "No black-translucent iOS status bar meta tag.",
  "popover-detached": "An open popover's panel hangs at its button: right above or below it, overlapping it sideways.",
  "aria-expanded": "A popover's button says aria-expanded=true exactly while its popover is open.",
  contrast: "Text has WCAG AA contrast with what is behind it: 4.5:1, or 3:1 for large text (placeholders, disabled controls and text over images excepted).",
  "focus-hidden": "The focused control is in sight: inside the window and its pane, not under a sticky bar or another layer.",
  // Design rules (design.js): consistency, measured from what the GUI does on every page.
  "spacing-scale": "The app's margins, paddings and gaps are on Carbon's spacing scale (2, 4, 8, 12, 16, 24, 32, 40, 48, 64, 80, 96, 160px); derived values excepted (centring a line in a 2rem row, centred columns, the docked nav's width).",
  "edge-align": "A page's title, description, views bar and blocks start on its breadcrumb's left edge (the first view tab's label 16px in, Carbon's tab inset); page header buttons, views bar and block headers end on one right edge.",
  rhythm: "The gaps between an item page's fields and between a view's blocks are all equal.",
  "toolbar-pitch": "Icon buttons side by side in a row touch: a 32px pitch, no gaps, no overlaps.",
  "type-style": "Text is set in one of the type styles the app uses (Carbon's label-01, body-compact-01, body-01, code-02, heading-compact-02, heading-04 …, and the item fields' one step up); weights only 300, 400, 600.",
  baseline: "A checkbox's label is centred on its box.",
  radius: "Square corners, except Carbon's own round parts (checkbox, toggle, tag, slider thumb, radio, tooltips).",
  shadow: "Box-shadows only on floating layers (popovers, menus, dialogs, dragged rows) and as inset focus / selection marks.",
  border: "Border widths are 1 or 2px.",
  "truncation-hint": "Text cut with an ellipsis can be read whole (a title, a tooltip or an accessible name holding it).",
  "touch-target": "On phones, controls are at least 24×24px or have no other control within 24px of their centre (WCAG 2.5.8; links in a line of text excepted).",
  "popover-padding": "Toolbar popover panels have the same padding on all sides.",
  "content-jump": "Nothing on screen moves or resizes during an interaction that shouldn't move it (editing in place, hovering, toggling, opening popovers).",
  "scroll-jump": "An interaction doesn't scroll the pane by itself.",
  "external-asset": "The app loads no fonts, scripts, styles or images from other hosts: it looks the same offline.",
  "console-error": "No console error or uncaught exception during the test (React warnings included).",
  "layout-shift": "A page settles without layout shifts once shown (CLS ≤ 0.02).",
  "popover-closed": "A popover stays open while its own controls are used (typing, toggling, picking).",
  "popover-jump": "While a popover's controls are used, its button stays put and its panel keeps the edge it hangs from and its width (no jump, no flip).",
  "target-jump": "The control being used (in a popover, a dialog, an editor) stays under the pointer.",
  leak: "Opening and closing things repeatedly leaves no elements behind.",
  baseline: "A key state looks as its stored screenshot (gui-tests/baselines/): at most 0.1% of the pixels differ.",
  assertion: "The behaviour checked by the test holds (named per check).",
  "test-error": "The test ran to its end (a control it needed was there and usable).",
};

/** Runs in the page. `opts.skip`: rule ids to leave out; `opts.max`: violations kept per rule. */
function __audit(opts) {
  const skip = new Set(opts.skip || []);
  const maxPerRule = opts.max || 8;
  const out = [];
  const counts = {};
  const T = 1.5; // px tolerance for sub-pixel rounding
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // How long each rule took (ms), for tuning the audit on big pages.
  const times = {};
  let section = "collect";
  let lapStart = performance.now();
  const lap = () => {
    const now = performance.now();
    times[section] = Math.round(now - lapStart);
    lapStart = now;
  };

  const report = (rule, el, message) => {
    if (skip.has(rule)) return;
    counts[rule] = (counts[rule] || 0) + 1;
    if (counts[rule] > maxPerRule) return;
    let box = null;
    if (el && el.getBoundingClientRect) {
      const r = el.getBoundingClientRect();
      box = { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
    }
    out.push({ rule, message, target: el ? describe(el) : "", box });
  };

  function describe(el) {
    const parts = [];
    let n = el;
    for (let i = 0; n && n.nodeType === 1 && i < 4; i++, n = n.parentElement) {
      let s = n.tagName.toLowerCase();
      const cls = [...n.classList].filter((c) => !/^cds--(layout|css-grid)/.test(c)).slice(0, 2);
      if (cls.length) s += "." + cls.join(".");
      const label = n.getAttribute("aria-label");
      if (label && i === 0) s += `[aria-label="${label.slice(0, 40)}"]`;
      parts.unshift(s);
    }
    const text = (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 40);
    return parts.join(" > ") + (text ? ` "${text}"` : "");
  }

  const cs = (el) => getComputedStyle(el);
  // The side nav while collapsed (phones, or hidden on desktop) is off screen, not shown.
  const collapsedNav = document.querySelector(".cds--side-nav:not(.cds--side-nav--expanded)");
  const visible = (el) =>
    el.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true }) &&
    el.getClientRects().length > 0 &&
    !(collapsedNav && collapsedNav.contains(el));
  /** Screen-reader-only content: clipped to 1px or less. */
  const srOnly = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width <= 1.5 || r.height <= 1.5) return true;
    const s = cs(el);
    return s.clip === "rect(0px, 0px, 0px, 0px)" || s.clipPath === "inset(50%)";
  };
  const isOrInside = (el, sel) => !!el.closest(sel);

  // Floating layers: content in a layer may cover the page (or another layer) by design.
  const LAYER_SEL = [
    ".cds--popover-content", ".cds--modal", ".cds--list-box__menu", ".cds--overflow-menu-options",
    ".flatpickr-calendar", "[role=tooltip]", "[role=menu]", "[role=listbox]", ".search-bar",
    ".cds--side-nav", ".ws-drop", ".lightbox", ".milkdown-link-popover", ".cds--toast-notification",
    ".overflow-bar[data-open] > .overflow-bar__items", ".md-link-popover",
  ].join(",");
  // The side nav floats over the content unless it is docked (narrow windows, phones).
  const overlayNav = !document.querySelector(".app-content--nav-docked");
  function layerOf(el) {
    const l = el.closest(LAYER_SEL);
    if (!l) return document.body;
    if (l.classList.contains("cds--side-nav") && !overlayNav) return document.body;
    return l;
  }

  // Per-element rules look at what is on screen and about one screen around it: a page of 1000
  // table rows has 80k+ elements, and computing every one's style takes a minute and GBs. Tests
  // scroll to what they check; the page-wide rules (window and pane overflow, ids) see everything.
  // Positions are read first (cheap), styles only for elements in that band.
  const band = { top: -vh, bottom: 2 * vh, left: -vw, right: 2 * vw };
  const rects = new Map();
  const shown = [];
  for (const el of document.querySelectorAll("body *")) {
    if (el instanceof SVGElement && !(el instanceof SVGSVGElement)) continue;
    const r = el.getBoundingClientRect();
    if (r.bottom < band.top || r.top > band.bottom || r.right < band.left || r.left > band.right) continue;
    if (!visible(el)) continue;
    rects.set(el, r);
    shown.push(el);
  }
  const rect = (el) => rects.get(el) || el.getBoundingClientRect();

  lap();
  section = "page-scroll";
  // ---- page-scroll ----------------------------------------------------------------------------------
  {
    const d = document.documentElement;
    if (window.scrollY > 0 || window.scrollX > 0 || d.scrollWidth > vw + T || d.scrollHeight > vh + T) {
      report("page-scroll", d, `window scrolls: scroll ${d.scrollWidth}x${d.scrollHeight} in ${vw}x${vh}, at ${window.scrollX},${window.scrollY}`);
    }
  }

  lap();
  section = "pane-h-overflow / empty-page";
  // ---- pane-h-overflow / empty-page -----------------------------------------------------------------
  for (const body of document.querySelectorAll(".ws-pane__body")) {
    if (!visible(body)) continue;
    if (body.scrollWidth > body.clientWidth + T) {
      // Name what sticks out: the outermost element past the pane's edge, else a text that runs
      // out of its element (unbreakable text in a box that can't shrink).
      const edge = body.getBoundingClientRect().left + body.clientLeft + body.clientWidth + T;
      let culprit = null;
      // Inside a box (below the pane) that clips it: cut off there, not what makes the pane wide.
      const clipped = (n) => {
        for (let p = n.parentElement; p && p !== body; p = p.parentElement) if (cs(p).overflowX !== "visible" && p.getBoundingClientRect().right <= edge) return true;
        return false;
      };
      for (const el of body.querySelectorAll("*")) {
        if (el.getBoundingClientRect().right > edge && !clipped(el) && !(el.parentElement && el.parentElement !== body && el.parentElement.getBoundingClientRect().right > edge)) {
          culprit = describe(el);
          break;
        }
      }
      if (!culprit) {
        const w = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
        const range = document.createRange();
        for (let n = w.nextNode(); n && !culprit; n = w.nextNode()) {
          range.selectNodeContents(n);
          if (range.getBoundingClientRect().right > edge && !clipped(n)) culprit = `text "${n.textContent.trim().slice(0, 30)}" in ${describe(n.parentElement)}`;
        }
      }
      report("pane-h-overflow", body, `pane scrolls sideways: ${body.scrollWidth} > ${body.clientWidth}${culprit ? `; sticking out: ${culprit}` : ""}`);
    }
    const tab = [...body.querySelectorAll(".ws-tab-slot")].find((s) => !s.hidden);
    if (tab && (tab.innerText || "").trim() === "" && !tab.querySelector("img,svg,iframe,canvas")) report("empty-page", body, "the shown tab has no content");
  }

  lap();
  section = "escapes-container";
  // ---- escapes-container ----------------------------------------------------------------------------
  // The nearest ancestor that clips (overflow other than visible) bounds an element: sticking out
  // of it sideways means it is cut off (hidden/clip) or makes that box scroll (auto/scroll),
  // which is only fine for boxes meant to scroll sideways.
  const H_SCROLLERS = ".cds--tab--list, .table-wrap--scroll .cds--data-table-content, pre, .milkdown pre, .code-editor, .cds--tabs__nav, .cm-scroller, .views-tabs";
  function clipParent(el) {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const s = cs(p);
      if (s.overflowX !== "visible" || s.contain.includes("paint")) return p;
    }
    return null;
  }
  for (const el of shown) {
    if (srOnly(el) || el.closest(".cds--assistive-text, .cds--visually-hidden, .cds--popover-content:not(.cds--popover--open > *)")) continue;
    const r = rect(el);
    if (r.width === 0 || r.height === 0) continue;
    const p = clipParent(el);
    if (!p) continue;
    if (p.matches(H_SCROLLERS) || p.closest(".cds--tab--list")) continue;
    const pr = p.getBoundingClientRect();
    const pcs = cs(p);
    const left = pr.left + p.clientLeft;
    const right = left + p.clientWidth;
    const over = Math.max(r.right - right, left - r.left);
    if (over <= T) continue;
    // Only report the outermost offender: its children stick out along with it.
    const parentEscapes = el.parentElement && el.parentElement !== p && rect(el.parentElement).right - right > T;
    if (parentEscapes) continue;
    const s = cs(el);
    if (s.textOverflow === "ellipsis") continue; // reported by text-clipped if relevant
    if (s.position === "fixed") continue; // placed in the window, not in its parent
    if (s.position === "absolute") {
      // Positioned decorations (focus rings, fades) are fine when invisible to the pointer.
      if (s.pointerEvents === "none") continue;
    }
    report("escapes-container", el, `sticks out ${Math.round(over)}px of ${describe(p)} (overflow-x: ${pcs.overflowX})`);
  }

  lap();
  section = "text-clipped";
  // ---- text-clipped ---------------------------------------------------------------------------------
  for (const el of shown) {
    const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (!hasText || srOnly(el)) continue;
    if (el.matches("input, textarea, select, option, script, style")) continue;
    const s = cs(el);
    const clipsX = s.overflowX !== "visible";
    const clipsY = s.overflowY !== "visible";
    if (clipsX && el.scrollWidth > el.clientWidth + T && s.textOverflow !== "ellipsis" && s.overflowX !== "auto" && s.overflowX !== "scroll") {
      report("text-clipped", el, `text cut off sideways without "…" (${el.scrollWidth} > ${el.clientWidth})`);
    }
    if (clipsY && el.scrollHeight > el.clientHeight + 2 && s.webkitLineClamp === "none" && s.overflowY !== "auto" && s.overflowY !== "scroll") {
      // A single line box taller than its element by its descenders is not clipping text.
      const lh = parseFloat(s.lineHeight) || parseFloat(s.fontSize) * 1.3;
      if (el.scrollHeight - el.clientHeight > lh * 0.4) report("text-clipped", el, `text cut off vertically (${el.scrollHeight} > ${el.clientHeight})`);
    }
  }

  lap();
  section = "text-overlap";
  // ---- text-overlap ---------------------------------------------------------------------------------
  {
    const boxes = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.textContent.trim()) continue;
      const el = n.parentElement;
      if (!el || !rects.has(el) || srOnly(el) || el.closest("script,style,textarea,.cds--assistive-text,svg,[aria-hidden=true] .cds--visually-hidden")) continue;
      // Text in a box that clips it counts only where it shows.
      range.selectNodeContents(n);
      for (const r of range.getClientRects()) {
        if (r.width < 2 || r.height < 2) continue;
        if (r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) continue;
        boxes.push({ r, el, node: n, layer: layerOf(el) });
      }
    }
    // Clip each box to its clipping ancestors (ellipsis text, scrolled content).
    const clipCache = new Map();
    function visibleArea(el) {
      if (clipCache.has(el)) return clipCache.get(el);
      let area = { left: -Infinity, top: -Infinity, right: Infinity, bottom: Infinity };
      for (let p = el; p && p !== document.documentElement; p = p.parentElement) {
        const s = cs(p);
        if (s.overflowX !== "visible" || s.overflowY !== "visible") {
          const pr = p.getBoundingClientRect();
          area = { left: Math.max(area.left, pr.left), top: Math.max(area.top, pr.top), right: Math.min(area.right, pr.right), bottom: Math.min(area.bottom, pr.bottom) };
        }
      }
      clipCache.set(el, area);
      return area;
    }
    const clipped = boxes
      .map((b) => {
        const a = visibleArea(b.el);
        const r = { left: Math.max(b.r.left, a.left), top: Math.max(b.r.top, a.top), right: Math.min(b.r.right, a.right), bottom: Math.min(b.r.bottom, a.bottom) };
        return { ...b, c: r };
      })
      .filter((b) => b.c.right - b.c.left > 1 && b.c.bottom - b.c.top > 1)
      .sort((a, b) => a.c.left - b.c.left);
    const seen = new Set();
    for (let i = 0; i < clipped.length; i++) {
      const a = clipped[i];
      for (let j = i + 1; j < clipped.length; j++) {
        const b = clipped[j];
        if (b.c.left >= a.c.right) break;
        if (a.node === b.node || a.layer !== b.layer) continue;
        const w = Math.min(a.c.right, b.c.right) - Math.max(a.c.left, b.c.left);
        const h = Math.min(a.c.bottom, b.c.bottom) - Math.max(a.c.top, b.c.top);
        // Lines of one paragraph touch by their line-height: demand a real overlap.
        if (w > 3 && h > Math.min(a.c.bottom - a.c.top, b.c.bottom - b.c.top) * 0.35) {
          const key = describe(a.el) + "|" + describe(b.el);
          if (seen.has(key)) continue;
          seen.add(key);
          report("text-overlap", a.el, `text overlaps "${b.node.textContent.trim().slice(0, 30)}" in ${describe(b.el)} (${Math.round(w)}x${Math.round(h)}px)`);
        }
      }
    }
  }

  lap();
  section = "controls";
  // ---- controls -------------------------------------------------------------------------------------
  const CONTROL_SEL = "button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=tab], [role=menuitem], [role=checkbox], [role=switch], [role=treeitem], [role=option], [role=combobox], [role=slider], [contenteditable=true], [contenteditable=plaintext-only]";
  const controls = shown.filter((el) => el.matches(CONTROL_SEL) && !srOnly(el) && !el.closest("[inert], [aria-hidden=true]"));
  // Controls nested in another control (an icon inside a button, a tab's close button) count once.
  const topControls = controls.filter((el) => !controls.some((o) => o !== el && o.contains(el) && !o.matches("[role=treeitem], [role=tab], [role=option], [contenteditable]")));
  const inViewport = (r) => r.right > 0 && r.bottom > 0 && r.left < vw && r.top < vh;
  /** The part of an element not scrolled out of view by its scrolling ancestors. */
  function shownRect(el) {
    let r = rect(el);
    let area = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
      const s = cs(p);
      if (s.overflowX !== "visible" || s.overflowY !== "visible") {
        const pr = p.getBoundingClientRect();
        area = { left: Math.max(area.left, pr.left), top: Math.max(area.top, pr.top), right: Math.min(area.right, pr.right), bottom: Math.min(area.bottom, pr.bottom) };
      }
    }
    area.left = Math.max(area.left, 0); area.top = Math.max(area.top, 0);
    area.right = Math.min(area.right, vw); area.bottom = Math.min(area.bottom, vh);
    return area;
  }

  for (const el of topControls) {
    const r = rect(el);
    if (!inViewport(r)) continue;
    const layer = layerOf(el);
    const s = shownRect(el);
    const fully = s.right - s.left >= r.width - T && s.bottom - s.top >= r.height - T;

    // tiny-target: text links are exempt (they are as big as their words, like "Io" in a list of
    // references); icon links and buttons aren't.
    const inline = el.matches("a") && (cs(el).display === "inline" || (el.textContent.trim() !== "" && !el.querySelector("svg, img")));
    // Carbon's slider thumb is 14px by design; its whole track takes clicks.
    if (!inline && !el.matches("input[type=checkbox], input[type=radio], .cds--slider__thumb") && (r.width < 16 - 0.5 || r.height < 16 - 0.5)) {
      report("tiny-target", el, `control is ${Math.round(r.width)}x${Math.round(r.height)}px`);
    }

    // occluded: hit-test the centre of the part that shows.
    if (fully && s.right - s.left > 4 && s.bottom - s.top > 4) {
      const x = (s.left + s.right) / 2;
      const y = (s.top + s.bottom) / 2;
      const hit = document.elementFromPoint(x, y);
      if (hit && hit !== el && !el.contains(hit) && !hit.contains(el)) {
        const hitLayer = layerOf(hit);
        const legit =
          hitLayer !== layer || // a popover, menu, modal or tooltip covers it
          hit.closest("label") === el.closest("label") && el.closest("label") || // a label's parts
          (el.id && hit.closest(`label[for="${CSS.escape(el.id)}"]`)) ||
          (() => {
            // Content scrolled under a sticky / fixed bar.
            for (let p = hit; p && p !== document.body; p = p.parentElement) {
              const pos = cs(p).position;
              if ((pos === "sticky" || pos === "fixed") && !p.contains(el)) return true;
            }
            return false;
          })() ||
          // Carbon puts a visual twin over some inputs (checkbox / toggle labels, date icons).
          el.matches("input") && (hit.closest(".cds--form-item, .cds--checkbox-wrapper, .cds--toggle, .cds--date-picker, .cds--search, .cds--list-box, .cds--number, .cds--slider-container") === el.closest(".cds--form-item, .cds--checkbox-wrapper, .cds--toggle, .cds--date-picker, .cds--search, .cds--list-box, .cds--number, .cds--slider-container"));
        if (!legit) report("occluded", el, `covered at its centre by ${describe(hit)}`);
      }
    }
  }

  // controls-overlap
  {
    const list = topControls
      .filter((el) => inViewport(rect(el)) && !el.matches("[contenteditable], [role=treeitem]"))
      .map((el) => ({ el, r: shownRect(el), layer: layerOf(el) }))
      .filter((c) => c.r.right - c.r.left > 2 && c.r.bottom - c.r.top > 2)
      .sort((a, b) => a.r.left - b.r.left);
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        if (b.r.left >= a.r.right - T) break;
        if (a.layer !== b.layer || a.el.contains(b.el) || b.el.contains(a.el)) continue;
        // A card's link lies under the whole card by design; the card's own links and checkboxes sit above it.
        if (a.el.matches(".item-card__link") || b.el.matches(".item-card__link")) continue;
        // Tabs of one tab list are laid out by Carbon (a dismissable tab's close button sits over
        // the tab; in a clipped strip the hidden neighbours touch the shown tab inside its clip).
        if (a.el.closest(".cds--tab--list") && a.el.closest(".cds--tab--list") === b.el.closest(".cds--tab--list")) continue;
        // A checkbox's input and its label are one control.
        if (a.el.closest("label") && a.el.closest("label") === b.el.closest("label")) continue;
        // Carbon composites put buttons inside their input (password toggle, combo box arrow, clear).
        const composite = ".cds--text-input__field-wrapper, .cds--list-box__field, .cds--list-box, .cds--search, .cds--number__input-wrapper, .cds--date-picker-input__wrapper, .cds--time-picker";
        if (a.el.closest(composite) && a.el.closest(composite) === b.el.closest(composite)) continue;
        if ((a.el.id && b.el.matches(`label[for="${CSS.escape(a.el.id)}"]`)) || (b.el.id && a.el.matches(`label[for="${CSS.escape(b.el.id)}"]`))) continue;
        const w = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
        const h = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
        if (w > T && h > T) report("controls-overlap", a.el, `overlaps ${describe(b.el)} by ${Math.round(w)}x${Math.round(h)}px`);
      }
    }
  }

  lap();
  section = "compact-size";
  // ---- compact-size ---------------------------------------------------------------------------------
  {
    // Deliberately larger modals: one holding a code editor (a component's code;
    // too cramped at xs) and the image lightbox (as wide as its image).
    const bigModal = (el) => !!el.closest(".cds--modal-container") && !!el.closest(".cds--modal")?.querySelector(".code-editor, .lightbox img") || !!el.closest(".lightbox");
    const BIG = [".cds--btn--md", ".cds--btn--lg", ".cds--btn--xl", ".cds--btn--2xl", ".cds--text-input--md", ".cds--text-input--lg", ".cds--select--md", ".cds--select--lg", ".cds--search--md", ".cds--search--lg", ".cds--list-box--md", ".cds--list-box--lg", ".cds--accordion--md", ".cds--accordion--lg", ".cds--dropdown--md", ".cds--dropdown--lg", ".cds--number--md", ".cds--number--lg", ".cds--modal-container--sm", ".cds--modal-container--md", ".cds--modal-container--lg", ".cds--date-picker__input--md", ".cds--date-picker__input--lg", ".cds--time-picker--md", ".cds--time-picker--lg", ".cds--overflow-menu--md", ".cds--overflow-menu--lg", ".cds--data-table--md", ".cds--data-table--lg", ".cds--data-table--xl", ".cds--data-table--xs"];
    for (const el of document.querySelectorAll(BIG.join(","))) {
      // The global search bar is large on purpose: a modal-like surface across the top.
      if (!visible(el) || el.closest(".search-bar")) continue;
      // Carbon puts its modal footer buttons in the modal's size; tall footer buttons are Carbon's.
      if (el.closest(".cds--modal-footer") || bigModal(el)) continue;
      report("compact-size", el, `uses a larger size (${[...el.classList].find((c) => BIG.includes("." + c))})`);
    }
    for (const el of shown) {
      if (!el.matches(".cds--btn, .cds--text-input, .cds--select-input, .cds--search-input, .cds--date-picker__input, .cds--time-picker__input-field, .cds--number input, .cds--list-box__field, .cds--list-box:not(.cds--multi-select--filterable)")) continue;
      // Exempt: Carbon's own small parts (tree labels, tabs, notifications) and the collection
      // editor's name, a heading-sized input by design.
      if (el.closest(".cds--modal-footer, .cds--tabs, .cds--toast-notification, .cds--inline-notification, .cds--actionable-notification, .title-edit__name, .search-bar") || el.matches(".cds--tree-node__label__text-button") || el.closest(".cds--modal-close-button") || srOnly(el)) continue;
      if (el.matches(".cds--list-box__field") && el.closest(".cds--list-box")) continue; // measured on the box
      const h = rect(el).height;
      if (Math.abs(h - 32) > 1 && !(el.matches("textarea") || el.matches(".cds--text-area"))) report("compact-size", el, `height ${Math.round(h)}px, the small size is 32px`);
    }
    for (const m of document.querySelectorAll(".cds--modal.is-visible .cds--modal-container")) {
      if (!m.classList.contains("cds--modal-container--xs") && !bigModal(m)) report("compact-size", m, "modal is not size xs");
    }
  }

  lap();
  section = "ghost-with-text";
  // ---- ghost-with-text ------------------------------------------------------------------------------
  for (const el of shown) {
    if (!el.matches(".cds--btn--ghost, .cds--btn--danger--ghost") || el.matches(".cds--tree-node__label__text-button")) continue;
    let text = "";
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const p = n.parentElement;
      if (p.closest(".cds--assistive-text, .cds--popover, .cds--visually-hidden, svg, [role=tooltip]") || srOnly(p) || !visible(p)) continue;
      text += n.textContent;
    }
    if (text.trim()) report("ghost-with-text", el, `ghost button with the label "${text.trim().slice(0, 40)}"`);
  }

  lap();
  section = "accessible-name";
  // ---- accessible-name ------------------------------------------------------------------------------
  function accName(el) {
    const by = el.getAttribute("aria-labelledby");
    if (by) {
      const t = by.split(/\s+/).map((id) => document.getElementById(id)?.textContent || "").join(" ").trim();
      if (t) return t;
    }
    const a = el.getAttribute("aria-label");
    if (a && a.trim()) return a;
    if (el.matches("input, select, textarea")) {
      if (el.id) {
        const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (l && l.textContent.trim()) return l.textContent;
      }
      const l = el.closest("label");
      if (l && l.textContent.trim()) return l.textContent;
      if (el.placeholder) return el.placeholder;
      if (el.title) return el.title;
      return "";
    }
    const t = (el.innerText || el.textContent || "").trim();
    if (t) return t;
    if (el.title) return el.title;
    const img = el.querySelector("img[alt]");
    if (img && img.alt) return img.alt;
    const svgTitle = el.querySelector("svg title");
    if (svgTitle && svgTitle.textContent.trim()) return svgTitle.textContent;
    return "";
  }
  for (const el of controls) {
    if (el.matches("[contenteditable]") || el.closest(".ProseMirror")) continue;
    if (!accName(el).trim()) report("accessible-name", el, "control has no accessible name");
  }
  for (const img of document.querySelectorAll("img")) {
    if (visible(img) && !img.hasAttribute("alt")) report("accessible-name", img, "image without alt attribute");
  }

  lap();
  section = "spellcheck";
  // ---- spellcheck -----------------------------------------------------------------------------------
  if (document.documentElement.getAttribute("spellcheck") !== "false") report("spellcheck", document.documentElement, '<html> lacks spellcheck="false"');
  for (const el of document.querySelectorAll("[spellcheck=true], [spellcheck='']")) report("spellcheck", el, "spell-check enabled");
  for (const el of document.querySelectorAll(".ProseMirror")) {
    if (el.spellcheck) report("spellcheck", el, "markdown editor has spell-check on");
  }

  lap();
  section = "popovers";
  // ---- popovers -------------------------------------------------------------------------------------
  const FLOAT_SEL = ".cds--popover--open > .cds--popover > .cds--popover-content, .cds--list-box__menu, .cds--overflow-menu-options--open, .cds--modal.is-visible .cds--modal-container, .flatpickr-calendar.open, [role=menu], .milkdown-link-popover";
  const floats = [...document.querySelectorAll(FLOAT_SEL)].filter((el) => visible(el) && !srOnly(el));
  for (const f of floats) {
    const r = f.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) continue;
    if (r.left < -T || r.top < -T || r.right > vw + T || r.bottom > vh + T) {
      report("popover-in-viewport", f, `reaches outside the window: ${Math.round(r.left)},${Math.round(r.top)} – ${Math.round(r.right)},${Math.round(r.bottom)} in ${vw}x${vh}`);
    }
    if (f.scrollWidth > f.clientWidth + T && cs(f).overflowX !== "visible") report("popover-overflow", f, `content wider than the panel: ${f.scrollWidth} > ${f.clientWidth}`);
    for (let p = f.parentElement; p; p = p.parentElement) {
      if (cs(p).filter !== "none") {
        report("filter-ancestor", p, `has filter: ${cs(p).filter} above an open floating panel`);
        break;
      }
    }
  }

  lap();
  section = "theme-color";
  // ---- theme-color ----------------------------------------------------------------------------------
  // Every colour on screen should be a Carbon token's value (themes, layers). The values of all
  // --cds-* custom properties are collected from the theme roots and layer containers.
  {
    // Colours are normalised to getComputedStyle's "rgb(r, g, b)" / "rgba(r, g, b, a)" through a
    // canvas: no DOM change, so no style recalculation of a huge page per token.
    const ctx = document.createElement("canvas").getContext("2d");
    const normCache = new Map();
    const norm = (c) => {
      if (normCache.has(c)) return normCache.get(c);
      ctx.fillStyle = "#000";
      ctx.fillStyle = c;
      const f = ctx.fillStyle; // "#rrggbb" or "rgba(r, g, b, a)"
      const out = f.startsWith("#") ? `rgb(${parseInt(f.slice(1, 3), 16)}, ${parseInt(f.slice(3, 5), 16)}, ${parseInt(f.slice(5, 7), 16)})` : f.replace(/rgba\((\d+), (\d+), (\d+), 0?(\.\d+|1|0)\)/, (_, r, g, b, a) => `rgba(${r}, ${g}, ${b}, ${Number(a)})`);
      normCache.set(c, out);
      return out;
    };
    const tokens = new Set(["rgba(0, 0, 0, 0)", "transparent"]);
    // Tokens differ by theme and layer only: one root per distinct theme context is enough (a big
    // page has thousands of tooltip contents, each an equal root).
    const candidates = [document.documentElement, document.body, ...document.querySelectorAll("[class*='cds--layer'], [class*='cds--white'], [class*='cds--g10'], [class*='cds--g90'], [class*='cds--g100'], .cds--popover-content, .cds--modal-container, .cds--side-nav, .cds--tooltip-content, .cds--theme-zone")];
    const seenContexts = new Set();
    for (const root of candidates) {
      const s = getComputedStyle(root);
      const key = ["--cds-background", "--cds-layer", "--cds-layer-01", "--cds-field", "--cds-text-primary", "--cds-border-subtle", "--cds-popover-background-color"].map((n) => s.getPropertyValue(n)).join("|");
      if (seenContexts.has(key)) continue;
      seenContexts.add(key);
      for (let i = 0; i < s.length; i++) {
        const name = s[i];
        if (!name.startsWith("--cds-")) continue;
        const v = s.getPropertyValue(name).trim();
        if (/^(#|rgb|hsl)/.test(v)) tokens.add(norm(v));
      }
    }
    const strip = (c) => c.replace(/rgba\((\d+), (\d+), (\d+), 1\)/, "rgb($1, $2, $3)");
    const known = (c) => tokens.has(strip(c)) || /rgba\(\d+, \d+, \d+, 0\)/.test(c);
    const seenColors = new Set();
    for (const el of shown) {
      // Exempt: user content (images, code colouring) and image covers filled with their average colour.
      if (el.closest("iframe, .item-view__image, img, .cm-editor, .token, .milkdown pre code, .lightbox, .item-card__cover") || srOnly(el)) continue;
      const s = cs(el);
      const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
      const props = [["background-color", s.backgroundColor]];
      if (hasText) props.push(["color", s.color]);
      for (const side of ["Top", "Right", "Bottom", "Left"]) {
        if (parseFloat(s[`border${side}Width`]) > 0 && s[`border${side}Style`] !== "none") props.push([`border-${side.toLowerCase()}-color`, s[`border${side}Color`]]);
      }
      for (const [prop, value] of props) {
        if (known(value) || seenColors.has(prop + value)) continue;
        seenColors.add(prop + value);
        report("theme-color", el, `${prop} ${value} is no theme token value`);
      }
    }
  }

  lap();
  section = "tab-strip";
  // ---- tab-strip ------------------------------------------------------------------------------------
  for (const strip of document.querySelectorAll(".ws-pane--top > .ws-pane__tabs")) {
    if (!visible(strip)) continue;
    const s = cs(strip);
    const bg = s.backgroundColor;
    const solid = /^rgb\(/.test(bg) || /rgba\([^)]*, 1\)$/.test(bg);
    // The strip is sticky in its scroller (phones) or simply at the top of a non-scrolling pane.
    const top = strip.getBoundingClientRect().top;
    if (!solid) report("tab-strip", strip, `background is not solid (${bg})`);
    if (s.position !== "sticky" && s.position !== "static" && s.position !== "relative") report("tab-strip", strip, `position ${s.position}`);
    if (s.position === "sticky" && s.top !== "0px") report("tab-strip", strip, `sticky at top ${s.top}`);
    if (Math.abs(top) > T && !strip.closest(".ws-split--column > .ws-split__child:not(:first-child)")) report("tab-strip", strip, `top tab strip is at y=${Math.round(top)}, not at the window's top`);
    const above = document.elementFromPoint(strip.getBoundingClientRect().left + 4, 1);
    if (above && !strip.contains(above) && !above.closest(".cds--side-nav, .search-bar, " + LAYER_SEL) && !above.contains(strip)) report("tab-strip", above, "something sits above the top tab strip");
  }
  for (const m of document.querySelectorAll('meta[name="apple-mobile-web-app-status-bar-style"]')) {
    if (m.content === "black-translucent") report("status-bar-meta", m, "black-translucent status bar style");
  }

  lap();
  section = "toolbar-align";
  // ---- toolbar-align --------------------------------------------------------------------------------
  {
    const rows = new Map();
    for (const el of shown) {
      if (!el.matches(".cds--btn--icon-only") || srOnly(el)) continue;
      const p = el.closest(".views-bar, .ws-pane__tabs, .section-header, .page-header__actions, .overflow-bar, .side-nav-search, .cds--toolbar-content, .items-search, .item-info");
      if (!p) continue;
      // A button in a popover opened from the row is laid out in the popover, not the row.
      const layer = el.closest(".cds--popover-content");
      if (layer && !p.closest(".cds--popover-content")) continue;
      if (!rows.has(p)) rows.set(p, []);
      rows.get(p).push(el);
    }
    for (const [row, buttons] of rows) {
      const centers = buttons.map((b) => {
        const r = rect(b);
        return (r.top + r.bottom) / 2;
      });
      // Buttons wrapped onto another line form their own row: compare those sharing a line.
      const sorted = [...centers].sort((a, b) => a - b);
      for (let i = 1; i < sorted.length; i++) {
        const d = sorted[i] - sorted[i - 1];
        if (d > T && d < 16) {
          report("toolbar-align", row, `icon buttons off by ${d.toFixed(1)}px vertically in one row`);
          break;
        }
      }
    }
  }

  lap();
  section = "nested-scroll";
  // ---- nested-scroll --------------------------------------------------------------------------------
  {
    const scrolls = (el) => {
      const s = cs(el);
      return (s.overflowY === "auto" || s.overflowY === "scroll") && el.scrollHeight > el.clientHeight + 2;
    };
    for (const el of shown) {
      if (layerOf(el) !== document.body || !scrolls(el) || el.matches("textarea, .cds--side-nav__navigation, .side-nav-tree")) continue;
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        if (scrolls(p) && !p.matches(".side-nav-tree, .cds--side-nav__navigation")) {
          report("nested-scroll", el, `scrolls inside ${describe(p)} (${el.scrollHeight} > ${el.clientHeight})`);
          break;
        }
      }
    }
  }

  lap();
  section = "duplicate-id";
  // ---- duplicate-id ---------------------------------------------------------------------------------
  {
    const ids = new Map();
    for (const el of document.querySelectorAll("[id]")) {
      if (!el.id) continue;
      ids.set(el.id, (ids.get(el.id) || 0) + 1);
    }
    for (const [id, n] of ids) if (n > 1) report("duplicate-id", document.getElementById(id), `id "${id}" used ${n} times`);
  }

  lap();
  section = "broken-image";
  // ---- broken-image ---------------------------------------------------------------------------------
  for (const img of document.querySelectorAll("img")) {
    if (!visible(img) || !img.getAttribute("src")) continue;
    if (img.complete && img.naturalWidth === 0) report("broken-image", img, `image failed to load: ${img.getAttribute("src").slice(0, 60)}`);
  }

  lap();
  section = "native-control";
  // ---- native-control -------------------------------------------------------------------------------
  for (const el of shown) {
    if (!el.matches("button, input:not([type=hidden]), select, textarea")) continue;
    if (el.closest(".ProseMirror, .milkdown, iframe, .cm-editor")) continue;
    const carbon = [...el.classList].some((c) => c.startsWith("cds--")) || !!el.closest("[class*='cds--']:not(.cds--content):not(body):not(.cds--layer-one):not(.cds--layer-two):not(.cds--layer-three)");
    if (!carbon) report("native-control", el, `<${el.tagName.toLowerCase()}> outside any Carbon component`);
  }

  lap();
  section = "icon-size";
  // ---- icon-size ------------------------------------------------------------------------------------
  for (const el of shown) {
    // Exempt: the collection editor's icon button and the icon picker's grid show a bigger icon
    // on purpose (the icon is the choice), and Carbon's modal close button.
    if (!el.matches(".cds--btn--icon-only") || el.closest(".title-edit, .cds--modal-close-button, .icon-grid") || srOnly(el)) continue;
    const svg = el.querySelector(":scope > svg, :scope > span > svg");
    if (!svg || !visible(svg)) continue;
    const r = svg.getBoundingClientRect();
    if (Math.abs(r.width - 16) > 0.5 || Math.abs(r.height - 16) > 0.5) report("icon-size", el, `icon is ${Math.round(r.width)}x${Math.round(r.height)}px, not 16px`);
  }

  lap();
  section = "contrast";
  // ---- contrast -------------------------------------------------------------------------------------
  {
    const ctx = document.createElement("canvas").getContext("2d");
    const rgba = (c) => {
      ctx.fillStyle = "#000";
      ctx.fillStyle = c;
      const f = ctx.fillStyle;
      if (f.startsWith("#")) return [parseInt(f.slice(1, 3), 16), parseInt(f.slice(3, 5), 16), parseInt(f.slice(5, 7), 16), 1];
      const m = f.match(/rgba?\(([\d.]+), ([\d.]+), ([\d.]+)(?:, ([\d.]+))?\)/);
      return m ? [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]] : [0, 0, 0, 1];
    };
    const over = (top, under) => {
      const a = top[3];
      return [top[0] * a + under[0] * (1 - a), top[1] * a + under[1] * (1 - a), top[2] * a + under[2] * (1 - a), 1];
    };
    const lum = (c) => {
      const ch = c.slice(0, 3).map((v) => {
        v /= 255;
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
    };
    const ratio = (a, b) => {
      const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
      return (x + 0.05) / (y + 0.05);
    };
    const pageBg = rgba(cs(document.body).backgroundColor)[3] > 0 ? rgba(cs(document.body).backgroundColor) : rgba(cs(document.documentElement).backgroundColor);
    /** The colour behind an element: its own and its ancestors' backgrounds, composited; null when an image or gradient is behind it. */
    const bgCache = new Map();
    function behind(el) {
      if (!el || el === document.documentElement) return pageBg[3] > 0 ? pageBg : [255, 255, 255, 1];
      if (bgCache.has(el)) return bgCache.get(el);
      const s = cs(el);
      let out;
      if (s.backgroundImage !== "none" || el.matches("img, video, canvas, iframe") || parseFloat(s.opacity) < 1) out = null;
      else {
        const under = behind(el.parentElement);
        const c = rgba(s.backgroundColor);
        out = under === null ? (c[3] >= 1 ? c : null) : c[3] > 0 ? over(c, under) : under;
      }
      bgCache.set(el, out);
      return out;
    }
    const seenPairs = new Set();
    for (const el of shown) {
      const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
      if (!hasText || srOnly(el)) continue;
      if (el.closest("[disabled], [aria-disabled=true], .cds--btn--disabled, .cds--label--disabled, .cds--text-input--disabled, iframe, .cm-editor, .token, .lightbox, .item-card__cover, .image-input, [role=tooltip]")) continue;
      if (el.matches("input, textarea, select, option")) continue; // their placeholders are exempt; values are checked as text elsewhere
      const s = cs(el);
      if (parseFloat(s.opacity) === 0) continue;
      const bg = behind(el);
      if (!bg) continue;
      const fg = rgba(s.color);
      const color = fg[3] < 1 ? over(fg, bg) : fg;
      const r = ratio(color, bg);
      const size = parseFloat(s.fontSize);
      const bold = parseInt(s.fontWeight, 10) >= 700;
      const large = size >= 24 || (bold && size >= 18.66);
      const need = large ? 3 : 4.5;
      if (r + 0.05 < need) {
        const key = `${s.color}|${bg.join(",")}`;
        if (seenPairs.has(key)) continue;
        seenPairs.add(key);
        report("contrast", el, `contrast ${r.toFixed(2)}:1 (needs ${need}:1): ${s.color} on rgb(${bg.slice(0, 3).map(Math.round).join(", ")})`);
      }
    }
  }

  lap();
  section = "popover-detached / aria-expanded";
  // ---- popover-detached / aria-expanded ------------------------------------------------------------
  {
    const TIP = ".cds--tooltip, .cds--icon-tooltip, .cds--definition-tooltip";
    const parts = (root) => {
      const own = root.querySelector(":scope > .cds--popover");
      const panel = own && own.querySelector(":scope > .cds--popover-content");
      const trigger = [...root.querySelectorAll("button, [role=button]")].find((b) => !own || !own.contains(b));
      return { own, panel, trigger };
    };
    for (const root of document.querySelectorAll(".cds--popover-container.cds--popover--open")) {
      if (root.matches(TIP) || !visible(root)) continue;
      const { panel, trigger } = parts(root);
      if (!panel || !trigger || !visible(panel) || !visible(trigger)) continue;
      const p = panel.getBoundingClientRect();
      const b = trigger.getBoundingClientRect();
      const M = 16;
      const near = p.right > b.left - M && p.left < b.right + M && p.bottom > b.top - M && p.top < b.bottom + M;
      if (!near) report("popover-detached", panel, `panel ${Math.round(p.left)},${Math.round(p.top)}–${Math.round(p.right)},${Math.round(p.bottom)} is away from its button at ${Math.round(b.left)},${Math.round(b.top)}–${Math.round(b.right)},${Math.round(b.bottom)}`);
    }
    for (const btn of document.querySelectorAll("button[aria-expanded]")) {
      if (!visible(btn)) continue;
      let root = null;
      for (let p = btn.parentElement; p; p = p.parentElement) {
        if (p.matches(".cds--popover-container") && !p.matches(TIP)) {
          root = p;
          break;
        }
      }
      if (!root) continue;
      const { own, panel, trigger } = parts(root);
      if (!panel || trigger !== btn || (own && own.contains(btn))) continue;
      const open = root.classList.contains("cds--popover--open");
      if ((btn.getAttribute("aria-expanded") === "true") !== open) report("aria-expanded", btn, `aria-expanded=${btn.getAttribute("aria-expanded")} while its popover is ${open ? "open" : "closed"}`);
    }
  }

  lap();
  section = "focus-hidden";
  // ---- focus-hidden ---------------------------------------------------------------------------------
  // Only where asked (opts.focus: right after focus moved, e.g. by Tab): a user who scrolls leaves
  // the focused control behind on purpose.
  if (opts.focus) {
    const el = document.activeElement;
    if (el && el !== document.body && el !== document.documentElement && el.tagName !== "IFRAME" && visible(el) && !srOnly(el) && !el.closest("[aria-hidden=true]")) {
      const r = el.getBoundingClientRect();
      let area = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
      for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
        const s = cs(p);
        if (s.overflowX !== "visible" || s.overflowY !== "visible") {
          const pr = p.getBoundingClientRect();
          area = { left: Math.max(area.left, pr.left), top: Math.max(area.top, pr.top), right: Math.min(area.right, pr.right), bottom: Math.min(area.bottom, pr.bottom) };
        }
      }
      area = { left: Math.max(area.left, 0), top: Math.max(area.top, 0), right: Math.min(area.right, vw), bottom: Math.min(area.bottom, vh) };
      const w = area.right - area.left, h = area.bottom - area.top;
      const need = Math.min(r.width * r.height * 0.5, 16 * 16);
      if (w <= 0 || h <= 0 || w * h < need) report("focus-hidden", el, `the focused control is out of sight (${Math.max(0, Math.round(w))}x${Math.max(0, Math.round(h))}px of it shows)`);
      else {
        const hit = document.elementFromPoint((area.left + area.right) / 2, (area.top + area.bottom) / 2);
        if (hit && hit !== el && !el.contains(hit) && !hit.contains(el)) {
          for (let p = hit; p && p !== document.body; p = p.parentElement) {
            const pos = cs(p).position;
            if ((pos === "sticky" || pos === "fixed") && !p.contains(el) && layerOf(p) === layerOf(el)) {
              report("focus-hidden", el, `the focused control is under ${describe(p)}`);
              break;
            }
          }
        }
      }
    }
  }

  lap();
  return { violations: out, counts, times };
}
