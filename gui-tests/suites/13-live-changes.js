// Data changing underneath (another pane, a sync): an open editor keeps what is typed in it while its item
// changes through the change feed.

/** Writes through the repository, as another pane or a sync would (the page only sees the change feed). */
async function external(t, fn, arg) {
  await t.page.evaluate(new Function("arg", `return (async () => { const repo = window.kubus.repo; const c = async (id) => (await repo.listCollections()).find((x) => x.id === id); ${fn} })()`), arg);
  await t.settle(300);
}

test("an open editor survives changes to its item @ desktop", async (t) => {
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
}, { viewport: "desktop", smoke: true });
