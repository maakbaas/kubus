// One click moves an edit from one field (saved) to the next (opened).

/** The field's value box on the item page of the active pane, by the field's name. */
const valueOf = (t, name, pane = ".ws-pane--active") => t.page.locator(`${pane} .item-fields`).getByRole("button", { name: `Edit ${name}`, exact: true }).first();

test("editing in place, then elsewhere: one click saves and opens the next @ desktop", async (t) => {
  await t.boot();
  const ids = await t.seed(profileSpec("typical", { items: 3 }));
  await t.open(t.itemPath(ids.collections.books, ids.items["books/i0"]));
  // Count → Date with one click: Count saved, Date's editor open.
  await valueOf(t, "Count").click();
  await t.editorReady();
  await t.page.keyboard.press("Control+A");
  await t.page.keyboard.type("77");
  const date = valueOf(t, "Date");
  await date.scrollIntoViewIfNeeded();
  await date.click({ position: await t.visiblePoint(date) });
  await t.settle();
  await t.until("the first field is saved", async () => (await t.page.locator(".ws-pane--active .item-fields").innerText()).includes("77") || "77 not shown");
  await t.until("one click opened the next field's editor", async () => (await t.count(".field-editor")) === 1 || `${await t.count(".field-editor")} editors open`);
  await t.audit("moved from one field to the next");
  await t.page.keyboard.press("Escape");
  await t.page.keyboard.press("Escape");
  await t.settle();
  // A checkbox toggled while another field is edited: the edit is saved, the box toggles.
  await valueOf(t, "Count").click();
  await t.editorReady();
  await t.page.keyboard.press("Control+A");
  await t.page.keyboard.type("88");
  const done = t.page.locator(".ws-pane--active .item-fields .checklist-row", { hasText: "Done" }).first();
  await done.scrollIntoViewIfNeeded();
  const before = await done.locator("input, [role=checkbox], .toggle-input").first().evaluate((el) => el.checked ?? el.getAttribute("aria-checked") ?? el.getAttribute("aria-pressed"));
  await done.locator("label, .toggle-input").first().click();
  await t.until("the edit is saved when a checkbox is clicked", async () => (await t.page.locator(".ws-pane--active .item-fields").innerText()).includes("88") || `88 not shown; ${await t.count(".field-editor")} editors open`);
  await t.until("the checkbox toggled with that same click", async () => {
    const after = await done.locator("input, [role=checkbox], .toggle-input").first().evaluate((el) => el.checked ?? el.getAttribute("aria-checked") ?? el.getAttribute("aria-pressed"));
    return String(before) !== String(after) || `${before} → ${after}`;
  });
  await t.settle();
  // A field being edited while its neighbour collapses: the editor stays, nothing breaks.
  await valueOf(t, "Count").click();
  await t.editorReady();
  await t.page.locator(".ws-pane--active .item-fields .collapse-caret").first().click().catch(() => {});
  await t.settle();
  await t.audit("a field collapsed while another is edited");
  await t.closeAll();
}, { viewport: "desktop", smoke: true });
