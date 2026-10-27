// Components without variables, written in place or shared, asking AI or not; a field's settings
// under its name and type; strike through the item; {{ }} code in filter values; cards that only
// change their layout with "Show as a list when narrow".

async function blockTool(t, scope, label) {
  const direct = scope.getByRole("button", { name: label, exact: true }).filter({ visible: true }).first();
  if (await direct.count()) await direct.click();
  else {
    await scope.getByRole("button", { name: "More actions" }).filter({ visible: true }).first().click();
    await t.settle(100);
    await t.page.getByRole("button", { name: label, exact: true }).filter({ visible: true }).last().click();
  }
  await t.settle(150);
}

/** Books with a checkbox that strikes the item through, a local and a shared component field, an AI field. */
function componentSpec() {
  const spec = profileSpec("typical", { items: 4 });
  const books = spec.collections[0];
  books.fields.push(
    { key: "read", name: "Read", kind: "checkbox", strikeThrough: true },
    { key: "hours", name: "Hours", kind: "component", code: "{{ Math.round(($item.Count ?? 0) / 40) }} h", output: "markdown" },
    { key: "shelf", name: "Shelf", kind: "ai", code: "Shelf for {{ $item.Title }}", output: "string" },
  );
  books.items[0].values.read = true;
  books.items[1].values.read = false;
  spec.components.push({ key: "prompt", name: "Short summary", code: "Summarise {{ $item.Title }} in a line.", ai: true, output: "string" });
  return spec;
}

for (const vp of ["desktop", "phone"]) {
  test(`collection editor: a field's settings under it, one per line; components written here @ ${vp}`, async (t) => {
    await t.boot();
    const ids = await t.seed(componentSpec());
    await t.open(`/collections/${ids.collections.books}/edit`);
    await t.audit("collection editor with field settings");
    // Every field's settings sit inside its row, under its name and type, each control on its own line.
    const layout = await t.page.evaluate(() =>
      [...document.querySelectorAll(".ws-pane--active .field-row__settings")].map((s) => {
        const row = s.closest(".field-row").getBoundingClientRect();
        const name = s.closest(".field-row").querySelector("input").getBoundingClientRect();
        const items = [...s.querySelectorAll(":scope > .cds--stack-vertical > *")].filter((e) => e.getBoundingClientRect().height > 0);
        const lefts = items.map((e) => Math.round(e.getBoundingClientRect().left));
        const tops = items.map((e) => e.getBoundingClientRect().top);
        return { below: s.getBoundingClientRect().top >= name.bottom, inside: s.getBoundingClientRect().bottom <= row.bottom + 1, oneEdge: new Set(lefts).size <= 1, stacked: tops.every((y, i) => i === 0 || y > tops[i - 1]) };
      }),
    );
    await t.check("fields with settings have them", layout.length >= 6, `${layout.length}`);
    await t.check("settings are under the field's name and type, inside its row", layout.every((l) => l.below && l.inside), JSON.stringify(layout));
    await t.check("settings start on one left edge, one per line", layout.every((l) => l.oneEdge && l.stacked), JSON.stringify(layout));
    // The component field written here: its code and output; Ask AI on the AI field, fixed once saved.
    const hours = t.page.locator(".ws-pane--active .field-row").filter({ has: t.page.locator('input[value="Hours"]') });
    await t.check("a component written here shows its code", (await hours.getByRole("textbox", { name: "Code" }).inputValue()).includes("$item.Count"));
    const shelf = t.page.locator(".ws-pane--active .field-row").filter({ has: t.page.locator('input[value="Shelf"]') });
    await t.check("an AI field's Ask AI is on and fixed", (await shelf.getByRole("switch", { name: /Ask AI/ }).getAttribute("aria-checked")) === "true" && (await shelf.getByRole("switch", { name: /Ask AI/ }).isDisabled()));
    await t.check("an AI field's prompt is shown", (await shelf.getByRole("textbox", { name: "Prompt" }).inputValue()).includes("Shelf for"));
    // Code with an unknown $ name can't be saved; it says why.
    await hours.getByRole("textbox", { name: "Code" }).fill("{{ $pages / 40 }}");
    await t.settle();
    await t.check("an unknown $ name is explained at the code", (await hours.innerText()).includes("$pages isn't known"));
    await hours.getByRole("textbox", { name: "Code" }).fill("{{ Math.round(($item.Count ?? 0) / 20) }} h");
    // A new component field: written here by default; switching to a shared one and back.
    await t.page.getByRole("button", { name: "Add field" }).click();
    await t.settle(100);
    const row = t.page.locator(".ws-pane--active .field-row").last();
    await row.getByRole("textbox", { name: "Field name" }).fill("Pages per hour");
    await row.locator(".cds--dropdown, .cds--list-box").first().click();
    await t.settle(100);
    await t.page.getByRole("option", { name: "Component", exact: true }).first().click();
    await t.settle(100);
    await t.audit("a new component field, written here");
    await row.getByRole("textbox", { name: "Code" }).fill("{{ 40 }}");
    await t.page.getByRole("button", { name: "Save changes" }).click();
    await t.until("saved: the collection's page", async () => (await t.page.locator(".ws-pane--active .page-header__title").innerText().catch(() => "")).includes("Books"));
    await t.open(t.itemPath(ids.collections.books, ids.items["books/i0"]));
    const hoursField = t.page.locator(".ws-pane--active .item-fields > *", { hasText: "Hours" }).first();
    await t.check("the edited local component computes the value", /\d+ h/.test(await hoursField.innerText()), await hoursField.innerText());
    await t.audit("item page with local component fields");
  }, { viewport: vp, smoke: vp === "desktop" });
}

test("components page: local ones by where they are used, saved as shared", async (t) => {
  await t.boot();
  const spec = componentSpec();
  spec.collections[0].views = [{ name: "All", blocks: [{ kind: "table" }, { kind: "component", title: "Count", local: "{{ $items.length }} books" }, { kind: "markdown", title: "Notes", options: { text: "Year {{ $now.getFullYear() }}" } }] }];
  const ids = await t.seed(spec);
  await t.open("/components");
  await t.audit("components: shared and written here");
  const text = await t.page.locator(".ws-pane--active .items-table, .ws-pane--active table").first().innerText();
  for (const where of ["Books › Hours", "Books › Shelf", "Books › All › Count", "Books › All › Notes"]) await t.check(`lists ${where}`, text.includes(where), text.slice(0, 300));
  await t.check("an AI component is tagged", (await t.page.locator(".ws-pane--active .cds--tag", { hasText: "AI" }).count()) >= 2);
  // Save the block's own component as a shared one: the block then shows the shared one.
  const row = t.page.locator(".ws-pane--active tr", { hasText: "Books › All › Count" });
  await row.getByRole("button", { name: /as a shared component/ }).click({ force: true }).catch(async () => {
    await row.getByRole("button", { name: "More actions" }).click();
    await t.page.getByRole("button", { name: /as a shared component/ }).last().click();
  });
  const modal = t.page.locator(".cds--modal.is-visible");
  await t.until("the dialog asks for a name", async () => (await modal.count()) === 1);
  await t.audit("save as shared component dialog");
  await modal.getByRole("textbox", { name: "Name" }).fill("Book count");
  await modal.getByRole("button", { name: "Save as shared" }).click();
  await t.until("the block's component is now shared, listed by its name", async () => {
    const all = await t.page.locator(".ws-pane--active table").first().innerText();
    return (all.includes("Book count") && !all.includes("Books › All › Count")) || all.slice(0, 200);
  });
  await t.open(t.listPath(ids.collections.books));
  await t.until("the view shows it as before", async () => (await t.page.locator(".ws-pane--active").innerText()).includes("4 books"));
  await t.check("the Markdown block's code is worked out", (await t.page.locator(".ws-pane--active .markdown-block").innerText()).includes(`Year ${new Date().getFullYear()}`));
  await t.audit("view with a shared and a Markdown block");
}, { viewport: "desktop" });

for (const vp of ["desktop", "phone"]) {
  test(`a component block written in its settings; add field with Ask AI @ ${vp}`, async (t) => {
    await t.boot();
    const ids = await t.seed(componentSpec());
    await t.open(t.listPath(ids.collections.books));
    // Add block → "Component (written here)": its code in Block settings.
    await blockTool(t, t.page.locator(".views-bar").first(), "View settings");
    await t.page.locator(".cds--popover--open").getByRole("button", { name: "Add block" }).click();
    await t.settle(100);
    await t.page.getByRole("menuitem", { name: "Component (written here)" }).click();
    await t.settle();
    await t.closeAll();
    const block = t.page.locator(".ws-pane--active .block").last();
    await block.scrollIntoViewIfNeeded();
    await blockTool(t, block.locator(".section-header").first(), "Block settings");
    const panel = t.page.locator(".cds--popover--open");
    await t.audit("block settings: a component written here");
    const code = panel.getByRole("textbox", { name: "Code" });
    await code.click();
    await t.popoverStep("typing a block's code", () => t.page.keyboard.type("{{ $items.length }} shown", { delay: 10 }), { target: code });
    await t.closeAll();
    await t.until("the block shows its result", async () => (await block.innerText()).includes("shown"));
    // Add field (from a block's Fields) as a Component with Ask AI: prompt and the cost.
    await t.open(t.listPath(ids.collections.books));
    await blockTool(t, t.page.locator(".block").first().locator(".section-header").first(), "Fields");
    await t.page.locator(".cds--popover--open").getByRole("button", { name: "Add field" }).click();
    const modal = t.page.locator(".cds--modal.is-visible");
    await t.until("the field dialog opens", async () => (await modal.count()) === 1);
    await modal.getByRole("textbox", { name: "Name" }).fill("Genre");
    const type = modal.locator(".cds--dropdown, .cds--list-box").first();
    await type.click();
    await t.settle(100);
    await t.dialogStep("field type → Component", () => t.page.getByRole("option", { name: "Component", exact: true }).first().click(), { target: type });
    await t.dialogStep("Ask AI on", () => modal.locator(".cds--toggle__switch").first().click());
    const outputs = (await modal.locator("select").filter({ has: t.page.locator('option[value="string"]') }).first().locator("option").allInnerTexts()).join(",");
    await t.check("Ask AI offers only text, number and Markdown", outputs.split(",").sort().join(",") === "Markdown,Number,Text", outputs);
    await t.check("it says what asking AI costs", (await modal.innerText()).includes("for 4 items"));
    await modal.getByRole("textbox", { name: "Prompt" }).fill("The genre of {{ $item.Title }}");
    // A shared AI component can be picked instead.
    const pick = modal.locator(".cds--dropdown").nth(1);
    await pick.click();
    await t.settle(100);
    await t.check("shared AI components are offered", (await t.page.getByRole("option", { name: /Short summary/ }).count()) === 1);
    await t.page.keyboard.press("Escape");
    await t.audit("add field dialog: Ask AI", { shotOnFail: true });
    await modal.getByRole("button", { name: "Add" }).click();
    const confirm = t.page.locator(".cds--modal.is-visible", { hasText: "Add field" });
    await confirm.getByRole("button", { name: "Add field" }).click().catch(() => {});
    await t.until("the field is added", async () => (await t.page.locator(".cds--modal.is-visible").count()) === 0);
  }, { viewport: vp });
}

for (const vp of ["desktop", "phone"]) {
  test(`strike through the item; {{ }} code in a filter value @ ${vp}`, async (t) => {
    await t.boot();
    const spec = componentSpec();
    spec.collections[0].views = [{ name: "All", blocks: [{ kind: "table" }] }, { name: "Cards", blocks: [{ kind: "cards", options: { coverFieldId: null, cardWidth: 14, coverRatio: "auto", showTitle: true, listNarrow: false } }] }];
    const ids = await t.seed(spec);
    await t.open(t.listPath(ids.collections.books));
    const struck = () => t.page.evaluate(() => [...document.querySelectorAll(".ws-pane--active .cell--struck, .ws-pane--active .item--struck")].map((e) => getComputedStyle(e.querySelector("a, div") ?? e).textDecorationLine));
    await t.until("the read book's title is struck through in the table", async () => {
      const s = await struck();
      return (s.length === 1 && s[0].includes("line-through")) || JSON.stringify(s);
    });
    await t.audit("table with a struck through item");
    await t.open(`${t.listPath(ids.collections.books)}?view=${ids.views["books/Cards"]}`);
    await t.until("and on its card", async () => (await struck()).length === 1);
    await t.audit("cards with a struck through item");
    // A filter value with {{ }}: Read is {{ 1 == 1 }} → the read book only.
    await t.open(t.listPath(ids.collections.books));
    await t.openPanel(t.page.locator(".views-bar").first(), "Filter");
    const panel = t.page.locator(".cds--popover--open");
    await panel.getByRole("button", { name: "Add filter" }).first().click();
    await t.settle(100);
    const field = panel.locator("select").first();
    await field.selectOption({ label: "Read" });
    await t.settle(100);
    await panel.locator("select").nth(1).selectOption({ label: "is" });
    await t.settle(100);
    const value = panel.getByRole("textbox", { name: "Value" }).last();
    await value.click();
    await t.popoverStep("typing {{ }} code as a filter value", () => t.page.keyboard.type("{{ 1 == 1 }}", { delay: 10 }), { target: value });
    await t.check("the value shows what the code works out to", (await panel.innerText()).includes("= true"));
    await t.audit("filter value with code");
    const rows = () => t.page.locator(".ws-pane--active .block").first().locator("tbody tr").count();
    await t.until("only the read book is shown", async () => (await rows()) <= 2 || `${await rows()} rows`);
    await value.fill("maybe");
    await t.settle();
    await t.check("a checkbox value that isn't true or false is invalid", (await panel.innerText()).includes("true or false"));
    await t.until("and matches nothing, not the unchecked books", async () => (await rows()) <= 1 || `${await rows()} rows`);
    await t.audit("invalid filter value");
  }, { viewport: vp, smoke: vp === "desktop" });
}

for (const [label, list, width, expectList] of [
  ["option off, narrow pane: cards as always", false, 18, false],
  ["option on, narrow pane: list rows", true, 18, true],
  ["option on, wide pane, one card per row: no list rows", true, 60, false],
]) {
  test(`cards: ${label}`, async (t) => {
    await t.boot();
    const spec = matrixSpec("typical", { items: 4 });
    spec.collections[0].views = [{ name: "Cards", blocks: [{ kind: "cards", options: { coverFieldId: "@cover", cardWidth: width, coverRatio: "auto", showTitle: true, listNarrow: list } }] }];
    const ids = await t.seed(spec);
    await t.open(t.listPath(ids.collections.books));
    await t.settle();
    const info = await t.page.evaluate(() => ({
      list: document.querySelectorAll(".ws-pane--active .item-card--cover-left").length,
      cards: document.querySelectorAll(".ws-pane--active .item-card").length,
      stacked: [...document.querySelectorAll(".ws-pane--active .item-card__fields")].some((f) => getComputedStyle(f).gridTemplateColumns.split(" ").length === 1),
    }));
    await t.check(expectList ? "the cards are list rows" : "no card is a list row", expectList ? info.list === info.cards && info.cards > 0 : info.list === 0, JSON.stringify(info));
    await t.check("labels stay beside their values", !info.stacked, JSON.stringify(info));
    await t.audit(`cards: ${label}`);
  }, { viewport: width > 20 ? "desktop" : "phone" });
}
