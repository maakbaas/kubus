// Perf: the app's hot paths, measured (`--perf` only; each test once, at normal speed). Every phase (t.measure) is one thing a person waits for: from the action (a load, a
// click, a key) to the state it leads to, plus the main thread's busy time, long tasks, elements
// and heap. Seeding, settling and audits are the suite's time, reported apart (perf-summary.json).
// The tests still check what they show (audits, checks): a faster app that shows less is no win.

/** Every row of a table block in the active pane is there (`n` at least). */
const rowsAtLeast = (n) => document.querySelectorAll(".ws-pane--active .items-table tbody tr:not(.table-add-row)").length >= n;
/** The active pane's tables have exactly `n` item rows. */
const rowsExactly = (n) => document.querySelectorAll(".ws-pane--active .items-table tbody tr:not(.table-add-row)").length === n;
/** The active pane shows a page that is done loading. */
const pageShown = () => !!document.querySelector(".ws-pane--active .ws-pane__body .page-header") && !document.querySelector(".page-loading");

/** Opens the app at `path` in a fresh document (the timed part is the caller's). */
const goto = (t, path) => t.page.goto(`${t.base}/?perf=${Date.now()}#${path}`);

/** Types `text` a key at a time, each key measured to the next frame (keystroke latency) as one phase. */
async function typeMeasured(t, name, text) {
  return t.measure(name, async () => {
    for (const ch of text) {
      await t.page.keyboard.press(ch === " " ? "Space" : ch);
      await t.page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())));
    }
  });
}

/** Books with the columns of a typical table (all 15 restack it as cards). */
function bookTable(n, { authors = 20, views = null } = {}) {
  const spec = profileSpec("typical", { items: 0, authors });
  const books = spec.collections[0];
  books.items = allKindItems(n, "typical", { target: "authors", targetCount: authors, image: null });
  books.views = views || [{ name: "All", blocks: [{ kind: "table", layout: { fields: ["title", "count", "date", "done", "fav", "ref", "tags"] } }] }];
  return spec;
}

test("perf: cold start to the first collection page", async (t) => {
  await t.boot();
  const ids = await t.seed(bookTable(300));
  const list = t.listPath(ids.collections.books);
  // A first load (the server and the browser's caches warm), then the measured ones.
  await t.open(list);
  await t.measure("cold start: 300 rows shown", () => goto(t, list), rowsAtLeast, { arg: 300 });
  await t.audit("first collection page");
  await t.measure("cold start: collections overview", () => goto(t, "/collections"), () => [...document.querySelectorAll(".ws-pane--active tbody .icon-label__text")].some((e) => e.textContent === "Authors") && !document.querySelector(".page-loading"));
  await t.measure("open the collection from the side nav", () => t.page.locator(".side-nav-tree").getByText("Books", { exact: true }).first().click(), rowsAtLeast, { arg: 300 });
  await t.audit("collection page from the side nav");
}, { perf: true });

test("perf: a 1,000-row table loads, scrolls and sorts", async (t) => {
  await t.boot();
  const ids = await t.seed(bookTable(1000));
  const list = t.listPath(ids.collections.books);
  await t.open("/collections");
  await t.measure("open 1,000 rows", () => t.go(list, { settle: false }), rowsAtLeast, { arg: 1000 });
  await t.audit("1,000 rows");
  const pane = t.page.locator(".ws-pane--active .ws-pane__body");
  for (const pos of [0.5, 1]) {
    await t.measure(`scroll to ${pos * 100}%`, () => pane.evaluate((el, pos) => (el.scrollTop = el.scrollHeight * pos), pos));
    await t.audit(`scrolled to ${pos * 100}%`, { shotOnFail: true });
  }
  await pane.evaluate((el) => (el.scrollTop = 0));
  const header = (name) => t.page.locator(".ws-pane--active .items-table thead th").filter({ hasText: name }).first();
  const sorted = (dir) => [...document.querySelectorAll(".ws-pane--active .items-table thead th")].some((th) => th.textContent.includes("Count") && th.getAttribute("aria-sort") === dir);
  await t.measure("sort by Count", () => header("Count").locator("button").first().click(), sorted, { arg: "ascending" });
  await t.measure("sort by Count, descending", () => header("Count").locator("button").first().click(), sorted, { arg: "descending" });
  await t.audit("sorted by Count");
  await t.check("still 1,000 rows", await t.page.evaluate(rowsAtLeast, 1000), "rows went missing");
}, { perf: true });

test("perf: computed fields with filters over many items", async (t) => {
  await t.boot();
  const spec = bookTable(600);
  const books = spec.collections[0];
  spec.components = [
    ...spec.components,
    { key: "score", name: "Score", code: "{{ ($item.Count ?? 0) * 3 + ($item.Tags || []).length }}", output: "number" },
    { key: "size", name: "Size", code: "{{ $item.Score > 300 ? 'big' : 'small' }}", output: "string" },
    { key: "blurb", name: "Blurb", code: "**{{ $item.Title }}** by {{ $item.Related || 'nobody' }}, {{ ($item.Todo || []).filter((x) => x.done).length }} done", output: "markdown" },
  ];
  books.fields.push(
    { key: "score", name: "Score", kind: "component", component: "score" },
    { key: "size", name: "Size", kind: "component", component: "size" },
    { key: "blurb", name: "Blurb", kind: "component", component: "blurb" },
  );
  const cols = ["title", "count", "score", "size", "blurb", "done"];
  books.views = [
    { name: "All", blocks: [{ kind: "table", layout: { fields: cols } }] },
    { name: "Big", blocks: [{ kind: "table", layout: { fields: cols }, sort: [{ field: "score", direction: "desc" }] }], filters: [] },
    { name: "Grouped", blocks: [{ kind: "table", layout: { fields: cols }, groupBy: "size" }] },
  ];
  const ids = await t.seed(spec);
  // The "Big" view's filter: a computed field's text.
  await t.page.evaluate(async ({ coll, size }) => {
    const repo = window.kubus.repo;
    const views = await repo.listViews(coll, "default");
    const big = views.find((v) => v.name === "Big");
    await repo.saveView({ ...big, filters: [{ id: crypto.randomUUID(), fieldId: size, operator: "is", value: "big" }] });
  }, { coll: ids.collections.books, size: ids.fields["books.size"] });
  const list = t.listPath(ids.collections.books);
  await t.open("/collections");
  await t.measure("open 600 items with 4 computed fields", () => t.go(list, { settle: false }), rowsAtLeast, { arg: 600 });
  await t.audit("computed fields");
  const tab = (name) => t.page.locator(".ws-pane--active .views-tabs [role=tab]").filter({ hasText: name }).first();
  const selected = (name) => [...document.querySelectorAll(".ws-pane--active .views-tabs [role=tab]")].some((x) => x.textContent.trim().startsWith(name) && x.getAttribute("aria-selected") === "true");
  await t.measure("filter on a computed field (view Big)", () => tab("Big").click(), selected, { arg: "Big" });
  const big = await t.page.evaluate(() => document.querySelectorAll(".ws-pane--active .items-table tbody tr:not(.table-add-row)").length);
  await t.check(`the filter keeps some items, not all (${big})`, big > 0 && big < 600, `${big} rows`);
  await t.measure("group by a computed field", () => tab("Grouped").click(), selected, { arg: "Grouped" });
  await t.audit("grouped by a computed field");
  await t.measure("back to all items", () => tab("All").click(), selected, { arg: "All" });
  // An edit recomputes that item (and the query runs again): Count feeds Score, Score feeds Size.
  const count = t.page.locator(".ws-pane--active .items-table tbody tr").first().locator(".cell-editable[aria-label='Edit Count']");
  await count.click();
  await t.editorReady();
  await t.page.keyboard.press("Control+A");
  await t.page.keyboard.type("777");
  const first = await t.page.locator(".ws-pane--active .items-table tbody tr").first().locator("a").first().innerText();
  await t.measure("save a value computed fields read", () => t.page.keyboard.press("Enter"), (title) => {
    const row = [...document.querySelectorAll(".ws-pane--active .items-table tbody tr")].find((r) => r.querySelector("a")?.textContent === title);
    return !!row && /2331|2332|2333|2334|2335/.test(row.textContent) && !row.querySelector(".cell--editing");
  }, { arg: first });
  await t.audit("after the edit");
}, { perf: true });

test("perf: an item page with many fields, blocks and components, edited in place", async (t) => {
  await t.boot();
  const extra = Array.from({ length: 30 }, (_, k) => ({ key: `x${k}`, name: `Extra ${k}`, kind: pick(["string", "number", "date", "checkbox", "string_list"], k) }));
  const spec = {
    components: [
      { key: "double", name: "Double", code: "{{ ($item.Count ?? 0) * 2 }}", output: "number" },
      { key: "line", name: "Line", code: "**{{ $item.Title }}**: {{ ($item.Tags || []).join(' · ') }}", output: "markdown" },
      { key: "tally", name: "Tally", code: "{{ $items.length }} tasks, {{ $items.filter((i) => i.Done).length }} done, {{ $all.length }} in all", output: "markdown" },
    ],
    collections: [
      {
        key: "projects", name: "Project", plural: "Projects", icon: "Folder",
        fields: [
          ...allKindFields({ target: "projects" }).filter((f) => f.kind !== "image"),
          { key: "double", name: "Double", kind: "component", component: "double" },
          { key: "line", name: "Line", kind: "component", component: "line" },
          ...extra,
        ],
        items: allKindItems(6, "typical", { target: "projects", targetCount: 6, image: null, keyPrefix: "t" }).map((it, i) => {
          for (const e of extra) it.values[e.key] = contentValue(e.kind, "typical", i + 1);
          return it;
        }),
        itemViews: [{
          name: "Page",
          layout: {
            blocks: [
              { kind: "table", title: "Tasks", collection: "tasks", filters: [{ field: "project", operator: "is", value: "$item" }], layout: { fields: ["name", "due", "done", "project"] } },
              { kind: "cards", title: "Task cards", collection: "tasks", filters: [{ field: "project", operator: "is", value: "$item" }], options: { coverFieldId: null, cardWidth: 14, coverRatio: "auto", showTitle: true, listNarrow: false } },
              { kind: "component", title: "Tally", collection: "tasks", componentKey: "tally", filters: [{ field: "project", operator: "is", value: "$item" }] },
              { kind: "markdown", title: "Notes", options: { text: MARKDOWN.long } },
            ],
          },
        }],
      },
      {
        key: "tasks", name: "Task", plural: "Tasks", icon: "Task",
        fields: [{ key: "name", name: "Name", kind: "string" }, { key: "due", name: "Due", kind: "date" }, { key: "done", name: "Done", kind: "checkbox" }, { key: "project", name: "Project", kind: "item", target: "projects" }],
        items: Array.from({ length: 400 }, (_, i) => ({ values: { name: `Task ${i + 1}`, due: contentValue("date", "typical", i), done: i % 3 === 0, project: { ref: `projects/t${i % 2}` } } })),
      },
    ],
  };
  const ids = await t.seed(spec);
  const page = t.itemPath(ids.collections.projects, ids.items["projects/t0"]);
  await t.open("/collections");
  await t.measure("open an item page: 45 fields, 4 blocks, 200 related tasks", () => t.go(page, { settle: false }), () => !!document.querySelector(".ws-pane--active .item-fields") && document.querySelectorAll(".ws-pane--active .items-table tbody tr:not(.table-add-row)").length >= 200);
  await t.audit("item page");
  // A text field: open its editor, type, save.
  const edit = (name) => t.page.locator(".ws-pane--active").getByRole("button", { name: `Edit ${name}`, exact: true }).first();
  await edit("Extra 0").scrollIntoViewIfNeeded();
  await t.measure("open a text field's editor", () => edit("Extra 0").click(), () => !!document.activeElement?.closest(".field-editor"));
  await t.page.keyboard.press("End");
  await typeMeasured(t, "type 24 characters into a text field", " and some more words her");
  await t.measure("save the text field (Enter)", () => t.page.keyboard.press("Enter"), () => [...document.querySelectorAll(".ws-pane--active .item-fields *")].some((e) => e.childElementCount === 0 && e.textContent.endsWith("some more words her")));
  // Count feeds the Double component: saving it recomputes the item.
  await edit("Count").scrollIntoViewIfNeeded();
  await edit("Count").click();
  await t.editorReady();
  await t.page.keyboard.press("Control+A");
  await t.page.keyboard.type("4321");
  await t.measure("save a number a component reads", () => t.page.keyboard.press("Enter"), () => (document.querySelector(".ws-pane--active .item-fields")?.textContent || "").includes("8642"));
  // Markdown: the editor opens in place; typing in it.
  await edit("Notes").scrollIntoViewIfNeeded();
  await t.measure("open the Markdown editor", () => edit("Notes").click(), () => !!document.activeElement?.closest(".md-editor, .field-editor"));
  await t.page.keyboard.press("Control+End");
  await typeMeasured(t, "type 24 characters into Markdown", " typed into the notes ok");
  await t.measure("save the Markdown (click outside)", async () => {
    const b = await t.page.locator(".ws-pane--active .ws-pane__body").boundingBox();
    await t.page.mouse.click(b.x + b.width - 6, b.y + 140);
  }, () => !document.querySelector(".ws-pane--active .md-editor .ProseMirror[contenteditable=true]") && (document.querySelector(".ws-pane--active .item-fields")?.textContent || "").includes("typed into the notes ok"));
  await t.audit("after the edits");
}, { perf: true });

test("perf: switching view tabs, workspace tabs and panes", async (t) => {
  await t.boot();
  const spec = bookTable(300, {
    views: [
      { name: "All", blocks: [{ kind: "table", layout: { fields: ["title", "count", "date", "done", "fav", "ref", "tags"] } }] },
      { name: "Cards", blocks: [{ kind: "cards", options: { coverFieldId: null, cardWidth: 14, coverRatio: "auto", showTitle: true, listNarrow: false } }] },
      { name: "Grouped", blocks: [{ kind: "table", groupBy: "done", layout: { fields: ["title", "count", "date", "tags"] } }] },
      { name: "Blocks", blocks: [{ kind: "markdown", title: "Notes", options: { text: MARKDOWN.long } }, { kind: "table", title: "Table", layout: { fields: ["title", "count", "done"] } }, { kind: "component", local: "{{ 21 * 2 }}" }] },
    ],
  });
  const ids = await t.seed(spec);
  const books = t.listPath(ids.collections.books);
  const authors = t.listPath(ids.collections.authors);
  const item = t.itemPath(ids.collections.books, ids.items["books/i0"]);
  await t.seed({ prefs: { "kubus.workspace.default": wsLayout([["/collections", books, item, "/components"], [authors, "/help"]], { active: 0 }) } });
  await t.open(books, { keepTabs: true });
  const viewTab = (name) => t.page.locator(".ws-pane--active .views-tabs [role=tab]").filter({ hasText: name }).first();
  const viewSelected = (name) => [...document.querySelectorAll(".ws-pane--active .views-tabs [role=tab]")].some((x) => x.textContent.trim().startsWith(name) && x.getAttribute("aria-selected") === "true") && !!document.querySelector(".ws-pane--active .block");
  for (const name of ["Cards", "Grouped", "Blocks", "All"]) await t.measure(`view tab: ${name}`, () => viewTab(name).click(), viewSelected, { arg: name });
  await t.audit("views switched");
  const wsTab = (pane, i) => t.page.locator(".ws-pane").nth(pane).locator(".ws-pane__tabs .cds--tabs__nav-item").nth(i);
  const wsSelected = ([pane, i]) => {
    const tab = document.querySelectorAll(".ws-pane")[pane]?.querySelectorAll(".ws-pane__tabs .cds--tabs__nav-item")[i];
    return !!tab && tab.getAttribute("aria-selected") === "true" && !!document.querySelector(".ws-pane--active .ws-tab-slot:not([hidden]) .page-header");
  };
  for (const [pane, i, label] of [[0, 0, "collections"], [0, 2, "item page"], [0, 3, "components"], [0, 1, "300 books"], [1, 0, "other pane: authors"], [1, 1, "other pane: help"], [0, 2, "back to the first pane"]]) {
    await t.measure(`workspace tab: ${label}`, () => wsTab(pane, i).click(), wsSelected, { arg: [pane, i] });
  }
  await t.audit("tabs switched");
}, { perf: true });

test("perf: typing in a toolbar popover over a large view", async (t) => {
  await t.boot();
  const ids = await t.seed(bookTable(1000));
  await t.open("/collections");
  await t.go(t.listPath(ids.collections.books));
  await t.until("1,000 rows", () => t.page.evaluate(rowsAtLeast, 1000), { timeout: 60000 });
  const bar = t.page.locator(".ws-pane--active .views-bar").first();
  const filterBtn = bar.getByRole("button", { name: /^Filter/ }).first();
  await t.measure("open the view's Filter", () => filterBtn.click(), () => !!document.querySelector(".toolbar-popover.cds--popover--open .toolbar-popover__panel"));
  const panel = t.page.locator(".toolbar-popover.cds--popover--open .toolbar-popover__panel").last();
  await t.measure("add a filter rule", () => panel.getByRole("button", { name: "Add filter" }).click(), () => !!document.querySelector(".toolbar-popover.cds--popover--open .query-editor__rule input[type=text], .toolbar-popover.cds--popover--open .query-editor__rule input:not([type])"));
  await panel.locator(".query-editor__rule input").first().click();
  await typeMeasured(t, "type a filter value over 1,000 rows", "Hyperion");
  await t.measure("the filtered rows", async () => {}, (n) => document.querySelectorAll(".ws-pane--active .items-table tbody tr:not(.table-add-row)").length < n, { arg: 1000 });
  await t.audit("filter typed");
  await t.measure("clear the filter value", async () => {
    await t.page.keyboard.press("Control+A");
    await t.page.keyboard.press("Backspace");
  }, rowsAtLeast, { arg: 1000 });
  await t.escapeCloses("filter popover");
  // A block's settings: its name typed a key at a time.
  const settings = t.page.locator(".ws-pane--active .block .section-header").first().getByRole("button", { name: "Block settings" });
  await t.measure("open Block settings", () => settings.click(), () => !!document.querySelector(".toolbar-popover.cds--popover--open .toolbar-popover__panel"));
  await t.page.locator(".toolbar-popover.cds--popover--open .toolbar-popover__panel").last().getByRole("textbox", { name: "Name" }).click();
  await typeMeasured(t, "type a block name", "Every book");
  await t.measure("store the name (Enter)", () => t.page.keyboard.press("Enter"), () => [...document.querySelectorAll(".ws-pane--active .block .section-header")].some((h) => h.textContent.includes("Every book")));
  await t.escapeCloses("block settings");
  await t.audit("block renamed");
}, { perf: true });

test("perf: search across collections", async (t) => {
  await t.boot();
  const spec = { collections: [] };
  for (const [k, name] of ["Book", "Film", "Album", "Recipe", "Place"].entries()) {
    spec.collections.push({
      key: `c${k}`, name, plural: `${name}s`,
      fields: [{ key: "title", name: "Title", kind: "string" }, { key: "notes", name: "Notes", kind: "markdown" }, { key: "tags", name: "Tags", kind: "string_list" }],
      items: Array.from({ length: 300 }, (_, i) => ({ values: { title: `${pick(TEXT.typical, i + k)} ${i + 1}`, notes: i % 4 === 0 ? MARKDOWN.long : MARKDOWN.typical, tags: [pick(TEXT.short, i), pick(TEXT.short, i + 3)] } })),
    });
  }
  await t.seed(spec);
  await t.open("/collections");
  await t.measure("open the search bar", () => t.page.getByRole("button", { name: "Search", exact: true }).first().click(), () => document.activeElement?.closest(".search-bar"));
  const hits = (q) => [...document.querySelectorAll(".ws-pane--active .cds--contained-list-item")].length > 0 && (document.querySelector(".ws-pane--active .page-header")?.textContent || "").includes(q);
  await typeMeasured(t, "type a search (6 keys)", "Hyperi");
  await t.measure("results for the search", async () => {}, hits, { arg: "Hyperi" });
  await t.audit("search results");
  await t.measure("search for a word in many notes", async () => {
    await t.page.keyboard.press("Control+A");
    await t.page.keyboard.type("ipsum");
  }, hits, { arg: "ipsum" });
  await t.audit("search results: notes");
}, { perf: true });
