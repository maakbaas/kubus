// The Markdown editor's own behaviours, each asserted on the Markdown that gets stored and on what is
// shown: Tab in a table, task boxes in the editor, the typed-link input rule, clicking links (plain,
// Ctrl) and #tags, the hover popover's Open / Edit / Remove, links typed by name, the code-language
// picker and stored images.

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

/** Stubs window.open, collecting the addresses opened. */
const stubOpen = (t) => t.page.evaluate(() => { window.__opened = []; window.open = (...a) => (window.__opened.push(a[0]), null); });

test("markdown editing: Tab in a table, task boxes and typed links", async (t) => {
  const ids = await openNote(t, "| a | b |\n| - | - |\n| 1 | 2 |\n\n- [ ] one\n- [x] two\n\nEnd");
  await openEditor(t);
  const pm = t.page.locator(".ProseMirror").first();

  // Tab moves between cells; in the last cell it adds a row and goes into it.
  await pm.locator("td").first().click();
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

test("markdown editing: #tags are decorated and clicked", async (t) => {
  await openNote(t, "Tags: #alpha and #beta/sub, `#incode` and [#inlink](https://example.com/y).");
  await openEditor(t);
  const pm = t.page.locator(".ProseMirror").first();
  // Decorations only: in text, not in code or a link's text.
  const tagTexts = await pm.locator("[data-tag]").evaluateAll((els) => els.map((e) => e.getAttribute("data-tag")));
  await t.check("#tags in text are decorated (not in code or a link)", JSON.stringify(tagTexts) === JSON.stringify(["#alpha", "#beta/sub"]), JSON.stringify(tagTexts));
  await pm.click({ position: { x: 4, y: 4 } });
  await t.page.keyboard.press("Control+End");
  await t.page.keyboard.type(" and #gamma");
  await t.until("a typed tag is decorated", async () => (await pm.locator('[data-tag="#gamma"]').count()) === 1);
  await t.page.keyboard.press("Backspace");
  await t.until("…and re-decorated as the text changes", async () => (await pm.locator('[data-tag="#gamm"]').count()) === 1);
  await t.audit("editor with tags");
  const tabNames = () => t.page.locator(".ws-pane__tabs .cds--tabs__nav-item").allInnerTexts();
  await pm.locator('[data-tag="#beta/sub"]').click({ modifiers: ["Control"], force: true });
  await t.until("Ctrl+click on a tag opens its search beside", async () => (await tabNames()).length === 2 || "no second tab");
  await t.check("…the page being edited stays open", (await t.count(".ProseMirror")) === 1);
  await t.page.locator(".ws-pane__tabs .cds--tabs__nav-item", { hasText: "Editing" }).first().click();
  await t.until("back on the edited page", async () => (await pm.isVisible()) || "hidden");
  await pm.locator('[data-tag="#alpha"]').click({ force: true });
  await t.until("a plain click on a tag searches for it here", async () => ((await t.page.locator(".ws-pane--active").innerText()).includes("#alpha") && (await t.count(".ProseMirror")) === 0) || "not shown");
});

test("markdown editing: clicking links (plain and Ctrl)", async (t) => {
  await openNote(t, "Go to [the books](books) or [outside](https://example.com/x) now.");
  await openEditor(t);
  const pm = t.page.locator(".ProseMirror").first();
  // An outside link opens in a new window (stubbed).
  await stubOpen(t);
  await pm.getByRole("link", { name: "outside" }).click();
  await t.until("a plain click on an outside link opens it in a new window", async () => (await t.page.evaluate(() => window.__opened)).includes("https://example.com/x"));
  await t.check("…and the editor stays", (await t.count(".ProseMirror")) === 1);
  // Ctrl+click opens the page beside (a new tab where there is no room); the one being edited stays.
  const tabNames = () => t.page.locator(".ws-pane__tabs .cds--tabs__nav-item").allInnerTexts();
  await pm.getByRole("link", { name: "the books" }).click({ modifiers: ["Control"] });
  await t.until("Ctrl+click on a link to a page opens it beside", async () => (await tabNames()).some((n) => n.includes("Books")) || "no Books tab");
  await t.check("…the page that was being edited stays open", (await tabNames()).some((n) => n.includes("Editing")) && (await t.count(".ProseMirror")) === 1);
  await t.audit("after Ctrl+click on a link");
});

test("markdown editing: a plain click on an app link opens it here", async (t) => {
  await openNote(t, "Go to [the books](books) now.");
  await openEditor(t);
  await t.page.locator(".ProseMirror").first().getByRole("link", { name: "the books" }).click();
  await t.until("the app link opens in this tab", async () => ((await t.page.locator(".ws-pane--active").innerText()).includes("Books") && (await t.count(".ProseMirror")) === 0) || "not shown");
});

test("markdown editing: link popover (open, edit, remove) and links by name", async (t) => {
  const ids = await openNote(t, "A [site](https://example.com/a) and [shelf](books) and [gone](https://example.com/gone).");
  await openEditor(t);
  const pm = t.page.locator(".ProseMirror").first();
  const popover = t.page.locator(".md-link-popover");
  const hover = async (name) => {
    await pm.getByRole("link", { name }).hover();
    await popover.waitFor({ timeout: 3000 });
    await t.wait(200);
  };
  await hover("site");
  await t.check("hovering a link shows its address", (await popover.locator(".md-link-popover__href").innerText()) === "https://example.com/a");
  await t.audit("link hover popover (address)");
  // Open.
  await stubOpen(t);
  await popover.getByRole("button", { name: "Open link" }).click();
  await t.until("Open link opens it outside", async () => (await t.page.evaluate(() => window.__opened)).includes("https://example.com/a"));
  // Edit.
  await hover("site");
  await popover.getByRole("button", { name: "Edit link" }).click();
  const url = t.page.getByRole("textbox", { name: "URL" });
  await url.waitFor();
  await t.check("Edit link opens a dialog with the URL", (await url.inputValue()) === "https://example.com/a");
  await t.audit("edit link dialog");
  await url.fill("");
  await t.check("an empty URL cannot be applied", await t.page.getByRole("button", { name: "Apply" }).isDisabled());
  await url.fill("https://example.com/b");
  await t.page.getByRole("button", { name: "Apply" }).click();
  await t.until("Apply changes the link", async () => (await pm.locator('a[href="https://example.com/b"]').count()) === 1);
  await t.check("…and keeps its text", (await pm.locator("a").first().innerText()) === "site");
  // Cancel keeps it.
  await hover("site");
  await popover.getByRole("button", { name: "Edit link" }).click();
  await url.waitFor();
  await url.fill("https://example.com/never");
  await t.page.getByRole("button", { name: "Cancel" }).click();
  await t.wait(300);
  await t.check("Cancel leaves the link", (await pm.locator('a[href="https://example.com/b"]').count()) === 1);
  // An app link: shown by name in the popover, and typed by name in the dialog, stored by id.
  const shelfHref = () => pm.locator("a").nth(1).getAttribute("href");
  await hover("shelf");
  await t.check("an app link is shown by name in the popover", (await popover.locator(".md-link-popover__href").innerText()) === "books", await popover.locator(".md-link-popover__href").innerText());
  await t.check("…stored by id", (await shelfHref()).startsWith("#/collections/"), await shelfHref());
  const booksHref = await shelfHref();
  await popover.getByRole("button", { name: "Edit link" }).click();
  await url.waitFor();
  await t.check("the dialog has the name form", (await url.inputValue()) === "books", await url.inputValue());
  await url.fill("authors");
  await t.page.getByRole("button", { name: "Apply" }).click();
  await t.until("a name typed in the dialog is stored by id", async () => ((await shelfHref()) !== booksHref && (await shelfHref()).startsWith("#/collections/")) || "unchanged");
  // Remove.
  await hover("gone");
  await popover.getByRole("button", { name: "Remove link" }).click();
  await t.until("Remove link removes the link, keeps the text", async () => ((await pm.getByRole("link", { name: "gone" }).count()) === 0 && (await pm.innerText()).includes("gone")) || "still a link");
  // A link typed by name is rewritten to its id; one naming nothing stays.
  await pm.click({ position: { x: 4, y: 4 } });
  await t.page.keyboard.press("Control+End");
  await t.page.keyboard.type(" Typed [by name](authors");
  await t.page.keyboard.type(")");
  await t.until("a link typed by name is stored by id", async () => ((await pm.locator("a").filter({ hasText: "by name" }).getAttribute("href").catch(() => "")) || "").startsWith("#/collections/"));
  await t.page.keyboard.type(" and [nowhere](nothing-like-this) too");
  await t.check("text typed after the link is not part of it", (await pm.locator("a").filter({ hasText: "by name" }).innerText()) === "by name", await pm.locator("a").filter({ hasText: "by name" }).innerText());
  await t.wait(500);
  await t.check("a name that names nothing stays as written", (await pm.locator("a").filter({ hasText: "nowhere" }).getAttribute("href")) === "nothing-like-this");
  await saveEditor(t);
  const notes = await storedNotes(t, ids);
  await t.check("stored: edited link, id links, removed link as plain text", notes.includes("[site](https://example.com/b)") && /\[shelf\]\(#\/collections\/[^)]+\)/.test(notes) && /\[by name\]\(#\/collections\/[^)]+\)/.test(notes) && notes.includes("gone") && !notes.includes("example.com/gone") && notes.includes("(nothing-like-this)"), notes);
  await t.audit("saved note with links");
});

test("markdown editing: code language picker and stored images", async (t) => {
  await t.boot();
  const spec = profileSpec("typical", { items: 2 });
  spec.images = [{ key: "pic", w: 80, h: 50 }];
  spec.collections[0].items.push({ key: "md", values: { title: "Editing", notes: "```\nlet a = 1;\n```\n\n```zig\nconst x = 1;\n```\n\nafter" } });
  const ids = await t.seed(spec);
  const hash = ids.images.pic;
  // Put images into the note now that the file id is known.
  const GIF = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
  await t.page.evaluate(async ([cid, iid, hash, GIF]) => {
    const repo = window.kubus.repo;
    const c = (await repo.listCollections()).find((x) => x.id === cid);
    const it = (await repo.listItems(c, "default")).find((i) => i.id === iid);
    const f = c.fields.find((x) => x.name === "Notes").id;
    await repo.updateItem(c, iid, { ...it.values, [f]: it.values[f] + `\n\n![stored pic](files/${hash} "Stored title")\n\n![outside](${GIF})\n` });
  }, [ids.collections.books, ids.items["books/md"], hash, GIF]);
  await t.open(t.itemPath(ids.collections.books, ids.items["books/md"]));
  await openEditor(t);
  const pm = t.page.locator(".ProseMirror").first();
  const selects = pm.locator('select[aria-label="Code language"]');
  await t.check("each code block has a language picker", (await selects.count()) === 2);
  await t.check("…with its fence language (an unknown one added)", (await selects.nth(0).inputValue()) === "" && (await selects.nth(1).inputValue()) === "zig");
  await selects.nth(0).selectOption("javascript");
  await t.until("choosing a language sets the fence", async () => (await selects.nth(0).inputValue()) === "javascript");
  await selects.nth(1).selectOption("");
  await t.until("back to plain text", async () => (await selects.nth(1).inputValue()) === "");
  // Typing in a block keeps its picker.
  await pm.locator("pre code").first().click();
  await t.page.keyboard.press("End");
  await t.page.keyboard.type(" // x");
  await t.check("typing in the code keeps the picker", (await selects.count()) === 2 && (await selects.nth(0).inputValue()) === "javascript");
  // Images.
  const imgs = pm.locator("img:not(.ProseMirror-separator)");
  await t.check("both images are in the editor", (await imgs.count()) === 2, await pm.innerHTML());
  await t.until("a stored image loads from the file store", async () => (await imgs.nth(0).evaluate((i) => i.complete && i.naturalWidth === 80)) || "not loaded");
  await t.check("…with its alt text and title", (await imgs.nth(0).getAttribute("alt")) === "stored pic" && (await imgs.nth(0).getAttribute("title")) === "Stored title");
  await t.check("an image that is not a stored file keeps its address", (await imgs.nth(1).getAttribute("src")) === GIF);
  await t.audit("editor with code pickers and an image");
  await saveEditor(t);
  const notes = await storedNotes(t, ids);
  await t.check("stored: the languages and the images", notes.includes("```javascript") && !notes.includes("```zig") && notes.includes("const x = 1;") && notes.includes(`![stored pic](files/${hash} "Stored title")`) && notes.includes(`![outside](${GIF})`), notes);
  // Reopened: the cached image shows at once.
  await openEditor(t);
  await t.until("a reopened editor shows the stored image", async () => (await t.page.locator(".ProseMirror img:not(.ProseMirror-separator)").first().evaluate((i) => i.complete && i.naturalWidth === 80)) || "not loaded");
  await t.page.keyboard.press("Escape");
});

test("markdown editing: table row and column handles", async (t) => {
  const ids = await openNote(t, "| a | b |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |\n\nAfter");
  await openEditor(t);
  const pm = t.page.locator(".ProseMirror").first();
  const rows = () => pm.locator("tr").count();
  const cellsInRow = (i) => pm.locator("tr").nth(i).locator("th, td").count();
  const hoverCell = async (cell) => {
    const b = await cell.boundingBox();
    await t.page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  };
  /** Hovers `cell`, opens its row / column handle's menu and presses `action`. */
  const act = async (kind, cell, action) => {
    await hoverCell(cell);
    const handle = t.page.locator(`.md-table-handle--${kind} button`).first();
    await handle.waitFor({ timeout: 3000 });
    await handle.click();
    await t.page.getByRole("button", { name: action, exact: true }).click();
    await t.settle(150);
  };
  await t.check("the table has a header and two rows", (await rows()) === 3);
  // A handle shows for the hovered row (and column) and is not there elsewhere.
  await hoverCell(pm.locator("tr").nth(1).locator("td").first());
  await t.until("hovering the first column shows the row handle", async () => (await t.count(".md-table-handle--row")) === 1 || "none");
  await t.audit("table row handle", { skip: ["compact-size"] }); // the handles are 1rem x 1.5rem on purpose
  await t.page.getByRole("button", { name: "Row", exact: true }).click();
  await t.check("its menu has the row actions", (await t.page.getByRole("button", { name: "Add row below", exact: true }).count()) === 1);
  await t.audit("table row menu", { skip: ["compact-size"] });
  await t.page.getByRole("button", { name: "Row", exact: true }).click();
  await t.until("the handle's button closes its menu", async () => (await t.page.getByRole("button", { name: "Add row below", exact: true }).count()) === 0 || "open");
  await t.page.mouse.move(5, 5);
  await t.until("the handle goes when the pointer leaves", async () => (await t.count(".md-table-handle")) === 0 || "still there");

  await act("row", pm.locator("tr").nth(1).locator("td").first(), "Add row below");
  await t.check("Add row below adds a row", (await rows()) === 4);
  await act("row", pm.locator("tr").nth(2).locator("td").first(), "Add row above");
  await t.check("Add row above (a body row) adds one", (await rows()) === 5);
  await act("row", pm.locator("tr").first().locator("th").first(), "Add row above");
  await t.check("Add row above the header makes a new header row", (await rows()) === 6 && (await pm.locator("tr").first().locator("th").count()) === 2 && (await pm.locator("tr").first().innerText()).trim() === "" && (await pm.locator("tr").nth(1).locator("th").count()) === 0, `${await rows()} rows`);
  await act("row", pm.locator("tr").first().locator("th").first(), "Delete row");
  await t.check("Delete row on the header promotes the next row", (await rows()) === 5 && (await pm.locator("tr").first().locator("th").count()) === 2 && (await pm.locator("tr").first().innerText()).includes("a"), `${await rows()} rows`);
  await act("row", pm.locator("tr").nth(1).locator("td").first(), "Delete row");
  await t.check("Delete row removes a body row", (await rows()) === 4);
  for (let i = 0; i < 2; i++) await act("row", pm.locator("tr").nth(1).locator("td").first(), "Delete row");
  await t.check("a table keeps one row below its header", (await rows()) === 2, `${await rows()} rows`);

  // Columns, from the header cell of the second column.
  await act("col", pm.locator("th").nth(1), "Add column right");
  await t.check("Add column right adds a column", (await cellsInRow(0)) === 3);
  await act("col", pm.locator("th").nth(1), "Add column left");
  await t.check("Add column left adds one", (await cellsInRow(0)) === 4);
  await act("col", pm.locator("th").nth(1), "Delete column");
  await t.check("Delete column removes one", (await cellsInRow(0)) === 3 && (await cellsInRow(1)) === 3);
  await t.audit("table after handle actions");
  await saveEditor(t);
  const notes = await storedNotes(t, ids);
  await t.check("stored: a three-column table and the text after it", notes.split("\n").filter((l) => l.startsWith("|")).every((l) => l.split("|").length === 5) && notes.includes("After"), notes);

  await openEditor(t);
  await act("col", pm.locator("th").nth(1), "Delete table");
  await t.check("Delete table removes the table", (await pm.locator("table").count()) === 0 && (await pm.innerText()).includes("After"));
  await saveEditor(t);
  await t.check("stored: no table left", !(await storedNotes(t, ids)).includes("|"));
});

/** Pastes (or drops) `files` into the editor the way the browser delivers them. */
async function sendFiles(t, kind, files) {
  await t.page.evaluate(async ([kind, files]) => {
    const dt = new DataTransfer();
    for (const f of files) {
      let blob;
      if (f.png) {
        const canvas = document.createElement("canvas");
        canvas.width = 30;
        canvas.height = 20;
        canvas.getContext("2d").fillRect(0, 0, 30, 20);
        blob = await new Promise((r) => canvas.toBlob(r, "image/png"));
      } else blob = new Blob([f.text], { type: f.type });
      dt.items.add(new File([blob], f.name, { type: f.type }));
    }
    const target = document.querySelector(".ProseMirror");
    if (kind === "paste") target.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    else {
      const r = target.getBoundingClientRect();
      target.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, clientX: r.left + 20, clientY: r.top + 10, bubbles: true, cancelable: true }));
    }
  }, [kind, files]);
}

test("markdown editing: pasted and dropped images are stored as files", async (t) => {
  const ids = await openNote(t, "Start");
  await openEditor(t);
  const pm = t.page.locator(".ProseMirror").first();
  const imgs = pm.locator("img:not(.ProseMirror-separator)");
  await pm.click();
  await t.page.keyboard.press("Control+End");
  await sendFiles(t, "paste", [{ name: "pasted.png", type: "image/png", png: true }]);
  await t.until("a pasted image appears in the text", async () => (await imgs.count()) === 1 || "no image");
  await t.check("…as a stored file with its name", ((await imgs.first().getAttribute("alt")) === "pasted.png"));
  await t.until("…which loads", async () => (await imgs.first().evaluate((i) => i.complete && i.naturalWidth === 30)) || "not loaded");
  await sendFiles(t, "paste", [{ name: "notes.txt", type: "text/plain", text: "x" }]);
  await t.wait(500);
  await t.check("a file that is not an image adds nothing", (await imgs.count()) === 1);
  await sendFiles(t, "drop", [{ name: "dropped.png", type: "image/png", png: true }]);
  await t.until("a dropped image appears too", async () => (await imgs.count()) === 2 || "no second image");
  await t.audit("editor with pasted and dropped images");
  await saveEditor(t);
  const notes = await storedNotes(t, ids);
  await t.check("stored: both as files/<sha256>, not as base64", /!\[pasted\.png\]\(files\/[0-9a-f]{64}\)/.test(notes) && /!\[dropped\.png\]\(files\/[0-9a-f]{64}\)/.test(notes) && !notes.includes("base64"), notes);
  await t.check("the view shows both images", (await t.count(".item-fields .md-view img")) === 2);
});
