// In-place editing on an item page: each field kind opened, typed into and saved without moving its label,
// box or text or anything else on the page (docs/features.md).

/** Box geometry of a field (by its name) on the item page: its label and its value / input box. */
async function fieldGeometry(t, name) {
  return t.page.evaluate((name) => {
    const fields = [...document.querySelectorAll(".item-fields > *")];
    const field = fields.find((f) => (f.querySelector(".cds--label")?.textContent || "").trim().replace(/^Collapse|^Expand/, "").trim().startsWith(name));
    if (!field) return null;
    const rect = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    };
    const box = field.querySelector(".view-field__value, .cds--text-input, .cds--number input, .cds--date-picker__input, .cds--list-box, .md-editor, .cds--text-area, .code-editor, .cm-editor");
    // The text's own position: the first text inside the box.
    let text = null;
    if (box) {
      const w = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
      for (let n = w.nextNode(); n; n = w.nextNode()) if (n.textContent.trim()) {
        const r = document.createRange();
        r.selectNodeContents(n);
        const rr = r.getClientRects()[0];
        if (rr) text = { x: rr.left, y: rr.top, w: 0, h: rr.height };
        break;
      }
      if (!text && box.matches("input, textarea")) {
        const s = getComputedStyle(box);
        const r = box.getBoundingClientRect();
        text = { x: r.left + parseFloat(s.paddingLeft) + parseFloat(s.borderLeftWidth), y: 0, w: 0, h: 0 };
      }
    }
    return { label: rect(field.querySelector(".cds--label")), box: rect(box), text, field: rect(field), boxKind: box ? box.className.split(" ")[0] : null };
  }, name);
}

function geometryDiff(a, b, { height = true, width = true, text = true } = {}) {
  const out = [];
  const near = (x, y, tol = 1) => Math.abs(x - y) <= tol;
  if (!a || !b) return ["field not found"];
  if (a.label && b.label && (!near(a.label.x, b.label.x) || !near(a.label.y, b.label.y))) out.push(`label moved ${(b.label.x - a.label.x).toFixed(1)},${(b.label.y - a.label.y).toFixed(1)}`);
  if (a.box && b.box) {
    if (!near(a.box.x, b.box.x) || !near(a.box.y, b.box.y)) out.push(`box moved ${(b.box.x - a.box.x).toFixed(1)},${(b.box.y - a.box.y).toFixed(1)} (${a.boxKind} → ${b.boxKind})`);
    if (width && !near(a.box.w, b.box.w)) out.push(`box width ${a.box.w.toFixed(1)} → ${b.box.w.toFixed(1)}`);
    if (height && !near(a.box.h, b.box.h)) out.push(`box height ${a.box.h.toFixed(1)} → ${b.box.h.toFixed(1)}`);
  }
  if (text && a.text && b.text && !near(a.text.x, b.text.x, 1.5)) out.push(`text starts ${(b.text.x - a.text.x).toFixed(1)}px sideways`);
  return out;
}

/** Clicks an empty spot of the page (the pane's right padding), which saves an open editor. */
async function clickOutside(t) {
  const b = await t.page.locator(".ws-pane--active .ws-pane__body").boundingBox();
  await t.page.mouse.click(b.x + b.width - 6, b.y + Math.min(b.height - 10, 140));
  await t.settle();
}

/** Opens a field's editor by clicking its value, checks geometry and shifts, then cancels / saves. */
async function editRoundTrip(t, name, { type = null, height = true, width = true, multiline = false, source = false } = {}) {
  const value = t.page.getByRole("button", { name: `Edit ${name}`, exact: true }).first();
  if (!(await value.count())) return t.check(`${name}: has an editable value`, false, "no 'Edit' button for the field");
  await value.scrollIntoViewIfNeeded();
  await t.settle();
  const before = await fieldGeometry(t, name);
  // A source editor (HTML: code in place of the rendered page) can't be as tall as the view; what
  // follows it may move then. An empty one is held to the same box as everything else.
  const empty = await value.evaluate((el) => el.classList.contains("view-field__value--empty"));
  const below = source && !empty ? ["[data-under-test] ~ *"] : [];
  // Marks the field (again after the editor replaced its element).
  const mark = () => t.page.evaluate((name) => {
    for (const el of document.querySelectorAll("[data-under-test]")) el.removeAttribute("data-under-test");
    const f = [...document.querySelectorAll(".item-fields > *")].find((f) => (f.querySelector(".cds--label")?.textContent || "").includes(name));
    f?.setAttribute("data-under-test", "");
  }, name);
  await mark();
  // Opening: nothing else on the page moves.
  await t.noShift(`${name}: opening the editor moves nothing else`, async () => {
    await value.click({ position: await t.visiblePoint(value) });
    await t.editorReady();
  }, { scope: ".ws-pane--active .ws-pane__body", except: ["[data-under-test]", ".field-editor", ...below] });
  const editing = await fieldGeometry(t, name);
  const diff = geometryDiff(before, editing, { height: height && !multiline && !(source && !empty), width });
  await t.check(`${name}: editor keeps the label, box and text in place`, diff.length === 0, diff.join("; "));
  await t.audit(`${name}: editing`);
  // Escape cancels: back to exactly the view.
  await mark();
  await t.noShift(`${name}: Escape restores the view without a jump`, async () => {
    await t.page.keyboard.press("Escape");
    await t.wait(200);
    // The first Escape may only close the date picker's calendar or a combo box's menu: a second
    // one cancels the edit (an open calendar or menu takes the first, as everywhere).
    if (await t.page.locator(".field-editor").count()) {
      await t.page.keyboard.press("Escape");
      await t.wait(200);
    }
  }, { scope: ".ws-pane--active .ws-pane__body", except: below });
  if (await t.page.locator(".field-editor").count()) {
    await t.fail(`${name}: Escape closes the editor`, "the editor is still open after Escape");
    await clickOutside(t);
  }
  const after = await fieldGeometry(t, name);
  const diff2 = geometryDiff(before, after, { width });
  await t.check(`${name}: cancelled field looks as before`, diff2.length === 0, diff2.join("; "));
  if (type !== null) {
    const again = t.page.getByRole("button", { name: `Edit ${name}`, exact: true }).first();
    await again.click({ position: await t.visiblePoint(again) });
    await t.editorReady();
    await t.page.keyboard.press("End");
    await t.page.keyboard.type(type);
    await t.page.keyboard.press(multiline ? "Control+Enter" : "Enter");
    // The editor closes once the save is stored (a slow machine takes longer than a settle).
    await t.page.locator(".field-editor").first().waitFor({ state: "detached", timeout: 15000 }).catch(() => {});
    await t.settle();
    if (await t.page.locator(".field-editor").count()) {
      await t.fail(`${name}: ${multiline ? "Ctrl+Enter" : "Enter"} saves and closes the editor`, "the editor is still open");
      await clickOutside(t);
    }
    await t.until(`${name}: typed text is saved and shown`, async () => (await t.page.locator(".item-fields").innerText()).includes(type.trim()) || `"${type.trim()}" not on the page after saving`);
    await t.audit(`${name}: saved`);
  }
}

const EDIT_CASES = [
  ["typical", "desktop"], ["typical", "phone"],
];

for (const [style, vp] of EDIT_CASES) {
  test(`edit every field in place: ${style} values @ ${vp}`, async (t) => {
    await t.boot();
    const ids = await t.seed(profileSpec(style, { items: 3 }));
    await t.open(t.itemPath(ids.collections.books, ids.items["books/i0"]));
    await t.audit("item page");
    await editRoundTrip(t, "Snippet", { height: false, multiline: true, source: true });
    await editRoundTrip(t, "Count", { type: "7" });
    await editRoundTrip(t, "Date");
    await editRoundTrip(t, "When", { height: false, width: false });
    await editRoundTrip(t, "Related");
    await editRoundTrip(t, "Notes", { type: " appended", height: false, multiline: true });
  }, { viewport: vp, smoke: style === "typical" && vp === "desktop" });
}
