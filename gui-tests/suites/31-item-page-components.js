// The item page's own controls and the components pages, each asserted by its result (what is
// shown, what the repository stores, what survives opening the page again): the Details and Page
// layout popovers, item views (add, save, discard, delete), a block whose collection is gone, an AI
// field's Generate again; the New item form; the Components list and its Show filter, creating,
// editing and deleting a component, every Output, the preview (item, grouped by) and AI "Try" against
// a fake model; saving a local component as shared; code errors.

const LLM = "https://llm.test/v1";
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET, POST, OPTIONS" };
const AI_PREFS = { "kubus.ai": { baseUrl: LLM, apiKey: "test-key", fieldModel: "fake-model", codeModel: "", paused: false } };

/** Serves a fake OpenAI-style model on a made-up address; `fake.answer(body, n)` gives the reply (a string, or { status, message }). */
async function fakeModel(t, answer) {
  const fake = { calls: [], answer };
  await t.page.route(`${LLM}/**`, async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    if (req.url().endsWith("/models")) return route.fulfill({ status: 200, headers: CORS, json: { data: [{ id: "fake-model" }] } });
    let body = {};
    try {
      body = JSON.parse(req.postData() || "{}");
    } catch {}
    fake.calls.push(body);
    const r = await fake.answer(body, fake.calls.length);
    if (r && typeof r === "object") return route.fulfill({ status: r.status, headers: CORS, json: { error: { message: r.message || "error" } } });
    return route.fulfill({ status: 200, headers: CORS, json: { choices: [{ message: { content: r } }] } });
  });
  return fake;
}
const promptOf = (body) => (body.messages || []).map((m) => m.content).join("\n");

/** The collection as stored now (fields, item views). */
const storedCollection = (t, id) => t.page.evaluate(async (id) => (await window.kubus.repo.listCollections()).find((c) => c.id === id), id);
/** An item view as stored: { name, layout, … }. */
const storedView = async (t, collectionId, index = 0) => (await storedCollection(t, collectionId)).itemViews[index];
/** The item as stored now. */
const storedItem = (t, collectionId, itemId) =>
  t.page.evaluate(async ([cid, iid]) => {
    const repo = window.kubus.repo;
    const c = (await repo.listCollections()).find((x) => x.id === cid);
    return await repo.getItem(c, iid);
  }, [collectionId, itemId]);
const storedComponents = (t) => t.page.evaluate(() => window.kubus.repo.listComponents());
const fieldsText = (t) => t.page.locator(".ws-pane--active .item-fields").innerText();
/** The open toolbar popover's panel. */
const panelOf = (t) => t.page.locator(".toolbar-popover.cds--popover--open");
/** A field's id by name. */
const fieldId = (collection, name) => collection.fields.find((f) => f.name === name).id;

/** Clicks a button of the page header (or of the views bar), through the "⋮" menu when it is folded into one. */
async function clickBar(t, label, scope = ".page-header") {
  const bar = t.page.locator(`.ws-pane--active ${scope}`).first();
  let btn = bar.getByRole("button", { name: label, exact: true }).filter({ visible: true }).first();
  if (!(await btn.count())) {
    await bar.getByRole("button", { name: "More actions" }).filter({ visible: true }).first().click();
    await t.settle(100);
    btn = bar.getByRole("button", { name: label, exact: true }).filter({ visible: true }).first();
  }
  await btn.click();
  await t.settle(150);
}

// ---- the item page: Details --------------------------------------------------------------

for (const vp of ["desktop"]) {
  test(`Details: collection, space, created and updated; moving it to a space @ ${vp}`, async (t) => {
    await t.boot();
    const spec = profileSpec("typical", { items: 2 });
    spec.spaces = [{ key: "w", name: "Work" }];
    const ids = await t.seed(spec);
    const coll = ids.collections.books;
    const item = ids.items["books/i0"];
    await t.open(t.itemPath(coll, item));
    await t.openPanel(t.page.locator(".ws-pane--active .page-header"), "Details");
    const info = panelOf(t).locator("dl.item-info");
    const labels = await info.locator("dt").allInnerTexts();
    await t.check("Details lists Collection, Space, Created and Updated", labels.join(",") === "Collection,Space,Created,Updated", labels.join(","));
    await t.check("the collection is named (singular)", (await info.locator("dd").first().innerText()).trim() === "Book");
    const stored = await storedItem(t, coll, item);
    const year = String(new Date(stored.createdAt).getFullYear());
    const dds = await info.locator("dd").allInnerTexts();
    await t.check("Created and Updated show the stored dates", dds[2].includes(year) && dds[3].includes(year), JSON.stringify(dds));
    await t.audit("Details popover with two spaces");
    // Moving it: the stored item changes space; the page stays open.
    const space = info.locator(".cds--dropdown button").first();
    await t.popoverStep("open the space dropdown", () => space.click(), { target: space });
    await t.page.getByRole("option", { name: /Work/ }).click();
    await t.until("the item is stored in the other space", async () => (await storedItem(t, coll, item)).spaceId === ids.spaces.w);
    await t.check("the page stays open", (await t.page.locator(".ws-pane--active .item-title").count()) > 0);
    await t.escapeCloses("Escape closes Details");
    // An edit changes Updated, not Created.
    await t.page.getByRole("button", { name: "Edit Count", exact: true }).click();
    await t.editorReady();
    await t.page.keyboard.press("Control+A");
    await t.page.keyboard.type("777");
    await t.page.keyboard.press("Enter");
    const countId = fieldId(await storedCollection(t, coll), "Count");
    await t.until("the edit is stored", async () => (await storedItem(t, coll, item)).values[countId] === 777);
    const after = await storedItem(t, coll, item);
    await t.check("Updated moved on, Created did not", after.updatedAt > stored.updatedAt && after.createdAt === stored.createdAt, `${stored.updatedAt} → ${after.updatedAt}`);
    await t.openPanel(t.page.locator(".ws-pane--active .page-header"), "Details");
    await t.audit("Details after an edit");
  }, { viewport: vp });
}

test("Details with one space has no Space row", async (t) => {
  await t.boot();
  const ids = await t.seed(profileSpec("typical", { items: 1 }));
  await t.open(t.itemPath(ids.collections.books, ids.items["books/i0"]));
  await t.openPanel(t.page.locator(".ws-pane--active .page-header"), "Details");
  const labels = await panelOf(t).locator("dl.item-info dt").allInnerTexts();
  await t.check("only Collection, Created and Updated", labels.join(",") === "Collection,Created,Updated", labels.join(","));
  await t.audit("Details popover");
});

// ---- the item page: Page layout ----------------------------------------------------------

for (const vp of ["desktop", "phone"]) {
  test(`Page layout: View name, Fields are editable, Hide empty fields, Fields; stored and kept after a reload @ ${vp}`, async (t) => {
    await t.boot();
    const spec = profileSpec("typical", { items: 2 });
    const books = spec.collections[0];
    books.items.push({ key: "sparse", values: { title: "Sparse book", count: 5 } });
    books.itemViews = [{ name: "Main" }, { name: "Other" }];
    const ids = await t.seed(spec);
    const coll = ids.collections.books;
    const path = t.itemPath(coll, ids.items["books/sparse"]);
    const collection = await storedCollection(t, coll);
    const header = t.page.locator(".ws-pane--active .page-header");
    await t.open(path);
    await t.until("Notes (empty) is listed among the fields", async () => (await fieldsText(t)).includes("Notes"));
    await t.openPanel(header, "Page layout");
    const panel = panelOf(t);
    await t.audit("Page layout popover");
    await t.check("it has View name and both checkboxes", (await panel.getByRole("textbox", { name: "View name" }).inputValue()) === "Main" && (await panel.getByRole("checkbox", { name: "Fields are editable" }).isChecked()) && !(await panel.getByRole("checkbox", { name: "Hide empty fields" }).isChecked()));

    // View name: Enter stores it; the tab shows it; an empty name changes nothing.
    const name = panel.getByRole("textbox", { name: "View name" });
    await name.fill("Renamed view");
    await name.press("Enter");
    await t.until("the view is stored under its new name", async () => (await storedView(t, coll)).name === "Renamed view");
    await t.check("its tab shows the new name", (await t.page.getByRole("tab", { name: "Renamed view" }).count()) === 1);
    await panel.getByRole("textbox", { name: "View name" }).fill("");
    await panel.getByRole("checkbox", { name: "Hide empty fields" }).focus();
    await t.settle();
    await t.check("an empty name is not stored", (await storedView(t, coll)).name === "Renamed view");

    // Hide empty fields: the empty ones go from the page, in the stored layout too; unticked, they return.
    const hideEmpty = panel.getByRole("checkbox", { name: "Hide empty fields" });
    await t.popoverStep("tick Hide empty fields", () => hideEmpty.click({ force: true }), { target: hideEmpty, scope: ".ws-pane--active .page-header" });
    await t.until("empty fields are hidden, filled ones stay", async () => {
      const text = await fieldsText(t);
      return (!text.includes("Notes") && !text.includes("Snippet") && text.includes("Count")) || text.slice(0, 200);
    });
    await t.check("hideEmpty is stored", (await storedView(t, coll)).layout.hideEmpty === true);
    await t.audit("page with empty fields hidden");
    await t.popoverStep("untick Hide empty fields", () => hideEmpty.click({ force: true }), { target: hideEmpty, scope: ".ws-pane--active .page-header" });
    await t.until("empty fields are back", async () => (await fieldsText(t)).includes("Notes"));
    await t.check("hideEmpty is stored off", (await storedView(t, coll)).layout.hideEmpty === false);

    // Fields: untick Count (gone from the page and the stored order), tick it again, hide its name.
    const count = panel.getByRole("checkbox", { name: "Count", exact: true });
    await t.popoverStep("untick the Count field", () => count.click({ force: true }), { target: count, scope: ".ws-pane--active .page-header" });
    await t.until("Count leaves the page", async () => !(await fieldsText(t)).includes("Count"));
    const stored = (await storedView(t, coll)).layout.fields;
    await t.check("the stored fields exclude Count and keep the others", Array.isArray(stored) && !stored.includes(fieldId(collection, "Count")) && stored.includes(fieldId(collection, "Notes")), JSON.stringify(stored));
    await t.popoverStep("tick the Count field", () => count.click({ force: true }), { target: count, scope: ".ws-pane--active .page-header" });
    await t.until("Count is back", async () => (await fieldsText(t)).includes("Count"));
    const hideName = panel.locator(".field-order__row", { hasText: "Count" }).first().getByRole("button", { name: "Hide field name" });
    await t.popoverStep("hide the field name", () => hideName.click(), { target: hideName, scope: ".ws-pane--active .page-header" });
    await t.until("the value shows without its name", async () => {
      const text = await fieldsText(t);
      return (text.includes("5") && !text.includes("Count")) || text.slice(0, 200);
    });
    await t.check("hiddenLabels is stored", (await storedView(t, coll)).layout.hiddenLabels.includes(fieldId(collection, "Count")));
    await t.audit("page layout popover after changes");

    // Fields are editable off: no editing in place; the edit icon makes all fields editable for now.
    const editable = panel.getByRole("checkbox", { name: "Fields are editable" });
    await t.check("fields are editable to begin with", (await t.page.getByRole("button", { name: "Edit Notes", exact: true }).count()) === 1);
    await t.popoverStep("untick Fields are editable", () => editable.click({ force: true }), { target: editable });
    await t.until("nothing can be edited in place", async () => (await t.page.locator(".ws-pane--active [aria-label^='Edit ']").count()) === 0);
    await t.check("editable is stored off", (await storedView(t, coll)).layout.editable === false);
    await t.closeAll();
    await t.audit("read-only page layout");
    await clickBar(t, "Show all fields, editable");
    await t.until("the edit icon makes everything editable for now", async () => (await t.page.getByRole("button", { name: "Edit Notes", exact: true }).count()) === 1);
    await t.check("…without storing it", (await storedView(t, coll)).layout.editable === false);
    await clickBar(t, "Back to this page's layout");
    await t.until("back to the page's layout", async () => (await t.page.getByRole("button", { name: "Edit Notes", exact: true }).count()) === 0);

    // Kept after a reload; the other view keeps its own.
    await t.open(path);
    await t.until("the view and its layout are as stored", async () => (await t.page.getByRole("tab", { name: "Renamed view" }).count()) === 1 && (await t.page.getByRole("button", { name: "Edit Notes", exact: true }).count()) === 0);
    await t.check("Count's name is still hidden after the reload", !(await fieldsText(t)).includes("Count"));
    await t.page.getByRole("tab", { name: "Other" }).click();
    await t.until("the other view is untouched: editable, names shown", async () => (await t.page.getByRole("button", { name: "Edit Notes", exact: true }).count()) === 1 && (await fieldsText(t)).includes("Count"));
    await t.audit("the other item view");
  }, { viewport: vp, smoke: vp === "desktop" });
}

/** Whether a bar has a button, also one folded into its "⋮" menu (the menu is closed again). */
async function barHas(t, label, scope = ".page-header") {
  const bar = t.page.locator(`.ws-pane--active ${scope}`).first();
  const find = () => bar.getByRole("button", { name: label, exact: true }).filter({ visible: true }).count();
  if (await find()) return true;
  const more = bar.getByRole("button", { name: "More actions" }).filter({ visible: true }).first();
  if (!(await more.count())) return false;
  await more.click();
  await t.settle(100);
  const found = (await find()) > 0;
  await t.page.keyboard.press("Escape");
  await t.settle(100);
  return found;
}

// ---- item views: add, save, discard, delete ------------------------------------------------

/** Clicks a block's tool (a button of its section header, or in its "More actions"). */
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

/** Books with one item view holding a table block of the authors. */
function itemViewSpec() {
  const spec = profileSpec("typical", { items: 2, authors: 3 });
  spec.collections[0].itemViews = [{ name: "Main", layout: { fields: ["title", "count", "authorsBlock"], blocks: [{ id: "authorsBlock", kind: "table", collection: "authors", title: "Authors here" }] } }];
  return spec;
}

for (const vp of ["desktop", "phone"]) {
  test(`item views: add, unsaved block changes, discard, save, delete @ ${vp}`, async (t) => {
    await t.boot();
    const ids = await t.seed(itemViewSpec());
    const coll = ids.collections.books;
    const path = t.itemPath(coll, ids.items["books/i0"]);
    const authors = await storedCollection(t, ids.collections.authors);
    const bio = fieldId(authors, "Bio");
    await t.open(path);
    const block = t.page.locator(".ws-pane--active [data-block-id]").first();
    const tabNames = async () => (await t.page.locator(".ws-pane--active .views-bar .views-tabs [role=tab]").allInnerTexts()).map((s) => s.trim());
    await t.until("the block lists the authors, Bio column included", async () => /Bio/.test(await block.innerText().catch(() => "")));
    await t.check("one view: no Delete view", !(await barHas(t, "Delete view", ".views-bar")));
    await t.audit("item page with one view");

    // "+": a copy of what is shown, named New, opens Page layout with its name selected.
    await clickBar(t, "Add view", ".views-bar");
    await t.until("a view named New is added and shown", async () => (await tabNames()).join("|") === "Main|New");
    await t.until("Page layout opens on its name, selected", async () => {
      const f = await t.page.evaluate(() => ({ id: document.activeElement?.id || "", sel: document.activeElement?.selectionEnd - document.activeElement?.selectionStart, val: document.activeElement?.value }));
      return (f.id.endsWith("item-layout-name") && f.val === "New" && f.sel === 3) || JSON.stringify(f);
    });
    await t.check("the new view keeps the block", (await storedView(t, coll, 1)).layout.blocks.length === 1);
    await t.page.keyboard.type("Second");
    await t.page.keyboard.press("Enter");
    await t.until("renamed: stored and in its tab", async () => (await storedView(t, coll, 1)).name === "Second" && (await tabNames()).join("|") === "Main|Second");
    await t.closeAll();
    await t.check("two views: Delete view is there", await barHas(t, "Delete view", ".views-bar"));
    await t.audit("item page with two views");

    // A block's Fields: unticking Bio changes only the draft ("*" on the tab, Discard / Save changes).
    const second = () => storedView(t, coll, 1);
    const untickBio = async () => {
      await blockTool(t, block.locator(".section-header").first(), "Fields");
      await panelOf(t).getByRole("checkbox", { name: "Bio", exact: true }).click({ force: true });
      await t.closeAll();
    };
    await untickBio();
    await t.until("Bio leaves the block", async () => !/Bio/.test(await block.innerText()));
    await t.until("the tab is marked unsaved and Discard / Save changes appear", async () => (await tabNames()).includes("Second *") && (await t.page.getByRole("button", { name: "Discard changes" }).count()) === 1 && (await t.page.getByRole("button", { name: "Save changes to view" }).count()) === 1);
    await t.check("nothing is stored yet", (await second()).layout.blocks[0].layout.fields === null);
    await t.audit("unsaved block change");
    await clickBar(t, "Discard changes", ".views-bar");
    await t.until("Discard brings Bio back, the marks go", async () => /Bio/.test(await block.innerText()) && (await tabNames()).join("|") === "Main|Second" && (await t.page.getByRole("button", { name: "Save changes to view" }).count()) === 0);
    // Switching views discards a draft too.
    await untickBio();
    await t.until("unsaved again", async () => (await tabNames()).includes("Second *"));
    await t.page.getByRole("tab", { name: "Main" }).click();
    await t.page.getByRole("tab", { name: "Second" }).click();
    await t.until("the draft went with the switch", async () => /Bio/.test(await block.innerText()) && (await tabNames()).join("|") === "Main|Second");
    // Save changes to view.
    await untickBio();
    await t.until("unsaved once more", async () => (await tabNames()).includes("Second *"));
    await clickBar(t, "Save changes to view", ".views-bar");
    await t.until("saved: the stored block shows its fields without Bio", async () => {
      const f = (await second()).layout.blocks[0].layout.fields;
      return (Array.isArray(f) && !f.includes(bio) && f.length > 0) || JSON.stringify(f);
    });
    await t.check("the marks are gone and Bio stays out", (await tabNames()).join("|") === "Main|Second" && !/Bio/.test(await block.innerText()));
    await t.check("the first view's block is unchanged", (await storedView(t, coll, 0)).layout.blocks[0].layout.fields === null);
    await t.open(path);
    await t.page.getByRole("tab", { name: "Second" }).click();
    await t.until("after a reload the saved view still lacks Bio", async () => (await block.count()) === 1 && /Name/.test(await block.innerText()) && !/Bio/.test(await block.innerText()));

    // Delete view: asks first; Cancel keeps it, Delete removes it and shows the other.
    await clickBar(t, "Delete view", ".views-bar");
    const modal = t.page.locator(".cds--modal.is-visible");
    await t.until("deleting asks first", async () => (await modal.innerText().catch(() => "")).includes("Delete view “Second”?"));
    await t.audit("delete view dialog");
    await modal.getByRole("button", { name: "Cancel" }).click();
    await t.until("Cancel closes the dialog", async () => (await t.count(".cds--modal.is-visible")) === 0);
    await t.check("…and keeps the view", (await t.page.getByRole("tab", { name: "Second" }).count()) === 1 && (await storedCollection(t, coll)).itemViews.length === 2);
    await clickBar(t, "Delete view", ".views-bar");
    await t.until("the dialog is back", async () => (await modal.count()) === 1);
    await modal.getByRole("button", { name: /^Delete/ }).click();
    await t.until("the view is deleted and the other shown", async () => (await storedCollection(t, coll)).itemViews.length === 1 && (await tabNames()).join("|") === "Main");
    await t.check("with one view left the Delete button is gone again", !(await barHas(t, "Delete view", ".views-bar")));
    await t.audit("after deleting the view");
  }, { viewport: vp, smoke: vp === "desktop" });
}

test("a block whose collection was deleted shows a warning; closing it removes the block", async (t) => {
  await t.boot();
  const spec = itemViewSpec();
  spec.collections.push({ key: "shelf", name: "Shelf", plural: "Shelves", fields: [{ key: "name", name: "Name", kind: "string" }], items: [{ values: { name: "Top shelf" } }] });
  spec.collections[0].itemViews[0].layout.blocks[0].collection = "shelf";
  const ids = await t.seed(spec);
  const coll = ids.collections.books;
  await t.open(t.itemPath(coll, ids.items["books/i0"]));
  const block = t.page.locator(".ws-pane--active [data-block-id]").first();
  await t.until("the block lists the shelves", async () => /Top shelf/.test(await block.innerText().catch(() => "")));
  // Deleted while the page is open (another pane, a sync).
  await t.page.evaluate((id) => window.kubus.repo.deleteCollection(id), ids.collections.shelf);
  const warning = t.page.locator(".ws-pane--active .cds--inline-notification--warning");
  await t.until("a warning replaces the block", async () => (await warning.count()) === 1 && (await warning.innerText()).includes("Block without collection") && (await warning.innerText()).includes("The collection this block listed was deleted."), { timeout: 8000 });
  await t.check("the stored view still has the block (nothing is removed by itself)", (await storedView(t, coll)).layout.blocks.length === 1);
  await t.audit("block without collection");
  await warning.getByRole("button", { name: /close/i }).click();
  const modal = t.page.locator(".cds--modal.is-visible");
  await t.until("closing it asks before removing the block", async () => (await modal.innerText().catch(() => "")).includes("Remove block"));
  await t.audit("remove block dialog");
  await modal.getByRole("button", { name: "Delete", exact: true }).click();
  await t.until("the block is gone from the page and the stored layout", async () => (await warning.count()) === 0 && (await storedView(t, coll)).layout.blocks.length === 0);
  await t.audit("after removing the block");
});

// ---- an AI field's Generate again --------------------------------------------------------

test("Generate again without a nudge: when it was made, Generate and Ctrl+Enter, the nudge is not kept", async (t) => {
  await t.boot();
  const fake = await fakeModel(t, (body, n) => `Reply number ${n}`);
  const spec = profileSpec("typical", { items: 1, ai: true });
  spec.prefs = AI_PREFS;
  const ids = await t.seed(spec);
  await t.open(t.itemPath(ids.collections.books, ids.items["books/i0"]));
  const row = t.page.locator(".ws-pane--active .item-fields > *", { hasText: "Summary" }).first();
  const value = async () => await row.innerText();
  await t.until("the first value is made", async () => /Reply number 1/.test(await value()), { timeout: 15000 });
  await t.openPanel(row, "Generate again");
  const panel = panelOf(t);
  await t.check("the panel says when it was last generated", /Last generated/.test(await panel.innerText()), await panel.innerText());
  // Generate, empty nudge: a request without a nudge, the value replaced.
  const before = fake.calls.length;
  await panel.getByRole("button", { name: "Generate", exact: true }).click();
  await t.until("a new request replaces the value", async () => fake.calls.length === before + 1 && /Reply number 2/.test(await value()), { timeout: 10000 });
  await t.check("the request has no nudge", !/nudge/i.test(promptOf(fake.calls[fake.calls.length - 1])), promptOf(fake.calls[fake.calls.length - 1]).slice(-200));
  // Ctrl+Enter in the nudge box generates with the nudge; once only.
  await t.openPanel(row, "Generate again");
  const nudge = panelOf(t).getByRole("textbox", { name: /Nudge/ });
  await nudge.fill("the paperback edition");
  await nudge.press("Control+Enter");
  await t.until("Ctrl+Enter generates with the nudge", async () => fake.calls.length === before + 2 && /Reply number 3/.test(await value()) && promptOf(fake.calls[fake.calls.length - 1]).includes("the paperback edition"), { timeout: 10000 });
  await t.openPanel(row, "Generate again");
  await t.check("the nudge is not kept for next time", (await panelOf(t).getByRole("textbox", { name: /Nudge/ }).inputValue()) === "");
  await t.audit("Generate again, reopened");
  await t.escapeCloses("Escape closes Generate again");
});

// ---- the New item form ---------------------------------------------------------------------

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

for (const vp of ["desktop", "phone"]) {
  test(`New item: the empty form's defaults, errors, every kind stored, Cancel @ ${vp}`, async (t) => {
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
  }, { viewport: vp, smoke: vp === "desktop" });
}

test("New item: only computed fields means nothing to enter; an unknown collection is not found", async (t) => {
  await t.boot();
  const ids = await t.seed({ collections: [{ key: "calc", name: "Sum", plural: "Sums", fields: [{ key: "c", name: "Twice", kind: "component", code: "{{ $item.Title }}" }], items: [] }] });
  await t.open(`/collections/${ids.collections.calc}/items/new`);
  await t.until("the form has no inputs, only Create", async () => (await t.page.locator(".ws-pane--active .item-fields--form").count()) === 1 && (await t.page.locator(".ws-pane--active .item-fields--form input, .ws-pane--active .item-fields--form textarea").count()) === 0);
  await t.audit("new item form without inputs");
  await t.page.getByRole("button", { name: "Create Sum" }).click();
  await t.until("Create makes an empty item", async () => (await t.page.evaluate(async (id) => {
    const repo = window.kubus.repo;
    const c = (await repo.listCollections()).find((x) => x.id === id);
    return (await repo.listItems(c, "default")).length;
  }, ids.collections.calc)) === 1);
  await t.open("/collections/00000000-0000-4000-8000-000000000000/items/new");
  await t.until("an unknown collection is not found", async () => /not found/i.test(await t.page.locator(".ws-pane--active").innerText()));
  await t.audit("new item form of an unknown collection");
});

// ---- the Components page and editor ---------------------------------------------------------

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
const cellsOf = async (r) => (await r.locator("td").allInnerTexts()).map((s) => s.trim());
/** The pane's current path through the page's own address, for "where am I". */
const hereTitle = async (t) => (await t.page.locator(".ws-pane--active .page-header__title").innerText().catch(() => "")).trim();

for (const vp of ["desktop"]) {
  test(`Components list: kinds, where, duplicate, open @ ${vp}`, async (t) => {
    await t.boot();
    const ids = await t.seed(componentsSpec());
    await t.open("/components");
    await t.audit("components list");
    const kinds = { "Field one": "Field", "Block one": "Block", "Static one": "Static", "Mixed one": "Mixed: fix it", "Prompt one": "AI field" };
    for (const [name, kind] of Object.entries(kinds)) {
      const cells = await cellsOf(row(t, name));
      await t.check(`${name}: kind ${kind}, shared`, cells[1] === kind && cells[2] === "Shared", JSON.stringify(cells));
    }
    const field1 = await cellsOf(row(t, "Field one"));
    await t.check("description and the code's first line are listed", field1[3] === "Shows the title" && field1[4].includes("$item.Title"), JSON.stringify(field1));
    // Sorting by Name reverses on a second click.
    const names = async () => (await t.page.locator(".ws-pane--active tbody tr td:first-child").allInnerTexts()).map((s) => s.trim());
    const header = t.page.locator(".ws-pane--active thead").getByRole("button", { name: /^Name/ });
    await header.click();
    const first = await names();
    await header.click();
    const second = await names();
    await t.check("sorting by Name flips the order", first.join("|") !== second.join("|") && first.slice().reverse().join("|") === second.join("|"), `${first[0]} / ${second[0]}`);
    // Duplicate: "Name 2", the same component.
    await row(t, "Static one").getByRole("button", { name: "Duplicate Static one" }).click({ force: true });
    await t.until("a copy named Static one 2 is stored with the same code", async () => {
      const c = (await storedComponents(t)).find((x) => x.name === "Static one 2");
      return (c && c.code === "Hello **there**") || "no copy yet";
    });
    await t.until("and listed", async () => (await row(t, "Static one 2").count()) === 1);
    // A name opens the editor.
    await row(t, "Field one").getByRole("link", { name: "Field one" }).click();
    await t.until("the editor opens with the component", async () => (await hereTitle(t)) === "Field one" && (await t.page.getByRole("textbox", { name: "Code", exact: true }).inputValue()) === "{{ $item.Title }}");
    await t.audit("editor of a field component");
  }, { viewport: vp });
}

test("Components: delete asks, an unused one goes; one fields use needs Also delete these fields", async (t) => {
  await t.boot();
  const spec = componentsSpec();
  spec.collections[0].fields.push({ key: "t1", name: "Title again", kind: "component", component: "field1" }, { key: "t2", name: "Title twice", kind: "component", component: "field1" });
  const ids = await t.seed(spec);
  const coll = ids.collections.books;
  await t.open("/components");
  const modal = t.page.locator(".cds--modal.is-visible");
  // Unused: asks, Cancel keeps it.
  await row(t, "Static one").getByRole("button", { name: "Delete Static one" }).click({ force: true });
  await t.until("the dialog names it and says no field uses it", async () => (await modal.innerText().catch(() => "")).includes("Delete component “Static one”?") && (await modal.innerText()).includes("No fields use it."));
  await t.audit("delete component dialog");
  await modal.getByRole("button", { name: "Cancel" }).click();
  await t.until("Cancel closes it", async () => (await t.count(".cds--modal.is-visible")) === 0);
  await t.check("…and keeps the component", (await storedComponents(t)).some((c) => c.name === "Static one"));
  await t.settle(500);
  await row(t, "Static one").getByRole("button", { name: "Delete Static one" }).click({ force: true });
  await t.until("asked again", async () => (await modal.count()) === 1);
  await modal.getByRole("button", { name: "Delete", exact: true }).click();
  await t.until("deleted: stored and listed no more", async () => !(await storedComponents(t)).some((c) => c.name === "Static one") && (await row(t, "Static one").count()) === 0);
  // Used by two fields: Delete waits for the checkbox.
  await row(t, "Field one").getByRole("button", { name: "Delete Field one" }).click({ force: true });
  await t.until("the dialog lists the fields using it", async () => /Used by “Title again” of Book, “Title twice” of Book/.test(await modal.innerText().catch(() => "")));
  const del = modal.getByRole("button", { name: "Delete", exact: true });
  await t.check("Delete is disabled until the box is ticked", await del.isDisabled());
  await t.check("the box offers to delete both fields", (await modal.innerText()).includes("Also delete these 2 fields"));
  await t.audit("delete component used by fields");
  await tick(t, modal.getByRole("checkbox", { name: /Also delete these 2 fields/ }));
  await t.until("ticked: Delete is enabled", async () => !(await del.isDisabled()));
  await del.click();
  await t.until("the component and both fields are gone", async () => {
    const names = (await storedCollection(t, coll)).fields.map((f) => f.name);
    return (!(await storedComponents(t)).some((c) => c.name === "Field one") && !names.includes("Title again") && !names.includes("Title twice") && names.includes("Title")) || names.join();
  });
  await t.audit("components after deleting");
});

for (const vp of ["desktop"]) {
  test(`new component: name needed, created and listed; edit, Cancel and Save; code errors @ ${vp}`, async (t) => {
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
  }, { viewport: vp, smoke: vp === "desktop" });
}

// Every Output: how the same editor shows the result, and what is stored.
test("every Output: markdown, text, number, image, HTML; stored and shown again", async (t) => {
  await t.boot();
  await t.seed(componentsSpec());
  const GIF = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
  const outputs = [
    ["Markdown", "markdown", "**bold** and `code`", async (r) => (await r.locator("strong").innerText()) === "bold" && (await r.locator("code").count()) === 1],
    ["Text", "string", "**not bold** {{ 1 + 1 }}", async (r) => (await r.innerText()).includes("**not bold** 2") && (await r.locator("strong").count()) === 0],
    ["Number", "number", "{{ 6 * 7 }}", async (r) => /^\s*Result\s*42\s*$/.test(await r.innerText())],
    ["Image (URL)", "image", GIF, async (r) => (await r.locator("img").count()) === 1],
    ["HTML", "html", "<b id='x'>in a frame</b>", async (r) => (await r.locator("iframe").count()) === 1],
  ];
  for (const [label, value, code, shown] of outputs) {
    await t.open("/components/new");
    const result = t.page.locator(".component-test__result");
    await t.page.getByRole("textbox", { name: "Name", exact: true }).fill(`Out ${label}`);
    await t.page.getByRole("combobox", { name: "Output" }).selectOption({ label });
    await t.page.getByRole("textbox", { name: "Code", exact: true }).fill(code);
    await t.until(`${label}: the result is shown that way`, async () => (await shown(result)) || (await result.innerText()).slice(0, 100), { timeout: 8000 });
    if (label === "Image (URL)" || label === "HTML") await t.audit(`new component, output ${label}`);
    await t.page.getByRole("button", { name: "Create component" }).click();
    await t.until(`${label}: stored with its output`, async () => (await storedComponents(t)).some((c) => c.name === `Out ${label}` && c.output === value));
  }
  // Opened again: the Output is as stored.
  for (const [label, value] of outputs.map((o) => [o[0], o[1]])) {
    await t.open("/components");
    await row(t, `Out ${label}`).getByRole("link", { name: `Out ${label}` }).click();
    await t.until(`${label}: the editor shows it`, async () => (await t.page.getByRole("combobox", { name: "Output" }).inputValue()) === value);
  }
});

// ---- the editor's preview and AI "Try" -------------------------------------------------------

test("preview: with a collection and an item, grouped by, with fields", async (t) => {
  await t.boot();
  await t.seed(componentsSpec());
  await t.open("/components/new");
  const code = t.page.getByRole("textbox", { name: "Code", exact: true });
  const result = t.page.locator(".component-test__preview");
  const form = t.page.locator(".form-page");
  // No built-in that reads items: no preview choices at all.
  await code.fill("Just text");
  await t.check("static code offers no preview collection", (await t.page.getByRole("combobox", { name: "Preview with collection" }).count()) === 0);
  // $item: a collection, then one of its items.
  await code.fill("{{ $item.Title }}");
  const collection = t.page.getByRole("combobox", { name: "Preview with collection" });
  await t.until("$item brings the collection choice", async () => (await collection.count()) === 1);
  await t.check("without a collection $item is empty", (await result.innerText()).replace("Result", "").trim() === "");
  await collection.selectOption({ label: "Book" });
  const item = t.page.getByRole("combobox", { name: "Preview Book" });
  await t.until("an item choice appears", async () => (await item.count()) === 1);
  await t.until("the items are loaded", async () => (await item.locator("option").allInnerTexts()).filter((x) => !/^No /.test(x)).length >= 3);
  const labels = await item.locator("option").allInnerTexts();
  await t.until("the first item is shown", async () => (await result.innerText()).includes(labels[0]) || labels[0]);
  await t.audit("preview with a collection");
  await item.selectOption({ index: 2 });
  await t.until("another item is shown", async () => (await result.innerText()).includes(labels[2]) || labels[2]);
  // $groups: grouped by a field.
  await code.fill("{{ $groups.map((g) => g.label + '=' + g.items.length).join(' ; ') }}");
  const group = t.page.getByRole("combobox", { name: "Preview grouped by" });
  await t.until("$groups brings the grouping choice, $item's item choice goes", async () => (await group.count()) === 1 && (await item.count()) === 0);
  await t.until("without grouping all items are one group", async () => (await result.innerText()).includes("All=4"));
  await group.selectOption({ label: "Done" });
  await t.until("grouped by Done: more than one group, 4 items in all", async () => {
    const x = (await result.innerText()).replace("Result", "").trim();
    const n = [...x.matchAll(/=(\d+)/g)].reduce((s, m) => s + Number(m[1]), 0);
    return (x.includes(" ; ") && n === 4) || x;
  });
  // $fields: the chosen fields.
  await code.fill("{{ $fields.length }} fields");
  const fieldsBox = form.locator(".cds--multi-select__wrapper, .cds--list-box").filter({ hasText: /of \d+ fields/ }).first();
  await t.until("$fields brings the field choice", async () => (await fieldsBox.count()) === 1);
  const total = Number(/of (\d+) fields/.exec(await fieldsBox.innerText())[1]);
  await t.until("all the fields are counted", async () => (await result.innerText()).includes(`${total} fields`));
  await fieldsBox.locator("button").first().click();
  await t.page.getByRole("option", { name: /^Notes/ }).first().click();
  await t.page.keyboard.press("Escape");
  await t.until("with one field unticked one fewer is counted", async () => (await result.innerText()).includes(`${total - 1} fields`) || (await result.innerText()));
  await t.check("the choice says so", new RegExp(`${total - 1} of ${total} fields`).test(await fieldsBox.innerText()), await fieldsBox.innerText());
  await t.audit("preview with fields");
});

test("AI prompt component: the prompt as sent, Try with a fake model, a reply that does not fit", async (t) => {
  await t.boot();
  const fake = await fakeModel(t, () => "A fine book about a winter planet");
  const spec = componentsSpec();
  spec.prefs = AI_PREFS;
  await t.seed(spec);
  await t.open("/components/new");
  await t.page.getByRole("textbox", { name: "Name", exact: true }).fill("Blurb");
  await t.page.getByRole("tab", { name: "AI prompt" }).click();
  await t.until("the code editor becomes a Prompt, Output offers text, number, Markdown", async () => {
    const o = (await t.page.getByRole("combobox", { name: "Output" }).locator("option").allInnerTexts()).join();
    return (await t.page.getByRole("textbox", { name: "Prompt" }).count()) === 1 && o === "Markdown,Text,Number" || o;
  });
  await t.check("no Write with AI for a prompt", (await t.page.getByText("Write with AI").count()) === 0);
  await t.page.getByRole("textbox", { name: "Prompt" }).fill("Summarise {{ $item.Title }} in a line.");
  await t.until("without a collection it says to choose one", async () => (await t.page.locator(".form-page").innerText()).includes("Choose a collection to preview the prompt"));
  await t.page.getByRole("combobox", { name: "Preview with collection" }).selectOption({ label: "Book" });
  await t.until("the items are loaded", async () => (await t.page.getByRole("combobox", { name: "Preview Book" }).locator("option").allInnerTexts()).filter((x) => !/^No /.test(x)).length >= 3);
  const firstTitle = await t.page.getByRole("combobox", { name: "Preview Book" }).locator("option").first().innerText();
  const sent = t.page.locator(".component-test__result", { hasText: "Sent to the model" });
  await t.until("the prompt is shown as it reads for the first item", async () => (await sent.innerText().catch(() => "")).includes(`Summarise ${firstTitle} in a line.`) || (await sent.innerText().catch(() => "no preview")));
  await t.check("nothing is asked until Try", fake.calls.length === 0);
  await t.audit("AI prompt preview");
  const tryIt = t.page.getByRole("button", { name: "Try", exact: true });
  await t.check("Try is enabled with a model set up", !(await tryIt.isDisabled()));
  await tryIt.click();
  const reply = t.page.locator(".component-test__result", { hasText: "The model's reply (not stored)" });
  await t.until("the reply is shown, marked as not stored", async () => (await reply.innerText().catch(() => "")).includes("A fine book about a winter planet"), { timeout: 10000 });
  await t.check("exactly one request, carrying the prompt", fake.calls.length === 1 && promptOf(fake.calls[0]).includes(`Summarise ${firstTitle} in a line.`), `${fake.calls.length}`);
  await t.audit("AI Try reply");
  // A number output and a reply that is not one.
  await t.page.getByRole("combobox", { name: "Output" }).selectOption({ label: "Number" });
  await t.page.getByRole("button", { name: "Try", exact: true }).click();
  await t.until("a reply that is no number says it does not fit", async () => (await t.page.locator(".form-page").innerText()).includes("The model's reply doesn't fit"), { timeout: 10000 });
  await t.audit("AI Try reply that does not fit");
  // Saved as an AI component.
  await t.page.getByRole("button", { name: "Create component" }).click();
  await t.until("stored as an AI component with its output", async () => (await storedComponents(t)).some((c) => c.name === "Blurb" && c.ai === true && c.output === "number" && c.code.includes("Summarise")));
});

test("AI Try without a model: disabled and says where to set one up", async (t) => {
  await t.boot();
  await t.seed(componentsSpec());
  await t.open("/components/new");
  await t.page.getByRole("tab", { name: "AI prompt" }).click();
  await t.page.getByRole("textbox", { name: "Prompt" }).fill("Summarise {{ $item.Title }}");
  await t.page.getByRole("combobox", { name: "Preview with collection" }).selectOption({ label: "Book" });
  await t.until("Try is disabled and Settings is named", async () => (await t.page.getByRole("button", { name: "Try", exact: true }).count()) === 1 && (await t.page.getByRole("button", { name: "Try", exact: true }).isDisabled()) && (await t.page.locator(".form-page").innerText()).includes("Set up a language model in Settings to try the prompt."));
  await t.audit("AI Try without a model");
});

// ---- a field's component: Value switch, Save as shared, back to local ----------------------

function hoursSpec() {
  const spec = profileSpec("typical", { items: 2 });
  spec.collections[0].fields.push({ key: "hours", name: "Hours", kind: "component", code: "{{ Math.round(($item.Count ?? 0) / 40) }} h", output: "markdown" });
  return spec;
}

for (const vp of ["desktop", "phone"]) {
  test(`a component field: Value switch keeps both texts, Save as shared, back to Local @ ${vp}`, async (t) => {
    await t.boot();
    const ids = await t.seed(hoursSpec());
    const coll = ids.collections.books;
    await t.open(`/collections/${coll}/edit`);
    const hours = t.page.locator(".ws-pane--active .field-row").filter({ has: t.page.locator('input[value="Hours"]') });
    const codeBox = hours.getByRole("textbox", { name: "Code", exact: true });
    // Code ⇄ AI prompt on a new field (a saved AI field is fixed): each side is kept while the editor is open.
    await t.check("Hours is local, with its code", (await codeBox.inputValue()).includes("$item.Count") && (await hours.innerText()).includes("Local: only this field uses it."));
    await t.check("a saved component field's Value switch is fixed", await hours.getByRole("tab", { name: "AI prompt" }).isDisabled());
    await t.page.getByRole("button", { name: "Add field" }).click();
    await t.settle(100);
    const fresh = t.page.locator(".ws-pane--active .field-row").last();
    await fresh.getByRole("textbox", { name: "Field name" }).fill("Draft");
    await fresh.locator(".cds--dropdown, .cds--list-box").first().click();
    await t.settle(100);
    await t.page.getByRole("option", { name: "Component", exact: true }).first().click();
    await t.settle(100);
    await fresh.getByRole("textbox", { name: "Code", exact: true }).fill("{{ $item.Title }} as code");
    await fresh.getByRole("tab", { name: "AI prompt" }).click();
    await t.until("the prompt side starts empty", async () => (await fresh.getByRole("textbox", { name: "Prompt" }).count()) === 1 && (await fresh.getByRole("textbox", { name: "Prompt" }).inputValue()) === "");
    await fresh.getByRole("textbox", { name: "Prompt" }).fill("How many hours for {{ $item.Title }}?");
    await fresh.getByRole("tab", { name: "Code" }).click();
    await t.until("back on Code: the code is as it was", async () => (await fresh.getByRole("textbox", { name: "Code", exact: true }).count()) === 1 && (await fresh.getByRole("textbox", { name: "Code", exact: true }).inputValue()) === "{{ $item.Title }} as code");
    await fresh.getByRole("tab", { name: "AI prompt" }).click();
    await t.until("and the prompt too", async () => (await fresh.getByRole("textbox", { name: "Prompt" }).inputValue()).startsWith("How many hours"));
    await t.audit("component field editor, AI prompt side");
    await t.open(`/collections/${coll}/edit`);

    // Save as shared: the name is checked, then the field uses the shared component.
    await hours.getByRole("button", { name: "Save as shared component" }).click();
    const modal = t.page.locator(".cds--modal.is-visible");
    await t.until("the dialog asks for a name", async () => (await modal.count()) === 1);
    await modal.getByRole("textbox", { name: "Name" }).fill("Double");
    await modal.getByRole("button", { name: "Save as shared" }).click();
    await t.until("a name taken by another component is refused", async () => (await modal.innerText()).includes("Another component has this name"));
    await modal.getByRole("textbox", { name: "Name" }).fill("");
    await modal.getByRole("button", { name: "Save as shared" }).click();
    await t.until("an empty name is refused", async () => (await modal.innerText()).includes("Give the component a name"));
    await t.audit("save as shared with an error");
    await modal.getByRole("textbox", { name: "Name" }).fill("Hours shared");
    await modal.getByRole("button", { name: "Save as shared" }).click();
    await t.until("the shared component is stored", async () => (await storedComponents(t)).some((c) => c.name === "Hours shared" && c.code.includes("$item.Count")));
    await t.until("the field now shows Shared with Edit component, no code", async () => (await hours.innerText()).includes("Shared: a change applies everywhere") && (await hours.getByRole("link", { name: "Edit component" }).count()) + (await hours.getByRole("button", { name: "Edit component" }).count()) === 1 && (await codeBox.count()) === 0);
    await t.page.getByRole("button", { name: "Save changes" }).click();
    const shared = (await storedComponents(t)).find((c) => c.name === "Hours shared");
    await t.until("saved: the field points at it and has no code of its own", async () => {
      const f = (await storedCollection(t, coll)).fields.find((x) => x.name === "Hours");
      return (f.componentId === shared.id && f.code === null) || JSON.stringify(f);
    });
    // The item page computes it from the shared component.
    await t.open(t.itemPath(coll, ids.items["books/i0"]));
    await t.until("the item page shows its value", async () => /\d+ h/.test(await t.page.locator(".ws-pane--active .item-fields").innerText()));

    // Back to Local: the choice says so and the code starts empty (the shared one is untouched).
    await t.open(`/collections/${coll}/edit`);
    const hours2 = t.page.locator(".ws-pane--active .field-row").filter({ has: t.page.locator('input[value="Hours"]') });
    await t.check("the editor shows it as shared", (await hours2.innerText()).includes("Shared: a change applies everywhere"));
    await hours2.getByRole("combobox", { name: "Component" }).click();
    await t.page.getByRole("option", { name: "Local" }).click();
    await t.until("Local: only this field uses it, with an empty code", async () => (await hours2.innerText()).includes("Local: only this field uses it.") && (await hours2.getByRole("textbox", { name: "Code", exact: true }).inputValue()) === "");
    await t.check("the shared component is still there", (await storedComponents(t)).some((c) => c.name === "Hours shared"));
    await t.audit("component field back to local");
  }, { viewport: vp });
}

// ---- a component field edited in place on the item page ------------------------------------

test("component field in place: Edit this field's component saves the field's code; code that does not fit is kept out", async (t) => {
  await t.boot();
  const ids = await t.seed(hoursSpec());
  const coll = ids.collections.books;
  await t.open(t.itemPath(coll, ids.items["books/i0"]));
  const field = t.page.locator(".ws-pane--active .item-fields > *", { hasText: "Hours" }).first();
  await field.getByRole("button", { name: "Edit this field's component" }).click();
  const editor = t.page.locator(".ws-pane--active .field-editor");
  await t.until("the code opens in an editor", async () => (await editor.count()) === 1 && (await editor.locator("textarea").first().inputValue()).includes("$item.Count"));
  await t.audit("component field editor");
  // Escape cancels.
  await editor.locator("textarea").first().fill("{{ 1 }} cancelled");
  await t.page.keyboard.press("Escape");
  await t.until("Escape closes it", async () => (await t.count(".ws-pane--active .field-editor")) === 0);
  await t.check("nothing was stored", (await storedCollection(t, coll)).fields.find((f) => f.name === "Hours").code.includes("$item.Count"));
  // Code that does not fit a field is explained and not saved.
  await field.getByRole("button", { name: "Edit this field's component" }).click();
  await editor.locator("textarea").first().fill("{{ $items.length }} books");
  await t.page.keyboard.press("Control+Enter");
  await t.settle();
  await t.check("a block's $items cannot be saved in a field", (await t.count(".ws-pane--active .field-editor")) === 1 && (await storedCollection(t, coll)).fields.find((f) => f.name === "Hours").code.includes("$item.Count"), await editor.innerText());
  await t.audit("component field editor with code that does not fit");
  // Valid code: Ctrl+Enter stores it in the field and the value follows.
  await editor.locator("textarea").first().fill("Pages: {{ $item.Count }}");
  await t.page.keyboard.press("Control+Enter");
  await t.until("stored in the field", async () => (await storedCollection(t, coll)).fields.find((f) => f.name === "Hours").code === "Pages: {{ $item.Count }}");
  await t.until("the editor closes and the value is recomputed", async () => (await t.count(".ws-pane--active .field-editor")) === 0 && /Pages: \d/.test(await field.innerText()));
  await t.audit("component field after an edit");
});
