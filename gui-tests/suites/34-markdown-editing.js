// The Markdown editor, asserted on the Markdown that gets stored: Tab in a table, task boxes, typed links.

/** Seeds a Book whose Notes are `notes`, opens its page. */
async function openNote(t, notes) {
  await t.boot();
  const spec = profileSpec("typical", { items: 2 });
  spec.collections[0].items.push({ key: "md", values: { title: "Editing", notes } });
  const ids = await t.seed(spec);
  await t.open(t.itemPath(ids.collections.books, ids.items["books/md"]));
  return ids;
}

/** The stored Notes of that Book. */
const storedNotes = (t, ids) =>
  t.page.evaluate(async ([cid, iid]) => {
    const c = (await window.kubus.repo.listCollections()).find((x) => x.id === cid);
    const it = (await window.kubus.repo.listItems(c, "default")).find((i) => i.id === iid);
    return it.values[c.fields.find((f) => f.name === "Notes").id];
  }, [ids.collections.books, ids.items["books/md"]]);

async function openEditor(t) {
  const v = t.page.getByRole("button", { name: "Edit Notes", exact: true }).first();
  await v.scrollIntoViewIfNeeded();
  await v.click({ position: await t.visiblePoint(v) });
  await t.page.waitForSelector(".ProseMirror", { timeout: 5000 });
  await t.wait(200);
}

/** Saves with Ctrl+Enter and waits until the editor is gone. */
async function saveEditor(t) {
  await t.page.keyboard.press("Control+Enter");
  await t.until("the editor closed", async () => (await t.count(".ProseMirror")) === 0);
  await t.settle();
}

test("markdown editing: Tab in a table, task boxes and typed links", async (t) => {
  const ids = await openNote(t, "| a | b |\n| - | - |\n| 1 | 2 |\n\n- [ ] one\n- [x] two\n\nEnd");
  await openEditor(t);
  const pm = t.page.locator(".ProseMirror").first();

  // Tab moves between cells; in the last cell it adds a row and goes into it.
  // The editor puts its caret where the opening click was once it has loaded: a click on the cell
  // before that is undone by it, so click until the caret stays in the cell.
  await t.until("the caret is in the first cell", async () => {
    await pm.locator("td").first().click();
    await t.wait(150);
    return t.page.evaluate(() => !!document.getSelection()?.anchorNode?.parentElement?.closest(".ProseMirror td"));
  });
  await t.page.keyboard.press("Tab");
  await t.page.keyboard.type("X");
  await t.check("Tab moves to the next cell", (await pm.locator("td").nth(1).innerText()).includes("X"), await pm.locator("td").nth(1).innerText());
  await t.check("…without adding a row", (await pm.locator("tr").count()) === 2);
  await t.page.keyboard.press("Tab");
  await t.until("Tab in the last cell adds a row", async () => (await pm.locator("tr").count()) === 3);
  await t.page.keyboard.type("Y");
  await t.check("…and the caret is in its first cell", (await pm.locator("tr").nth(2).locator("td").first().innerText()).includes("Y"));
  await t.page.keyboard.press("Shift+Tab");
  await t.check("Shift+Tab is the cell keymap's, not a new row", (await pm.locator("tr").count()) === 3);

  // A task box is toggled by a click on its box (the li's left edge); the text is not.
  const tasks = pm.locator('li[data-item-type="task"]');
  const clickBox = async (i) => {
    const b = await tasks.nth(i).boundingBox();
    await t.page.mouse.click(b.x + 6, b.y + 12);
  };
  await clickBox(0);
  await t.until("a click on the box checks it", async () => (await tasks.nth(0).getAttribute("data-checked")) === "true");
  await clickBox(1);
  await t.until("…and unchecks a checked one", async () => (await tasks.nth(1).getAttribute("data-checked")) !== "true");
  const b0 = await tasks.nth(0).boundingBox();
  await t.page.mouse.click(b0.x + b0.width - 10, b0.y + 12);
  await t.check("a click on the task's text does not toggle", (await tasks.nth(0).getAttribute("data-checked")) === "true");

  // The input rule: [text](url) becomes a link when ) is typed.
  await t.page.keyboard.press("Control+End");
  await t.page.keyboard.press("Enter");
  await t.page.keyboard.type("See [the docs](https://example.org/docs) now");
  await t.until("a typed [text](url) becomes a link", async () => (await pm.locator('a[href="https://example.org/docs"]').count()) === 1);
  await t.check("…showing only its text", (await pm.locator("a").first().innerText()) === "the docs");
  await t.audit("editor with a table, task boxes and a typed link");
  await saveEditor(t);
  const notes = await storedNotes(t, ids);
  await t.check("the table got its cell and row", /\| a\s*\| b\s*\|/.test(notes) && notes.includes("X") && /\|\s*Y\s*\|/.test(notes), notes);
  await t.check("the task boxes are stored toggled", /[-*] \[x\] one/.test(notes) && /[-*] \[ \] two/.test(notes), notes);
  await t.check("the link is stored as Markdown", notes.includes("[the docs](https://example.org/docs)"), notes);
  await t.check("the view shows the table and the link", (await t.count(".item-fields .md-view table")) === 1 && (await t.count('.item-fields .md-view a[href="https://example.org/docs"]')) === 1);
}, { smoke: true });
