// ---------------------------------------------------------------------------------------------
// Test harness. This file, data.js, audit.js and one suite are concatenated into the body of a
// single `async page => { … }` function and run with `playwright-cli run-code` (see run.mjs).
// That sandbox has no require/import, no setTimeout and no file system: waiting goes through
// Playwright (page.waitForTimeout), files are written by Playwright (screenshot paths).
//
// A suite registers tests with test(name, fn). Each test runs in a fresh browser context (its
// own OPFS database, localStorage and viewport) and gets a `t` with helpers; every checkpoint
// (t.audit, t.check, t.noShift, …) is a pass/fail criterion recorded with a screenshot.
// ---------------------------------------------------------------------------------------------

/* global __OPTS, page */

const __tests = [];
/** Registers a test. `opts.viewport`: a key of VIEWPORTS (default desktop); `opts.dark`: dark theme. */
function test(name, fn, opts = {}) {
  __tests.push({ name, fn, opts });
}

const VIEWPORTS = {
  phone: { width: 390, height: 844, isMobile: true, hasTouch: true },
  "phone-small": { width: 320, height: 568, isMobile: true, hasTouch: true },
  tablet: { width: 820, height: 1180, isMobile: true, hasTouch: true },
  laptop: { width: 1024, height: 768 },
  desktop: { width: 1440, height: 900 },
  short: { width: 1280, height: 520 },
  wide: { width: 2560, height: 1200 },
};

class TestFailure extends Error {}

function __makeT(ctx, pg, name, opts) {
  const base = __OPTS.baseUrl.replace(/\/$/, "");
  const shotDir = __OPTS.shotDir;
  const slug = name.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").slice(0, 80);
  const checkpoints = [];
  const errors = [];
  let shotN = 0;
  let loads = 0;
  // Where the test's time goes (ms), reported with its result.
  const timing = { boot: 0, seed: 0, load: 0, settle: 0, settles: 0, settleTimeouts: 0, audit: 0, audits: 0, screenshot: 0, screenshots: 0 };
  const timed = async (key, fn) => {
    const t0 = Date.now();
    try {
      return await fn();
    } finally {
      timing[key] += Date.now() - t0;
    }
  };
  let where = "";

  pg.on("console", (m) => {
    if (m.type() === "error") errors.push({ where, text: m.text().slice(0, 500) });
  });
  pg.on("pageerror", (e) => errors.push({ where, text: "Uncaught: " + String(e && e.message || e).slice(0, 500) }));
  // The app's own files must all load (a missing chunk, icon or stored file); other hosts (a made-up
  // model address in the AI tests) are not the app's.
  const sameOrigin = (url) => url.startsWith(base + "/");
  pg.on("response", (r) => {
    if (r.status() >= 400 && sameOrigin(r.url())) errors.push({ where, text: `Request failed: ${r.status()} ${r.url().slice(base.length, base.length + 200)}` });
  });
  pg.on("requestfailed", (r) => {
    const why = (r.failure() && r.failure().errorText) || "";
    // Aborted: a navigation or a reload cancelled it, not a failure.
    if (sameOrigin(r.url()) && !/ABORTED/i.test(why)) errors.push({ where, text: `Request failed: ${why} ${r.url().slice(base.length, base.length + 200)}` });
  });

  async function shoot(boxes) {
    shotN += 1;
    const file = `${slug}--${String(shotN).padStart(2, "0")}.jpg`;
    try {
      if (boxes && boxes.length) {
        await pg.evaluate((boxes) => {
          const layer = document.createElement("div");
          layer.id = "__gui_test_marks";
          layer.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647";
          for (const b of boxes) {
            const m = document.createElement("div");
            m.style.cssText = `position:fixed;left:${b.x - 2}px;top:${b.y - 2}px;width:${b.w + 4}px;height:${b.h + 4}px;outline:2px solid #ff00ff;background:rgba(255,0,255,.12)`;
            const tag = document.createElement("span");
            tag.textContent = b.n;
            tag.style.cssText = "position:absolute;left:-2px;top:-16px;font:bold 11px/14px monospace;background:#ff00ff;color:#fff;padding:0 3px";
            m.appendChild(tag);
            layer.appendChild(m);
          }
          document.body.appendChild(layer);
        }, boxes);
      }
      await timed("screenshot", () => pg.screenshot({ path: `${shotDir}/${file}`, type: "jpeg", quality: 70, animations: "disabled", caret: "initial" }));
      timing.screenshots++;
      return file;
    } catch {
      return null;
    } finally {
      if (boxes && boxes.length) await pg.evaluate(() => document.getElementById("__gui_test_marks")?.remove()).catch(() => {});
    }
  }

  function record(cp) {
    checkpoints.push(cp);
    return cp.pass;
  }

  const t = {
    page: pg,
    context: ctx,
    viewport: opts.viewport || "desktop",
    vp: VIEWPORTS[opts.viewport || "desktop"],
    phone: (opts.viewport || "desktop").startsWith("phone"),
    base,
    checkpoints,
    errors,
    timing,

    /** Names what the test is doing now (shown with console errors and failures). */
    at(label) {
      where = label;
    },

    /** Loads the app and waits for the database (for seeding before showing a page). */
    async boot() {
      await timed("boot", async () => {
        await pg.goto(base + "/");
        await pg.waitForFunction(() => window.kubus && window.kubus.repo, null, { timeout: 30000 });
        await pg.waitForSelector(".ws-pane", { timeout: 30000 });
      });
    },

    /** Opens an app route in the (single) tab by loading the app with it in the address bar. */
    async open(path = "/collections", { settle = true, keepTabs = false } = {}) {
      where = path;
      // A fresh single tab (unless keepTabs), and a real load: a changed hash alone loads nothing.
      if (!keepTabs && pg.url().startsWith(base)) {
        await pg.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("kubus.workspace.")).forEach((k) => localStorage.removeItem(k)));
      }
      loads += 1;
      await timed("load", async () => {
        await pg.goto(`${base}/?load=${loads}#${path}`);
        await pg.waitForFunction(() => window.kubus && window.kubus.repo, null, { timeout: 30000 });
        await pg.waitForSelector(".ws-pane", { timeout: 30000 });
      });
      if (settle) await t.settle();
    },

    /** Navigates the active tab like a side-nav link would (no reload). */
    async go(path) {
      where = path;
      await pg.evaluate((path) => {
        const a = document.createElement("a");
        a.href = "#" + path;
        a.textContent = "go";
        document.querySelector(".ws-links").appendChild(a);
        a.click();
        a.remove();
      }, path);
      await t.settle();
    },

    /** Waits until the page stops changing: no DOM mutations for `quiet` ms, fonts and loaders done. */
    async settle(quiet = 200, max = 5000) {
      timing.settles++;
      const t0 = Date.now();
      const timedOut = await pg
        .evaluate(
          ({ quiet, max }) =>
            new Promise((resolve) => {
              const start = performance.now();
              let last = performance.now();
              const obs = new MutationObserver(() => (last = performance.now()));
              obs.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
              const tick = () => {
                const busy = document.querySelector(".page-loading, .cds--loading:not(.cds--loading--stop), .cds--skeleton");
                const t = performance.now();
                if ((!busy && t - last >= quiet) || t - start > max) {
                  obs.disconnect();
                  resolve(t - start > max);
                } else requestAnimationFrame(tick);
              };
              (document.fonts ? document.fonts.ready : Promise.resolve()).then(() => requestAnimationFrame(tick));
            }),
          { quiet, max },
        )
        .catch(() => false);
      timing.settle += Date.now() - t0;
      if (timedOut) timing.settleTimeouts++;
    },

    async wait(ms) {
      await pg.waitForTimeout(ms);
    },

    /** Seeds data through the dev build's repository (window.kubus.repo); see data.js. */
    async seed(spec) {
      return await timed("seed", () => pg.evaluate(__seedInPage, spec));
    },

    /**
     * Runs the layout audit (audit.js) and records it as one checkpoint, with a screenshot in
     * which every violation is outlined and numbered.
     */
    async audit(label, { skip = [], settle = true, shotOnFail = false, focus = false } = {}) {
      if (settle) await t.settle();
      const res = await timed("audit", () => pg.evaluate(__audit, { skip: [...skip, ...(opts.skip || []), ...(__OPTS.skip || [])], max: 8, focus }));
      timing.audits++;
      const violations = res.violations;
      const boxes = violations.filter((v) => v.box && v.box.w > 0).map((v, i) => ({ ...v.box, n: i + 1 }));
      const screenshot = shotOnFail && !violations.length && !__OPTS.shotAll ? null : await shoot(boxes);
      return record({ kind: "audit", label, pass: violations.length === 0, violations, counts: res.counts, screenshot });
    },

    /** A plain assertion; a failing one gets a screenshot. */
    async check(label, pass, detail = "") {
      const screenshot = pass && !__OPTS.shotAll ? null : await shoot();
      return record({ kind: "check", label, pass: !!pass, detail: pass ? "" : String(detail), screenshot });
    },

    /** Like check, but stops the test when it fails (later steps would only fail along). */
    async require(label, pass, detail = "") {
      if (!(await t.check(label, pass, detail))) throw new TestFailure(`${label}: ${detail}`);
    },

    /** A screenshot checkpoint without a criterion (shows the state in the report). */
    async snap(label) {
      await t.settle();
      const screenshot = await shoot();
      return record({ kind: "snap", label, pass: true, screenshot });
    },

    /**
     * Content-jump check: what is on screen (outside `except`) must not move or resize while
     * `action` runs. Elements that appear or disappear are fine; moved ones are reported, only the
     * outermost of a group that moved together. `inPage`: positions within the pane's content
     * (the pane scrolling back because its content got shorter is the browser, not a jump).
     */
    async noShift(label, action, { scope = "body", except = [], tolerance = 1, settle = true, inPage = false } = {}) {
      await t.settle();
      await pg.evaluate(({ scope, inPage }) => {
        const map = new Map();
        const root = document.querySelector(scope) || document.body;
        const pane = document.querySelector(".ws-pane--active .ws-pane__body");
        const off = inPage && pane ? pane.scrollTop : 0;
        for (const el of root.querySelectorAll("*")) {
          if (el instanceof SVGElement && !(el instanceof SVGSVGElement)) continue;
          if (!el.checkVisibility({ visibilityProperty: true, opacityProperty: true })) continue;
          // Not on screen: screen-reader-only text and the box of a closed popover.
          if (el.closest(".cds--visually-hidden, .cds--assistive-text, .cds--popover-container:not(.cds--popover--open) > .cds--popover")) continue;
          const r = el.getBoundingClientRect();
          if (r.width <= 1 || r.height <= 1) continue;
          map.set(el, { x: r.left, y: r.top + off, w: r.width, h: r.height });
        }
        window.__shiftSnap = map;
        window.__scrollSnap = inPage ? [] : [...document.querySelectorAll(".ws-pane__body, .cds--side-nav__navigation, .side-nav-tree")].map((el) => [el, el.scrollTop, el.scrollLeft]);
      }, { scope, inPage });
      await action();
      if (settle) await t.settle();
      const moved = await pg.evaluate(({ except, tolerance, inPage }) => {
        const map = window.__shiftSnap;
        const pane = document.querySelector(".ws-pane--active .ws-pane__body");
        const off = inPage && pane ? pane.scrollTop : 0;
        const exceptEls = except.flatMap((s) => [...document.querySelectorAll(s)]);
        const out = [];
        const movedSet = new Set();
        const describe = (el) => {
          const parts = [];
          for (let n = el, i = 0; n && n.nodeType === 1 && i < 3; n = n.parentElement, i++) {
            parts.unshift(n.tagName.toLowerCase() + ([...n.classList].slice(0, 2).map((c) => "." + c).join("")));
          }
          const text = (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 30);
          return parts.join(" > ") + (text ? ` "${text}"` : "");
        };
        for (const [el, a] of map) {
          if (!el.isConnected || !el.checkVisibility({ visibilityProperty: true, opacityProperty: true })) continue;
          if (exceptEls.some((x) => x.contains(el) || el.contains(x))) continue;
          if (el.closest(".cds--popover-content, .cds--popover-caret, [role=tooltip], .cds--modal, .cds--list-box__menu, .flatpickr-calendar, [role=menu]")) continue;
          const r = el.getBoundingClientRect();
          const dx = r.left - a.x, dy = r.top + off - a.y, dw = r.width - a.w, dh = r.height - a.h;
          if (Math.abs(dx) > tolerance || Math.abs(dy) > tolerance || Math.abs(dw) > tolerance || Math.abs(dh) > tolerance) {
            movedSet.add(el);
            out.push({ el, dx, dy, dw, dh });
          }
        }
        // Keep the outermost moved element of each moved subtree, if it moved the same way.
        const top = out.filter((m) => {
          const p = m.el.parentElement;
          if (!p || !movedSet.has(p)) return true;
          const pm = out.find((o) => o.el === p);
          return !(Math.abs(pm.dx - m.dx) <= 1 && Math.abs(pm.dy - m.dy) <= 1);
        });
        delete window.__shiftSnap;
        const scrolled = (window.__scrollSnap || []).filter(([el, y, x]) => el.isConnected && (Math.abs(el.scrollTop - y) > tolerance || Math.abs(el.scrollLeft - x) > tolerance));
        delete window.__scrollSnap;
        const scrollJumps = scrolled.map(([el, y, x]) => {
          const r = el.getBoundingClientRect();
          return { rule: "scroll-jump", message: `scrolled by ${el.scrollLeft - x},${el.scrollTop - y}`, target: describe(el), box: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } };
        });
        return scrollJumps.concat(top.slice(0, 10).map((m) => {
          const r = m.el.getBoundingClientRect();
          return {
            rule: "content-jump",
            message: `moved ${m.dx.toFixed(1)},${m.dy.toFixed(1)} resized ${m.dw.toFixed(1)},${m.dh.toFixed(1)}`,
            target: describe(m.el),
            box: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
          };
        }));
      }, { except, tolerance, inPage });
      const boxes = moved.filter((v) => v.box.w > 0).map((v, i) => ({ ...v.box, n: i + 1 }));
      const screenshot = moved.length || __OPTS.shotAll ? await shoot(boxes) : null;
      return record({ kind: "shift", label, pass: moved.length === 0, violations: moved, screenshot });
    },

    /**
     * One step inside an open popover (typing, toggling, picking an option, adding a row): the
     * popover stays open (unless `keepOpen: false`), its button doesn't move, its panel keeps the
     * edge it hangs from (it may grow away from its button, never jump, shrink back past it or flip
     * to the other side) and keeps its width, and the control acted on (`target`, a locator) stays
     * under the pointer. With `scope` (a selector), nothing there moves either (noShift's rules:
     * floating layers excepted), e.g. the tab bars and page header behind the panel.
     */
    async popoverStep(label, action, { target = null, scope = null, except = [], keepOpen = true, tolerance = 1 } = {}) {
      await t.settle(100);
      const found = await pg.evaluate(() => {
        for (const el of document.querySelectorAll("[data-step-popover]")) el.removeAttribute("data-step-popover");
        const roots = [...document.querySelectorAll(".cds--popover-container.cds--popover--open")].filter((r) => !r.matches(".cds--tooltip, .cds--icon-tooltip, .cds--definition-tooltip") && r.querySelector(":scope > .cds--popover > .cds--popover-content"));
        const root = roots[roots.length - 1];
        if (!root) return false;
        root.setAttribute("data-step-popover", "");
        return true;
      });
      if (!found) return t.check(`${label}: a popover is open`, false, "no open popover before the step");
      // Brought into view first, as a person would scroll to it (a click would scroll it there
      // itself, after the positions were taken).
      if (target) {
        await target.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
        await target.evaluate((el) => el.setAttribute("data-step-target", "")).catch(() => {});
      }
      const geo = () => pg.evaluate(() => {
        const root = document.querySelector("[data-step-popover]");
        if (!root) return null;
        const own = root.querySelector(":scope > .cds--popover");
        const panel = own && own.querySelector(":scope > .cds--popover-content");
        const trigger = [...root.querySelectorAll("button")].find((b) => !own || !own.contains(b));
        const r = (el) => {
          if (!el || !el.isConnected || !el.getClientRects().length) return null;
          const b = el.getBoundingClientRect();
          return { left: b.left, top: b.top, right: b.right, bottom: b.bottom, width: b.width, height: b.height };
        };
        const tgt = document.querySelector("[data-step-target]");
        return { open: root.classList.contains("cds--popover--open") && !!panel && panel.getClientRects().length > 0, trigger: r(trigger), panel: r(panel), target: r(tgt), targetName: tgt ? (tgt.getAttribute("aria-label") || tgt.textContent || "").trim().slice(0, 40) : "" };
      });
      const a = await geo();
      let shift = null;
      if (scope) shift = await t.noShift(`${label}: nothing behind the popover moves`, action, { scope, except, tolerance });
      else {
        await action();
        await t.settle();
      }
      const b = await geo();
      const out = [];
      const box = (r) => (r ? { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } : null);
      const off = (x, y) => Math.abs(x - y) > tolerance;
      if (!b) out.push({ rule: "popover-closed", message: "the popover is gone", target: "popover" });
      else if (keepOpen && !b.open) out.push({ rule: "popover-closed", message: "the popover closed while being used", target: "popover", box: box(a.panel) });
      if (a && b && b.open && a.panel && b.panel) {
        if (a.trigger && b.trigger && (off(a.trigger.left, b.trigger.left) || off(a.trigger.top, b.trigger.top))) out.push({ rule: "popover-jump", message: `its button moved ${(b.trigger.left - a.trigger.left).toFixed(1)},${(b.trigger.top - a.trigger.top).toFixed(1)}`, target: "popover button", box: box(b.trigger) });
        const below = (g) => g.trigger && g.panel.top >= g.trigger.top;
        if (a.trigger && below(a) !== below(b)) out.push({ rule: "popover-jump", message: `the panel flipped ${below(a) ? "from below to above" : "from above to below"} its button`, target: "popover panel", box: box(b.panel) });
        else if (below(a) ? off(a.panel.top, b.panel.top) : off(a.panel.bottom, b.panel.bottom)) out.push({ rule: "popover-jump", message: `the panel's ${below(a) ? "top" : "bottom"} edge moved ${below(a) ? (b.panel.top - a.panel.top).toFixed(1) : (b.panel.bottom - a.panel.bottom).toFixed(1)}px`, target: "popover panel", box: box(b.panel) });
        if (off(a.panel.left, b.panel.left) || off(a.panel.right, b.panel.right)) out.push({ rule: "popover-jump", message: `the panel moved sideways or changed width: ${Math.round(a.panel.left)}–${Math.round(a.panel.right)} → ${Math.round(b.panel.left)}–${Math.round(b.panel.right)}`, target: "popover panel", box: box(b.panel) });
        if (a.target && b.target && (off(a.target.left, b.target.left) || off(a.target.top, b.target.top))) out.push({ rule: "target-jump", message: `the control acted on moved ${(b.target.left - a.target.left).toFixed(1)},${(b.target.top - a.target.top).toFixed(1)}`, target: a.targetName, box: box(b.target) });
      }
      await pg.evaluate(() => document.querySelector("[data-step-target]")?.removeAttribute("data-step-target")).catch(() => {});
      const boxes = out.filter((v) => v.box && v.box.w > 0).map((v, i) => ({ ...v.box, n: i + 1 }));
      const screenshot = out.length || __OPTS.shotAll ? await shoot(boxes) : null;
      record({ kind: "popover", label, pass: out.length === 0, violations: out, screenshot });
      return out.length === 0 && (!shift || shift);
    },

    /**
     * Escape closes the open popover (or menu, or dialog) at once and leaves nothing floating
     * behind; for a toolbar popover, focus returns to its button. Recorded as one checkpoint.
     */
    async escapeCloses(label, { focusBack = true } = {}) {
      const before = await pg.evaluate(() => {
        const root = [...document.querySelectorAll(".cds--popover-container.cds--popover--open")].filter((r) => !r.matches(".cds--tooltip, .cds--icon-tooltip, .cds--definition-tooltip")).pop();
        for (const el of document.querySelectorAll("[data-esc-trigger]")) el.removeAttribute("data-esc-trigger");
        const own = root && root.querySelector(":scope > .cds--popover");
        const trigger = root && [...root.querySelectorAll("button")].find((b) => !own || !own.contains(b));
        if (trigger) trigger.setAttribute("data-esc-trigger", "");
        return { popover: !!root, trigger: !!trigger };
      });
      await pg.keyboard.press("Escape");
      await t.settle(100);
      const after = await pg.evaluate(() => {
        const left = [...document.querySelectorAll(".cds--popover-container.cds--popover--open, .cds--modal.is-visible, .cds--list-box--expanded, [role=menu]")].filter((r) => !r.matches(".cds--tooltip, .cds--icon-tooltip, .cds--definition-tooltip") && r.checkVisibility());
        const trig = document.querySelector("[data-esc-trigger]");
        const focus = document.activeElement;
        // A popover opened from a "⋮" menu closes with it: focus goes to "⋮" (its button is hidden).
        const menuToggle = trig && !trig.checkVisibility() ? trig.closest(".overflow-bar")?.querySelector(".overflow-bar__toggle") : null;
        return { left: left.map((e) => e.className.split(" ").slice(0, 3).join(".")), focusOk: !trig || trig === focus || trig.contains(focus) || (!!menuToggle && menuToggle === focus), focus: focus ? focus.tagName.toLowerCase() + "." + [...focus.classList].slice(0, 2).join(".") + (focus.getAttribute("aria-label") ? `[${focus.getAttribute("aria-label")}]` : "") : "none" };
      });
      const problems = [];
      if (after.left.length) problems.push(`still open after Escape: ${after.left.join(", ")}`);
      if (focusBack && before.trigger && !after.focusOk) problems.push(`focus went to ${after.focus}, not back to the popover's button`);
      return t.check(`${label}: Escape closes it${focusBack && before.trigger ? " and focus returns to its button" : ""}`, problems.length === 0, problems.join("; "));
    },

    /**
     * One step inside an open dialog (typing, picking, a choice that adds inputs): the dialog stays
     * open, keeps its width and place sideways and its top edge (it may grow downwards, never move
     * up or sideways under the pointer), and the control acted on (`target`) stays put.
     */
    async dialogStep(label, action, { target = null, keepOpen = true, tolerance = 1 } = {}) {
      await t.settle(100);
      if (target) {
        await target.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
        await target.evaluate((el) => el.setAttribute("data-step-target", "")).catch(() => {});
      }
      const geo = () => pg.evaluate(() => {
        const m = [...document.querySelectorAll(".cds--modal.is-visible .cds--modal-container")].pop();
        const r = (el) => {
          if (!el || !el.isConnected || !el.getClientRects().length) return null;
          const b = el.getBoundingClientRect();
          return { left: b.left, top: b.top, right: b.right, bottom: b.bottom, width: b.width, height: b.height };
        };
        const tgt = document.querySelector("[data-step-target]");
        return { open: !!m, dialog: r(m), target: r(tgt), targetName: tgt ? (tgt.getAttribute("aria-label") || tgt.id || tgt.textContent || "").trim().slice(0, 40) : "" };
      });
      const a = await geo();
      await action();
      await t.settle();
      const b = await geo();
      const out = [];
      const off = (x, y) => Math.abs(x - y) > tolerance;
      const box = (r) => (r ? { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } : null);
      if (keepOpen && !b.open) out.push({ rule: "popover-closed", message: "the dialog closed while being used", target: "dialog", box: box(a.dialog) });
      if (a.dialog && b.dialog) {
        if (off(a.dialog.left, b.dialog.left) || off(a.dialog.right, b.dialog.right)) out.push({ rule: "popover-jump", message: `the dialog moved sideways or changed width: ${Math.round(a.dialog.left)}–${Math.round(a.dialog.right)} → ${Math.round(b.dialog.left)}–${Math.round(b.dialog.right)}`, target: "dialog", box: box(b.dialog) });
        if (off(a.dialog.top, b.dialog.top)) out.push({ rule: "popover-jump", message: `the dialog's top edge moved ${(b.dialog.top - a.dialog.top).toFixed(1)}px`, target: "dialog", box: box(b.dialog) });
        if (a.target && b.target && (off(a.target.left, b.target.left) || off(a.target.top, b.target.top))) out.push({ rule: "target-jump", message: `the control acted on moved ${(b.target.left - a.target.left).toFixed(1)},${(b.target.top - a.target.top).toFixed(1)}`, target: a.targetName, box: box(b.target) });
      }
      await pg.evaluate(() => document.querySelector("[data-step-target]")?.removeAttribute("data-step-target")).catch(() => {});
      const boxes = out.filter((v) => v.box && v.box.w > 0).map((v, i) => ({ ...v.box, n: i + 1 }));
      const screenshot = out.length || __OPTS.shotAll ? await shoot(boxes) : null;
      return record({ kind: "dialog", label, pass: out.length === 0, violations: out, screenshot });
    },

    /**
     * Where focus is now: a short description, whether it is in sight (inside the window and the
     * boxes that clip it, not under a sticky bar) and whether it is drawn differently from the same
     * control without focus (an outline, a shadow, a border or background change on it, its label
     * or a wrapper, or their ::before / ::after). Buttons, links and boxes only: blurring a text
     * input to compare could end an edit.
     */
    async focusInfo() {
      return pg.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body || el === document.documentElement) return { none: true };
        const describe = (n) => {
          const parts = [];
          for (let p = n, i = 0; p && p.nodeType === 1 && i < 3; p = p.parentElement, i++) parts.unshift(p.tagName.toLowerCase() + [...p.classList].slice(0, 2).map((c) => "." + c).join(""));
          const name = (n.getAttribute("aria-label") || n.textContent || "").trim().replace(/\s+/g, " ").slice(0, 30);
          return parts.join(" > ") + (name ? ` "${name}"` : "");
        };
        const r = el.getBoundingClientRect();
        let area = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
        for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
          const s = getComputedStyle(p);
          if (s.overflowX !== "visible" || s.overflowY !== "visible") {
            const pr = p.getBoundingClientRect();
            area = { left: Math.max(area.left, pr.left), top: Math.max(area.top, pr.top), right: Math.min(area.right, pr.right), bottom: Math.min(area.bottom, pr.bottom) };
          }
        }
        area = { left: Math.max(area.left, 0), top: Math.max(area.top, 0), right: Math.min(area.right, innerWidth), bottom: Math.min(area.bottom, innerHeight) };
        const w = area.right - area.left, h = area.bottom - area.top;
        const shown = el.checkVisibility({ visibilityProperty: true, opacityProperty: true }) || !!el.closest("label, .cds--checkbox-wrapper, .cds--toggle, .cds--slider");
        let inSight = shown && w > 0 && h > 0 && w * h >= Math.min(r.width * r.height * 0.5, 64);
        let under = "";
        if (inSight) {
          const hit = document.elementFromPoint((area.left + area.right) / 2, (area.top + area.bottom) / 2);
          if (hit && hit !== el && !el.contains(hit) && !hit.contains(el)) {
            for (let p = hit; p && p !== document.body; p = p.parentElement) {
              const pos = getComputedStyle(p).position;
              if ((pos === "sticky" || pos === "fixed") && !p.contains(el) && !p.closest(".cds--popover-content, [role=tooltip]")) {
                under = describe(p);
                inSight = false;
                break;
              }
            }
          }
        }
        const kind = el.matches("input:not([type=checkbox]):not([type=radio]), textarea, select, [contenteditable=true], [contenteditable=plaintext-only], [role=combobox]") ? "text" : "other";
        let indicator = null;
        if (kind === "other") {
          // Its label, wrapper, first descendants (a tree node draws focus on its label row) and next
          // sibling (Carbon's toggle draws it on the switch beside its button).
          const parts = [el, el.parentElement, el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null, el.closest("label"), ...[...el.querySelectorAll("*")].slice(0, 4), el.nextElementSibling, ...(el.nextElementSibling ? [...el.nextElementSibling.querySelectorAll("*")].slice(0, 4) : [])].filter(Boolean);
          // Transitions off while comparing: Carbon fades its focus ring in and out.
          const still = document.createElement("style");
          still.textContent = "*, *::before, *::after { transition: none !important; animation: none !important; }";
          document.head.appendChild(still);
          const sig = () => parts.map((p) => [null, "::before", "::after"].map((pseudo) => {
            const s = getComputedStyle(p, pseudo);
            return [s.outlineStyle, s.outlineWidth, s.outlineColor, s.boxShadow, s.borderTopColor, s.borderBottomColor, s.backgroundColor, s.textDecorationLine].join("|");
          }).join("/")).join("#");
          const focused = sig();
          el.setAttribute("data-focus-probe", "");
          el.blur();
          const blurred = sig();
          el.focus({ preventScroll: true, focusVisible: true });
          el.removeAttribute("data-focus-probe");
          still.remove();
          indicator = focused !== blurred;
        }
        // Unique per element: icon buttons often describe alike.
        el.__focusId ||= (window.__focusIds = (window.__focusIds || 0) + 1);
        return { none: false, id: el.__focusId, what: describe(el), inSight, under, kind, indicator, tag: el.tagName.toLowerCase(), inDialog: !!el.closest(".cds--modal"), sideNav: !!el.closest(".cds--side-nav") };
      });
    },

    /** Number of elements in the document (for leak checks after opening and closing things). */
    async nodeCount() {
      return pg.evaluate(() => document.getElementsByTagName("*").length);
    },

    /** Bounding boxes of the elements matching a selector (visible ones). */
    async rects(selector) {
      return pg.evaluate((sel) => [...document.querySelectorAll(sel)].filter((e) => e.getClientRects().length).map((e) => {
        const r = e.getBoundingClientRect();
        return { x: r.left, y: r.top, w: r.width, h: r.height, right: r.right, bottom: r.bottom };
      }), selector);
    },

    async count(selector) {
      return pg.locator(selector).count();
    },

    /** Layout shift (CLS) recorded since the page loaded or since t.markShifts(), without input. */
    async shifts() {
      return pg.evaluate(() => (window.__guiShifts || []).filter((s) => !s.input).reduce((a, s) => a + s.value, 0));
    },
    /** The biggest shifts since load / markShifts: their score, time and what moved. */
    async shiftSources(max = 4) {
      return pg.evaluate((max) => (window.__guiShifts || []).filter((s) => !s.input).sort((a, b) => b.value - a.value).slice(0, max).map((s) => `${s.value.toFixed(3)} at ${Math.round(s.t)}ms: ${s.sources.join("; ")}`), max);
    },
    async markShifts() {
      await pg.evaluate(() => (window.__guiShifts = []));
    },

    /**
     * Closes what floats over the page: popovers, menus and modals (Escape), the global search bar
     * (Escape inside it) and the side nav where it is an overlay (its toggle).
     */
    async closeAll() {
      for (let i = 0; i < 4; i++) {
        const open = await pg.evaluate(() => !!document.querySelector(".cds--popover--open, .cds--modal.is-visible, .cds--list-box--expanded, [role=menu]"));
        if (!open) break;
        await pg.keyboard.press("Escape");
        await t.wait(120);
      }
      const search = pg.locator(".search-bar input");
      if (await search.count()) {
        await search.focus().catch(() => {});
        await pg.keyboard.press("Escape");
        await t.wait(120);
      }
      const overlayNav = await pg.evaluate(() => !document.querySelector(".app-content--nav-docked") && !!document.querySelector(".cds--side-nav--expanded"));
      if (overlayNav) {
        await pg.getByRole("button", { name: "Hide menu" }).filter({ visible: true }).first().click().catch(() => {});
        await t.wait(150);
      }
    },

    /**
     * A click position near the top-left of the part of `locator` that is on screen. A fixed
     * offset like {x: 4, y: 4} on an element taller than the pane can lie above the view, and
     * Playwright then scrolls the page to reach it (a jump the app didn't make).
     */
    async visiblePoint(locator, dx = 4, dy = 4) {
      return locator.evaluate((el, [dx, dy]) => {
        const r = el.getBoundingClientRect();
        const pane = el.closest(".ws-pane__body")?.getBoundingClientRect() ?? { top: 0, bottom: innerHeight };
        const strip = el.closest(".ws-pane")?.querySelector(".ws-pane__tabs")?.getBoundingClientRect().bottom ?? 0;
        const top = Math.max(r.top, pane.top, strip);
        return { x: dx, y: Math.max(dy, Math.min(r.height - 1, top - r.top + dy)) };
      }, [dx, dy]);
    },

    /** Clicks the first visible match of a role + accessible name. */
    async clickRole(role, name, { exact = false, index = 0 } = {}) {
      const loc = pg.getByRole(role, { name, exact }).filter({ visible: true }).nth(index);
      await loc.click({ timeout: 5000 });
      await t.settle(150);
      return loc;
    },

    /** Opens the item page of an item by its collection and item ids. */
    itemPath: (collectionId, itemId) => `/collections/${collectionId}/items/${itemId}`,
    listPath: (collectionId) => `/collections/${collectionId}/items`,
  };
  t.fail = async (label, detail) => t.check(label, false, detail);
  return t;
}

async function __main(pg) {
  const entry = __tests.find((x) => x.name === __OPTS.test);
  if (!entry) return JSON.stringify({ name: __OPTS.test, status: "error", error: "test not found", checkpoints: [], errors: [] });
  const opts = entry.opts;
  const vp = VIEWPORTS[opts.viewport || "desktop"];
  const browser = pg.context().browser();
  const ctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    isMobile: !!vp.isMobile,
    hasTouch: !!vp.hasTouch,
    deviceScaleFactor: 1,
    colorScheme: opts.dark ? "dark" : "light",
    reducedMotion: "reduce",
  });
  // Layout shifts as the browser measures them (CLS), with whether input preceded them.
  await ctx.addInitScript(() => {
    window.__guiShifts = [];
    try {
      new PerformanceObserver((list) => {
        // Each shift with the elements Chrome attributes it to (what moved, from where to where).
        const describe = (n) => {
          if (!n || n.nodeType !== 1) return n ? "#text in " + describe(n.parentElement) : "?";
          const parts = [];
          for (let el = n, i = 0; el && el.nodeType === 1 && i < 3; el = el.parentElement, i++) parts.unshift(el.tagName.toLowerCase() + [...el.classList].slice(0, 2).map((c) => "." + c).join(""));
          return parts.join(" > ");
        };
        const box = (r) => `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`;
        for (const e of list.getEntries()) {
          const sources = (e.sources || []).map((s) => `${describe(s.node)} (${box(s.previousRect)} → ${box(s.currentRect)})`);
          window.__guiShifts.push({ value: e.value, input: e.hadRecentInput, t: e.startTime, sources });
        }
      }).observe({ type: "layout-shift", buffered: true });
    } catch {}
  });
  const p = await ctx.newPage();
  p.setDefaultTimeout(8000);
  const t = __makeT(ctx, p, entry.name, opts);
  const started = Date.now();
  let status = "pass";
  let error = null;
  try {
    await entry.fn(t);
  } catch (e) {
    error = String((e && e.stack) || e).split("\n").slice(0, 6).join("\n");
    status = e instanceof TestFailure ? "fail" : "error";
    try {
      const shot = await (async () => {
        const file = `${entry.name.replace(/[^a-z0-9]+/gi, "-").slice(0, 80)}--error.jpg`;
        await p.screenshot({ path: `${__OPTS.shotDir}/${file}`, type: "jpeg", quality: 70 });
        return file;
      })();
      t.checkpoints.push({ kind: "error", label: "test stopped", pass: false, detail: error, screenshot: shot });
    } catch {}
  }
  // Criterion for every test: no console errors / uncaught exceptions while it ran.
  const ignored = (__OPTS.ignoreConsole || []).map((s) => new RegExp(s));
  const errs = t.errors.filter((e) => !ignored.some((r) => r.test(e.text)));
  t.checkpoints.push({ kind: "console", label: "no console errors", pass: errs.length === 0, detail: errs.slice(0, 10).map((e) => `[${e.where}] ${e.text}`).join("\n") });
  if (status === "pass" && t.checkpoints.some((c) => !c.pass)) status = "fail";
  await ctx.close().catch(() => {});
  return JSON.stringify({ name: entry.name, status, error, ms: Date.now() - started, timing: t.timing, viewport: opts.viewport || "desktop", dark: !!opts.dark, checkpoints: t.checkpoints });
}
