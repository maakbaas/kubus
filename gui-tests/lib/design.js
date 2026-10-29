// ---------------------------------------------------------------------------------------------
// Design rules: visual consistency, next to the layout audit's breakage rules (audit.js). Like
// `__audit`, `__design` runs inside the browser (page.evaluate) on what is on screen and returns
// one entry per violation ({ rule, message, target, box }); `t.audit` runs both and records them
// together. Each rule was first measured on every page (`{ survey: true }` returns what each rule
// sees, by value, instead of violations); what the app does almost everywhere became the rule and
// the outliers were fixed in styles.css. Exemptions: a selector, with a comment saying why.
//
// Rules (ids in CRITERIA, audit.js):
//   spacing-scale     margins, paddings and gaps on Carbon's spacing scale
//   edge-align        a pane's content starts on one left edge
//   block-fit         every block (on item pages too) lies inside its page's content box; what it draws (chart, map) inside the block
//   phone-width       a window-wide pane on a phone: the page's content box is the window minus the page padding
//   rhythm            equal gaps between the fields of an item page / the blocks of a view
//   toolbar-pitch     icon buttons in a row at a 32px pitch: no gaps, no overlaps
//   progress-stop     a progress bar sits in a LoadingBar with a "×" stop button, on the right edge of its
//                     block's header buttons (or the block's own)
//   type-style        text set in one of the Carbon type styles the app uses
//   baseline          text side by side shares a baseline
//   radius            square corners, but for Carbon's own round parts
//   shadow            box-shadows only on floating layers and as focus / selection marks
//   border            border widths 0, 1 or 2px
//   truncation-hint   text cut with "…" shows its whole text somewhere (title, tooltip, name)
//   touch-target      phones: controls ≥ 24×24px, or 24px apart (WCAG 2.5.8)
//   popover-padding   toolbar popover panels: one padding on all sides
// ---------------------------------------------------------------------------------------------

/** Runs in the page. `opts.skip`: rule ids to leave out; `opts.max`: violations kept per rule; `opts.survey`: measure only. */
function __design(opts) {
  const skip = new Set(opts.skip || []);
  const maxPerRule = opts.max || 8;
  const survey = opts.survey ? {} : null;
  const out = [];
  const counts = {};
  const T = 1.5;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const cs = (el) => getComputedStyle(el);

  function describe(el) {
    const parts = [];
    let n = el;
    for (let i = 0; n && n.nodeType === 1 && i < 4; i++, n = n.parentElement) {
      let s = n.tagName.toLowerCase();
      const cls = [...n.classList].slice(0, 2);
      if (cls.length) s += "." + cls.join(".");
      parts.unshift(s);
    }
    const text = (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 30);
    return parts.join(" > ") + (text ? ` "${text}"` : "");
  }
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
  /** Survey mode: counts a value seen by a rule, with an example element. */
  const seen = (rule, value, el) => {
    if (!survey) return;
    const r = (survey[rule] ||= {});
    const v = (r[value] ||= { n: 0, example: describe(el) });
    v.n++;
  };
  /** A rule's check: a violation, or (survey) just the value. */
  const judge = (rule, ok, el, value, message) => {
    seen(rule, value, el);
    if (!survey && !ok) report(rule, el, message);
  };

  const visible = (el) => el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) && el.getClientRects().length > 0;
  const srOnly = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width <= 1.5 || r.height <= 1.5) return true;
    const s = cs(el);
    return s.clip === "rect(0px, 0px, 0px, 0px)" || s.clipPath === "inset(50%)";
  };
  // On screen only (a big page has tens of thousands of elements; tests scroll to what they check).
  const shown = [];
  const collapsedNav = document.querySelector(".cds--side-nav:not(.cds--side-nav--expanded)");
  for (const el of document.querySelectorAll("body *")) {
    if (el instanceof SVGElement || el.closest("#__gui_test_marks, iframe, .cm-editor, .lightbox")) continue;
    const r = el.getBoundingClientRect();
    if (r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw || r.width === 0 || r.height === 0) continue;
    if (!visible(el) || srOnly(el) || (collapsedNav && collapsedNav.contains(el))) continue;
    shown.push(el);
  }
  const ownText = (el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
  const px = (v) => Math.round(parseFloat(v) * 100) / 100;
  /** Rendered user content: a note's Markdown, an HTML / component field. Its spacing is the content's. */
  const USER_CONTENT = ".md-view, .milkdown, .ProseMirror, .html-view, .component-value";

  // ---- spacing-scale ------------------------------------------------------------------------------
  // Carbon's spacing scale. Only the app's own elements (with a class, none of them cds--) are
  // held to it; Carbon's components keep their own insides. Exempt, because they are derived, not
  // chosen: the vertical padding that centres one line of text in a 2rem row (its value follows
  // from the font: (2rem - border - line) / 2), equal side margins that centre a column (auto),
  // the workspace's offset beside the docked side nav (its width), and cells of Carbon's tables.
  {
    const SCALE = new Set([0, 2, 4, 8, 12, 16, 24, 32, 40, 48, 64, 80, 96, 160]);
    const PROPS = ["marginTop", "marginRight", "marginBottom", "marginLeft", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "rowGap", "columnGap"];
    for (const el of shown) {
      // A chart's insides are Carbon Charts' (Carbon's design: its tooltips, legends and axes).
      if ([...el.classList].some((c) => c.startsWith("cds--")) || el.closest(USER_CONTENT + ", .cds--chart-holder") || !el.classList.length) continue;
      // The page's end also clears the home indicator and an on-screen keyboard (keyboardInset.ts).
      if (el.matches(".app-content, .cds--data-table td, .cds--data-table th")) continue;
      const pageEnd = el.matches(".ws-tab-content");
      const s = cs(el);
      const h = el.getBoundingClientRect().height;
      const row = Math.abs(h - 32) <= 1 || Math.abs(h - 31) <= 1;
      for (const p of PROPS) {
        const raw = s[p];
        if (raw === "normal" || raw === "auto") continue;
        const v = Math.abs(px(raw));
        if (!Number.isFinite(v) || SCALE.has(v)) {
          seen("spacing-scale", `${v}`, el);
          continue;
        }
        // The same centring for the first line of a taller value (--block-pad-top, styles.css).
        if ((row || el.matches(".view-field__value, .code-editor__input, .code-editor__highlight")) && /^padding(Top|Bottom)$/.test(p)) continue;
        if (pageEnd && p === "paddingBottom") continue;
        if (/^margin(Left|Right)$/.test(p) && s.marginLeft === s.marginRight) continue;
        judge("spacing-scale", false, el, `${v}`, `${p} ${v}px is not on the spacing scale`);
      }
    }
  }

  // ---- toolbar-pitch ------------------------------------------------------------------------------
  // Icon buttons side by side in one row touch: a 32px pitch (Carbon's small icon buttons), no
  // gap that reads as a separate group, no overlap.
  {
    const rows = new Map();
    for (const el of shown) {
      if (!el.matches(".cds--btn--icon-only")) continue;
      const row = el.closest(".views-bar__actions, .section-header__actions, .page-header__actions, .overflow-bar__items, .items-search, .item-info");
      if (!row || (el.closest(".cds--popover-content") && !row.closest(".cds--popover-content"))) continue;
      if (!rows.has(row)) rows.set(row, []);
      rows.get(row).push(el.getBoundingClientRect());
    }
    for (const [row, rects] of rows) {
      const line = rects.filter((r) => Math.abs((r.top + r.bottom) / 2 - (rects[0].top + rects[0].bottom) / 2) < 8).sort((a, b) => a.left - b.left);
      for (let i = 1; i < line.length; i++) {
        const gap = Math.round(line[i].left - line[i - 1].right);
        judge("toolbar-pitch", Math.abs(gap) <= 1, row, `gap ${gap}`, `icon buttons ${gap > 0 ? `${gap}px apart` : `overlap by ${-gap}px`} in one row`);
      }
    }
  }

  // ---- progress-stop -----------------------------------------------------------------------------
  // Every progress bar is a LoadingBar (ui/LoadingBar.tsx): a 32px "×" icon button at its right, on
  // the right edge of the block's header buttons (the block's own edge when its header is hidden).
  {
    for (const bar of shown) {
      if (!bar.matches(".cds--progress-bar")) continue;
      const box = bar.closest(".loading-bar");
      const stop = box && [...box.querySelectorAll(".cds--btn--icon-only")].find((b) => shown.includes(b));
      if (!stop) {
        judge("progress-stop", false, bar, "no stop", "a progress bar has no \"×\" stop button (LoadingBar with onStop)");
        continue;
      }
      const section = bar.closest("section, .view-field");
      const buttons = section ? [...section.querySelectorAll(":scope > .section-header .cds--btn--icon-only")].filter((b) => shown.includes(b)) : [];
      const edge = buttons.length ? Math.max(...buttons.map((b) => b.getBoundingClientRect().right)) : section ? section.getBoundingClientRect().right : 0;
      const right = stop.getBoundingClientRect().right;
      judge("progress-stop", !edge || Math.abs(right - edge) <= T, stop, `${Math.round(right)} vs ${Math.round(edge)}`, "the stop button's right edge differs from the block's header buttons'");
    }
  }

  // ---- type-style ---------------------------------------------------------------------------------
  // (font-size / line-height / letter-spacing, weight) of every text, against Carbon's type styles.
  {
    const STYLES = {
      "12/16/0.32": "label-01 / helper-text-01",
      "12/16/0.16": "label-01 (v11)",
      "14/18/0.16": "body-compact-01 / heading-compact-01",
      "14/20/0.16": "body-01",
      "14/20/0.32": "code-02",
      "14/18/0.32": "code-02 on one 2rem row (dates and code in tables)",
      // Carbon sets its labels in a fixed 1rem line; item fields' labels are one step up (label-02's size).
      "14/16/0.16": "label-02 in Carbon's 1rem label line (item fields)",
      // Carbon's menu items set their text in a fixed 1rem line too; in item fields, at body-compact-02's size.
      "16/16/0": "body-compact-02 in Carbon's 1rem menu-item line (item fields)",
      "16/22/0": "body-compact-02 / heading-compact-02",
      "16/24/0": "body-02 / heading-02",
      "20/28/0": "heading-03",
      "28/36/0": "heading-04",
      "32/40/0": "heading-05",
      "42/50.36/0": "heading-06 (a stat's number)",
    };
    const WEIGHTS = new Set(["300", "400", "600"]);
    // Carbon's components with their own text settings (tree nodes, the tab strip's contained tabs,
    // sortable table headers, Carbon Charts' axes, legends and tooltips): Carbon's design.
    const CARBON_TEXT = ".cds--tree-node, .cds--tabs--contained, .cds--table-header-label, .cds--table-sort, .cds--chart-holder";
    for (const el of shown) {
      if (!ownText(el) || el.closest(USER_CONTENT + ", .item-card__cover, " + CARBON_TEXT)) continue;
      const s = cs(el);
      const size = px(s.fontSize);
      const lh = s.lineHeight === "normal" ? "normal" : px(s.lineHeight);
      const ls = s.letterSpacing === "normal" ? 0 : px(s.letterSpacing);
      const key = `${size}/${lh}/${ls}`;
      judge("type-style", key in STYLES, el, key, `font ${key} (size / line-height / letter-spacing) is none of the type styles used`);
      judge("type-style", WEIGHTS.has(s.fontWeight), el, `weight ${s.fontWeight}`, `font weight ${s.fontWeight} (only 300, 400, 600)`);
    }
  }

  // ---- radius / shadow / border -------------------------------------------------------------------
  {
    // Carbon's own round parts: checkbox (2px), toggle (track and knob), tag, slider thumb, radio,
    // the content switcher's ends, loading spinner, a chart legend's swatches (Carbon Charts'); the Markdown's inline code (the editor's).
    const ROUND = ".cds--popover-content, .cds--checkbox-label, .cds--toggle__switch, .cds--toggle__appearance, .cds--tag, .cds--slider__thumb, .cds--radio-button__appearance, .cds--loading, .cds--popover-caret, .cds--tooltip-content, .cds--skeleton, .cds--chart-holder";
    // Floating layers (shadows give them depth) and the dragged row of a reorder.
    const FLOATING = ".cds--popover-content, .overflow-bar[data-open] > .overflow-bar__items, .cds--modal-container, .cds--list-box__menu, .cds--overflow-menu-options, .flatpickr-calendar, [role=menu], .search-bar, .cds--side-nav, [data-dragging], .cds--toast-notification, .ws-drop, .cds--cc--tooltip";
    for (const el of shown) {
      const s = cs(el);
      const radius = [s.borderTopLeftRadius, s.borderTopRightRadius, s.borderBottomLeftRadius, s.borderBottomRightRadius].map(px);
      const r = Math.max(...radius);
      if (r > 0 || survey) judge("radius", r === 0 || !!el.closest(ROUND) || el.matches(ROUND) || !!el.closest(USER_CONTENT), el, `${r}`, `rounded corners (${r}px)`);
      if (s.boxShadow !== "none") {
        // An inset shadow is a focus / selection mark (Carbon draws focus and selected rows with it).
        // Carbon's contained tabs draw their dividers as box-shadows (Carbon's design).
        // So does what is being edited in place (the title's field background spread around it).
        // So does a chart legend's swatch (Carbon Charts' own focus ring around it).
        const inset = /inset/.test(s.boxShadow) || el.matches(".cds--tabs--contained .cds--tabs__nav-item, :focus-within, .cds--chart-holder .legend-item .checkbox");
        judge("shadow", inset || !!el.closest(FLOATING) || el.matches(FLOATING), el, inset ? "inset" : "outer", `a box-shadow outside the floating layers: ${s.boxShadow.slice(0, 60)}`);
      }
      // Carbon's notifications mark their kind with a 3px edge (Carbon's design).
      const notice = !!el.closest(".cds--inline-notification, .cds--actionable-notification, .cds--toast-notification");
      for (const side of ["Top", "Right", "Bottom", "Left"]) {
        if (s[`border${side}Style`] === "none" || notice) continue;
        const w = px(s[`border${side}Width`]);
        if (w === 0) continue;
        judge("border", w === 1 || w === 2, el, `${w}`, `border-${side.toLowerCase()} ${w}px (only 1 or 2px)`);
      }
    }
  }

  // ---- truncation-hint ----------------------------------------------------------------------------
  // Text cut with an ellipsis can still be read whole: a title on it or an ancestor, a tooltip (a
  // Carbon tooltip / icon button label), or an accessible name that holds it.
  for (const el of shown) {
    const s = cs(el);
    if (s.textOverflow !== "ellipsis" || s.overflowX === "visible" || el.scrollWidth <= el.clientWidth + 1) continue;
    const text = (el.textContent || "").trim().replace(/\s+/g, " ");
    if (!text) continue;
    let hinted = false;
    for (let p = el; p && p !== document.body && !hinted; p = p.parentElement) {
      const t = p.getAttribute("title") || p.getAttribute("aria-label") || "";
      if (t && t.replace(/\s+/g, " ").includes(text.slice(0, 40))) hinted = true;
      if (p.matches(".cds--tooltip, .cds--icon-tooltip, .cds--definition-tooltip, [aria-describedby]")) hinted = true;
    }
    // A <select>'s or a list box's chosen text is read whole in its list.
    if (el.closest("select, .cds--list-box, .cds--select")) hinted = true;
    judge("truncation-hint", hinted, el, hinted ? "hinted" : "not hinted", `"${text.slice(0, 30)}…" is cut and its whole text is shown nowhere`);
  }

  // ---- touch-target -------------------------------------------------------------------------------
  // Phones (coarse pointer): every control at least 24×24px, or with nothing else within 24px of
  // its centre (WCAG 2.5.8). Links in running text are exempt (the WCAG inline exception).
  if (matchMedia("(pointer: coarse)").matches) {
    // Links set in a line of text (a cell's or card's list of titles, helper text): their height is
    // the line's (the WCAG exception for targets constrained by the line-height of text).
    const inline = (el) => el.matches("a") && (cs(el).display === "inline" || !!el.closest("td, dd, .cds--form__helper-text, .view-field__value"));
    const controls = shown.filter((el) => el.matches("button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=checkbox], [role=tab], [role=option], [role=menuitem]") && !inline(el) && !el.closest("p, li, .md-view, .cds--chart-holder") && !el.disabled);
    const rects = controls.map((el) => el.getBoundingClientRect());
    controls.forEach((el, i) => {
      const r = rects[i];
      if (r.width >= 24 - 0.5 && r.height >= 24 - 0.5) return seen("touch-target", "≥24", el);
      // A small control: a 24px circle on its centre may not reach another control.
      const cx = (r.left + r.right) / 2, cy = (r.top + r.bottom) / 2;
      const crowded = rects.some((o, j) => {
        if (j === i || controls[j].contains(el) || el.contains(controls[j])) return false;
        const dx = Math.max(o.left - cx, 0, cx - o.right), dy = Math.max(o.top - cy, 0, cy - o.bottom);
        return Math.hypot(dx, dy) < 12;
      });
      judge("touch-target", !crowded, el, crowded ? "small, crowded" : "small, spaced", `${Math.round(r.width)}×${Math.round(r.height)}px with another control within 24px`);
    });
  }

  // ---- popover-padding ----------------------------------------------------------------------------
  for (const panel of document.querySelectorAll(".cds--popover--open .toolbar-popover__panel")) {
    // A list of rows (the tab menu) is padded at the sides only: its rows bring their own height, as a menu's do.
    if (!visible(panel) || panel.querySelector(":scope > .tab-menu__list")) continue;
    const s = cs(panel);
    const pads = [s.paddingTop, s.paddingRight, s.paddingBottom, s.paddingLeft].map(px);
    const even = pads.every((p) => p === pads[0]);
    judge("popover-padding", even, panel, pads.join(" "), `padding ${pads.join(" / ")}px is not the same on all sides`);
  }

  // ---- edge-align -------------------------------------------------------------------------------
  // In a pane the page has one left edge, where its breadcrumb starts: the title (its icon, when
  // it has one), description, views bar and blocks start there too, and the first view tab's
  // label at Carbon's tab inset (16px: the tab's line starts on the edge). On the right, the page
  // header's buttons, the views bar and the block headers end on one edge.
  {
    const textLeft = (el) => {
      const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let n = w.nextNode(); n; n = w.nextNode()) {
        if (!n.textContent.trim() || !n.parentElement || !visible(n.parentElement)) continue;
        const range = document.createRange();
        range.selectNodeContents(n);
        const r = range.getClientRects()[0];
        if (r && r.width > 0) return r.left;
      }
      return null;
    };
    for (const pane of document.querySelectorAll(".ws-pane")) {
      const tab = [...pane.querySelectorAll(".ws-tab-slot")].find((s) => !s.hidden);
      const content = tab && tab.querySelector(".ws-tab-content");
      const crumb = content && [...content.querySelectorAll(".page-header .cds--breadcrumb")].find(visible);
      if (!crumb) continue;
      const edge = crumb.getBoundingClientRect().left;
      const own = (sel) => [...content.querySelectorAll(sel)].filter((e) => visible(e) && !e.closest(".cds--popover-content, .cds--modal, .item-fields"));
      const LEFT = [
        ["page title", ".page-header__title", 0, false],
        ["description", ".page-header__subtitle", 0, false],
        ["views bar", ".views-bar", 0, false],
        ["block", "@blocks", 0, false],
        ["first view tab's label", ".views-bar .cds--tabs__nav-item:first-child", 16, true],
      ];
      // Blocks of a collection view and of an item page (inside .item-fields): the outermost ones.
      const blocks = [...content.querySelectorAll(".block")].filter((b) => visible(b) && !b.closest(".cds--popover-content, .cds--modal") && !b.parentElement.closest(".block"));
      // Blocks side by side in a row (views/BlockRows.tsx): only the row's first starts on the left edge, only its last's header ends on the right one.
      const rowCells = (b) => {
        const cells = b.closest(".block-row__cells");
        return cells && cs(cells).flexDirection === "row" ? [...cells.querySelectorAll(":scope > .block-cell")].filter(visible) : null;
      };
      const atStart = (b) => !rowCells(b) || rowCells(b)[0] === b.closest(".block-cell");
      const atEnd = (b) => !rowCells(b) || rowCells(b).at(-1) === b.closest(".block-cell");
      for (const [name, sel, inset, text] of LEFT) {
        for (const el of (sel === "@blocks" ? blocks.filter(atStart) : own(sel)).slice(0, 4)) {
          // A tab list scrolled sideways (the selected tab brought into view) moves its labels with it.
        const scrolled = text ? el.closest(".cds--tab--list")?.scrollLeft ?? 0 : 0;
        const left = text ? textLeft(el) + scrolled : el.getBoundingClientRect().left;
          if (left === null) continue;
          const d = Math.round(left - edge - inset);
          judge("edge-align", Math.abs(d) <= 1, el, `${name} ${d}`, `${name} starts ${d}px off the page's left edge${inset ? ` (+${inset}px)` : ""}`);
        }
      }
      const rights = [...own(".page-header__actions"), ...own(".views-bar"), ...blocks.filter(atEnd).map((b) => b.querySelector(":scope > .section-header")).filter((h) => h && visible(h))].map((el) => [el, el.getBoundingClientRect().right]);
      if (rights.length > 1) {
        const ref = rights[0][1];
        for (const [el, right] of rights.slice(1)) {
          const d = Math.round(right - ref);
          judge("edge-align", Math.abs(d) <= 1, el, `right ${d}`, `ends ${d}px off the page header's right edge`);
        }
      }
      // Blocks end where the page's content box does, and what a block draws stays inside the block:
      // a chart's svg or a map's canvas (the outermost svg: Carbon's heatmap draws wider axes inside it, clipped by it) that is wider than its block would push its "⋮" menu out.
      const cb = content.getBoundingClientRect();
      const cstyle = cs(content);
      const boxRight = cb.right - px(cstyle.paddingRight) - (content.offsetWidth - content.clientWidth);
      for (const b of blocks.slice(0, 12)) {
        const br = b.getBoundingClientRect().right;
        judge("block-fit", br <= boxRight + 1, b, `block ${Math.round(br - boxRight)}`, `ends ${Math.round(br - boxRight)}px beyond the page's content box`);
        for (const d of [...b.querySelectorAll("svg, canvas")].filter((e) => visible(e) && !e.closest(".cds--popover-content, button, .cds--btn") && !e.parentElement.closest("svg")).slice(0, 6)) {
          const r = d.getBoundingClientRect();
          if (r.width < 100) continue;
          judge("block-fit", r.right <= br + 1, d, `drawn ${Math.round(r.right - br)}`, `a ${Math.round(r.width)}px-wide ${d.tagName.toLowerCase()} ends ${Math.round(r.right - br)}px beyond its block`);
        }
      }
      // A pane as wide as a phone's window: the page's content box is the window minus one spacing-05.
      const pr = pane.getBoundingClientRect();
      if (vw <= 672 && Math.abs(pr.left) <= 1 && Math.abs(pr.right - vw) <= 1) {
        const pad = 16;
        const head = [...content.querySelectorAll(".page-header")].find(visible);
        const left = crumb.getBoundingClientRect().left;
        judge("phone-width", Math.abs(left - pad) <= 1, crumb, `left ${Math.round(left - pad)}`, `the page starts ${Math.round(left)}px from the window's left edge, not ${pad}px`);
        if (head) {
          const right = head.getBoundingClientRect().right;
          judge("phone-width", Math.abs(vw - pad - right) <= 1, head, `right ${Math.round(vw - pad - right)}`, `the page header ends ${Math.round(vw - right)}px from the window's right edge, not ${pad}px`);
        }
      }
    }
  }

  // ---- rhythm -------------------------------------------------------------------------------------
  // Equal gaps between siblings: an item page's fields and blocks, a collection view's blocks.
  // On a collection page only the blocks count (the header and views bar above them have their own gaps).
  const lists = new Map([...document.querySelectorAll(".item-fields")].map((l) => [l, null]));
  // Blocks are in rows (views/BlockRows.tsx): the gaps between rows, and between the blocks of a row stacked (a phone).
  for (const r of document.querySelectorAll(".ws-tab-content .block-row")) if (!r.closest(".item-fields")) lists.set(r.parentElement, ".block-row");
  for (const c of document.querySelectorAll(".ws-tab-content .block-row__cells")) if (cs(c).flexDirection === "column") lists.set(c, ".block-cell");
  for (const [list, only] of lists) {
    if (!visible(list)) continue;
    // Through display: contents wrappers (a field shown without its label); not screen-reader-only bits.
    const flat = (els) => els.flatMap((k) => (cs(k).display === "contents" ? flat([...k.children]) : [k]));
    const kids = flat([...list.children]).filter((k) => (!only || k.matches(only)) && visible(k) && !srOnly(k) && k.getBoundingClientRect().height > 2);
    const gaps = [];
    for (let i = 1; i < kids.length; i++) gaps.push(Math.round(kids[i].getBoundingClientRect().top - kids[i - 1].getBoundingClientRect().bottom));
    const set = [...new Set(gaps)];
    judge("rhythm", set.length <= 1, list, set.join(","), `gaps between its parts differ: ${set.join(", ")}px`);
  }

  // ---- baseline -----------------------------------------------------------------------------------
  // A checkbox's label beside its box, a tab's label and its close button: centred on one line.
  for (const label of shown.filter((el) => el.matches(".cds--checkbox-label-text"))) {
    const box = label.closest(".cds--checkbox-label");
    if (!box) continue;
    const before = getComputedStyle(box, "::before");
    const lr = label.getBoundingClientRect();
    const br = box.getBoundingClientRect();
    const boxTop = br.top + px(before.top === "auto" ? "0" : before.top) + px(before.marginTop);
    const boxMid = boxTop + px(before.height) / 2;
    const lineH = px(cs(label).lineHeight) || lr.height;
    const textMid = lr.top + px(cs(label).paddingTop) + lineH / 2;
    const d = Math.round(textMid - boxMid);
    judge("baseline", Math.abs(d) <= 2, label, `checkbox ${d}`, `checkbox label ${d}px off its box's centre`);
  }

  return { violations: out, counts, survey };
}
