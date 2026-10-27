// The Markdown editor and view: typing every GFM construct, Ctrl+Enter, height follows the content
// (no inner scrolling), wide tables and code in narrow panes, links, braces as text, task boxes.

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

  test(`markdown: links, hover popover, braces as text, task boxes @ ${vp}`, async (t) => {
    await t.boot();
    const spec = profileSpec("typical", { items: 2 });
    spec.collections[0].items.push({ key: "links", values: { title: "Links", notes: "A [link to somewhere](https://example.com) and [an app link](books) and braces {{ 1 + 1 }} here.\n\n- [ ] toggle me\n- [x] done already\n" } });
    const ids = await t.seed(spec);
    await t.open(t.itemPath(ids.collections.books, ids.items["books/links"]));
    await t.audit("view with links, braces and tasks");
    // A value is data: {{ }} in it shows as typed, never run.
    await t.check("{{ }} in a Markdown value shows as typed", (await t.page.locator(".ws-pane--active .item-fields").innerText()).includes("{{ 1 + 1 }}"), "braces changed or run");
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
    await t.audit("editor with links and braces");
    const link = t.page.locator(".ProseMirror a").first();
    if (await link.count()) {
      await link.hover();
      await t.wait(500);
      await t.audit("link hover popover");
    }
    await t.check("{{ }} is plain text in the editor", (await t.page.locator(".ProseMirror").first().innerText()).includes("{{ 1 + 1 }}"), "braces changed");
    await t.page.keyboard.press("Control+Enter");
    await t.settle();
  }, { viewport: vp });
}

// HTML fields look like Markdown fields: the frame gets the app's fonts (frameFonts.ts) and the
// same type styles, so the same text is set identically, offline too.
for (const vp of ["desktop", "phone"]) {
  test(`HTML fields render text exactly like Markdown fields @ ${vp}`, async (t) => {
    await t.boot();
    const spec = profileSpec("typical", { items: 1 });
    spec.collections[0].items.push({
      key: "same",
      values: {
        title: "Same text twice",
        // One short paragraph per style: where a long line breaks may differ (the Markdown view keeps
        // spaces as ProseMirror does, white-space: break-spaces, which HTML can't: its source's line
        // breaks would show), the type itself may not.
        notes: "Plain text\n\n**bold text**\n\n*italic text*\n\n***bold italic***\n\n`code text`\n\n[a link](https://example.com)",
        html: "<p>Plain text</p><p><strong>bold text</strong></p><p><em>italic text</em></p><p><strong><em>bold italic</em></strong></p><p><code>code text</code></p><p><a href=\"https://example.com\">a link</a></p>",
      },
    });
    const ids = await t.seed(spec);
    await t.open(t.itemPath(ids.collections.books, ids.items["books/same"]));
    await t.page.waitForSelector("iframe.html-frame");
    // Each inline part: its type style and the width it is set in.
    const measure = (root) => {
      const ps = [...root.querySelectorAll("p")];
      const p = ps[0];
      const part = (sel) => {
        const el = sel ? ps.map((x) => x.querySelector(sel)).find(Boolean) : p;
        if (!el) return { missing: sel };
        const s = getComputedStyle(el);
        const r = document.createRange();
        r.selectNodeContents(sel ? el : p.firstChild);
        return { family: s.fontFamily.split(",")[0].replace(/"/g, ""), size: s.fontSize, weight: s.fontWeight, style: s.fontStyle, lineHeight: s.lineHeight, spacing: s.letterSpacing, lines: r.getClientRects().length, width: Math.round(r.getBoundingClientRect().width * 10) / 10 };
      };
      return { box: Math.round(p.getBoundingClientRect().width * 10) / 10, left: Math.round(p.getBoundingClientRect().left * 10) / 10, plain: part(null), bold: part("strong"), italic: part("em"), boldItalic: part("strong em, em strong"), code: part("code"), link: part("a"), plexLoaded: document.fonts.check('600 14px "IBM Plex Sans"') && [...document.fonts].some((f) => f.family.replace(/"/g, "") === "IBM Plex Sans" && f.status === "loaded") };
    };
    const md = await t.page.locator(".item-fields .md-view").first().evaluate((root, src) => new Function(`return (${src})`)()(root), measure.toString());
    let inFrame = null;
    for (let i = 0; i < 40 && !inFrame; i++) {
      const frame = t.page.frames().find((f) => f !== t.page.mainFrame());
      const r = frame ? await frame.evaluate(`(${measure.toString()})(document)`).catch(() => null) : null;
      if (r && r.plexLoaded) inFrame = r;
      else await t.wait(100);
    }
    await t.require("the HTML frame has the app's IBM Plex loaded", !!inFrame, "Plex never loaded in the frame");
    // The text runs as wide in both, so it wraps at the same words.
    await t.check("the text is as wide in HTML as in Markdown", Math.abs(md.box - inFrame.box) <= 0.5, `${md.box} → ${inFrame.box}`);
    for (const k of ["plain", "bold", "italic", "boldItalic", "code", "link"]) {
      const a = md[k], b = inFrame[k];
      const diff = a.missing || b.missing ? [`no ${a.missing || b.missing} in ${a.missing ? "Markdown" : "HTML"}`] : ["family", "size", "weight", "style", "lineHeight", "spacing", "lines"].filter((x) => a[x] !== b[x]).map((x) => `${x} ${a[x]} → ${b[x]}`);
      if (Math.abs(a.width - b.width) > 0.5) diff.push(`width ${a.width} → ${b.width}`);
      await t.check(`${k} text is set the same in Markdown and HTML`, diff.length === 0, diff.join("; "));
    }
    await t.audit("Markdown and HTML fields side by side");
  }, { viewport: vp });
}
