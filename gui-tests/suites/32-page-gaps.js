// The rarer paths of the collection and item pages, each asserted by its result (what is stored,
// what is shown, what survives opening the page again): a collection with no saved view storing its
// "All" view when something needs a real one, removing blocks and deleting a view on the collection
// page, deleting an item from its page, editing an empty title, a wrapped text edited in place,
// stored images inside an HTML field, the table's add row (errors, leaving it, a failed save), and
// a delete or save that fails.

const modalOf = (t) => t.page.locator(".cds--modal.is-visible");
const barOf = (t) => t.page.locator(".ws-pane--active .views-bar").first();
const panelOf = (t) => t.page.locator(".toolbar-popover.cds--popover--open");
const blocksOf = (t) => t.page.locator(".ws-pane--active .block");
/** The views stored for a collection in a space (the default one unless named). */
const storedViewsIn = (t, collectionId, space = "default") => t.page.evaluate(([id, space]) => window.kubus.repo.listViews(id, space), [collectionId, space]);
const storedCollection = (t, id) => t.page.evaluate(async (id) => (await window.kubus.repo.listCollections()).find((c) => c.id === id), id);
const storedItems = (t, collectionId) =>
  t.page.evaluate(async (id) => {
    const repo = window.kubus.repo;
    const c = (await repo.listCollections()).find((x) => x.id === id);
    return await repo.listItems(c, "default");
  }, collectionId);
const storedValue = async (t, collectionId, itemId, fieldName) => {
  const c = await storedCollection(t, collectionId);
  const item = (await storedItems(t, collectionId)).find((i) => i.id === itemId);
  return item && item.values[c.fields.find((f) => f.name === fieldName).id];
};

/** Clicks a button of the views bar (or the page header), through the "⋮" menu when it is folded into one. */
async function clickBar(t, label, scope = ".views-bar") {
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

const simple = (key, name, plural) => ({
  key,
  name,
  plural,
  fields: [{ key: "name", name: "Name", kind: "string" }],
  items: [{ values: { name: `${name} one` } }, { values: { name: `${name} two` } }],
});

// ---- a collection with no saved view ----------------------------------------------------------

test("no saved view: it shows an All view, stored for real the moment something needs one", async (t) => {
  await t.boot();
  // Views are kept per space: in a space where a collection has none yet, it shows a virtual All.
  const names = ["Add", "Mark", "Rename", "Block", "Filter", "Fold"];
  const spec = { spaces: [{ key: "w", name: "Work" }], collections: names.map((n) => simple(n.toLowerCase(), n, n)) };
  const ids = await t.seed(spec);
  const work = ids.spaces.w;
  await t.page.evaluate((id) => localStorage.setItem("kubus.space", JSON.stringify(id)), work);
  const storedViews = (t, id) => storedViewsIn(t, id, work);
  const open = async (key) => {
    await t.open(t.listPath(ids.collections[key]));
    await t.until("the page shows its All view", async () => /All/.test(await barOf(t).innerText().catch(() => "")) && (await blocksOf(t).count()) === 1);
  };
  const only = async (key) => {
    const v = await storedViews(t, ids.collections[key]);
    return v.length === 1 ? v[0] : null;
  };

  // Nothing is stored just for looking.
  await open("add");
  await t.check("a collection nobody touched has no stored view", (await storedViews(t, ids.collections.add)).length === 0);
  await t.check("…and with one view there is no Star / Delete", !(await barOf(t).getByRole("button", { name: "Delete view" }).count()) && !(await barOf(t).getByRole("button", { name: /default view/ }).count()));
  await t.audit("the virtual All view");

  // "+" stores All first, then the new view beside it.
  await clickBar(t, "Add view");
  await t.until("Add view stores All and the new view", async () => (await storedViews(t, ids.collections.add)).map((v) => v.name).join("|") === "All|New");
  await t.until("the new view is the one shown, with its settings open", async () => (await barOf(t).getByRole("tab", { selected: true }).innerText()).startsWith("New") && (await panelOf(t).count()) === 1);
  await t.closeAll();

  // A bookmark needs a real view.
  await open("mark");
  await clickBar(t, "Bookmark");
  await t.until("bookmarking stores All", async () => (await only("mark"))?.name === "All");
  await t.until("…and the button now removes the bookmark", async () => (await barOf(t).getByRole("button", { name: "Remove bookmark" }).count()) === 1);

  // Renaming it.
  await open("rename");
  await t.openPanel(barOf(t), "View settings");
  const name = panelOf(t).getByRole("textbox", { name: "View name" });
  await t.check("the name field starts with All", (await name.inputValue()) === "All");
  await name.fill("Mine");
  await name.press("Enter");
  await t.until("renaming stores the view under its new name", async () => (await only("rename"))?.name === "Mine");
  await t.closeAll();
  await t.until("the tab shows it", async () => /Mine/.test(await barOf(t).innerText()));

  // Adding a block in the view's settings.
  await open("block");
  await t.openPanel(barOf(t), "View settings");
  await panelOf(t).getByRole("button", { name: "Add block", exact: true }).click();
  await t.page.getByRole("menuitem", { name: "Markdown", exact: true }).click();
  await t.until("a new block is stored with the All view", async () => {
    const v = await only("block");
    return v?.name === "All" && v.blocks.length === 2 && v.blocks[1].kind === "markdown";
  });
  await t.closeAll();
  await t.until("two blocks are shown", async () => (await blocksOf(t).count()) === 2);
  await t.audit("a block added to the virtual view");

  // A filter, saved with the check mark.
  await open("filter");
  await t.openPanel(barOf(t), "Filter");
  await panelOf(t).getByRole("button", { name: /Add filter/ }).first().click();
  await t.settle();
  await t.closeAll();
  await t.until("the view is marked as changed", async () => /\*/.test(await barOf(t).innerText()));
  await t.check("nothing is stored before Save", (await storedViews(t, ids.collections.filter)).length === 0);
  await clickBar(t, "Save changes to view");
  await t.until("Save stores All with the filter", async () => {
    const v = await only("filter");
    return v?.name === "All" && v.filters.length === 1;
  });

  // Folding a block is stored with the view too.
  await open("fold");
  await blocksOf(t).first().locator(".section-header .collapse-caret").first().click();
  await t.until("collapsing stores All with the block folded", async () => {
    const v = await only("fold");
    return v?.name === "All" && v.collapsed.blocks.length === 1;
  });
  await t.open(t.listPath(ids.collections.fold));
  await t.until("after a reload the block is still folded", async () => (await blocksOf(t).first().getByRole("button", { name: "Expand" }).count()) === 1);
}, { smoke: true });

// ---- removing blocks and deleting a view on the collection page -------------------------------

test("blocks removed (asked first, from the block and from View settings); a view deleted", async (t) => {
  await t.boot();
  const spec = { collections: [simple("books", "Book", "Books")] };
  spec.collections[0].views = [
    { name: "Main", isDefault: true, blocks: [{ kind: "table", title: "First" }, { kind: "markdown", title: "Second", options: { text: "Some words" } }, { kind: "cards", title: "Third" }] },
    { name: "Other", blocks: [{ kind: "table" }] },
  ];
  const ids = await t.seed(spec);
  const coll = ids.collections.books;
  await t.open(t.listPath(coll));
  await t.until("three blocks", async () => (await blocksOf(t).count()) === 3);
  const stored = async () => (await storedViewsIn(t, coll)).find((v) => v.name === "Main");

  // From the second block's settings: asked, Cancel keeps it.
  const second = () => blocksOf(t).nth(1);
  await t.openPanel(second(), "Block settings");
  await panelOf(t).getByRole("button", { name: "Remove block" }).click();
  await t.until("asked first", async () => /Remove block/.test(await modalOf(t).innerText().catch(() => "")) && /Items are not affected/.test(await modalOf(t).innerText()));
  await t.audit("Remove block dialog");
  await modalOf(t).getByRole("button", { name: "Cancel" }).click();
  await t.until("Cancel closes the dialog", async () => (await t.count(".cds--modal.is-visible")) === 0);
  await t.check("…and keeps all three blocks, shown and stored", (await blocksOf(t).count()) === 3 && (await stored()).blocks.length === 3);
  await t.closeAll();
  await t.openPanel(second(), "Block settings");
  await panelOf(t).getByRole("button", { name: "Remove block" }).click();
  await t.until("asked again", async () => (await modalOf(t).count()) === 1);
  await modalOf(t).getByRole("button", { name: /^(Delete|Remove)/ }).click();
  await t.until("the block is gone from the page and the stored view", async () => (await blocksOf(t).count()) === 2 && (await stored()).blocks.map((b) => b.title).join("|") === "First|Third");
  await t.closeAll();

  // From View settings' block list.
  await t.openPanel(barOf(t), "View settings");
  await panelOf(t).getByRole("button", { name: "Remove block" }).first().click();
  await t.until("asked first", async () => (await modalOf(t).count()) === 1);
  await modalOf(t).getByRole("button", { name: /^(Delete|Remove)/ }).click();
  await t.until("the first block is removed", async () => (await blocksOf(t).count()) === 1 && (await stored()).blocks.map((b) => b.title).join("|") === "Third");
  await t.check("the last block cannot be removed any more", (await panelOf(t).getByRole("button", { name: "Remove block" }).count()) === 0);
  await t.closeAll();
  await t.openPanel(blocksOf(t).first(), "Block settings");
  await t.check("…nor from its own settings", (await panelOf(t).getByRole("button", { name: "Remove block" }).count()) === 0);
  await t.closeAll();
  await t.open(t.listPath(coll));
  await t.until("after a reload one block remains", async () => (await blocksOf(t).count()) === 1);

  // Deleting a view asks first.
  await clickBar(t, "Delete view");
  await t.until("deleting asks first", async () => /Delete view “Main”\?/.test(await modalOf(t).innerText().catch(() => "")));
  await modalOf(t).getByRole("button", { name: "Cancel" }).click();
  await t.until("Cancel closes it", async () => (await t.count(".cds--modal.is-visible")) === 0);
  await t.check("…and keeps both views", (await storedViewsIn(t, coll)).length === 2 && (await barOf(t).getByRole("tab").count()) === 2);
  await clickBar(t, "Delete view");
  await t.until("asked again", async () => (await modalOf(t).count()) === 1);
  await modalOf(t).getByRole("button", { name: "Delete", exact: true }).click();
  await t.until("the view is deleted and the other shown", async () => (await storedViewsIn(t, coll)).map((v) => v.name).join("|") === "Other" && (await barOf(t).getByRole("tab").count()) === 1);
  await t.audit("after deleting the view");
});

// ---- the item page -----------------------------------------------------------------------------

test("an item is deleted from its page: asked first, a failed delete says so", async (t) => {
  await t.boot();
  const spec = { collections: [simple("books", "Book", "Books")] };
  const ids = await t.seed(spec);
  const coll = ids.collections.books;
  const keep = ids.items["books/i0"];
  const page = t.page.locator(".ws-pane--active");

  // Delete: asked first.
  await t.open(t.itemPath(coll, keep));
  await t.until("the item page", async () => /Book one/.test(await page.innerText().catch(() => "")));
  await page.getByRole("button", { name: "Delete Book", exact: true }).first().click();
  await t.until("deleting asks first, naming the item", async () => /Delete Book\?/.test(await modalOf(t).innerText().catch(() => "")) && /“Book one” will be removed/.test(await modalOf(t).innerText()));
  await t.audit("Delete item dialog");
  await modalOf(t).getByRole("button", { name: "Cancel" }).click();
  await t.until("Cancel closes the dialog", async () => (await t.count(".cds--modal.is-visible")) === 0);
  await t.check("…and keeps the item", (await storedItems(t, coll)).length === 2);

  // A delete that fails stays on the page and says why.
  await t.page.evaluate(() => {
    const repo = window.kubus.repo;
    window.__deleteItem = repo.deleteItem;
    repo.deleteItem = async () => {
      throw new Error("The disk is full");
    };
  });
  await page.getByRole("button", { name: "Delete Book", exact: true }).first().click();
  await t.until("asked again", async () => (await modalOf(t).count()) === 1);
  await modalOf(t).getByRole("button", { name: "Delete", exact: true }).click();
  await t.until("the error is shown on the page", async () => /The disk is full/.test(await page.innerText()));
  await t.check("the item is still there, and so is the page", (await storedItems(t, coll)).length === 2 && /Book one/.test(await page.innerText()));
  await t.audit("a failed delete");
  await t.page.evaluate(() => {
    window.kubus.repo.deleteItem = window.__deleteItem;
  });

  // The real thing: it goes, and the page gives way to the list.
  await page.getByRole("button", { name: "Delete Book", exact: true }).first().click();
  await t.until("asked once more", async () => (await modalOf(t).count()) === 1);
  await modalOf(t).getByRole("button", { name: "Delete", exact: true }).click();
  await t.until("the item is deleted", async () => (await storedItems(t, coll)).length === 1 && !(await storedItems(t, coll)).some((i) => i.id === keep));
  await t.until("the tab is back on the list, without it", async () => (await page.locator(".item-title").count()) === 0 && /Book two/.test(await page.innerText()));
  await t.check("the list no longer shows it", !/Book one/.test(await page.innerText()));
  await t.audit("after deleting the item");
});

// ---- text that wraps, edited in place ---------------------------------------------------------

const LONG = "A long line of text that has to wrap over several lines in a narrow column, so that editing it happens in a box that wraps the same way and nothing moves";

test("a wrapped text is edited in a box of its own: typed into, Enter saves, never a line break", async (t) => {
  await t.boot();
  const spec = { collections: [simple("books", "Book", "Books")] };
  const c = spec.collections[0];
  c.fields.push({ key: "summary", name: "Summary", kind: "string" });
  c.items = [{ key: "a", values: { name: "Cell book", summary: LONG } }, { key: "b", values: { name: "Page book", summary: LONG } }];
  c.views = [{ name: "All", blocks: [{ kind: "table", layout: { fields: ["name", "summary"] } }] }];
  const ids = await t.seed(spec);
  const coll = ids.collections.books;
  const idA = ids.items["books/a"];
  const idB = ids.items["books/b"];

  // In a table cell (a narrow pane makes the text wrap).
  await t.open(t.listPath(coll));
  const cell = t.page.locator(".items-table tbody tr").filter({ hasText: "Cell book" }).getByRole("button", { name: /Edit Summary/ }).first();
  await t.until("the table shows the text", async () => (await cell.count()) === 1);
  const wrapped = await cell.evaluate((el) => el.getBoundingClientRect().height > 40);
  await t.check("the text wraps over several lines in its cell", wrapped);
  await cell.click();
  const box = t.page.locator(".items-table .cell-inline-editor [role=textbox]");
  await t.until("a text box of its own opens in place of the text", async () => (await box.count()) === 1);
  await t.check("it holds the whole text", (await box.innerText()) === LONG);
  await t.page.keyboard.press("Control+End");
  await t.page.keyboard.type(" and more");
  await t.page.keyboard.press("Enter");
  await t.until("Enter saves what was typed, as one line", async () => (await storedValue(t, coll, idA, "Summary")) === `${LONG} and more`);
  await t.until("the editor is gone", async () => (await box.count()) === 0);
  await t.audit("after editing a wrapped cell");

  // On the item page.
  await t.open(t.itemPath(coll, idB));
  const field = t.page.locator(".ws-pane--active .item-fields").getByRole("button", { name: /Edit Summary/ }).first();
  await t.until("the item page shows it", async () => (await field.count()) === 1);
  await field.click();
  const editor = t.page.locator(".ws-pane--active .field-textbox");
  await t.until("the wrapping box opens", async () => (await editor.count()) === 1);
  await t.page.keyboard.press("Control+A");
  await t.page.keyboard.type("Short now");
  await t.page.keyboard.press("Enter");
  await t.until("Enter saves it", async () => (await storedValue(t, coll, idB, "Summary")) === "Short now");
  await t.until("…and shows it", async () => /Short now/.test(await t.page.locator(".ws-pane--active .item-fields").innerText()));
  await t.audit("after editing a wrapped field");
}, { viewport: "phone" });

// ---- stored images inside an HTML field ------------------------------------------------------

test("an HTML field with a stored image shows it (the frame embeds the file), also a second time", async (t) => {
  await t.boot();
  const spec = {
    images: [{ key: "pic", w: 80, h: 60 }],
    collections: [{ key: "pages", name: "Page", plural: "Pages", fields: [{ key: "name", name: "Name", kind: "string" }, { key: "body", name: "Body", kind: "html" }], items: [{ key: "p", values: { name: "With a picture" } }] }],
  };
  const ids = await t.seed(spec);
  const coll = ids.collections.pages;
  const item = ids.items["pages/p"];
  const bodyId = ids.fields["pages.body"];
  const missing = "0".repeat(64);
  await t.page.evaluate(
    async ([coll, item, bodyId, img, missing]) => {
      const repo = window.kubus.repo;
      const c = (await repo.listCollections()).find((x) => x.id === coll);
      await repo.updateItem(c, item, { [bodyId]: `<p>Here:</p><img id="pic" src="files/${img}"><img id="gone" src="files/${missing}">` });
    },
    [coll, item, bodyId, ids.images.pic, missing],
  );
  const frameDoc = () => t.page.locator(".ws-pane--active iframe").first().getAttribute("srcdoc");
  for (const visit of ["first", "second"]) {
    await t.open(t.itemPath(coll, item));
    await t.until(`${visit} visit: the frame embeds the image as data`, async () => /src="data:image\/png;base64,/.test((await frameDoc().catch(() => "")) || ""), { timeout: 8000 });
    const doc = await frameDoc();
    await t.check(`${visit} visit: the file that is not stored stays a plain reference`, doc.includes(`files/${missing}`) && !doc.includes(`files/${ids.images.pic}`));
  }
  const loaded = await t.page.frameLocator(".ws-pane--active iframe").first().locator("img#pic").evaluate((img) => img.complete && img.naturalWidth === 80);
  await t.check("the image really renders inside the frame", loaded);
  await t.audit("an HTML field with an image");
});

// ---- the table's add row ---------------------------------------------------------------------

test("the add row: an invalid value stays open with its error, a valid one is added; leaving it; a failed save", async (t) => {
  await t.boot();
  const spec = { collections: [simple("books", "Book", "Books")] };
  const c = spec.collections[0];
  c.fields.push({ key: "pages", name: "Pages", kind: "number" });
  c.views = [{ name: "All", blocks: [{ kind: "table", layout: { fields: ["name", "pages"] } }] }];
  const ids = await t.seed(spec);
  const coll = ids.collections.books;
  await t.open(t.listPath(coll));
  const row = t.page.locator(".items-table .table-add-row:not(.table-add-row--idle)");
  const add = async () => {
    await t.page.getByRole("button", { name: "Add Book" }).filter({ visible: true }).first().click();
    await t.until("the add row opens", async () => (await row.count()) === 1);
  };
  const count = async () => (await storedItems(t, coll)).length;

  // Nothing typed: Enter adds nothing, the row stays.
  await add();
  await t.page.keyboard.press("Enter");
  await t.settle(200);
  await t.check("Enter on an untouched row adds nothing and keeps it open", (await count()) === 2 && (await row.count()) === 1);

  // An invalid number: an error under it, the row stays, nothing is added.
  await t.page.keyboard.type("Bad one");
  await row.locator("input").nth(1).fill("abc");
  await t.page.keyboard.press("Enter");
  await t.until("the number says it is not valid", async () => /Not a valid number/.test(await row.innerText()));
  await t.check("nothing was added and the row is still open", (await count()) === 2 && (await row.count()) === 1);
  // The error is an outline plus a title on the cell; its text never pushes the input over the row above.
  await t.check("the invalid cell carries its message as a title", (await row.locator(".add-cell[title*='Not a valid number']").count()) === 1);
  await t.audit("add row with an error");
  // Clicking away with the error keeps the row too.
  await t.page.locator(".ws-pane--active .page-header__title").first().click();
  await t.settle(200);
  await t.check("clicking outside an invalid row keeps it open", (await row.count()) === 1 && (await count()) === 2);
  // Fixing it and clicking away adds it and closes the row.
  await row.locator("input").nth(1).fill("12");
  await t.page.locator(".ws-pane--active .page-header__title").first().click();
  await t.until("clicking outside a valid row adds the item", async () => (await count()) === 3 && (await row.count()) === 0);
  await t.check("…with its values", (await storedItems(t, coll)).some((i) => i.values[ids.fields["books.name"]] === "Bad one" && i.values[ids.fields["books.pages"]] === 12));

  // Clicking away from an untouched row just closes it.
  await add();
  await t.page.locator(".ws-pane--active .page-header__title").first().click();
  await t.until("an untouched row closes", async () => (await row.count()) === 0);
  await t.check("…adding nothing", (await count()) === 3);

  // A save that fails: the error is under the first field and the row keeps what was typed.
  await t.page.evaluate(() => {
    const repo = window.kubus.repo;
    window.__createItem = repo.createItem;
    repo.createItem = async () => {
      throw new Error("Could not save");
    };
  });
  await add();
  await t.page.keyboard.type("Will fail");
  await t.page.keyboard.press("Enter");
  await t.until("the failure is shown in the row", async () => /Could not save/.test(await row.innerText()));
  await t.check("the typed text is kept and nothing was added", (await row.locator("input").first().inputValue()) === "Will fail" && (await count()) === 3);
  await t.page.evaluate(() => {
    window.kubus.repo.createItem = window.__createItem;
  });
  await t.page.keyboard.press("Enter");
  await t.until("with the repository back, Enter adds it and the row is ready for the next", async () => (await count()) === 4 && (await row.locator("input").first().inputValue()) === "");
  // Escape closes the row (still open, ready for the next item).
  await t.page.keyboard.press("Escape");
  await t.until("Escape closes the row", async () => (await row.count()) === 0);
});

// ---- an AI prompt that cannot be sent, and a model that fails ---------------------------------

test("AI prompt preview: an empty prompt for the item says so; Try against a failing model shows its error", async (t) => {
  await t.boot();
  const LLM = "https://llm.test/v1";
  const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET, POST, OPTIONS" };
  let calls = 0;
  await t.page.route(`${LLM}/**`, async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    if (req.url().endsWith("/models")) return route.fulfill({ status: 200, headers: cors, json: { data: [{ id: "fake-model" }] } });
    calls++;
    return route.fulfill({ status: 500, headers: cors, json: { error: { message: "The model fell over" } } });
  });
  const spec = { prefs: { "kubus.ai": { baseUrl: LLM, apiKey: "test-key", fieldModel: "fake-model", codeModel: "", paused: false } }, collections: [simple("books", "Book", "Books")] };
  spec.collections[0].items = [{ values: {} }];
  await t.seed(spec);
  await t.open("/components/new");
  await t.page.getByRole("textbox", { name: "Name", exact: true }).fill("Blurb");
  await t.page.getByRole("tab", { name: "AI prompt" }).click();
  await t.page.getByRole("textbox", { name: "Prompt" }).fill("{{ $item.Name }}");
  await t.page.getByRole("combobox", { name: "Preview with collection" }).selectOption({ label: "Book" });
  const form = t.page.locator(".form-page");
  await t.until("the empty prompt is reported", async () => (await form.innerText()).includes("The prompt is empty for this item"));
  await t.check("there is nothing to Try", (await t.page.getByRole("button", { name: "Try", exact: true }).count()) === 0);
  await t.audit("a prompt that is empty for the item");
  // An item with a name makes a prompt; the model fails.
  await t.page.evaluate(async () => {
    const repo = window.kubus.repo;
    const c = (await repo.listCollections())[0];
    await repo.createItem(c, { [c.fields[0].id]: "Dune" }, "default");
  });
  await t.until("a second item is offered", async () => (await t.page.getByRole("combobox", { name: "Preview Book" }).locator("option").count()) === 2);
  await t.page.getByRole("combobox", { name: "Preview Book" }).selectOption({ label: "Dune" });
  await t.until("the prompt reads for it", async () => (await form.innerText()).includes("Dune"));
  await t.page.getByRole("button", { name: "Try", exact: true }).click();
  await t.until("the model's failure is shown", async () => (await form.innerText()).includes("The model fell over"), { timeout: 10000 });
  await t.check("one request was made and Try is available again", calls === 1 && !(await t.page.getByRole("button", { name: "Try", exact: true }).isDisabled()));
  await t.audit("AI Try failed");
});

// ---- phones: blocks and the page use the pane's whole width ---------------------------------------
// Reported on a phone: on an item page the chart and map blocks were wider than the other blocks
// ("⋮" menus further right), and the portrait layout did not seem to use the full width.

for (const vp of ["phone-360", "phone", "phone-412"]) {
  test(`phone portrait: item and collection pages use the window's width, every block fits it @ ${vp}`, async (t) => {
    await t.boot();
    const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "*" };
    await t.page.route("https://tiles.openfreemap.org/**", (route) => {
      if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
      if (route.request().url().includes("/styles/")) return route.fulfill({ status: 200, headers: CORS, json: { version: 8, name: "stub", sources: {}, layers: [{ id: "background", type: "background", paint: { "background-color": "#ffffff" } }] } });
      return route.fulfill({ status: 404, headers: CORS, body: "" });
    });
    const ids = await t.seed(matrixSpec("typical", { items: 6, drawn: true }));
    const W = t.vp.width;
    const measure = () =>
      t.page.evaluate(() => {
        const r = (el) => { const b = el.getBoundingClientRect(); return { left: Math.round(b.left * 10) / 10, right: Math.round(b.right * 10) / 10, width: Math.round(b.width * 10) / 10 }; };
        const content = document.querySelector(".ws-pane--active .ws-tab-slot:not([hidden]) .ws-tab-content");
        return {
          inner: window.innerWidth, scroll: document.documentElement.scrollWidth,
          content: r(content),
          header: r(content.querySelector(".page-header")),
          blocks: [...content.querySelectorAll(".block")].map((b) => ({ title: b.querySelector(".section-header")?.textContent.trim().slice(0, 12), box: r(b), head: b.querySelector(".section-header") ? r(b.querySelector(".section-header")) : null, menu: (() => { const m = [...b.querySelectorAll(".section-header button")].filter((x) => x.checkVisibility()).pop(); return m ? r(m).right : null; })(), drawn: Math.max(0, ...[...b.querySelectorAll("svg, canvas")].filter((x) => x.getBoundingClientRect().width > 100).map((x) => r(x).right)) })),
        };
      });
    for (const [label, path] of [
      ["item page", `/collections/${ids.collections.books}/items/${ids.items["books/i0"]}`],
      ["collection blocks view", `/collections/${ids.collections.books}/items?view=${ids.views["books/Blocks"]}`],
    ]) {
      await t.open(path);
      await t.until(`${label}: the blocks are shown`, async () => (await t.count(".block")) >= 4);
      await t.settle(500);
      const m = await measure();
      await t.check(`${label}: layout viewport is the window (${m.inner} of ${W}) and nothing scrolls sideways`, m.inner === W && m.scroll <= W, JSON.stringify(m));
      const pad = 16;
      await t.check(`${label}: the page's content box spans the window minus the page padding`, Math.abs(m.header.left - pad) <= 1 && Math.abs(m.header.right - (W - pad)) <= 1, `header ${JSON.stringify(m.header)}`);
      const wide = m.blocks.filter((b) => b.box.right > m.header.right + 1 || b.box.left < m.header.left - 1);
      await t.check(`${label}: no block is wider than the page's content box`, wide.length === 0, JSON.stringify(wide));
      const menus = [...new Set(m.blocks.filter((b) => b.menu).map((b) => b.menu))];
      await t.check(`${label}: every block's "⋮" menu ends on one right edge`, menus.length === 1, menus.join(", "));
      const over = m.blocks.filter((b) => b.drawn > m.header.right + 1);
      await t.check(`${label}: charts and maps stay inside the content box`, over.length === 0, JSON.stringify(over));
      const heads = [...new Set(m.blocks.filter((b) => b.head).map((b) => b.head.right))];
      await t.check(`${label}: every block header ends on one right edge`, heads.length === 1, heads.join(", ") + " " + JSON.stringify(m.blocks));
    }
  }, { viewport: vp });
}
