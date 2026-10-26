// Data changing underneath: what another pane, another device (sync) or the app itself writes
// arrives through the change feed while the page is in use. An open editor keeps what is typed in
// it; the rest of the page updates in place without jumping; a deleted item, collection or field
// leaves an orderly page behind, never a blank or a crash.

/** Writes through the repository, as another pane or a sync would (the page only sees the change feed). */
async function external(t, fn, arg) {
  await t.page.evaluate(new Function("arg", `return (async () => { const repo = window.kubus.repo; const c = async (id) => (await repo.listCollections()).find((x) => x.id === id); ${fn} })()`), arg);
  await t.settle(300);
}

for (const vp of ["desktop", "phone"]) {
  test(`an open editor survives changes to its item @ ${vp}`, async (t) => {
    await t.boot();
    const ids = await t.seed(profileSpec("typical", { items: 3 }));
    const coll = ids.collections.books;
    const item = ids.items["books/i0"];
    await t.open(t.itemPath(coll, item));
    // Typing in Notes; meanwhile Count changes elsewhere.
    const notes = t.page.getByRole("button", { name: "Edit Notes", exact: true }).first();
    await notes.click({ position: await t.visiblePoint(notes) });
    await t.page.waitForSelector(".ProseMirror");
    await t.page.keyboard.press("Control+End");
    await t.page.keyboard.type(" typed while it changed");
    await t.noShift("another field changing moves nothing above it", async () => {
      await external(t, `const col = await c(arg.coll); const f = col.fields.find((x) => x.name === "Count"); const it = await repo.getItem(col, arg.item); await repo.updateItem(col, arg.item, { ...it.values, [f.id]: 31337 });`, { coll, item });
    }, { scope: ".ws-pane--active .ws-pane__body", except: [".item-fields > *:has([aria-label='Edit Count']) ~ *", ".item-fields > *:has([aria-label='Edit Count'])"] });
    await t.check("the editor is still open", (await t.count(".ProseMirror")) === 1);
    await t.check("what was typed is still in the editor", (await t.page.locator(".ProseMirror").innerText()).includes("typed while it changed"));
    await t.until("the changed field shows its new value", async () => (await t.page.locator(".ws-pane--active .item-fields").innerText()).includes("31337"));
    // The same field changed elsewhere while it is being edited: what is typed here wins on save.
    await external(t, `const col = await c(arg.coll); const f = col.fields.find((x) => x.name === "Notes"); const it = await repo.getItem(col, arg.item); await repo.updateItem(col, arg.item, { ...it.values, [f.id]: "Written elsewhere" });`, { coll, item });
    await t.check("an edit of the same field elsewhere doesn't replace what is being typed", (await t.page.locator(".ProseMirror").innerText().catch(() => "")).includes("typed while it changed"), "the editor's text was replaced");
    await t.page.keyboard.press("Control+Enter");
    await t.settle();
    await t.until("saving keeps what was typed here", async () => (await t.page.locator(".ws-pane--active .item-fields").innerText()).includes("typed while it changed"));
    await t.audit("after changes from elsewhere");
  }, { viewport: vp, smoke: vp === "desktop" });
}

test("the open item is deleted elsewhere", async (t) => {
  await t.boot();
  const ids = await t.seed(profileSpec("typical", { items: 3 }));
  const coll = ids.collections.books;
  const item = ids.items["books/i1"];
  await t.seed({ prefs: { "kubus.workspace.default": wsLayout([[t.itemPath(coll, item)], [t.listPath(coll)]], { active: 0 }) } });
  await t.open(t.itemPath(coll, item), { keepTabs: true });
  const v = t.page.locator(".ws-pane").first().getByRole("button", { name: "Edit Count", exact: true }).first();
  await v.click();
  await t.editorReady();
  await external(t, "await repo.deleteItem(arg);", item);
  await t.audit("item page after its item was deleted");
  const left = await t.page.locator(".ws-pane").first().innerText();
  await t.check("the page says the item is gone (not blank)", left.trim().length > 0, "empty pane");
  const rows = await t.page.locator(".ws-pane").nth(1).locator(".items-table tbody tr:not(.table-add-row)").count();
  await t.check("the list in the other pane drops it", rows === 2, `${rows} rows`);
});

test("a collection is deleted while its pages are open", async (t) => {
  await t.boot();
  const ids = await t.seed(matrixSpec("typical", { items: 3 }));
  const coll = ids.collections.books;
  await t.seed({ prefs: { "kubus.workspace.default": wsLayout([[t.listPath(coll), t.itemPath(coll, ids.items["books/i0"])], ["/collections"]], { active: 0 }) } });
  await t.open(t.listPath(coll), { keepTabs: true });
  await t.openPanel(t.page.locator(".ws-pane").first().locator(".ws-tab-slot:not([hidden]) .block .section-header").first(), "Fields");
  await external(t, "await repo.deleteCollection(arg);", coll);
  await t.audit("collection page after its collection was deleted");
  await t.check("no popover is left hanging over a page that is gone", (await t.count(".toolbar-popover.cds--popover--open")) === 0 || (await t.count(".ws-pane .items-table")) > 0);
  await t.until("the overview no longer lists it", async () => !(await t.page.locator(".ws-pane").nth(1).innerText()).includes("Books"));
  await t.page.locator(".ws-pane").first().locator(".cds--tabs__nav-item").nth(1).click().catch(() => {});
  await t.settle();
  await t.audit("its item page after the collection was deleted");
});

for (const vp of ["desktop", "phone"]) {
  test(`fields renamed, added and removed while a table is open @ ${vp}`, async (t) => {
    await t.boot();
    const ids = await t.seed(profileSpec("typical", { items: 5 }));
    const coll = ids.collections.books;
    await t.open(t.listPath(coll));
    const edit = (fn) => external(t, `const col = await c(arg); const fields = (${fn})(col.fields); await repo.saveCollection({ id: col.id, name: col.name, pluralName: col.pluralName, icon: col.icon, description: col.description, spaceIds: col.spaceIds, fields }, "default");`, coll);
    await edit(`(fs) => fs.map((f) => f.name === "Count" ? { ...f, name: "Count renamed to something much longer" } : f)`);
    await t.audit("a field renamed");
    // Column names: the header of a table, the line labels (data-label) of a stacked one.
    const names = () => t.page.locator(".ws-pane--active .items-table").first().evaluate((el) => [...el.querySelectorAll("th, td[data-label]")].map((c) => c.getAttribute("data-label") || c.textContent).join("|"));
    await t.check("the column shows the new name", (await names()).includes("Count renamed"));
    await edit(`(fs) => [...fs, { id: crypto.randomUUID(), name: "Added field", kind: "string", targetCollectionId: null, componentId: null, componentArgs: {}, choiceFilter: [], toggleIcon: null, aiPrompt: null, aiOutput: null }]`);
    await t.audit("a field added");
    await edit(`(fs) => fs.filter((f) => f.name !== "Date" && f.name !== "Tags")`);
    await t.audit("two fields removed");
    await t.check("removed columns are gone", !(await names()).includes("Tags"));
    // An item page of the collection takes the same changes.
    await t.open(t.itemPath(coll, ids.items["books/i0"]));
    await edit(`(fs) => fs.filter((f) => f.name !== "Notes")`);
    await t.audit("item page after a field was removed");
  }, { viewport: vp });
}

test("many changes in a burst while a table is shown", async (t) => {
  await t.boot();
  const ids = await t.seed(profileSpec("typical", { items: 10 }));
  const coll = ids.collections.books;
  await t.open(t.listPath(coll));
  // 40 writes in quick succession (a sync catching up): the page keeps up and ends right.
  await external(t, `const col = await c(arg); const f = col.fields.find((x) => x.name === "Count"); const items = await repo.listItems(col, "default"); for (let i = 0; i < 40; i++) { const it = items[i % items.length]; await repo.updateItem(col, it.id, { ...it.values, [f.id]: 1000 + i }); }`, coll);
  await t.settle(500);
  const text = await t.page.locator(".ws-pane--active .items-table").innerText();
  await t.check("the last values are shown", ["1039", "1038", "1030"].every((v) => text.includes(v)), "not the last written values");
  await t.audit("after a burst of changes");
});
