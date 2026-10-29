// The collection editor: a field's settings under its name and type, and local components.

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

test("collection editor: a field's settings under it, one per line; local components @ desktop", async (t) => {
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
  // The local component field: its code and output; AI prompt on the AI field, fixed once saved.
  const hours = t.page.locator(".ws-pane--active .field-row").filter({ has: t.page.locator('input[value="Hours"]') });
  await t.check("a local component shows its code", (await hours.getByRole("textbox", { name: "Code" }).inputValue()).includes("$item.Count"));
  const shelf = t.page.locator(".ws-pane--active .field-row").filter({ has: t.page.locator('input[value="Shelf"]') });
  await t.check("an AI field's AI prompt is selected and fixed", (await shelf.getByRole("tab", { name: "AI prompt" }).getAttribute("aria-selected")) === "true" && (await shelf.getByRole("tab", { name: "AI prompt" }).isDisabled()));
  await t.check("an AI field's prompt is shown", (await shelf.getByRole("textbox", { name: "Prompt" }).inputValue()).includes("Shelf for"));
  // Code with an unknown $ name can't be saved; it says why.
  await hours.getByRole("textbox", { name: "Code" }).fill("{{ $pages / 40 }}");
  await t.settle();
  await t.check("an unknown $ name is explained at the code", (await hours.innerText()).includes("$pages isn't known"));
  await hours.getByRole("textbox", { name: "Code" }).fill("{{ Math.round(($item.Count ?? 0) / 20) }} h");
  // A new component field: local by default; switching to a shared one and back.
  await t.page.getByRole("button", { name: "Add field" }).click();
  await t.settle(100);
  const row = t.page.locator(".ws-pane--active .field-row").last();
  await row.getByRole("textbox", { name: "Field name" }).fill("Pages per hour");
  await row.locator(".cds--dropdown, .cds--list-box").first().click();
  await t.settle(100);
  await t.page.getByRole("option", { name: "Component", exact: true }).first().click();
  await t.settle(100);
  await t.audit("a new component field, local");
  await row.getByRole("textbox", { name: "Code" }).fill("{{ ($item.Count ?? 0) / 40 }}");
  await t.page.getByRole("button", { name: "Save changes" }).click();
  await t.until("saved: the collection's page", async () => (await t.page.locator(".ws-pane--active .page-header__title").innerText().catch(() => "")).includes("Books"));
  await t.open(t.itemPath(ids.collections.books, ids.items["books/i0"]));
  const hoursField = t.page.locator(".ws-pane--active .item-fields > *", { hasText: "Hours" }).first();
  await t.check("the edited local component computes the value", /\d+ h/.test(await hoursField.innerText()), await hoursField.innerText());
  await t.audit("item page with local component fields");
}, { viewport: "desktop", smoke: true });
