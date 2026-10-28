// Field kinds and their settings, in the collection editor and in the field dialog (a block's
// Fields → Add field): the type menu lists every kind, each kind brings its own settings, and what is
// set survives saving and a reload (read back through window.kubus.repo and shown again in the editor).
// Refers to, the toggle icons, strike through, component code and output, Ask AI, validation, a
// type changed before saving, a removed field, names and description, the title field, and editing a
// list of items in place.

/** The types a new field can have, in the menu's order ("AI" is a Component field with Ask AI on). */
const KINDS = ["String", "Markdown", "HTML", "Number", "Date", "Date & time", "Checkbox", "Image", "Item", "List of strings", "Checklist", "List of items", "Component"];
/** The stored kind of each type in the menu. */
const KIND_OF = { String: "string", Markdown: "markdown", HTML: "html", Number: "number", Date: "date", "Date & time": "datetime", Checkbox: "checkbox", Image: "image", Item: "item", "List of strings": "string_list", Checklist: "checklist", "List of items": "item_list", Component: "component" };
/** What a checkbox or checklist can show instead of its box (the dropdown's choices, in order). */
const ICONS = ["Checkbox", "Heart", "Star", "Flag", "Bookmark", "Checkmark", "Thumbs up", "Happy face", "Neutral face", "Sad face", "Winking face"];
const ICON_KEY = { Checkbox: null, Heart: "heart", Star: "star", Flag: "flag", Bookmark: "bookmark", Checkmark: "checkmark", "Thumbs up": "thumbsUp", "Happy face": "happy", "Neutral face": "neutral", "Sad face": "sad", "Winking face": "wink" };
/** What a component field's Output offers (value → text), in order. */
const OUTPUTS = { markdown: "Markdown", string: "Text", number: "Number", image: "Image (URL)", html: "HTML" };

/** A Carbon dropdown inside `scope`, by its title. */
const dropdown = (t, scope, title) => scope.locator(".cds--dropdown__wrapper").filter({ has: t.page.locator(".cds--label", { hasText: new RegExp(`^${title}$`) }) }).first();

/** The options of the open menu, as texts. */
const menuOptions = async (t) => (await t.page.getByRole("option").filter({ visible: true }).allInnerTexts()).map((s) => s.trim());

/** Opens a dropdown, picks an option by its text. */
async function choose(t, scope, title, option) {
  await dropdown(t, scope, title).locator(".cds--list-box__field").first().click();
  await t.settle(80);
  await t.page.getByRole("option", { name: option, exact: true }).filter({ visible: true }).first().click();
  await t.settle(80);
}

/** What a dropdown shows as chosen. */
const chosen = async (t, scope, title) => (await dropdown(t, scope, title).locator(".cds--list-box__field").first().innerText()).trim();

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
  if (type !== "String") await choose(t, row, "Field type", type);
  return row;
}

/** The collection as stored (by name), as plain data. */
const stored = (t, name) =>
  t.page.evaluate(async (name) => {
    const c = (await window.kubus.repo.listCollections()).find((x) => x.name === name);
    return c ? JSON.parse(JSON.stringify(c)) : null;
  }, name);

/** An item's stored values by field name. */
const storedValues = (t, collectionId, itemId) =>
  t.page.evaluate(async ([cid, iid]) => {
    const c = (await window.kubus.repo.listCollections()).find((x) => x.id === cid);
    const it = (await window.kubus.repo.listItems(c, "default")).find((i) => i.id === iid);
    return Object.fromEntries(c.fields.map((f) => [f.name, it?.values[f.id] ?? null]));
  }, [collectionId, itemId]);

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

/** Opens a block's Fields popover on the collection's page and the Add field dialog from it. */
async function openFieldDialog(t, collectionId) {
  await t.open(t.listPath(collectionId));
  const bar = t.page.locator(".block").first().locator(".section-header").first();
  let btn = bar.getByRole("button", { name: "Fields", exact: true }).filter({ visible: true }).first();
  if (!(await btn.count())) {
    await bar.getByRole("button", { name: "More actions" }).filter({ visible: true }).first().click();
    await t.settle(100);
    btn = t.page.getByRole("button", { name: "Fields", exact: true }).filter({ visible: true }).last();
  }
  await btn.click();
  await t.settle(150);
  await t.page.locator(".cds--popover--open").getByRole("button", { name: "Add field" }).click();
  const modal = t.page.locator(".cds--modal.is-visible");
  await t.until("the field dialog opens", async () => (await modal.count()) === 1);
  return modal;
}

/** The settings a type brings, checked inside `scope` (a field row or the dialog). */
async function settingsOf(t, scope) {
  const text = await scope.innerText();
  return {
    refersTo: (await dropdown(t, scope, "Refers to").count()) > 0,
    icon: (await dropdown(t, scope, "Icon").count()) > 0,
    strike: /Strike through/.test(text),
    askAi: (await scope.locator(".cds--content-switcher").count()) > 0,
    component: (await dropdown(t, scope, "Component").count()) > 0,
    code: (await scope.getByRole("textbox", { name: "Code" }).count()) > 0,
  };
}

const NONE = { refersTo: false, icon: false, strike: false, askAi: false, component: false, code: false };
const SETTINGS = {
  Item: { ...NONE, refersTo: true },
  "List of items": { ...NONE, refersTo: true },
  Checkbox: { ...NONE, icon: true, strike: true },
  Checklist: { ...NONE, icon: true, strike: true },
  Component: { ...NONE, askAi: true, component: true, code: true },
};

for (const vp of ["desktop", "phone"]) {
  test(`editor: the type menu lists every kind, each brings its own settings @ ${vp}`, async (t) => {
    await t.boot();
    await t.seed(targetSpec());
    await t.open("/collections/new");
    const row = rows(t).first();
    await row.getByRole("textbox", { name: "Field name" }).fill("Probe");
    await dropdown(t, row, "Field type").locator(".cds--list-box__field").first().click();
    await t.settle(100);
    const options = await menuOptions(t);
    await t.check("the menu offers the 13 types, AI not among them", JSON.stringify(options) === JSON.stringify(KINDS), options.join(" | "));
    await t.check("each type has an icon", (await t.page.getByRole("option").filter({ visible: true }).locator("svg").count()) >= KINDS.length);
    await t.audit("field type menu open");
    await t.escapeCloses("Escape closes the type menu");
    await t.check("a new field is a String", (await chosen(t, row, "Field type")) === "String");
    await t.check("a String has no settings", JSON.stringify(await settingsOf(t, row)) === JSON.stringify(NONE) && (await row.locator(".field-row__settings").count()) === 0);
    for (const type of KINDS) {
      await choose(t, row, "Field type", type);
      await t.check(`${type}: chosen`, (await chosen(t, row, "Field type")) === type, await chosen(t, row, "Field type"));
      const got = await settingsOf(t, row);
      const want = SETTINGS[type] ?? NONE;
      await t.check(`${type}: brings ${Object.keys(SETTINGS).includes(type) ? Object.entries(want).filter(([, v]) => v).map(([k]) => k).join(", ") : "no settings"}`, JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got));
      if (type === "Checkbox") await t.check("a checkbox strikes the item through", (await row.innerText()).includes("Strike through the item when checked"));
      if (type === "Checklist") await t.check("a checklist strikes checked entries through", (await row.innerText()).includes("Strike through checked entries"));
      if (SETTINGS[type]) await t.audit(`settings of ${type}`);
    }
    // The chosen type is what gets stored.
    await choose(t, row, "Field type", "Number");
    await t.page.getByRole("textbox", { name: "Name", exact: true }).first().fill("Gizmos");
    await saveEditor(t, "Create collection");
    const c = await stored(t, "Gizmo");
    await t.check("the number field was stored", storedField(c, "Probe")?.kind === "number", JSON.stringify(c?.fields.map((f) => f.kind)));
  }, { viewport: vp, smoke: vp === "desktop" });
}

test("field dialog: the same kinds, the same settings", async (t) => {
  await t.boot();
  const ids = await t.seed(profileSpec("typical", { items: 3 }));
  const modal = await openFieldDialog(t, ids.collections.books);
  await modal.getByRole("textbox", { name: "Name" }).fill("Probe");
  await dropdown(t, modal, "Field type").locator(".cds--list-box__field").first().click();
  await t.settle(100);
  const options = await menuOptions(t);
  await t.check("the dialog offers the same 13 types", JSON.stringify(options) === JSON.stringify(KINDS), options.join(" | "));
  await t.audit("field dialog: type menu open");
  await t.page.keyboard.press("Escape");
  await t.settle(100);
  await t.check("Escape closed the menu, not the dialog", (await modal.count()) === 1);
  for (const type of KINDS) {
    await choose(t, modal, "Field type", type);
    const got = await settingsOf(t, modal);
    const want = SETTINGS[type] ?? NONE;
    await t.check(`${type}: settings in the dialog`, JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got));
    if (SETTINGS[type]) await t.audit(`dialog with ${type}`, { shotOnFail: true });
  }
  await t.check("the helper names the field as $item[…] reads it", (await modal.innerText()).includes('$item["Probe"]'));
}, { viewport: "desktop" });

for (const vp of ["desktop"]) {
  test(`editor: every kind with its settings is stored, and shown again after a reload @ ${vp}`, async (t) => {
    await t.boot();
    const ids = await t.seed(targetSpec());
    await t.open("/collections/new");
    await t.page.getByRole("textbox", { name: "Name", exact: true }).first().fill("Gadgets");
    await t.page.getByRole("textbox", { name: "Description (optional)" }).fill("Things with every field type.");
    // The first row (a String called Name) stays; one field of each other type follows.
    for (const type of KINDS.slice(1)) {
      const row = await addRow(t, `F ${type}`, type);
      if (type === "Item") await choose(t, row, "Refers to", "Authors");
      if (type === "List of items") await choose(t, row, "Refers to", "Gadgets (itself)");
      if (type === "Checkbox") {
        await choose(t, row, "Icon", "Heart");
        await row.getByText("Strike through the item when checked").click();
      }
      if (type === "Checklist") await choose(t, row, "Icon", "Flag");
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
    const want = { "F Markdown": "markdown", "F HTML": "html", "F Number": "number", "F Date": "date", "F Date & time": "datetime", "F Checkbox": "checkbox", "F Image": "image", "F Item": "item", "F List of strings": "string_list", "F Checklist": "checklist", "F List of items": "item_list", "F Component": "component", "F AI": "ai" };
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
    await t.check("one row per field", (await all.count()) === 14, `${await all.count()}`);
    const rowOf = (name) => all.filter({ has: t.page.locator(`input[value="${name}"]`) });
    await t.check("types can't be changed any more", (await rowOf("F Number").locator(".cds--dropdown").first().getAttribute("class")).includes("cds--dropdown--disabled") || (await rowOf("F Number").locator(".cds--list-box__field").first().isDisabled()));
    await t.check("Item shows its collection", (await chosen(t, rowOf("F Item"), "Refers to")).includes("Authors"));
    await t.check("and can't be changed", await dropdown(t, rowOf("F Item"), "Refers to").locator(".cds--list-box__field").first().isDisabled());
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
  }, { viewport: vp, smoke: vp === "desktop" });
}

test("Refers to: required, offers collections, choices, fixed once saved", async (t) => {
  await t.boot();
  const spec = targetSpec();
  spec.collections.push({ key: "books", name: "Book", plural: "Books", icon: "Book", fields: [{ key: "title", name: "Title", kind: "string" }, { key: "by", name: "By", kind: "item", target: "authors" }, { key: "also", name: "Also", kind: "item_list", target: "authors" }], items: [] });
  const ids = await t.seed(spec);
  // A new collection: Authors, Books and itself are offered; none chosen is a problem on save.
  await t.open("/collections/new");
  await t.page.getByRole("textbox", { name: "Name", exact: true }).first().fill("Reviews");
  for (const type of ["Item", "List of items"]) {
    const row = await addRow(t, `To ${type}`, type);
    await t.check(`${type}: nothing chosen yet`, (await chosen(t, row, "Refers to")) === "Choose…", await chosen(t, row, "Refers to"));
    await dropdown(t, row, "Refers to").locator(".cds--list-box__field").first().click();
    await t.settle(100);
    const options = await menuOptions(t);
    await t.check(`${type}: offers every collection and itself`, JSON.stringify(options) === JSON.stringify(["Authors", "Books", "Reviews (itself)"]), options.join(" | "));
    await t.page.keyboard.press("Escape");
    await t.settle(80);
  }
  await t.page.getByRole("button", { name: "Create collection" }).click();
  await t.settle();
  await t.check("saving is refused: the page stays", (await onForm(t)));
  await t.check("each reference field asks for a collection", (await t.page.getByText("Choose a collection").count()) >= 2, `${await t.page.getByText("Choose a collection").count()}`);
  await t.check("nothing was stored", (await stored(t, "Review")) === null);
  await t.audit("references without a collection");
  const first = rows(t).nth(1);
  await choose(t, first, "Refers to", "Authors");
  await t.check("the problem goes with the choice", (await first.innerText()).includes("Choose a collection") === false);
  // Authors have a choice filter editor ("Choices"): only items matching are offered.
  await t.check("a reference shows its Choices", (await first.innerText()).includes("Choices") && (await first.innerText()).includes("Any Author can be chosen."));
  await first.getByRole("button", { name: /Add filter/ }).first().click();
  await t.settle(150);
  await t.audit("a reference with a choice filter row", { shotOnFail: true });
  await choose(t, rows(t).nth(2), "Refers to", "Books");
  await t.page.getByRole("button", { name: "Create collection" }).click();
  await t.until("saved", async () => !(await onForm(t)));
  const c = await stored(t, "Review");
  await t.check("targets stored", storedField(c, "To Item")?.targetCollectionId === ids.collections.authors && storedField(c, "To List of items")?.targetCollectionId === ids.collections.books);
  // A saved field's collection is fixed; its kind too.
  await t.open(`/collections/${ids.collections.books}/edit`);
  const by = rows(t).filter({ has: t.page.locator('input[value="By"]') });
  await t.check("Refers to is fixed once saved", await dropdown(t, by, "Refers to").locator(".cds--list-box__field").first().isDisabled());
  await t.check("and so is the type", await dropdown(t, by, "Field type").locator(".cds--list-box__field").first().isDisabled());
  await t.audit("saved reference fields");
}, { viewport: "desktop" });

for (const kind of ["Checkbox", "Checklist"]) {
  test(`${kind}: every icon can be chosen, is stored and shows on the item page`, async (t) => {
    await t.boot();
    const stored1 = kind === "Checkbox" ? { kind: "checkbox", value: false } : { kind: "checklist", value: ["[ ] one", "[x] two"] };
    const spec = { collections: [{ key: "t", name: "Thing", plural: "Things", fields: [{ key: "name", name: "Name", kind: "string" }, ...ICONS.map((icon, i) => ({ key: `f${i}`, name: `${icon} ${kind}`, kind: stored1.kind }))], items: [{ key: "x", values: { name: "Item", ...Object.fromEntries(ICONS.map((_, i) => [`f${i}`, stored1.value])) } }] }] };
    const ids = await t.seed(spec);
    await t.open(`/collections/${ids.collections.t}/edit`);
    const first = rows(t).nth(1);
    await dropdown(t, first, "Icon").locator(".cds--list-box__field").first().click();
    await t.settle(100);
    const options = await menuOptions(t);
    await t.check("the Icon menu lists the box and ten icons", JSON.stringify(options) === JSON.stringify(ICONS), options.join(" | "));
    await t.check("each has its icon", (await t.page.getByRole("option").filter({ visible: true }).locator("svg").count()) >= ICONS.length);
    await t.audit(`${kind}: Icon menu open`);
    await t.page.keyboard.press("Escape");
    await t.settle(80);
    for (const [i, icon] of ICONS.entries()) {
      const row = rows(t).nth(i + 1);
      await choose(t, row, "Icon", icon);
      await t.check(`${icon}: shown as chosen`, (await chosen(t, row, "Icon")) === icon, await chosen(t, row, "Icon"));
    }
    await t.audit(`${kind}: every icon chosen`);
    await saveEditor(t);
    const c = await stored(t, "Thing");
    for (const icon of ICONS) await t.check(`${icon}: stored as ${ICON_KEY[icon]}`, storedField(c, `${icon} ${kind}`)?.toggleIcon === ICON_KEY[icon], String(storedField(c, `${icon} ${kind}`)?.toggleIcon));
    // The editor shows them again.
    await t.open(`/collections/${ids.collections.t}/edit`);
    const shown = [];
    for (let i = 1; i <= ICONS.length; i++) shown.push(await chosen(t, rows(t).nth(i), "Icon"));
    await t.check("after a reload the editor shows each choice", JSON.stringify(shown) === JSON.stringify(ICONS), shown.join(" | "));
    // The item page: an icon is a toggle button, the box an ordinary checkbox.
    await t.open(t.itemPath(ids.collections.t, ids.items["t/x"]));
    await t.audit(`item page with ${kind} icons`);
    for (const icon of ICONS) {
      const field = t.page.locator(".ws-pane--active .item-fields > *", { hasText: `${icon} ${kind}` }).first();
      await field.scrollIntoViewIfNeeded();
      const toggles = await field.locator("button[role=checkbox]").count();
      const boxes = await field.locator("input[type=checkbox]").count();
      await t.check(`${icon}: ${icon === "Checkbox" ? "an ordinary box" : "an icon toggle"}`, icon === "Checkbox" ? boxes >= 1 && toggles === 0 : toggles >= 1 && boxes === 0, `${toggles} toggles, ${boxes} boxes`);
    }
    // Pressing the icon toggles it and stores the value.
    const heart = t.page.locator(".ws-pane--active .item-fields > *", { hasText: `Heart ${kind}` }).first();
    const toggle = heart.locator("button[role=checkbox]").first();
    const before = await toggle.getAttribute("aria-checked");
    await toggle.click();
    await t.until("the icon toggled", async () => (await toggle.getAttribute("aria-checked")) !== before);
    await t.until("and the value was stored", async () => {
      const v = (await storedValues(t, ids.collections.t, ids.items["t/x"]))[`Heart ${kind}`];
      return kind === "Checkbox" ? v === true : JSON.stringify(v) !== JSON.stringify(stored1.value) || JSON.stringify(v);
    });
  }, { viewport: "desktop" });
}

test("Strike through: item and checked entries, off and on", async (t) => {
  await t.boot();
  const spec = { collections: [{ key: "t", name: "Task", plural: "Tasks", fields: [{ key: "name", name: "Name", kind: "string" }, { key: "done", name: "Done", kind: "checkbox" }, { key: "steps", name: "Steps", kind: "checklist" }], items: [{ key: "a", values: { name: "Write", done: true, steps: ["[x] outline", "[ ] draft"] } }, { key: "b", values: { name: "Read", done: false, steps: ["[ ] skim"] } }] }] };
  const ids = await t.seed(spec);
  const struck = (sel) => t.page.evaluate((sel) => [...document.querySelectorAll(`.ws-pane--active ${sel}`)].map((e) => getComputedStyle(e.querySelector("a, div") ?? e).textDecorationLine.includes("line-through")), sel);
  await t.open(t.listPath(ids.collections.t));
  await t.check("without the setting nothing is struck", (await struck(".cell--struck")).length === 0);
  await t.open(t.itemPath(ids.collections.t, ids.items["t/a"]));
  const doneName = t.page.locator(".ws-pane--active .item-fields .checkbox-field__name", { hasText: "Done" }).first();
  await t.check("the checked box's name isn't struck", !(await doneName.evaluate((e) => getComputedStyle(e).textDecorationLine.includes("line-through"))));
  await t.open(`/collections/${ids.collections.t}/edit`);
  const done = rows(t).filter({ has: t.page.locator('input[value="Done"]') });
  const steps = rows(t).filter({ has: t.page.locator('input[value="Steps"]') });
  await t.check("the checkbox's setting is named for the item", (await done.innerText()).includes("Strike through the item when checked"));
  await t.check("the checklist's for its entries", (await steps.innerText()).includes("Strike through checked entries"));
  await done.getByText("Strike through the item when checked").click();
  await steps.getByText("Strike through checked entries").click();
  await t.audit("strike through ticked");
  await saveEditor(t);
  const c = await stored(t, "Task");
  await t.check("both stored", storedField(c, "Done").strikeThrough === true && storedField(c, "Steps").strikeThrough === true);
  await t.until("the checked item is struck in the table, the other not", async () => {
    const s = await struck(".cell--struck");
    return (s.length === 1 && s[0]) || JSON.stringify(s);
  });
  await t.audit("table with a struck through item");
  await t.open(t.itemPath(ids.collections.t, ids.items["t/a"]));
  await t.check("on the item page the checked box's name is struck", await t.page.locator(".ws-pane--active .item-fields .checkbox-field__name.checklist-row__done--struck").first().isVisible());
  const entries = await t.page.locator(".ws-pane--active .checklist-row__done--struck").evaluateAll((els) => els.map((e) => ({ text: e.textContent.trim(), line: getComputedStyle(e).textDecorationLine })));
  await t.check("and so is the checked entry (only that one)", entries.filter((e) => e.text.includes("outline")).length === 1 && !entries.some((e) => e.text.includes("draft")), JSON.stringify(entries));
  await t.audit("item page with struck through entries");
  // Unticked again: nothing is struck.
  await t.open(`/collections/${ids.collections.t}/edit`);
  await rows(t).filter({ has: t.page.locator('input[value="Done"]') }).getByText("Strike through the item when checked").click();
  await saveEditor(t);
  await t.check("stored off", storedField(await stored(t, "Task"), "Done").strikeThrough === false);
  await t.until("the table strikes nothing", async () => (await struck(".cell--struck")).length === 0);
}, { viewport: "desktop" });

test("Component field: local code, every Output, a shared one, problems", async (t) => {
  await t.boot();
  const spec = targetSpec();
  spec.collections.push({ key: "t", name: "Thing", plural: "Things", fields: [{ key: "name", name: "Name", kind: "string" }, { key: "count", name: "Count", kind: "number" }], items: [{ key: "x", values: { name: "Widget", count: 21 } }] });
  const ids = await t.seed(spec);
  await t.open(`/collections/${ids.collections.t}/edit`);
  const row = await addRow(t, "Computed", "Component");
  await t.check("starts local, Markdown, empty", (await chosen(t, row, "Component")) === "Local" && (await row.locator("select").first().inputValue()) === "markdown" && (await row.getByRole("textbox", { name: "Code" }).inputValue()) === "");
  await t.check("Value is Code", (await isOn(valueTab(row, "Code"))) && !(await isOn(valueTab(row, "AI prompt"))));
  const select = row.locator("select").first();
  const offered = (await select.locator("option").allInnerTexts()).map((s) => s.trim());
  await t.check("Output offers Markdown, Text, Number, Image (URL), HTML", JSON.stringify(offered) === JSON.stringify(Object.values(OUTPUTS)), offered.join(" | "));
  await t.check("the Save as shared button waits for code", await row.getByRole("button", { name: "Save as shared component" }).isDisabled());
  await t.audit("a new component field");
  // Unknown $ names, and code that mixes field and block names, are explained at the code.
  const code = row.getByRole("textbox", { name: "Code" });
  await code.fill("{{ $nothing }}");
  await t.until("an unknown $ name is explained", async () => (await row.innerText()).includes("$nothing isn't known"));
  await code.fill("{{ $item.Count }} {{ $items.length }}");
  await t.until("mixing $item with a block's names is refused", async () => /\$item and a block's/.test(await row.innerText()));
  await t.page.getByRole("button", { name: "Save changes" }).click();
  await t.settle();
  await t.check("saving with such code is refused", (await onForm(t)));
  await t.audit("component field with a problem");
  // Every output: one field each.
  await code.fill("{{ $item.Count * 2 }}");
  for (const [value, text] of Object.entries(OUTPUTS).slice(1)) {
    const r = await addRow(t, `Out ${value}`, "Component");
    await r.getByRole("textbox", { name: "Code" }).fill(value === "html" ? "<b>{{ $item.Count }}</b>" : value === "image" ? "{{ 'about:blank#' + $item.Count }}" : "{{ $item.Count * 2 }}");
    await r.locator("select").first().selectOption({ label: text });
    await t.check(`Output ${text} chosen`, (await r.locator("select").first().inputValue()) === value);
  }
  // A shared component instead of local code.
  const shared = await addRow(t, "Shared", "Component");
  await dropdown(t, shared, "Component").locator(".cds--list-box__field").first().click();
  await t.settle(100);
  const choices = await menuOptions(t);
  await t.check("Component offers Local and the shared field components", choices[0] === "Local" && choices.some((c) => c.startsWith("Double")), choices.join(" | "));
  await t.page.getByRole("option", { name: /^Double/ }).filter({ visible: true }).first().click();
  await t.settle(100);
  await t.check("a shared one hides the code, offers Edit component", (await shared.getByRole("textbox", { name: "Code" }).count()) === 0 && (await shared.getByRole("button", { name: "Edit component" }).count()) + (await shared.getByRole("link", { name: "Edit component" }).count()) === 1);
  await t.check("and says it is shared", (await shared.innerText()).includes("Shared: a change applies everywhere"));
  await t.audit("component field with a shared component");
  await saveEditor(t);
  const c = await stored(t, "Thing");
  await t.check("local code stored", storedField(c, "Computed")?.code === "{{ $item.Count * 2 }}" && storedField(c, "Computed")?.componentId === null);
  for (const value of Object.keys(OUTPUTS).slice(1)) await t.check(`output ${value} stored`, storedField(c, `Out ${value}`)?.output === value, String(storedField(c, `Out ${value}`)?.output));
  await t.check("the shared component stored, no code of its own", storedField(c, "Shared")?.componentId === ids.components.double && storedField(c, "Shared")?.code === null);
  await t.open(t.itemPath(ids.collections.t, ids.items["t/x"]));
  const field = (n) => t.page.locator(".ws-pane--active .item-fields > *", { hasText: n }).first();
  await t.until("the local component computes", async () => (await field("Computed").innerText()).includes("42") || (await field("Computed").innerText()));
  await t.until("the shared one computes", async () => (await field("Shared").innerText()).includes("42") || (await field("Shared").innerText()));
  await t.audit("item page with component fields");
}, { viewport: "desktop" });

test("AI field: Value AI prompt, prompt, output; fixed once saved", async (t) => {
  await t.boot();
  const spec = targetSpec();
  spec.components.push({ key: "prompt", name: "Short summary", code: "Summarise {{ $item.Name }}.", ai: true, output: "string" });
  const ids = await t.seed(spec);
  await t.open(`/collections/${ids.collections.authors}/edit`);
  const row = await addRow(t, "Summary", "Component");
  await row.getByRole("textbox", { name: "Code" }).fill("{{ $item.Name }}");
  await valueTab(row, "AI prompt").click();
  await t.until("AI prompt is selected", async () => await isOn(valueTab(row, "AI prompt")));
  await t.check("it shows a Prompt, empty (code isn't a prompt)", (await row.getByRole("textbox", { name: "Prompt" }).count()) === 1 && (await row.getByRole("textbox", { name: "Prompt" }).inputValue()) === "");
  await t.check("and the output stays Markdown (an AI output too)", (await row.locator("select").first().inputValue()) === "markdown");
  const offered = (await row.locator("select").first().locator("option").allInnerTexts()).map((s) => s.trim());
  await t.check("an AI field's output is Text, Number or Markdown", JSON.stringify(offered.sort()) === JSON.stringify(["Markdown", "Number", "Text"]), offered.join(" | "));
  await t.check("it says what asking costs", (await row.innerText()).includes("for 3 items now"));
  await t.check("Write with AI is not offered for a prompt", (await row.getByText("Write with AI").count()) === 0);
  await row.locator("select").first().selectOption({ label: "Number" });
  await row.getByRole("textbox", { name: "Prompt" }).fill("How many letters are in {{ $item.Name }}? Only the number.");
  // The shared AI components are offered, plain ones are not.
  await dropdown(t, row, "Prompt").locator(".cds--list-box__field").first().click();
  await t.settle(100);
  const choices = await menuOptions(t);
  await t.check("only AI components are offered", choices.some((c) => c.startsWith("Short summary")) && !choices.some((c) => c.startsWith("Double")), choices.join(" | "));
  await t.page.keyboard.press("Escape");
  await t.audit("an AI field in the editor");
  // Back to Code (a new field): the code written before is there again; to AI prompt: the prompt.
  await valueTab(row, "Code").click();
  await t.until("Code again, with the code written before", async () => (await row.getByRole("textbox", { name: "Code" }).count()) === 1 && (await row.getByRole("textbox", { name: "Code" }).inputValue()) === "{{ $item.Name }}");
  await valueTab(row, "AI prompt").click();
  await t.until("AI prompt again, with its prompt", async () => (await row.getByRole("textbox", { name: "Prompt" }).count()) === 1 && (await row.getByRole("textbox", { name: "Prompt" }).inputValue()).startsWith("How many letters"));
  await saveEditor(t);
  const c = await stored(t, "Author");
  const f = storedField(c, "Summary");
  await t.check("stored as an AI field with its prompt and output", f?.kind === "ai" && f.output === "number" && f.code.startsWith("How many letters"), JSON.stringify(f));
  await t.open(`/collections/${ids.collections.authors}/edit`);
  const saved = rows(t).filter({ has: t.page.locator('input[value="Summary"]') });
  await t.check("the Value switch is fixed once saved", (await valueTab(saved, "Code").isDisabled()) && (await valueTab(saved, "AI prompt").isDisabled()));
  await t.check("and the output: the stored values are in that form", await saved.locator("select").first().isDisabled() && (await saved.locator("select").first().inputValue()) === "number");
  await t.check("the helper says why", (await saved.innerText()).includes("Fixed once saved"));
  await t.check("the prompt can still be edited", await saved.getByRole("textbox", { name: "Prompt" }).isEditable());
  await t.audit("a saved AI field");
}, { viewport: "desktop" });

test("editor validation: empty and duplicate names, the last field, nothing stored", async (t) => {
  await t.boot();
  const ids = await t.seed(targetSpec());
  const before = await t.page.evaluate(async () => (await window.kubus.repo.listCollections()).length);
  await t.open("/collections/new");
  const remove = rows(t).first().getByRole("button", { name: /A collection needs at least one field|Remove field/ });
  await t.until("the only field can't be removed", async () => (await remove.count()) === 1 && (await remove.isDisabled()));
  await addRow(t, "Title", "String");
  await addRow(t, "title ", "Number"); // the same name: case and spaces don't count
  await addRow(t, "", "Date");
  await t.page.getByRole("button", { name: "Create collection" }).click();
  await t.settle();
  const form = t.page.locator(".ws-pane--active .form-page");
  await t.until("the problems are shown", async () => (await t.page.locator(".ws-pane--active .form-page").innerText()).includes("Duplicate field name"));
  const text = await t.page.locator(".ws-pane--active .page-header, .ws-pane--active .form-page").evaluateAll((els) => els.map((e) => e.innerText).join("\n"));
  await t.check("an empty name (the header) is asked for", text.includes("Name is required"));
  await t.check("and the singular name", text.includes("Singular name is required"));
  await t.check("a duplicate field name is named", text.includes("Duplicate field name"), text);
  await t.check("the page stays; nothing was stored", (await onForm(t)) && (await t.page.evaluate(async () => (await window.kubus.repo.listCollections()).length)) === before);
  await t.audit("editor with every problem shown");
  // Fixing each one makes it go.
  await t.page.getByRole("textbox", { name: "Name", exact: true }).first().fill("Notes");
  await t.check("the singular follows the plural", (await t.page.getByRole("textbox", { name: "Singular name" }).inputValue()) === "Note");
  await rows(t).nth(2).getByRole("textbox", { name: "Field name" }).fill("Size");
  await rows(t).nth(3).getByRole("textbox", { name: "Field name" }).fill("Day");
  await t.until("the errors are gone", async () => !(await form.innerText()).match(/is required|Duplicate field name/));
  await saveEditor(t, "Create collection");
  const c = await stored(t, "Note");
  await t.check("saved with its four fields, in order", JSON.stringify(c?.fields.map((f) => f.name)) === JSON.stringify(["Name", "Title", "Size", "Day"]), JSON.stringify(c?.fields.map((f) => f.name)));
  // An existing collection: renaming a field to another's name is refused.
  await t.open(`/collections/${ids.collections.authors}/edit`);
  await addRow(t, "NAME", "String");
  await t.page.getByRole("button", { name: "Save changes" }).click();
  await t.settle();
  await t.check("a new field with an existing name is refused", (await t.page.locator(".ws-pane--active .form-page").innerText()).includes("Duplicate field name"));
  await t.check("and not stored", storedField(await stored(t, "Author"), "NAME") === undefined);
}, { viewport: "desktop" });

for (const vp of ["desktop", "phone"]) {
  test(`field dialog: validation, Cancel, and a field added to the collection @ ${vp}`, async (t) => {
    await t.boot();
    const ids = await t.seed(profileSpec("typical", { items: 3 }));
    const modal = await openFieldDialog(t, ids.collections.books);
    const add = modal.getByRole("button", { name: "Add", exact: true });
    await add.click();
    await t.settle(150);
    await t.check("an empty name is refused, the dialog stays", (await modal.innerText()).includes("Name is required") && (await t.page.locator(".cds--modal.is-visible").count()) === 1);
    await t.audit("field dialog with an empty name");
    await modal.getByRole("textbox", { name: "Name" }).fill("count");
    await add.click();
    await t.settle(150);
    await t.check("a name of another field (any case) is refused", (await modal.innerText()).includes("Another field has this name"));
    await modal.getByRole("textbox", { name: "Name" }).fill("Series");
    await choose(t, modal, "Field type", "Item");
    await add.click();
    await t.settle(150);
    await t.check("a reference without a collection is refused", (await modal.innerText()).includes("Choose a collection"));
    await t.audit("field dialog with a reference problem");
    await choose(t, modal, "Refers to", "Authors");
    await t.check("the problem goes", !(await modal.innerText()).includes("Choose a collection"));
    // The collection is told: adding asks first; No leaves it as it was.
    await add.click();
    const confirm = t.page.locator(".cds--modal.is-visible", { hasText: "Add “Series” to Books?" });
    await t.until("adding asks first", async () => (await confirm.count()) === 1);
    await t.check("it says the field belongs to the collection", (await confirm.innerText()).includes("exists for all its items and views"));
    await t.audit("Add field? confirmation");
    await confirm.getByRole("button", { name: "Cancel" }).click();
    await t.settle(200);
    await t.check("Cancel stores nothing", storedField(await stored(t, "Book"), "Series") === undefined);
    await t.check("the field dialog is still open", (await modal.filter({ hasText: "Series" }).count()) + (await t.page.locator(".cds--modal.is-visible").getByRole("textbox", { name: "Name" }).count()) >= 1);
    await modal.getByRole("button", { name: "Add", exact: true }).click();
    await t.until("asked again", async () => (await t.page.locator(".cds--modal.is-visible", { hasText: "Add “Series” to Books?" }).count()) === 1);
    await t.page.locator(".cds--modal.is-visible", { hasText: "Add “Series” to Books?" }).getByRole("button", { name: "Add field" }).click();
    await t.until("the dialog closes", async () => (await t.page.locator(".cds--modal.is-visible").count()) === 0);
    const field = storedField(await stored(t, "Book"), "Series");
    await t.check("the field is on the collection, an Item field of Authors", field?.kind === "item" && field.targetCollectionId === ids.collections.authors, JSON.stringify(field));
    // Cancel on the field dialog itself.
    const again = await openFieldDialog(t, ids.collections.books);
    await again.getByRole("textbox", { name: "Name" }).fill("Never");
    await again.getByRole("button", { name: "Cancel" }).click();
    await t.until("Cancel closes it", async () => (await t.page.locator(".cds--modal.is-visible").count()) === 0);
    await t.check("and stores nothing", storedField(await stored(t, "Book"), "Never") === undefined);
  }, { viewport: vp, smoke: vp === "desktop" });
}

test("a type changed before saving starts afresh; a saved field's type is fixed", async (t) => {
  await t.boot();
  const ids = await t.seed(targetSpec());
  await t.open("/collections/new");
  await t.page.getByRole("textbox", { name: "Name", exact: true }).first().fill("Drafts");
  const row = await addRow(t, "Shape", "Item");
  await choose(t, row, "Refers to", "Authors");
  await t.check("Item with Authors", (await chosen(t, row, "Refers to")).includes("Authors"));
  await choose(t, row, "Field type", "Checkbox");
  await choose(t, row, "Icon", "Star");
  await row.getByText("Strike through the item when checked").click();
  await t.check("the reference settings are gone, the checkbox's shown", !(await settingsOf(t, row)).refersTo && (await chosen(t, row, "Icon")) === "Star");
  await choose(t, row, "Field type", "Item");
  await t.check("back to Item: no collection chosen again", (await chosen(t, row, "Refers to")) === "Choose…", await chosen(t, row, "Refers to"));
  await choose(t, row, "Field type", "Component");
  await row.getByRole("textbox", { name: "Code" }).fill("{{ $item.Shape }}");
  await choose(t, row, "Field type", "Checklist");
  await t.check("a checklist starts with the box, no strike through", (await chosen(t, row, "Icon")) === "Checkbox" && !(await row.getByRole("checkbox", { name: /Strike through/ }).isChecked()));
  await choose(t, row, "Field type", "Component");
  await t.check("a component starts with empty code", (await row.getByRole("textbox", { name: "Code" }).inputValue()) === "");
  await choose(t, row, "Field type", "Date");
  await t.audit("a field changed to Date");
  await saveEditor(t, "Create collection");
  const f = storedField(await stored(t, "Draft"), "Shape");
  await t.check("only the last type is stored, nothing left over", f?.kind === "date" && f.targetCollectionId === null && f.toggleIcon === null && f.strikeThrough === false && f.code === null && f.componentId === null, JSON.stringify(f));
  // Saved: the type can't change; a field added now still can.
  await t.open(`/collections/${(await stored(t, "Draft")).id}/edit`);
  const saved = rows(t).filter({ has: t.page.locator('input[value="Shape"]') });
  await t.check("a saved field's type is disabled", await dropdown(t, saved, "Field type").locator(".cds--list-box__field").first().isDisabled());
  await t.check("the editor says so", (await t.page.locator(".ws-pane--active .form-page").innerText()).includes("A field's type cannot change once saved."));
  const fresh = await addRow(t, "Fresh", "Number");
  await t.check("a new field's type can be chosen", !(await dropdown(t, fresh, "Field type").locator(".cds--list-box__field").first().isDisabled()));
  await choose(t, fresh, "Field type", "Markdown");
  await t.check("and changed", (await chosen(t, fresh, "Field type")) === "Markdown");
}, { viewport: "desktop" });

test("deleting a field: asked first, its values go from view, the others stay", async (t) => {
  await t.boot();
  const ids = await t.seed(profileSpec("typical", { items: 3 }));
  await t.open(`/collections/${ids.collections.books}/edit`);
  const n = await rows(t).count();
  const notes = rows(t).filter({ has: t.page.locator('input[value="Count"]') });
  await notes.getByRole("button", { name: "Remove field" }).click();
  await t.check("the row goes at once", (await rows(t).count()) === n - 1, `${n} → ${await rows(t).count()}`);
  await t.page.getByRole("button", { name: "Save changes" }).click();
  const dialog = t.page.locator(".cds--modal.is-visible", { hasText: "Remove fields?" });
  await t.until("saving asks first", async () => (await dialog.count()) === 1);
  await t.check("it names the field", (await dialog.innerText()).includes("“Count”"));
  await t.audit("Remove fields? dialog");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await t.settle(200);
  await t.check("Cancel stores nothing, the editor stays", storedField(await stored(t, "Book"), "Count") !== undefined && (await onForm(t)));
  await t.page.getByRole("button", { name: "Save changes" }).click();
  await t.until("asked again", async () => (await dialog.count()) === 1);
  await dialog.getByRole("button", { name: "Remove and save" }).click();
  await t.until("saved", async () => !(await onForm(t)));
  const c = await stored(t, "Book");
  await t.check("the field is gone, the others stay", storedField(c, "Count") === undefined && c.fields.length === n - 1, `${n} rows, ${c.fields.length} stored: ${c.fields.map((f) => f.name)}`);
  await t.until("the table has no Count column", async () => !(await t.page.locator(".ws-pane--active table").first().innerText()).includes("Count"));
  await t.open(t.itemPath(ids.collections.books, ids.items["books/i0"]));
  await t.check("the item page shows the other fields, not Count", !(await t.page.locator(".ws-pane--active .item-fields").innerText()).includes("Count") && (await t.page.locator(".ws-pane--active .item-fields").innerText()).includes("Notes"));
  await t.audit("item page without the removed field");
  // Two at once, then the last one can't go.
  await t.open(`/collections/${ids.collections.authors}/edit`);
  const all = await rows(t).count();
  for (let i = 0; i < all - 1; i++) await rows(t).last().getByRole("button", { name: "Remove field" }).click();
  await t.check("one field is left", (await rows(t).count()) === 1);
  await t.check("and it can't be removed", await rows(t).first().getByRole("button", { name: "A collection needs at least one field" }).isDisabled());
  await t.audit("a collection down to one field");
}, { viewport: "desktop" });

for (const vp of ["desktop", "phone"]) {
  test(`names: plural (the title), singular, description, saved and shown again @ ${vp}`, async (t) => {
    await t.boot();
    await t.open("/collections/new");
    // The header is the (plural) name; the singular follows it until it is typed.
    const plural = t.page.getByRole("textbox", { name: "Name", exact: true }).first();
    const singular = t.page.getByRole("textbox", { name: "Singular name" });
    await plural.fill("Libraries");
    await t.check("the singular is suggested (-ies → -y)", (await singular.inputValue()) === "Library", await singular.inputValue());
    await plural.fill("Boxes");
    await t.check("and follows the plural (-xes → -x)", (await singular.inputValue()) === "Box", await singular.inputValue());
    await t.check("the helper shows how it reads", (await t.page.locator(".ws-pane--active .form-page").innerText()).includes("“New Box”, “This Box”"));
    await singular.fill("Carton");
    await plural.fill("Crates");
    await t.check("typed by hand, the singular stays", (await singular.inputValue()) === "Carton", await singular.inputValue());
    await singular.fill("Crate");
    await t.page.getByRole("textbox", { name: "Description (optional)" }).fill("Things that hold things.\nSecond line.");
    await t.audit("new collection with names and description");
    await saveEditor(t, "Create collection");
    const c = await stored(t, "Crate");
    await t.check("names and description are stored", c?.pluralName === "Crates" && c.description === "Things that hold things.\nSecond line.", JSON.stringify([c?.name, c?.pluralName, c?.description]));
    await t.until("the plural names the page", async () => (await t.page.locator(".ws-pane--active .page-header__title").innerText()).includes("Crates") || (await t.page.locator(".ws-pane--active .page-header__title").innerText()));
    await t.check("the singular names the new-item button", (await t.page.getByRole("button", { name: /^New Crate/ }).count()) + (await t.page.getByRole("link", { name: /^New Crate/ }).count()) >= 1);
    await t.open(`/collections/${c.id}/edit`);
    await t.check("the editor shows them again", (await singular.inputValue()) === "Crate" && (await plural.inputValue()) === "Crates" && (await t.page.getByRole("textbox", { name: "Description (optional)" }).inputValue()).includes("Second line."));
    await plural.fill("Chests");
    await t.check("a saved singular does not follow a new plural", (await singular.inputValue()) === "Crate");
    await plural.fill("");
    await singular.fill("");
    await t.page.getByRole("button", { name: "Save changes" }).click();
    await t.settle();
    const text = await t.page.locator(".ws-pane--active .page-header").innerText();
    await t.check("emptied names are refused", (await onForm(t)) && (await t.page.locator(".ws-pane--active .form-page").innerText()).includes("Singular name is required") && text.includes("Name is required"), text);
    await t.check("and nothing changed", (await stored(t, "Crate"))?.pluralName === "Crates");
    await t.audit("editor with empty names");
    await plural.fill("Chests");
    await singular.fill("Chest");
    await saveEditor(t);
    const edited = await stored(t, "Chest");
    await t.check("renamed, same collection and fields", edited?.id === c.id && edited.pluralName === "Chests" && edited.fields.length === c.fields.length);
    await t.until("the new plural is shown", async () => (await t.page.locator(".ws-pane--active .page-header__title").innerText()).includes("Chests"));
    await t.audit("renamed collection");
  }, { viewport: vp });
}

test("Title: the editor's choices, stored, and what each makes of an item's title", async (t) => {
  await t.boot();
  const spec = { collections: [{ key: "t", name: "Person", plural: "People", fields: [{ key: "name", name: "Name", kind: "string" }, { key: "alias", name: "Alias", kind: "string" }, { key: "age", name: "Age", kind: "number" }, { key: "born", name: "Born", kind: "date" }, { key: "bio", name: "Bio", kind: "markdown" }], items: [{ key: "a", values: { name: "Ada", alias: "Countess", age: 36, born: "1815-12-10" } }, { key: "b", values: { alias: "Bee", age: 5 } }] }] };
  const ids = await t.seed(spec);
  const fieldNames = () => t.page.locator(".ws-pane--active .item-fields .cds--label").allInnerTexts().then((l) => l.map((s) => s.replace(/^(Collapse|Expand)/, "").trim()));
  const title = async () => (await t.page.locator(".ws-pane--active .page-header__title").first().innerText()).trim();
  await t.open(t.itemPath(ids.collections.t, ids.items["t/a"]));
  await t.check("by default the first text field with a value is the title", (await title()) === "Ada");
  let names = await fieldNames();
  await t.check("it isn't repeated among the fields", !names.some((n) => n.startsWith("Name")) && names.some((n) => n.startsWith("Alias")), names.join(" | "));
  await t.audit("item with its automatic title");
  await t.open(t.itemPath(ids.collections.t, ids.items["t/b"]));
  await t.check("with Name empty the next text field is the title", (await title()) === "Bee");
  // The editor's Title menu: automatic, the text, number and date fields, none.
  await t.open(`/collections/${ids.collections.t}/edit`);
  await t.check("the editor starts on the automatic choice", (await chosen(t, t.page.locator(".ws-pane--active"), "Title")) === "The first text field with a value", await chosen(t, t.page.locator(".ws-pane--active"), "Title"));
  await dropdown(t, t.page.locator(".ws-pane--active"), "Title").locator(".cds--list-box__field").first().click();
  await t.settle(100);
  const options = await menuOptions(t);
  await t.check("it offers automatic, the string, number and date fields (not Markdown), and none", JSON.stringify(options) === JSON.stringify(["The first text field with a value", "Name", "Alias", "Age", "Born", "No title"]), options.join(" | "));
  await t.audit("Title menu open");
  await t.page.keyboard.press("Escape");
  await t.settle(80);
  const setTitle = async (option) => {
    await t.open(`/collections/${ids.collections.t}/edit`);
    await choose(t, t.page.locator(".ws-pane--active"), "Title", option);
    await saveEditor(t);
  };
  await setTitle("Alias");
  const person = await stored(t, "Person");
  await t.check("Alias is stored as the title field", person.titleField === storedField(person, "Alias").id, String(person.titleField));
  await t.open(t.itemPath(ids.collections.t, ids.items["t/a"]));
  await t.check("the title is Alias, not Name", (await title()) === "Countess", await title());
  names = await fieldNames();
  await t.check("Name is a field now, Alias isn't repeated", names.some((n) => n.startsWith("Name")) && !names.some((n) => n.startsWith("Alias")), names.join(" | "));
  await t.open(t.listPath(ids.collections.t));
  const table = await t.page.locator(".ws-pane--active table").first().innerText();
  await t.check("the table links its items by Alias", table.includes("Countess") && table.includes("Bee"), table.slice(0, 200));
  await setTitle("Age");
  await t.open(t.itemPath(ids.collections.t, ids.items["t/a"]));
  await t.check("a number can be the title", (await title()) === "36", await title());
  await setTitle("No title");
  await t.check("none is stored", (await stored(t, "Person")).titleField === "none");
  await t.open(t.itemPath(ids.collections.t, ids.items["t/a"]));
  await t.check("the item is called by the collection's name", (await title()).includes("Person"), await title());
  await t.audit("item without a title");
  await t.open(`/collections/${ids.collections.t}/edit`);
  await t.check("the editor shows the choice again", (await chosen(t, t.page.locator(".ws-pane--active"), "Title")) === "No title");
  await setTitle("The first text field with a value");
  await t.check("automatic is stored as no choice", !(await stored(t, "Person")).titleField);
}, { viewport: "desktop" });

for (const vp of ["desktop", "phone"]) {
  test(`List of items, edited in an item: add, choose, remove, a choice filter @ ${vp}`, async (t) => {
    await t.boot();
    const spec = targetSpec();
    spec.collections[0].items.push({ key: "d", values: { name: "Zadie" } });
    spec.collections.push({
      key: "books", name: "Book", plural: "Books",
      fields: [
        { key: "title", name: "Title", kind: "string" },
        { key: "authors", name: "Authors", kind: "item_list", target: "authors" },
        { key: "picky", name: "Picky", kind: "item_list", target: "authors", choiceFilter: [{ field: "name", operator: "contains", value: "ula" }] },
        { key: "one", name: "Main", kind: "item", target: "authors" },
      ],
      items: [{ key: "x", values: { title: "Dawn", authors: { refs: ["authors/a", "authors/b"] } } }],
    });
    const ids = await t.seed(spec);
    const authorId = (k) => ids.items[`authors/${k}`];
    const book = () => storedValues(t, ids.collections.books, ids.items["books/x"]);
    await t.open(t.itemPath(ids.collections.books, ids.items["books/x"]));
    const field = t.page.locator(".ws-pane--active .item-fields > *", { hasText: "Authors" }).first();
    await t.check("the list shows its two items by their names", (await field.innerText()).includes("Ursula") && (await field.innerText()).includes("Octavia"), await field.innerText());
    await t.audit("item with a list of items");
    // A row is a button: clicking beside its link edits that row alone, as a combo box; choosing saves.
    const combos = () => field.getByRole("combobox");
    const editRow = async (loc, n) => {
      await loc.getByRole("button", { name: `Edit Authors ${n}` }).first().click({ position: { x: 160, y: 8 } });
      await t.until(`row ${n} is a combo box`, async () => (await combos().count()) === 1);
    };
    await editRow(field, 1);
    await t.check("the combo box holds that item", (await combos().first().inputValue()) === "Ursula", await combos().first().inputValue());
    await t.audit("editing one row of a list of items");
    await combos().first().click();
    await t.settle(100);
    const options = await menuOptions(t);
    await t.check("it offers the authors", options.includes("Zadie") && options.includes("Stanislaw"), options.join(" | "));
    await t.page.getByRole("option", { name: "Zadie", exact: true }).filter({ visible: true }).first().click();
    await t.until("choosing replaces that item, in place", async () => JSON.stringify((await book()).Authors) === JSON.stringify([authorId("d"), authorId("b")]) || JSON.stringify((await book()).Authors));
    await t.until("the row shows the new name, the editor closed", async () => (await combos().count()) === 0 && (await field.innerText()).includes("Zadie") && !(await field.innerText()).includes("Ursula"));
    // Add item: an empty row to choose from; the chosen one is added.
    await field.getByRole("button", { name: "Add item" }).click();
    await t.until("Add item adds a row with an empty combo box", async () => (await combos().count()) === 1 && (await combos().first().inputValue()) === "");
    await t.check("its placeholder asks for an Author", (await combos().first().getAttribute("placeholder")) === "Choose Author", String(await combos().first().getAttribute("placeholder")));
    await combos().first().click();
    await t.settle(100);
    await t.page.getByRole("option", { name: "Stanislaw", exact: true }).filter({ visible: true }).first().click();
    await t.until("the chosen item is added at the end", async () => JSON.stringify((await book()).Authors) === JSON.stringify([authorId("d"), authorId("b"), authorId("c")]) || JSON.stringify((await book()).Authors));
    await t.audit("list of items after adding");
    // An added row left empty goes again, nothing stored.
    await field.getByRole("button", { name: "Add item" }).click();
    await t.until("an empty row is open", async () => (await combos().count()) === 1);
    const body = await t.page.locator(".ws-pane--active .ws-pane__body").boundingBox();
    await t.page.mouse.click(body.x + body.width - 6, body.y + Math.min(body.height - 10, 140));
    await t.settle(250);
    await t.check("stored list unchanged", JSON.stringify((await book()).Authors) === JSON.stringify([authorId("d"), authorId("b"), authorId("c")]));
    // Remove item takes a row out at once.
    await field.getByRole("button", { name: "Remove item" }).first().click();
    await t.until("Remove item removes the first, and stores", async () => JSON.stringify((await book()).Authors) === JSON.stringify([authorId("b"), authorId("c")]) || JSON.stringify((await book()).Authors));
    await t.until("and shows it", async () => !(await field.innerText()).includes("Zadie"));
    await field.getByRole("button", { name: "Remove item" }).first().click();
    await t.settle(150);
    await field.getByRole("button", { name: "Remove item" }).first().click();
    await t.until("an emptied list is stored as no value", async () => (await book()).Authors === null || JSON.stringify((await book()).Authors));
    await t.audit("an emptied list of items");
    // A choice filter limits what a row offers: only authors containing "ula".
    const picky = t.page.locator(".ws-pane--active .item-fields > *", { hasText: "Picky" }).first();
    await picky.scrollIntoViewIfNeeded();
    await picky.getByRole("button", { name: "Add item" }).click();
    await t.until("a combo box opens", async () => (await picky.getByRole("combobox").count()) === 1);
    await picky.getByRole("combobox").first().click();
    await t.settle(100);
    const filtered = await menuOptions(t);
    await t.check("a choice filter offers only the matching authors", JSON.stringify([...filtered].sort()) === JSON.stringify(["Ursula"]), filtered.join(" | "));
    await t.page.getByRole("option", { name: "Ursula", exact: true }).filter({ visible: true }).first().click();
    await t.until("the filtered choice is stored", async () => JSON.stringify((await book()).Picky) === JSON.stringify([authorId("a")]) || JSON.stringify((await book()).Picky));
    await t.audit("list of items with a choice filter");
    // Reload: everything is still there.
    await t.open(t.itemPath(ids.collections.books, ids.items["books/x"]));
    await t.check("after a reload the filtered list shows Ursula", (await t.page.locator(".ws-pane--active .item-fields > *", { hasText: "Picky" }).first().innerText()).includes("Ursula"));
  }, { viewport: vp });
}
