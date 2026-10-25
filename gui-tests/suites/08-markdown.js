// The Markdown editor and view: typing every GFM construct, Ctrl+Enter, height follows the content
// (no inner scrolling), wide tables and code in narrow panes, links, {{ }} chips, task boxes.

async function openNotesEditor(t) {
  const v = t.page.getByRole("button", { name: "Edit Notes", exact: true }).first();
  await v.scrollIntoViewIfNeeded();
  await v.click({ position: await t.visiblePoint(v) });
  await t.page.waitForSelector(".ProseMirror", { timeout: 5000 });
  await t.wait(200);
}

for (const vp of ["desktop", "phone"]) {
  test(`markdown: type every GFM construct @ ${vp}`, async (t) => {
    await t.boot();
    const spec = profileSpec("typical", { items: 2 });
    spec.collections[0].items.push({ key: "md", values: { title: "Markdown playground", notes: "Start." } });
    const ids = await t.seed(spec);
    await t.open(t.itemPath(ids.collections.books, ids.items["books/md"]));
    await openNotesEditor(t);
    await t.page.keyboard.press("Control+End");
    const lines = [
      "", "# Heading 1", "## Heading 2", "### Heading 3", "Plain **bold** *italic* ~~strike~~ `code` text.",
      "- bullet one", "nested?", "", "1. first", "second", "", "- [ ] a task", "another task", "", "> a quote line",
      "", "```", "const x = 1; // a code block with a line long enough to need sideways room in narrow panes for sure", "```",
      "", "| a | b | c |", "", "Final paragraph with a URL https://example.com/a/very/long/link/that/does/not/break/anywhere",
    ];
    for (const line of lines) {
      await t.page.keyboard.type(line);
      await t.page.keyboard.press("Enter");
    }
    await t.settle();
    await t.audit("editor with typed content");
    const scrolls = await t.page.locator(".ProseMirror").evaluate((el) => {
      let n = el;
      while (n && n !== document.body) {
        const s = getComputedStyle(n);
        if ((s.overflowY === "auto" || s.overflowY === "scroll") && n.scrollHeight > n.clientHeight + 2 && !n.classList.contains("ws-pane__body")) return n.className;
        n = n.parentElement;
      }
      return null;
    });
    await t.check("the editor grows with its content (no inner scrolling)", scrolls === null, `scrolls inside ${scrolls}`);
    await t.page.keyboard.press("Control+Enter");
    await t.settle();
    await t.check("Ctrl+Enter saves and closes the editor", (await t.count(".ProseMirror")) === 0, "editor still open");
    await t.audit("rendered markdown");
    const html = await t.page.locator(".item-fields").innerHTML();
    for (const [what, re] of [["heading", /<h1/], ["bold", /<strong/], ["strike", /<del|<s>/], ["code block", /<pre/], ["quote", /<blockquote/], ["task list", /task-list/]]) {
      await t.check(`typed ${what} renders`, re.test(html), `no ${what} in the rendered field`);
    }
  }, { viewport: vp });

  test(`markdown: long content, wide tables and code @ ${vp}`, async (t) => {
    await t.boot();
    const spec = profileSpec("long", { items: 2 });
    spec.collections[0].items.push({ key: "huge", values: { title: "Huge note", notes: Array.from({ length: 30 }, (_, i) => `## Section ${i}\n\n${MARKDOWN.long}`).join("\n\n") } });
    const ids = await t.seed(spec);
    const started = Date.now();
    await t.open(t.itemPath(ids.collections.books, ids.items["books/huge"]));
    await t.check(`a 30-section note renders within 6s (${((Date.now() - started) / 1000).toFixed(1)}s)`, Date.now() - started < 6000, `${Date.now() - started}ms`);
    await t.audit("huge note");
    const t0 = Date.now();
    await openNotesEditor(t);
    await t.check(`the editor opens on a huge note within 4s (${((Date.now() - t0) / 1000).toFixed(1)}s)`, Date.now() - t0 < 4000, `${Date.now() - t0}ms`);
    await t.audit("editing a huge note", { shotOnFail: true });
    await t.page.keyboard.press("Escape");
    await t.page.keyboard.press("Escape");
  }, { viewport: vp, heavy: true });

  test(`markdown: links, hover popover, {{ }} chips, task boxes @ ${vp}`, async (t) => {
    await t.boot();
    const spec = profileSpec("typical", { items: 2 });
    spec.collections[0].items.push({ key: "links", values: { title: "Links", notes: "A [link to somewhere](https://example.com) and [an app link](books) and a chip {{ 1 + 1 }} here.\n\n- [ ] toggle me\n- [x] done already\n" } });
    const ids = await t.seed(spec);
    await t.open(t.itemPath(ids.collections.books, ids.items["books/links"]));
    await t.audit("view with links, chip result and tasks");
    // Task boxes toggle in the view without opening the editor or moving anything.
    const task = t.page.locator(".md-view__task--toggle").first();
    if (await task.count()) {
      await t.noShift("toggling a task box in the view moves nothing", async () => {
        await task.click();
        await t.wait(200);
      }, { scope: ".ws-pane--active .ws-pane__body" });
      await t.check("toggling a task does not open the editor", (await t.count(".ProseMirror")) === 0);
    }
    await openNotesEditor(t);
    await t.audit("editor with a chip");
    const link = t.page.locator(".ProseMirror a").first();
    if (await link.count()) {
      await link.hover();
      await t.wait(500);
      await t.audit("link hover popover");
    }
    const chip = t.page.locator(".ProseMirror [data-section], .ProseMirror .md-section, .ProseMirror .section-chip").first();
    if (await chip.count()) {
      await chip.click();
      await t.settle();
      await t.audit("code dialog of a chip");
      await t.closeAll();
    }
    await t.page.keyboard.press("Control+Enter");
    await t.settle();
  }, { viewport: vp });
}
