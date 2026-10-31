// Every field kind with its settings, set in the collection editor, stored and shown again after a reload
// (read back through window.kubus.repo).

/** The types a new field can have, in the menu's order ("AI" is a Component field with Ask AI on). */
const KINDS = ["String", "Markdown", "HTML", "Number", "Date", "Date & time", "Checkbox", "Image", "Item", "List of strings", "List of numbers", "Checklist", "List of items", "Component"];

/** What a dropdown shows as chosen. */
const chosen = async (t, scope, title) => (await dropdownOf(t, scope, title).locator(".cds--list-box__field").first().innerText()).trim();

/** One side of the Value switch inside `scope`: "Code" or "AI prompt". */
const valueTab = (scope, side) => scope.locator(".cds--content-switcher button").filter({ hasText: new RegExp(`^${side}$`) });

const isOn = async (loc) => (await loc.getAttribute("aria-selected")) === "true" || (await loc.getAttribute("class")).includes("selected");

/** Whether the editor form is still on screen (the tab's route is not in the address bar). */
const onForm = async (t) => (await t.page.locator(".ws-pane--active .form-page").count()) === 1;

const rows = (t) => t.page.locator(".ws-pane--active .field-row[data-field-id]");

/** Adds a field to the collection editor: its row, named, with the type chosen. */
async function addRow(t, name, type) {
  await t.page.getByRole("button", { name: "Add field" }).click();
  await t.settle(80);
  const row = rows(t).last();
  await row.getByRole("textbox", { name: "Field name" }).fill(name);
  if (type !== "String") await pickOption(t, row, "Field type", type);
  return row;
}

/** The collection as stored (by name), as plain data. */
const stored = (t, name) =>
  t.page.evaluate(async (name) => {
    const c = (await window.kubus.repo.listCollections()).find((x) => x.name === name);
    return c ? JSON.parse(JSON.stringify(c)) : null;
  }, name);

const storedField = (c, name) => c?.fields.find((f) => f.name === name);

/** Authors (with items) and a shared component to refer to / choose. */
function targetSpec() {
  return {
    components: [{ key: "double", name: "Double", code: "{{ ($item.Count ?? 0) * 2 }}", output: "markdown" }],
    collections: [
      { key: "authors", name: "Author", plural: "Authors", icon: "User", fields: [{ key: "name", name: "Name", kind: "string" }], items: [{ key: "a", values: { name: "Ursula" } }, { key: "b", values: { name: "Octavia" } }, { key: "c", values: { name: "Stanislaw" } }] },
    ],
  };
}

/** Saves the collection editor; waits for the collection's page. */
async function saveEditor(t, label = "Save changes") {
  await t.page.getByRole("button", { name: label }).click();
  await t.until("saved: the editor closes", async () => !(await onForm(t)));
}

test("editor: every kind with its settings is stored, and shown again after a reload @ desktop", async (t) => {
  await t.boot();
  const ids = await t.seed(targetSpec());
  await t.open("/collections/new");
  await t.page.getByRole("textbox", { name: "Name", exact: true }).first().fill("Gadgets");
  await t.page.getByRole("textbox", { name: "Description (optional)" }).fill("Things with every field type.");
  // The first row (a String called Name) stays; one field of each other type follows.
  for (const type of KINDS.slice(1)) {
    const row = await addRow(t, `F ${type}`, type);
    if (type === "Item") await pickOption(t, row, "Refers to", "Authors");
    if (type === "List of items") await pickOption(t, row, "Refers to", "Gadgets (itself)");
    if (type === "Checkbox") {
      await pickOption(t, row, "Icon", "Heart");
      await row.getByText("Strike through the item when checked").click();
    }
    if (type === "Checklist") await pickOption(t, row, "Icon", "Flag");
    if (type === "Component") await row.getByRole("textbox", { name: "Code" }).fill("{{ $item.Name }}!");
  }
  // …and a field asking AI.
  const ai = await addRow(t, "F AI", "Component");
  await valueTab(ai, "AI prompt").click();
  await ai.getByRole("textbox", { name: "Prompt" }).fill("Describe {{ $item.Name }}");
  await t.audit("editor with every kind");
  await saveEditor(t, "Create collection");
  const c = await stored(t, "Gadget");
  await t.require("the collection is stored", !!c);
  const want = { "F Markdown": "markdown", "F HTML": "html", "F Number": "number", "F Date": "date", "F Date & time": "datetime", "F Checkbox": "checkbox", "F Image": "image", "F Item": "item", "F List of strings": "string_list", "F List of numbers": "number_list", "F Checklist": "checklist", "F List of items": "item_list", "F Component": "component", "F AI": "ai" };
  for (const [name, kind] of Object.entries(want)) await t.check(`${name} is stored as ${kind}`, storedField(c, name)?.kind === kind, storedField(c, name)?.kind);
  await t.check("its description is stored", c.description === "Things with every field type.");
  await t.check("Item refers to Authors", storedField(c, "F Item")?.targetCollectionId === ids.collections.authors);
  await t.check("List of items refers to the collection itself", storedField(c, "F List of items")?.targetCollectionId === c.id);
  await t.check("other kinds refer to nothing", c.fields.filter((f) => !["item", "item_list"].includes(f.kind)).every((f) => f.targetCollectionId === null));
  await t.check("checkbox: icon and strike through", storedField(c, "F Checkbox")?.toggleIcon === "heart" && storedField(c, "F Checkbox")?.strikeThrough === true);
  await t.check("checklist: icon, no strike through", storedField(c, "F Checklist")?.toggleIcon === "flag" && storedField(c, "F Checklist")?.strikeThrough === false);
  await t.check("component: its own code, Markdown", storedField(c, "F Component")?.code === "{{ $item.Name }}!" && storedField(c, "F Component")?.output === "markdown");
  await t.check("AI: its prompt, Markdown", storedField(c, "F AI")?.code === "Describe {{ $item.Name }}" && storedField(c, "F AI")?.output === "markdown", JSON.stringify(storedField(c, "F AI")));
  // Back in the editor: everything is there, the type fixed.
  await t.open(`/collections/${c.id}/edit`);
  await t.audit("saved collection in the editor");
  const all = rows(t);
  // Every type once, and AI (a Component field asking AI).
  await t.check("one row per field", (await all.count()) === KINDS.length + 1, `${await all.count()}`);
  const rowOf = (name) => all.filter({ has: t.page.locator(`input[value="${name}"]`) });
  await t.check("types can't be changed any more", (await rowOf("F Number").locator(".cds--dropdown").first().getAttribute("class")).includes("cds--dropdown--disabled") || (await rowOf("F Number").locator(".cds--list-box__field").first().isDisabled()));
  await t.check("Item shows its collection", (await chosen(t, rowOf("F Item"), "Refers to")).includes("Authors"));
  await t.check("and can't be changed", await dropdownOf(t, rowOf("F Item"), "Refers to").locator(".cds--list-box__field").first().isDisabled());
  await t.check("List of items shows the collection itself", (await chosen(t, rowOf("F List of items"), "Refers to")).includes("Gadgets"));
  await t.check("checkbox shows Heart and Strike through ticked", (await chosen(t, rowOf("F Checkbox"), "Icon")) === "Heart" && (await rowOf("F Checkbox").getByRole("checkbox", { name: /Strike through/ }).isChecked()));
  await t.check("checklist shows Flag, strike through off", (await chosen(t, rowOf("F Checklist"), "Icon")) === "Flag" && !(await rowOf("F Checklist").getByRole("checkbox", { name: /Strike through/ }).isChecked()));
  await t.check("component shows its code", (await rowOf("F Component").getByRole("textbox", { name: "Code" }).inputValue()) === "{{ $item.Name }}!");
  const aiRow = rowOf("F AI");
  await t.check("AI shows Value: AI prompt, fixed, and its prompt", (await isOn(valueTab(aiRow, "AI prompt"))) && (await valueTab(aiRow, "AI prompt").isDisabled()) && (await valueTab(aiRow, "Code").isDisabled()) && (await aiRow.getByRole("textbox", { name: "Prompt" }).inputValue()).startsWith("Describe"));
  // Saved unchanged: nothing is lost.
  await saveEditor(t);
  const again = await stored(t, "Gadget");
  await t.check("saving again changes nothing", JSON.stringify(again.fields.map(({ position, ...f }) => f)) === JSON.stringify(c.fields.map(({ position, ...f }) => f)));
}, { viewport: "desktop", smoke: true });
