// More editing: undo / redo and pasting (text, a link, {{ }} code) in the Markdown editor, undo in
// the code editor, a reference field's choice filter, moving an item to another space, an item
// view pinned / starred / deleted, a component field's code and its "Change component?" dialog,
// cards (open, a checkbox in a card, open in a new tab) and opening search results.

const fieldsText = (t) => t.page.locator(".ws-pane--active .item-fields").innerText();

/** Pastes `text` (as text/plain) into the focused element, the way a clipboard paste arrives. */
async function pasteText(t, text) {
  await t.page.evaluate((text) => {
    const dt = new DataTransfer();
    dt.setData("text/plain", text);
    document.activeElement.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, text);
  await t.settle(100);
}

for (const vp of ["desktop", "phone"]) {
  test(`Markdown: undo, redo and pasting text, a link and {{ }} code @ ${vp}`, async (t) => {
    await t.boot();
    const ids = await t.seed(profileSpec("typical", { items: 2 }));
    await t.open(t.itemPath(ids.collections.books, ids.items["books/i0"]));
    await t.page.getByRole("button", { name: "Edit Notes", exact: true }).click();
    await t.page.waitForSelector(".field-editor .ProseMirror");
    const pm = t.page.locator(".field-editor .ProseMirror").first();
    await pm.focus();
    await t.page.keyboard.press("Control+End");
    await t.page.keyboard.press("Enter");
    await t.page.keyboard.type("Typed then undone");
    await t.until("the typed text is there", async () => (await pm.innerText()).includes("Typed then undone"));
    await t.page.keyboard.press("Control+z");
    await t.until("Ctrl+Z undoes the typing", async () => !(await pm.innerText()).includes("Typed then undone") || "still there");
    await t.page.keyboard.press("Control+Shift+z");
    await t.until("Ctrl+Shift+Z redoes it", async () => (await pm.innerText()).includes("Typed then undone") || "not back");
    // Pasting.
    await t.page.keyboard.press("Enter");
    await pasteText(t, "Pasted plain words");
    await t.until("pasted text is inserted", async () => (await pm.innerText()).includes("Pasted plain words"));
    await t.page.keyboard.press("Enter");
    await pasteText(t, "https://example.com/pasted");
    await t.until("a pasted address is inserted", async () => (await pm.innerText()).includes("example.com/pasted"));
    await t.page.keyboard.press("Enter");
    await pasteText(t, "Shown title: {{ $item.Title }}");
    await t.until("pasted {{ }} code becomes a section chip, not text", async () => (await pm.locator("[data-type=section], .md-section, .section-chip").count()) > 0 || !(await pm.innerText()).includes("{{") || "shown as text", { timeout: 3000 });
    await t.audit("markdown after pasting");
    await t.page.keyboard.press("Control+Enter");
    await t.until("saved", async () => (await t.count(".field-editor")) === 0);
    const text = await fieldsText(t);
    await t.check("the saved note has the pasted text and address", text.includes("Pasted plain words") && text.includes("example.com/pasted"));
    await t.check("the {{ }} code is evaluated on the page (no raw code)", !text.includes("{{ $item.Title }}"), "raw code shown");
    await t.audit("markdown with pasted content saved");
  }, { viewport: vp });
}

test("code editor: undo and redo", async (t) => {
  await t.boot();
  const ids = await t.seed(profileSpec("typical", { items: 1 }));
  await t.open(`/components/${ids.components.double}`);
  const code = t.page.getByRole("textbox", { name: "Component" });
  const before = await code.inputValue();
  await code.click();
  await t.page.keyboard.press("Control+End");
  await t.page.keyboard.type(" extra");
  await t.until("typed into the code", async () => (await code.inputValue()).endsWith(" extra"));
  // The browser's own undo of a text box: it may take a step per keystroke.
  for (let i = 0; i < 8 && (await code.inputValue()) !== before; i++) await t.page.keyboard.press("Control+z");
  await t.until("Ctrl+Z undoes it", async () => (await code.inputValue()) === before || JSON.stringify(await code.inputValue()));
  for (let i = 0; i < 8 && !(await code.inputValue()).endsWith(" extra"); i++) await t.page.keyboard.press("Control+Shift+z");
  await t.until("Ctrl+Shift+Z redoes it", async () => (await code.inputValue()).endsWith(" extra") || JSON.stringify(await code.inputValue()));
  await t.audit("code editor after undo / redo");
});

test("a reference field's choice filter limits what it offers", async (t) => {
  await t.boot();
  const spec = profileSpec("typical", { items: 2 });
  const related = spec.collections[0].fields.find((f) => f.key === "ref");
  related.choiceFilter = [{ field: "name", operator: "contains", value: "Hyperion" }];
  const ids = await t.seed(spec);
  // The editor shows the filter under the field.
  await t.open(`/collections/${ids.collections.books}/edit`);
  await t.check("the collection editor shows the field's choice filter", (await t.page.locator(".ws-pane--active").innerText()).includes("Choices"));
  await t.audit("collection editor with a choice filter");
  // The item page offers only matching authors.
  await t.open(t.itemPath(ids.collections.books, ids.items["books/i1"]));
  // Scrolled to first and settled: the HTML field above it sizes its frame once it has loaded.
  const relatedValue = t.page.getByRole("button", { name: "Edit Related", exact: true });
  await relatedValue.scrollIntoViewIfNeeded();
  await t.settle(300);
  await relatedValue.click();
  await t.editorReady();
  await t.page.keyboard.press("Control+a");
  await t.page.keyboard.press("Backspace");
  await t.page.keyboard.type("o");
  await t.settle();
  // Typing "o" matches most authors' names; only what the filter lets through is offered.
  // The current value stays offered (it is what the field holds); every other choice passes the filter.
  const options = await t.page.locator("[role=option]:not(.cds--list-box__menu-item--active)").allInnerTexts();
  await t.check("only the authors the filter lets through are offered", options.length > 0 && options.every((o) => /Hyperion/.test(o)), JSON.stringify(options));
  await t.audit("reference choices filtered");
  await t.page.keyboard.press("Escape");
  await t.page.keyboard.press("Escape");
});

for (const vp of ["desktop", "phone"]) {
  test(`an item moved to another space; item views pinned, starred, deleted @ ${vp}`, async (t) => {
    await t.boot();
    const spec = profileSpec("typical", { items: 3 });
    spec.spaces = [{ key: "w", name: "Work" }];
    spec.collections[0].itemViews = [{ name: "Default" }, { name: "Compact", layout: { fields: ["title", "count", "done"] } }];
    const ids = await t.seed(spec);
    const item = t.itemPath(ids.collections.books, ids.items["books/i0"]);
    // Moving it: Details → Space.
    await t.open(item);
    await t.openPanel(t.page.locator(".ws-pane--active .page-header"), "Details");
    const space = t.page.locator(".toolbar-popover.cds--popover--open .cds--dropdown button").first();
    await t.popoverStep("open the space dropdown", () => space.click(), { target: space });
    await t.page.getByRole("option", { name: /Work/ }).click();
    await t.settle();
    await t.check("the page stays open after moving it", (await t.page.locator(".ws-pane--active .item-title").count()) > 0);
    await t.page.keyboard.press("Escape");
    await t.open(t.listPath(ids.collections.books));
    const rows = await t.page.locator(".ws-pane--active .items-table tbody tr:not(.table-add-row)").count();
    const titles = await t.page.locator(".ws-pane--active").innerText();
    await t.check("it left this space's list", !titles.includes("The Left Hand of Darkness 1") || rows === 2, `${rows} rows`);
    // Item views of another item: pin, star, delete.
    const other = t.itemPath(ids.collections.books, ids.items["books/i1"]);
    await t.open(other);
    await t.page.getByRole("tab", { name: "Compact" }).click();
    await t.settle();
    // On a phone these buttons are in the views bar's "⋮" menu.
    const action = async (name) => {
      const bar = t.page.locator(".ws-pane--active .views-bar").first();
      let btn = bar.getByRole("button", { name }).filter({ visible: true }).first();
      if (!(await btn.count())) {
        await bar.getByRole("button", { name: "More actions" }).filter({ visible: true }).first().click();
        await t.settle(100);
        btn = bar.getByRole("button", { name }).filter({ visible: true }).first();
      }
      return btn;
    };
    await (await action(/Always show this Book with this view/)).click();
    await t.settle();
    await t.page.keyboard.press("Escape");
    await t.check("Pin says pinned", (await (await action(/Unpin from this Book/)).getAttribute("aria-pressed")) === "true");
    await t.page.keyboard.press("Escape");
    await t.open(other);
    await t.until("a pinned view opens with the item", async () => (await t.page.getByRole("tab", { name: "Compact" }).getAttribute("aria-selected")) === "true");
    await (await action(/Star as default view/)).click();
    await t.settle();
    await t.page.keyboard.press("Escape");
    await t.open(t.itemPath(ids.collections.books, ids.items["books/i2"]));
    await t.until("a starred view is the default for other items", async () => (await t.page.getByRole("tab", { name: "Compact" }).getAttribute("aria-selected")) === "true");
    await t.audit("item with the starred view");
    await (await action("Delete view")).click();
    await t.until("deleting a view asks first", async () => (await t.page.locator(".cds--modal.is-visible").innerText().catch(() => "")).includes("Delete view"));
    await t.audit("delete view dialog");
    await t.page.locator(".cds--modal.is-visible").getByRole("button", { name: /^Delete/ }).click();
    await t.until("the view is gone", async () => (await t.page.getByRole("tab", { name: "Compact" }).count()) === 0);
    await t.audit("after deleting the view");
  }, { viewport: vp });
}

test("a component field: its code, and Change component? (keep editing, discard, change)", async (t) => {
  await t.boot();
  const ids = await t.seed(profileSpec("typical", { items: 2 }));
  await t.open(t.itemPath(ids.collections.books, ids.items["books/i1"]));
  const computed = () => t.page.locator(".ws-pane--active .item-fields > *", { hasText: "Computed" }).first();
  const valueBefore = (await computed().innerText()).replace("Computed", "").trim();
  const openCode = async () => {
    await computed().getByRole("button").filter({ hasNotText: /Collapse/ }).last().click().catch(async () => computed().click());
    await t.page.waitForSelector(".field-editor textarea", { timeout: 5000 });
  };
  const away = async () => {
    const b = await t.page.locator(".ws-pane--active .page-header").boundingBox();
    await t.page.mouse.click(b.x + 4, b.y + b.height - 4);
    await t.settle();
  };
  await openCode();
  await t.audit("component field's code");
  await t.page.locator(".field-editor textarea").first().fill("{{ ($x ?? 0) * 3 }}");
  await away();
  const modal = t.page.locator(".cds--modal.is-visible");
  await t.until("saving a changed component asks first", async () => (await modal.innerText().catch(() => "")).includes("Change component"));
  await t.audit("change component? dialog");
  await modal.getByRole("button", { name: "Keep editing" }).click();
  await t.until("Keep editing returns to the code", async () => (await t.count(".field-editor textarea")) === 1 && (await t.count(".cds--modal.is-visible")) === 0);
  await away();
  await t.until("asked again", async () => (await modal.innerText().catch(() => "")).includes("Change component"));
  await modal.getByRole("button", { name: "Discard changes" }).click();
  await t.until("Discard closes the editor, the value as before", async () => (await t.count(".field-editor")) === 0 && (await computed().innerText()).includes(valueBefore));
  await openCode();
  await t.page.locator(".field-editor textarea").first().fill("{{ ($x ?? 0) * 3 }}");
  await away();
  await modal.getByRole("button", { name: "Change component" }).click();
  await t.until("Change component saves it: the value is computed anew", async () => (await t.count(".field-editor")) === 0 && !(await computed().innerText()).includes(valueBefore) || (await computed().innerText()));
  await t.audit("component changed");
});

for (const vp of ["desktop", "phone"]) {
  test(`cards: open an item, a checkbox in a card, open in a new tab; search results @ ${vp}`, async (t) => {
    await t.boot();
    const ids = await t.seed(matrixSpec("typical", { items: 4 }));
    await t.open(`${t.listPath(ids.collections.books)}?view=${ids.views["books/Cards"]}`);
    const card = t.page.locator(".ws-pane--active .item-card").first();
    // A checkbox in a card toggles there; the card doesn't open.
    const box = card.locator(".toggle-input, .cds--checkbox-label").first();
    if (await box.count()) {
      const state = () => card.locator("input[type=checkbox], [aria-pressed], [aria-checked]").first().evaluate((el) => el.checked ?? el.getAttribute("aria-pressed") ?? el.getAttribute("aria-checked")).catch(() => null);
      const before = await state();
      await box.click();
      await t.until("a checkbox in a card toggles", async () => String(await state()) !== String(before) || `${before} → ${await state()}`);
      await t.check("…without opening the item", (await t.count(".ws-pane--active .item-cards")) === 1);
    }
    // Middle click: a new tab, this one stays.
    const tabs = await t.count(".ws-pane--active .ws-pane__tabs [role=tab]");
    // The card's link is stretched over it: a click anywhere on the card's title area is on it.
    const title = card.locator(".item-card__title");
    const at = async () => {
      const b = await title.boundingBox();
      return [b.x + 8, b.y + b.height / 2];
    };
    await t.page.mouse.click(...(await at()), { button: "middle" });
    await t.until("a middle click opens the item in a new tab", async () => (await t.count(".ws-pane--active .ws-pane__tabs [role=tab]")) === tabs + 1 || `${await t.count(".ws-pane--active .ws-pane__tabs [role=tab]")} tabs`);
    await t.check("…and this tab still shows the cards", (await t.count(".ws-pane--active .item-cards")) === 1);
    // A click opens it here.
    await t.open(`${t.listPath(ids.collections.books)}?view=${ids.views["books/Cards"]}`);
    await t.page.mouse.click(...(await at()));
    await t.until("a click on a card opens its item", async () => (await t.count(".ws-pane--active .item-title")) > 0);
    await t.audit("item opened from a card");
    // Search: a result opens its item.
    await t.open("/search?q=Solaris");
    const hit = t.page.locator(".ws-pane--active .cds--contained-list-item").filter({ hasText: "Solaris" }).first();
    await t.until("the search shows a result", async () => (await hit.count()) > 0);
    await t.audit("search results");
    await hit.click();
    await t.until("a search result opens its item", async () => (await t.count(".ws-pane--active .item-title")) > 0 || (await t.page.locator(".ws-pane--active").innerText()).slice(0, 80));
  }, { viewport: vp });
}
