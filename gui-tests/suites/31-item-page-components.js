// The New item form (defaults, errors, every kind stored, Cancel) and creating a shared component
// (name needed, edit, Cancel and Save, code errors).

/** The collection as stored now (fields, item views). */
const storedCollection = (t, id) => t.page.evaluate(async (id) => (await window.kubus.repo.listCollections()).find((c) => c.id === id), id);

const storedComponents = (t) => t.page.evaluate(() => window.kubus.repo.listComponents());

/** A field's id by name. */
const fieldId = (collection, name) => collection.fields.find((f) => f.name === name).id;

/** Ticks a Carbon checkbox the way a person does, by its label (the input itself is visually hidden), and waits for the tick. */
async function tick(t, input) {
  const id = await input.getAttribute("id");
  await input.evaluate((el) => el.click());
  await t.until("the box is ticked", async () => (await input.isChecked()) || "not ticked");
}

/** A collection with one field of each kind the form enters (and a component and an AI field, which it leaves out). */
function thingSpec() {
  return {
    collections: [
      { key: "people", name: "Person", plural: "People", fields: [{ key: "name", name: "Name", kind: "string" }], items: [{ values: { name: "Ursula" } }, { values: { name: "Octavia" } }] },
      {
        key: "things", name: "Thing", plural: "Things",
        fields: [
          { key: "name", name: "Name", kind: "string" },
          { key: "pages", name: "Pages", kind: "number" },
          { key: "released", name: "Released", kind: "date" },
          { key: "seen", name: "Seen at", kind: "datetime" },
          { key: "done", name: "Done", kind: "checkbox" },
          { key: "tags", name: "Tags", kind: "string_list" },
          { key: "steps", name: "Steps", kind: "checklist" },
          { key: "author", name: "Author", kind: "item", target: "people" },
          { key: "calc", name: "Calc", kind: "component", code: "{{ $item.Name }}!" },
          { key: "sum", name: "Sum", kind: "ai", code: "Sum up {{ $item.Name }}", output: "string" },
        ],
        items: [{ values: { name: "Existing" } }],
      },
    ],
  };
}

test("New item: the empty form's defaults, errors, every kind stored, Cancel @ desktop", async (t) => {
  await t.boot();
  const ids = await t.seed(thingSpec());
  const coll = ids.collections.things;
  const names = async () => {
    const items = await t.page.evaluate(async (id) => {
      const repo = window.kubus.repo;
      const c = (await repo.listCollections()).find((x) => x.id === id);
      return (await repo.listItems(c, "default")).map((i) => ({ id: i.id, values: i.values }));
    }, coll);
    return items;
  };
  const collection = await storedCollection(t, coll);
  const f = (name) => fieldId(collection, name);
  await t.open(t.listPath(coll));
  await t.page.getByRole("button", { name: "New Thing" }).filter({ visible: true }).first().click();
  await t.until("the form opens", async () => (await t.page.locator(".ws-pane--active .page-header__title").innerText().catch(() => "")).includes("New Thing"));
  const form = t.page.locator(".ws-pane--active .item-fields--form");
  // Defaults per kind: empty inputs, an unticked box; the computed and AI fields are not entered here.
  await t.check("text, number and date inputs start empty", (await form.getByRole("textbox", { name: "Name", exact: true }).inputValue()) === "" && (await form.getByRole("textbox", { name: "Pages" }).inputValue()) === "" && (await form.getByRole("textbox", { name: "Released" }).inputValue()) === "");
  await t.check("the checkbox starts unticked", !(await form.getByRole("checkbox", { name: /^Done\b/ }).first().isChecked()));
  await t.check("a list starts with one empty row", (await form.getByRole("textbox", { name: "Tags 1" }).inputValue()) === "" && (await form.getByRole("textbox", { name: "Tags 2" }).count()) === 0);
  const text = await form.innerText();
  await t.check("Calc (component) and Sum (AI) are not asked for", !/\bCalc\b/.test(text) && !/\bSum\b/.test(text), text.slice(0, 300));
  await t.check("the button names the collection", (await t.page.getByRole("button", { name: "Create Thing" }).count()) === 1);
  await t.audit("empty new item form");

  // Errors: nothing is created, each says what is wrong, and typing clears it.
  await form.getByRole("textbox", { name: "Pages" }).fill("lots");
  await form.getByRole("textbox", { name: "Released" }).fill("last Tuesday");
  await t.page.getByRole("button", { name: "Create Thing" }).click();
  await t.until("the number says it is not valid", async () => (await form.innerText()).includes("Not a valid number"));
  await t.check("still on the form, nothing created", (await t.page.locator(".ws-pane--active .page-header__title").innerText()).includes("New Thing") && (await names()).length === 1);
  await t.audit("new item form with errors");
  await form.getByRole("textbox", { name: "Pages" }).fill("42");
  await t.until("editing a field clears its error", async () => !(await form.innerText()).includes("Not a valid number"));
  await form.getByRole("textbox", { name: "Released" }).fill("2024-05-17");
  await form.getByRole("textbox", { name: "Released" }).press("Tab");
  await form.getByRole("textbox", { name: "Pages" }).fill("4,5");
  await t.check("a comma becomes a decimal point", (await form.getByRole("textbox", { name: "Pages" }).inputValue()) === "4.5");

  // Every kind filled, stored as typed.
  await form.getByRole("textbox", { name: "Name", exact: true }).fill("A new thing");
  await form.getByRole("textbox", { name: "Seen at" }).first().fill("2024-05-17");
  await form.getByRole("textbox", { name: "Seen at" }).first().press("Tab");
  await form.getByRole("textbox", { name: "Time" }).fill("13:45");
  await tick(t, form.getByRole("checkbox", { name: /^Done\b/ }).first());
  await form.getByRole("textbox", { name: "Tags 1" }).fill("alpha");
  await form.getByRole("button", { name: "Add item" }).first().click();
  await form.getByRole("textbox", { name: "Tags 2" }).fill("beta");
  await form.getByRole("textbox", { name: "Steps 1" }).fill("first step");
  await tick(t, form.getByRole("checkbox", { name: "Steps 1 done" }));
  const author = form.getByRole("combobox", { name: "Author" });
  await author.click();
  await t.page.getByRole("option", { name: "Octavia" }).click();
  await t.audit("new item form filled");
  await t.page.getByRole("button", { name: "Create Thing" }).click();
  await t.until("Create returns to the list", async () => (await t.page.locator(".ws-pane--active .page-header__title").innerText().catch(() => "")).includes("Things") && !(await t.page.locator(".ws-pane--active .page-header__title").innerText()).includes("New Thing"));
  await t.until("the item is stored with every value", async () => (await names()).length === 2);
  const created = (await names()).find((i) => i.values[f("Name")] === "A new thing");
  const v = created.values;
  await t.check("name, number, date, checkbox", v[f("Name")] === "A new thing" && v[f("Pages")] === 4.5 && v[f("Released")] === "2024-05-17" && v[f("Done")] === true, JSON.stringify(v));
  await t.check("date & time as an instant of the typed local time", new Date(v[f("Seen at")]).getTime() === new Date("2024-05-17T13:45").getTime(), String(v[f("Seen at")]));
  await t.check("the lists keep their rows, the checklist its mark", JSON.stringify(v[f("Tags")]) === JSON.stringify(["alpha", "beta"]) && JSON.stringify(v[f("Steps")]) === JSON.stringify(["[x] first step"]), JSON.stringify([v[f("Tags")], v[f("Steps")]]));
  const octavia = await t.page.evaluate(async (id) => {
    const repo = window.kubus.repo;
    const c = (await repo.listCollections()).find((x) => x.id === id);
    return (await repo.listItems(c, "default")).find((i) => Object.values(i.values).includes("Octavia")).id;
  }, ids.collections.people);
  await t.check("the reference points at the chosen item", v[f("Author")] === octavia, String(v[f("Author")]));
  await t.check("the new item is in the list", (await t.page.locator(".ws-pane--active").innerText()).includes("A new thing"));
  await t.audit("list after creating");

  // An empty form creates an item with nothing in it (a checkbox unticked).
  await t.page.getByRole("button", { name: "New Thing" }).filter({ visible: true }).first().click();
  await t.until("the form again, empty (it starts afresh)", async () => (await t.page.locator(".ws-pane--active .item-fields--form").getByRole("textbox", { name: "Name", exact: true }).inputValue().catch(() => "x")) === "");
  await t.page.getByRole("button", { name: "Create Thing" }).click();
  await t.until("an empty item is created", async () => (await names()).length === 3);
  const empty = (await names()).find((i) => i.values[f("Name")] == null && i.values[f("Pages")] == null);
  await t.check("its values are empty, the checkbox false", !!empty && empty.values[f("Done")] !== true && empty.values[f("Tags")] == null, JSON.stringify(empty));

  // Cancel: back to the list, nothing created, what was typed is gone.
  await t.page.getByRole("button", { name: "New Thing" }).filter({ visible: true }).first().click();
  const form2 = t.page.locator(".ws-pane--active .item-fields--form");
  await form2.getByRole("textbox", { name: "Name", exact: true }).fill("Never saved");
  await t.page.getByRole("button", { name: "Cancel" }).click();
  await t.until("Cancel returns to the list", async () => !(await t.page.locator(".ws-pane--active .page-header__title").innerText()).includes("New Thing"));
  await t.check("nothing was created", (await names()).length === 3 && !(await t.page.locator(".ws-pane--active").innerText()).includes("Never saved"));
  await t.audit("list after Cancel");
}, { viewport: "desktop", smoke: true });

/** Books plus shared components of every kind: field, block, static, mixed and an AI prompt. */
function componentsSpec() {
  const spec = profileSpec("typical", { items: 4, authors: 2 });
  spec.components.push(
    { key: "field1", name: "Field one", description: "Shows the title", code: "{{ $item.Title }}", output: "string" },
    { key: "block1", name: "Block one", code: "{{ $items.length }} books", output: "markdown" },
    { key: "static1", name: "Static one", code: "Hello **there**", output: "markdown" },
    { key: "mixed1", name: "Mixed one", code: "{{ $item.Title }} {{ $items.length }}", output: "markdown" },
    { key: "prompt1", name: "Prompt one", code: "Summarise {{ $item.Title }}", output: "string", ai: true },
  );
  return spec;
}

const row = (t, name) => t.page.locator(".ws-pane--active tbody tr", { hasText: name }).first();

/** The pane's current path through the page's own address, for "where am I". */
const hereTitle = async (t) => (await t.page.locator(".ws-pane--active .page-header__title").innerText().catch(() => "")).trim();

test("new component: name needed, created and listed; edit, Cancel and Save; code errors @ desktop", async (t) => {
  await t.boot();
  await t.seed(componentsSpec());
  await t.open("/components/new");
  const name = t.page.getByRole("textbox", { name: "Name", exact: true });
  const code = t.page.getByRole("textbox", { name: "Code", exact: true });
  await code.fill("**{{ 6 * 7 }}**");
  await t.page.getByRole("button", { name: "Create component" }).click();
  await t.until("a missing name is asked for", async () => (await t.page.locator(".form-page").innerText()).includes("Give the component a name"));
  await t.check("nothing was created", !(await storedComponents(t)).some((c) => c.code === "**{{ 6 * 7 }}**"));
  await t.audit("new component without a name");
  await name.fill("The answer");
  await t.page.getByRole("textbox", { name: "Description" }).fill("Six times seven");
  const result = t.page.locator(".component-test__preview");
  await t.until("the result is worked out as typed (bold 42)", async () => (await result.locator("strong").allInnerTexts()).join() === "42");
  await t.audit("new component with its result");
  await t.page.getByRole("button", { name: "Create component" }).click();
  await t.until("created: stored, back on the list", async () => (await hereTitle(t)) === "Components" && (await storedComponents(t)).some((c) => c.name === "The answer" && c.description === "Six times seven" && c.code === "**{{ 6 * 7 }}**" && c.output === "markdown" && c.ai === false));

  // Edit: Cancel leaves it, Save changes it.
  await row(t, "The answer").getByRole("link", { name: "The answer" }).click();
  await t.until("the editor shows what is stored", async () => (await name.inputValue()) === "The answer" && (await code.inputValue()) === "**{{ 6 * 7 }}**");
  await name.fill("Changed but cancelled");
  await t.page.getByRole("button", { name: "Cancel" }).click();
  await t.until("Cancel goes back to the list", async () => (await hereTitle(t)) === "Components");
  await t.check("the stored name is unchanged", (await storedComponents(t)).some((c) => c.name === "The answer") && !(await storedComponents(t)).some((c) => c.name === "Changed but cancelled"));
  await row(t, "The answer").getByRole("link", { name: "The answer" }).click();
  await t.until("the editor again", async () => (await code.inputValue()) === "**{{ 6 * 7 }}**");
  await code.fill("{{ 6 * 8 }} things");
  await name.fill("The answer, revised");
  await t.until("the result follows the code", async () => (await result.innerText()).includes("48 things"));
  await t.page.getByRole("button", { name: "Save changes" }).click();
  await t.until("saved under the new name and code", async () => (await storedComponents(t)).some((c) => c.name === "The answer, revised" && c.code === "{{ 6 * 8 }} things"));
  await t.until("back on the list, still one of it", async () => (await hereTitle(t)) === "Components" && (await t.page.locator(".ws-pane--active tbody tr", { hasText: "The answer" }).count()) === 1);

  // Code errors: an unknown $ name and a mix cannot be saved; a failing line is shown in the result.
  await row(t, "The answer, revised").getByRole("link", { name: /The answer/ }).click();
  await t.until("the editor", async () => (await code.inputValue()) === "{{ 6 * 8 }} things");
  await code.fill("{{ $pages / 40 }}");
  await t.until("the unknown name is explained", async () => (await t.page.locator(".form-page").innerText()).includes("$pages isn't known"));
  await t.page.getByRole("button", { name: "Save changes" }).click();
  await t.settle();
  await t.check("it is not saved", (await hereTitle(t)) === "The answer, revised" && (await storedComponents(t)).some((c) => c.code === "{{ 6 * 8 }} things"));
  await t.audit("code with an unknown name");
  await code.fill("{{ $item.Title }} and {{ $items.length }}");
  await t.until("a mix of $item and a block's names is explained", async () => { const x = await t.page.locator(".form-page").innerText(); return /uses both/.test(x) || x.slice(0, 600); });
  await t.page.getByRole("button", { name: "Save changes" }).click();
  await t.settle();
  await t.check("the mix is not saved either", (await storedComponents(t)).every((c) => c.code !== "{{ $item.Title }} and {{ $items.length }}"));
  await code.fill("before {{ (() => { throw new Error('boom'); })() }} after");
  await t.until("a failing section shows a warning with its message in the result", async () => { const x = await result.innerText(); return /boom/.test(x) || x.slice(0, 300); });
  await t.audit("code that throws");
  await code.fill("{{ syntax error ( }}");
  await t.until("a syntax error is shown in the result too", async () => /Unexpected|Syntax|Missing|rror/i.test(await result.innerText()) || (await result.innerText()).slice(0, 200));
}, { viewport: "desktop", smoke: true });
