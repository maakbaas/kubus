// Query editing, with the rows it leaves asserted: filter conditions of every field kind, And / Or,
// Value from the page's item, remove filter; Sort by / Direction; Group by / Group order and the
// groups' collapse kept; the date period (kinds, Which, Previous / Next, Any date, Counted from,
// Range); a view's filter against a block's own; "Filter all blocks" on an item page; a reference
// field's Choices. Every step is followed by the table's rows (read from the page), what was stored
// (window.kubus.repo) and, after a reload, the same again.

const DAY_MS = 86400000;
const pad2 = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
/** Noon, `n` days from today (local): its day is the same whatever the time of the run. */
const dayAt = (n) => {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + n);
  return d;
};
const dayStr = (n) => ymd(dayAt(n));
const ago = (ms) => new Date(Date.now() - ms).toISOString();
const sundayOf = (d) => {
  const s = new Date(d);
  s.setDate(s.getDate() - s.getDay());
  return s;
};

/** [first, last] day ("yyyy-mm-dd") of the day / week / month / year `offset` units from today's (the suite's own calendar, not the app's). */
function periodDays(kind, offset = 0) {
  const t = dayAt(0);
  if (kind === "day") return [dayStr(offset), dayStr(offset)];
  if (kind === "week") {
    const s = sundayOf(t);
    s.setDate(s.getDate() + 7 * offset);
    const e = new Date(s);
    e.setDate(e.getDate() + 6);
    return [ymd(s), ymd(e)];
  }
  if (kind === "month") return [ymd(new Date(t.getFullYear(), t.getMonth() + offset, 1)), ymd(new Date(t.getFullYear(), t.getMonth() + offset + 1, 0))];
  return [`${t.getFullYear() + offset}-01-01`, `${t.getFullYear() + offset}-12-31`];
}

// --- data -------------------------------------------------------------------------------------

const AUTHORS = [
  { key: "ada", name: "Ada", top: 200, debut: dayStr(-10), mentor: "bram" },
  { key: "bram", name: "Bram", top: 300, debut: dayStr(-50), mentor: null },
  { key: "cleo", name: "Cleo", top: 100, debut: dayStr(-2), mentor: "ada" },
];

// Published is `pub` days from today (none: empty); Logged is a moment `hours` ago.
const BOOKS = [
  { key: "alpha", title: "Alpha", pages: 120, read: true, pub: 0, hours: 1, tags: ["fiction", "classic"], todo: ["[x] pack", "[ ] sail"], notes: "Mentions **whales** twice", html: "<p>Hello <b>sea</b></p>", author: "ada", authors: ["ada", "bram"], cover: true },
  { key: "bravo", title: "Bravo", pages: 250, read: false, pub: -1, hours: 30, tags: ["fiction"], todo: ["[x] pack", "[x] sail"], notes: "A quiet harbour", html: "<p>Dock</p>", author: "bram", authors: ["bram"], cover: false },
  { key: "charlie", title: "Charlie", pages: 80, read: true, pub: -3, hours: 72, tags: ["science"], todo: [], notes: "", html: "", author: "ada", authors: [], cover: true },
  { key: "delta", title: "Delta", pages: 400, read: false, pub: -8, hours: 200, tags: [], todo: ["[ ] only"], notes: "Whales again", html: "<p>Sea</p>", author: "cleo", authors: ["ada", "cleo"], cover: false },
  { key: "echo", title: "Echo", pages: 250, read: true, pub: -20, hours: 500, tags: ["science", "classic"], todo: ["[x] one"], notes: "", html: "", author: null, authors: [], cover: false },
  { key: "foxtrot", title: "Foxtrot", pages: null, read: false, pub: -45, hours: 1000, tags: ["fiction"], todo: [], notes: "", html: "", author: "bram", authors: [], cover: false },
  { key: "golf", title: "Golf", pages: 5, read: true, pub: -100, hours: 2000, tags: ["classic"], todo: [], notes: "", html: "", author: "bram", authors: ["bram"], cover: false },
  { key: "hotel", title: "Hotel", pages: 999, read: false, pub: -400, hours: 9000, tags: [], todo: [], notes: "", html: "", author: null, authors: [], cover: false },
  { key: "india", title: "India", pages: 60, read: true, pub: 1, hours: 4, tags: ["science"], todo: [], notes: "", html: "", author: "cleo", authors: [], cover: false },
  { key: "juliet", title: "Juliet", pages: 300, read: false, pub: 10, hours: 6, tags: [], todo: [], notes: "", html: "", author: "ada", authors: [], cover: false },
  { key: "kilo", title: "Kilo", pages: 0, read: true, pub: null, hours: 8, tags: [], todo: [], notes: "", html: "", author: null, authors: [], cover: false },
  { key: "lima", title: "Lima", pages: 75, read: false, pub: null, hours: 10, tags: ["fiction", "science"], todo: [], notes: "", html: "", author: null, authors: [], cover: false },
];
const TITLES = BOOKS.map((b) => b.title);
const authorName = (key) => (key ? AUTHORS.find((a) => a.key === key).name : "");
const loggedDay = (b) => ymd(new Date(ago(b.hours * 3600000)));
const pubDay = (b) => (b.pub === null ? null : dayStr(b.pub));

function querySpec({ views, authorViews, choice } = {}) {
  return {
    images: [{ key: "img", w: 16, h: 16 }],
    collections: [
      {
        key: "authors", name: "Author", plural: "Authors", icon: "User",
        fields: [
          { key: "name", name: "Name", kind: "string" },
          { key: "top", name: "Top pages", kind: "number" },
          { key: "debut", name: "Debut", kind: "date" },
          { key: "mentor", name: "Mentor", kind: "item", target: "authors" },
          { key: "nation", name: "Nation", kind: "string" },
        ],
        itemViews: authorViews,
        items: AUTHORS.map((a) => ({ key: a.key, values: { name: a.name, top: a.top, debut: a.debut, mentor: a.mentor ? { ref: `authors/${a.mentor}` } : null, nation: a.key === "bram" ? "Dutch" : "English" } })),
      },
      {
        key: "books", name: "Book", plural: "Books", icon: "Book",
        fields: [
          { key: "title", name: "Title", kind: "string" },
          { key: "pages", name: "Pages", kind: "number" },
          { key: "read", name: "Read", kind: "checkbox" },
          { key: "pub", name: "Published", kind: "date" },
          { key: "logged", name: "Logged", kind: "datetime" },
          { key: "tags", name: "Tags", kind: "string_list" },
          { key: "todo", name: "Todo", kind: "checklist" },
          { key: "notes", name: "Notes", kind: "markdown" },
          { key: "html", name: "Snippet", kind: "html" },
          { key: "author", name: "Author", kind: "item", target: "authors", choiceFilter: choice },
          { key: "authors", name: "Co-authors", kind: "item_list", target: "authors" },
          { key: "cover", name: "Cover", kind: "image" },
        ],
        items: BOOKS.map((b) => ({
          key: b.key,
          values: {
            title: b.title, pages: b.pages, read: b.read, pub: pubDay(b), logged: ago(b.hours * 3600000), tags: b.tags, todo: b.todo, notes: b.notes, html: b.html,
            author: b.author ? { ref: `authors/${b.author}` } : null, authors: { refs: b.authors.map((a) => `authors/${a}`) }, cover: b.cover ? { image: "img" } : null,
          },
        })),
        views: views || [{ name: "All", blocks: [{ kind: "table" }] }],
      },
    ],
  };
}

// --- helpers ----------------------------------------------------------------------------------

/** The titles in a block's table(s), in the order shown (rows of collapsed groups aren't on screen). */
async function titlesOf(t, block = 0) {
  return await t.page.evaluate((block) => {
    const b = document.querySelectorAll(".ws-pane--active .block")[block];
    if (!b) return null;
    // Rows of a table, or the titles on cards.
    const cells = [...b.querySelectorAll("tbody tr")].filter((r) => r.checkVisibility()).map((r) => (r.querySelector("td")?.innerText || "").trim());
    const cards = [...b.querySelectorAll(".item-card__title")].filter((c) => c.checkVisibility()).map((c) => c.innerText.trim());
    return [...cells, ...cards].filter(Boolean);
  }, block);
}
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const names = (list) => list.map((b) => b.title);

/** Waits until the block shows exactly these titles (as a set, or in this order with `ordered`). */
async function expectRows(t, label, expected, { block = 0, ordered = false } = {}) {
  let last = null;
  return t.until(`${label}: ${expected.length} row(s)`, async () => {
    last = await titlesOf(t, block);
    if (!last) return "no block";
    return (ordered ? JSON.stringify(last) === JSON.stringify(expected) : same(last, expected)) || `shows ${JSON.stringify(last)}, expected ${JSON.stringify(expected)}`;
  });
}

const FILTER = /^Filter( \(\d+\))?$|^Filter all blocks( \(\d+\))?$/;
const panelOf = (t) => t.page.locator(".toolbar-popover__panel:visible").last();
const rulesOf = (t) => panelOf(t).locator(".query-editor__rule");

/** Opens the view's Filter panel (in the views bar), or a block's menu (`name`) in its header. */
async function openView(t, name = FILTER) {
  await t.openPanel(t.page.locator(".views-bar").first(), name);
  return panelOf(t);
}
async function openBlock(t, name, block = 0) {
  await t.openPanel(t.page.locator(".ws-pane--active .block").nth(block).locator(".section-header").first(), name);
  return panelOf(t);
}
async function addRule(t) {
  await panelOf(t).getByRole("button", { name: "Add filter" }).click();
  await t.settle(100);
  return rulesOf(t).last();
}
/** Sets a rule's field, condition and value (a typed one, or an option's text of an item picker). */
async function setRule(t, rule, { field, cond, value, join }) {
  if (join) await rule.getByLabel("Join", { exact: true }).selectOption({ label: join });
  if (field) await rule.getByLabel("Field", { exact: true }).selectOption({ label: field });
  if (cond) await rule.getByLabel("Condition", { exact: true }).selectOption({ label: cond });
  if (value !== undefined) {
    const input = rule.getByLabel("Value", { exact: true });
    if ((await input.evaluate((e) => e.tagName)) === "SELECT") await input.selectOption({ label: value });
    else await input.fill(value);
  }
  await t.settle(100);
}
const optionsOf = (locator) => locator.locator("option").allInnerTexts();
const saveView = async (t) => {
  await t.page.locator(".views-bar").getByRole("button", { name: "Save changes to view" }).click();
  await t.settle(200);
};
const storedView = (t, collectionId) => t.page.evaluate(async (cid) => (await window.kubus.repo.listViews(cid, "default"))[0], collectionId);

// --- filter conditions ---------------------------------------------------------------------------

// Conditions the menu offers per field kind (KIND_RULES), with the field to try them on.
const OPERATORS = {
  Title: ["contains", "does not contain", "is", "is not", "is empty", "is not empty"],
  Notes: ["contains", "does not contain", "is empty", "is not empty"],
  Snippet: ["contains", "does not contain", "is empty", "is not empty"],
  Pages: ["=", "≠", ">", "<", "is empty", "is not empty"],
  Published: ["is", "is before", "is after", "is empty", "is not empty"],
  Logged: ["is on", "is before", "is after", "is empty", "is not empty"],
  Read: ["is checked", "is not checked", "is"],
  Cover: ["is empty", "is not empty"],
  Author: ["is", "is not", "is empty", "is not empty"],
  Tags: ["contains", "does not contain", "is empty", "is not empty"],
  Todo: ["contains", "does not contain", "is empty", "is not empty"],
  "Co-authors": ["includes", "does not include", "is empty", "is not empty"],
};

const empty = (v) => v === null || v === "" || (Array.isArray(v) && v.length === 0);
// [field, condition, value, predicate].
const CASES = [
  ["Title", "contains", "ta", (b) => b.title.toLowerCase().includes("ta")],
  ["Title", "does not contain", "a", (b) => !b.title.toLowerCase().includes("a")],
  ["Title", "is", "echo", (b) => b.title.toLowerCase() === "echo"],
  ["Title", "is not", "Echo", (b) => b.title !== "Echo"],
  ["Title", "is empty", undefined, (b) => empty(b.title)],
  ["Title", "is not empty", undefined, (b) => !empty(b.title)],
  ["Notes", "contains", "whales", (b) => b.notes.toLowerCase().includes("whales")],
  ["Notes", "does not contain", "whales", (b) => !b.notes.toLowerCase().includes("whales")],
  ["Notes", "is empty", undefined, (b) => empty(b.notes)],
  ["Notes", "is not empty", undefined, (b) => !empty(b.notes)],
  ["Snippet", "contains", "sea", (b) => b.html.toLowerCase().includes("sea")],
  ["Snippet", "is empty", undefined, (b) => empty(b.html)],
  ["Pages", "=", "250", (b) => b.pages === 250],
  ["Pages", "≠", "250", (b) => b.pages !== 250],
  ["Pages", ">", "250", (b) => b.pages !== null && b.pages > 250],
  ["Pages", "<", "100", (b) => b.pages !== null && b.pages < 100],
  ["Pages", "is empty", undefined, (b) => b.pages === null],
  ["Pages", "is not empty", undefined, (b) => b.pages !== null],
  ["Published", "is", dayStr(-8), (b) => pubDay(b) === dayStr(-8)],
  ["Published", "is before", dayStr(-8), (b) => !!pubDay(b) && pubDay(b) < dayStr(-8)],
  ["Published", "is after", dayStr(-8), (b) => !!pubDay(b) && pubDay(b) > dayStr(-8)],
  ["Published", "is empty", undefined, (b) => pubDay(b) === null],
  ["Published", "is not empty", undefined, (b) => pubDay(b) !== null],
  ["Logged", "is on", loggedDay(BOOKS[2]), (b) => loggedDay(b) === loggedDay(BOOKS[2])],
  ["Logged", "is before", loggedDay(BOOKS[3]), (b) => loggedDay(b) < loggedDay(BOOKS[3])],
  ["Logged", "is after", loggedDay(BOOKS[3]), (b) => loggedDay(b) > loggedDay(BOOKS[3])],
  ["Read", "is checked", undefined, (b) => b.read],
  ["Read", "is not checked", undefined, (b) => !b.read],
  ["Read", "is", "true", (b) => b.read],
  ["Read", "is", "false", (b) => !b.read],
  ["Cover", "is empty", undefined, (b) => !b.cover],
  ["Cover", "is not empty", undefined, (b) => b.cover],
  ["Author", "is", "Ada", (b) => b.author === "ada"],
  ["Author", "is not", "Ada", (b) => b.author !== "ada"],
  ["Author", "is empty", undefined, (b) => !b.author],
  ["Author", "is not empty", undefined, (b) => !!b.author],
  ["Tags", "contains", "classic", (b) => b.tags.includes("classic")],
  ["Tags", "does not contain", "classic", (b) => !b.tags.includes("classic")],
  ["Tags", "is empty", undefined, (b) => b.tags.length === 0],
  ["Tags", "is not empty", undefined, (b) => b.tags.length > 0],
  ["Todo", "contains", "sail", (b) => b.todo.some((x) => x.includes("sail"))],
  ["Todo", "is empty", undefined, (b) => b.todo.length === 0],
  ["Co-authors", "includes", "Bram", (b) => b.authors.includes("bram")],
  ["Co-authors", "does not include", "Bram", (b) => !b.authors.includes("bram")],
  ["Co-authors", "is empty", undefined, (b) => b.authors.length === 0],
  ["Co-authors", "is not empty", undefined, (b) => b.authors.length > 0],
];

// Two tests, so that two browsers share the work.
const CONDITION_GROUPS = [
  ["text and numbers", ["Title", "Notes", "Snippet", "Pages"]],
  ["dates, checkboxes, references and lists", ["Published", "Logged", "Read", "Cover", "Author", "Tags", "Todo", "Co-authors"]],
];

for (const [label, fieldNames] of CONDITION_GROUPS) {
  test(`filter: every condition of ${label}, rows asserted @ desktop`, async (t) => {
    await t.boot();
    const ids = await t.seed(querySpec());
    await t.open(t.listPath(ids.collections.books));
    await expectRows(t, "unfiltered", TITLES);
    const panel = await openView(t);
    const rule = await addRule(t);
    await t.check("the first rule says Where", (await rule.innerText()).includes("Where"), await rule.innerText());
    // The filter button counts its rules.
    await t.until("the view's Filter button counts the rule", async () => (await t.page.locator(".views-bar").getByRole("button", { name: "Filter (1)", exact: true }).count()) > 0);
    // Conditions offered per kind.
    for (const field of fieldNames) {
      const expected = OPERATORS[field];
      await setRule(t, rule, { field });
      const got = await optionsOf(rule.getByLabel("Condition", { exact: true }));
      await t.check(`${field}: conditions are ${expected.join(" / ")}`, JSON.stringify(got) === JSON.stringify(expected), JSON.stringify(got));
    }
    await t.audit("filter rule", { shotOnFail: true });
    // Rows per condition.
    for (const [field, cond, value, pred] of CASES.filter((c) => fieldNames.includes(c[0]))) {
      await setRule(t, rule, { field, cond, value });
      await expectRows(t, `${field} ${cond}${value === undefined ? "" : " " + value}`, names(BOOKS.filter(pred)));
    }
    if (fieldNames[0] !== "Title") return;
    // A number that isn't one matches nothing and says so; a rule still without its value filters nothing yet.
    await setRule(t, rule, { field: "Pages", cond: ">", value: "lots" });
    await expectRows(t, "an invalid number matches nothing", []);
    await t.check("and the input says why", (await panel.innerText()).includes("Not a number"));
    await t.audit("invalid value", { shotOnFail: true });
    await setRule(t, rule, { field: "Pages", cond: ">", value: "" });
    await expectRows(t, "a rule without its value filters nothing yet", TITLES);
    // Remove filter.
    await setRule(t, rule, { field: "Read", cond: "is checked" });
    await expectRows(t, "Read is checked", names(BOOKS.filter((b) => b.read)));
    await rule.getByRole("button", { name: "Remove filter" }).click();
    await t.settle(100);
    await t.check("Remove filter takes the rule away", (await rulesOf(t).count()) === 0);
    await expectRows(t, "and everything is shown again", TITLES);
  }, { viewport: "desktop", smoke: fieldNames[0] === "Title" });
}

// --- And / Or ------------------------------------------------------------------------------------

/** Rules read in order without precedence: "A or B and C" is "(A or B) and C". */
const chain = (rules, b) => rules.reduce((acc, r, i) => (i === 0 ? r.pred(b) : r.join === "Or" ? acc || r.pred(b) : acc && r.pred(b)), true);

test("filter: And / Or between rules, Where, Remove filter, saved with the view @ desktop", async (t) => {
  await t.boot();
  const ids = await t.seed(querySpec());
  await t.open(t.listPath(ids.collections.books));
  await openView(t);
  const read = { field: "Read", cond: "is checked", pred: (b) => b.read };
  const long = { field: "Pages", cond: ">", value: "100", join: "And", pred: (b) => b.pages !== null && b.pages > 100 };
  const ada = { field: "Author", cond: "is", value: "Ada", join: "And", pred: (b) => b.author === "ada" };
  const rules = [read, long, ada];
  for (const [i, r] of rules.entries()) {
    const row = await addRule(t);
    await setRule(t, row, r);
    const joins = await rulesOf(t).nth(i).getByLabel("Join", { exact: true }).count();
    await t.check(`rule ${i + 1} ${i === 0 ? "says Where, with no join to choose" : "joins what is above (a choice of And / Or)"}`, i === 0 ? joins === 0 && (await rulesOf(t).first().innerText()).includes("Where") : joins === 1);
    await expectRows(t, `${rules.slice(0, i + 1).map((x) => `${x.join || "Where"} ${x.field}`).join(" ")}`, names(BOOKS.filter((b) => chain(rules.slice(0, i + 1), b))));
  }
  await t.check("the Filter button counts three rules", (await t.page.locator(".views-bar").getByRole("button", { name: "Filter (3)", exact: true }).count()) > 0);
  await t.audit("three rules, And", { shotOnFail: true });
  // Every combination of the two joins.
  for (const [j2, j3] of [["Or", "And"], ["And", "Or"], ["Or", "Or"], ["And", "And"]]) {
    long.join = j2;
    ada.join = j3;
    await rulesOf(t).nth(1).getByLabel("Join", { exact: true }).selectOption({ label: j2 });
    await rulesOf(t).nth(2).getByLabel("Join", { exact: true }).selectOption({ label: j3 });
    await expectRows(t, `Read ${j2} Pages>100 ${j3} Author Ada`, names(BOOKS.filter((b) => chain(rules, b))));
  }
  // Or, then saved: the join is stored and comes back.
  long.join = "Or";
  ada.join = "And";
  await rulesOf(t).nth(1).getByLabel("Join", { exact: true }).selectOption({ label: "Or" });
  await rulesOf(t).nth(2).getByLabel("Join", { exact: true }).selectOption({ label: "And" });
  await expectRows(t, "Read Or Pages>100 And Author Ada", names(BOOKS.filter((b) => chain(rules, b))));
  await t.closeAll();
  await saveView(t);
  const stored = await storedView(t, ids.collections.books);
  await t.check("the view stores three rules, the Or one marked", stored.filters.length === 3 && stored.filters.map((f) => f.join || "and").join() === "and,or,and", JSON.stringify(stored.filters.map((f) => f.join)));
  await t.open(t.listPath(ids.collections.books));
  await expectRows(t, "after a reload: the same rows", names(BOOKS.filter((b) => chain(rules, b))));
  await openView(t);
  await t.check("and the same joins", (await rulesOf(t).count()) === 3 && (await rulesOf(t).nth(1).getByLabel("Join", { exact: true }).inputValue()) === "or");
  // Removing the first rule: the next one becomes the first (Where), what is left joins in order.
  await rulesOf(t).first().getByRole("button", { name: "Remove filter" }).click();
  await t.settle(100);
  const left = [long, ada];
  await t.check("without the first rule, the next says Where", (await rulesOf(t).first().innerText()).includes("Where") && (await rulesOf(t).count()) === 2);
  await expectRows(t, "two rules left", names(BOOKS.filter((b) => chain([{ ...left[0], join: undefined }, left[1]], b))));
  await rulesOf(t).last().getByRole("button", { name: "Remove filter" }).click();
  await rulesOf(t).last().getByRole("button", { name: "Remove filter" }).click();
  await t.settle(100);
  await expectRows(t, "no rules: everything", TITLES);
  await t.check("the button no longer counts", (await t.page.locator(".views-bar").getByRole("button", { name: "Filter", exact: true }).count()) > 0);
}, { viewport: "desktop" });

// --- view-level and block-level filters, Limit -------------------------------------------------------

test("filter: a block builds on its view's filter (And narrows, Or lets more in); Limit @ desktop", async (t) => {
  await t.boot();
  const ids = await t.seed(querySpec({ views: [{ name: "Two", blocks: [{ kind: "table", title: "First" }, { kind: "table", title: "Second" }] }] }));
  await t.open(t.listPath(ids.collections.books));
  await expectRows(t, "both blocks show everything", TITLES, { block: 1 });
  // The view's filter reaches both blocks.
  await openView(t);
  await setRule(t, await addRule(t), { field: "Read", cond: "is checked" });
  const readOnes = names(BOOKS.filter((b) => b.read));
  await expectRows(t, "view filter: first block", readOnes, { block: 0 });
  await expectRows(t, "view filter: second block", readOnes, { block: 1 });
  await t.closeAll();
  // A block's own rule comes after it.
  await openBlock(t, FILTER, 1);
  await t.check("the block's panel says it uses the view's filter", (await panelOf(t).innerText()).includes("Only the view's filter"), await panelOf(t).innerText());
  const rule = await addRule(t);
  await t.check("the block's first rule joins the view's (a join, no Where)", (await rule.innerText()).includes("Where") === false && (await rule.getByLabel("Join", { exact: true }).count()) === 1);
  await setRule(t, rule, { field: "Pages", cond: ">", value: "100", join: "And" });
  const narrowed = BOOKS.filter((b) => b.read && b.pages !== null && b.pages > 100);
  await expectRows(t, "And narrows the second block", names(narrowed), { block: 1 });
  await expectRows(t, "the first block is as the view says", readOnes, { block: 0 });
  await t.check("its Filter button counts its own rule", (await t.page.locator(".ws-pane--active .block").nth(1).getByRole("button", { name: "Filter (1)", exact: true }).count()) === 1);
  await t.audit("block filter building on the view's", { shotOnFail: true });
  await setRule(t, rule, { join: "Or" });
  await expectRows(t, "Or lets more into the second block", names(BOOKS.filter((b) => b.read || (b.pages !== null && b.pages > 100))), { block: 1 });
  await t.closeAll();
  // Saved, and back after a reload.
  await saveView(t);
  const stored = await storedView(t, ids.collections.books);
  await t.check("stored: the view's rule and the second block's own, the first block has none", stored.filters.length === 1 && stored.blocks[1].filters.length === 1 && !(stored.blocks[0].filters || []).length, JSON.stringify([stored.filters.length, stored.blocks.map((b) => b.filters && b.filters.length)]));
  await t.open(t.listPath(ids.collections.books));
  await expectRows(t, "reloaded: first block", readOnes, { block: 0 });
  await expectRows(t, "reloaded: second block", names(BOOKS.filter((b) => b.read || (b.pages !== null && b.pages > 100))), { block: 1 });
  // Taking the view's filter away: the block's Or rule stands alone.
  await openView(t);
  await rulesOf(t).first().getByRole("button", { name: "Remove filter" }).click();
  await t.closeAll();
  await expectRows(t, "no view filter: the first block shows everything", TITLES, { block: 0 });
  await openBlock(t, FILTER, 1);
  await t.check("the block's rule is now the first (Where)", (await rulesOf(t).first().innerText()).includes("Where"));
  await expectRows(t, "and filters on its own", names(BOOKS.filter((b) => b.pages !== null && b.pages > 100)), { block: 1 });
  // Limit: items shown at a time.
  await t.closeAll();
  await openBlock(t, FILTER, 0);
  const limit = panelOf(t).getByRole("spinbutton", { name: "Items shown at a time" });
  await limit.fill("5");
  await t.settle(200);
  await t.until("a Limit of 5 shows five rows", async () => ((await titlesOf(t, 0)) || []).length === 5);
  await t.closeAll();
  const more = t.page.locator(".ws-pane--active .block").first().getByRole("button", { name: "Show more" });
  await t.check("and offers Show more", (await more.count()) === 1);
  await more.click();
  await t.until("Show more adds five", async () => ((await titlesOf(t, 0)) || []).length === 10);
  await t.audit("limited block", { shotOnFail: true });
}, { viewport: "desktop" });

// --- sort ------------------------------------------------------------------------------------------

// The sort key of each field, as KIND_RULES defines it (null: empty, sorts last in both directions).
const SORT_KEYS = {
  Title: (b) => b.title.toLowerCase(),
  Pages: (b) => b.pages,
  Read: (b) => (b.read ? 1 : 0),
  Published: (b) => pubDay(b),
  Logged: (b) => new Date(ago(b.hours * 3600000)).toISOString(),
  Tags: (b) => b.tags.join(", ").toLowerCase() || null,
  Todo: (b) => (b.todo.length ? b.todo.filter((x) => x.startsWith("[x]")).length / b.todo.length : null),
  Author: (b) => (b.author ? authorName(b.author).toLowerCase() : null),
  "Co-authors": (b) => b.authors.map(authorName).join(", ").toLowerCase() || null,
  Cover: (b) => (b.cover ? 1 : 0),
};
const compareKeys = (a, b) => (a === b ? 0 : a === null ? 1 : b === null ? -1 : typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b), undefined, { numeric: true }));
/** Whether titles come in the order of a field's keys (ties in any order; empty values last whatever the direction). */
function sortedBy(titles, key, desc) {
  const keys = titles.map((title) => key(BOOKS.find((b) => b.title === title)));
  for (let i = 1; i < keys.length; i++) {
    const [a, b] = [keys[i - 1], keys[i]];
    if (a === null && b !== null) return false;
    if (a !== null && b !== null && compareKeys(a, b) * (desc ? -1 : 1) > 0) return false;
  }
  return true;
}

test("sort: Sort by every field, both directions, kept with the view @ desktop", async (t) => {
  await t.boot();
  const ids = await t.seed(querySpec());
  await t.open(t.listPath(ids.collections.books));
  await expectRows(t, "sorted by title", TITLES, { ordered: true });
  await openBlock(t, "Sort and group");
  const panel = panelOf(t);
  const sortBy = panel.getByLabel("Sort by", { exact: true });
  const dir = panel.getByLabel("Direction", { exact: true });
  const options = await optionsOf(sortBy);
  await t.check("Sort by offers no sorting, the title, every field and the dates", JSON.stringify(options) === JSON.stringify(["No sorting", "Title", "Title", "Pages", "Read", "Published", "Logged", "Tags", "Todo", "Notes", "Snippet", "Author", "Co-authors", "Cover", "Last updated", "Created"]), JSON.stringify(options));
  await t.check("Direction starts as Ascending", (await dir.inputValue()) === "asc");
  await t.audit("sort and group popover", { shotOnFail: true });
  let last = [];
  for (const field of Object.keys(SORT_KEYS)) {
    for (const desc of [false, true]) {
      await sortBy.selectOption({ label: field });
      await dir.selectOption({ label: desc ? "Descending" : "Ascending" });
      await t.settle(100);
      const sorted = field === "Title" ? (desc ? [...TITLES].reverse() : TITLES) : null;
      await t.until(`${field} ${desc ? "descending" : "ascending"}`, async () => {
        last = (await titlesOf(t)) || [];
        if (last.length !== BOOKS.length) return `${last.length} rows`;
        return (sorted ? JSON.stringify(last) === JSON.stringify(sorted) : sortedBy(last, SORT_KEYS[field], desc)) || JSON.stringify(last);
      });
    }
  }
  // Empty values stay last in both directions (Published: two books without a date).
  await sortBy.selectOption({ label: "Published" });
  await dir.selectOption({ label: "Descending" });
  await t.until("Published descending: the books without a date are last", async () => {
    const rows = (await titlesOf(t)) || [];
    return JSON.stringify(rows.slice(-2).sort()) === JSON.stringify(["Kilo", "Lima"]) || JSON.stringify(rows);
  });
  // The title row order, newest first.
  await sortBy.selectOption({ label: "Pages" });
  await dir.selectOption({ label: "Descending" });
  await t.until("Pages descending starts with the longest", async () => ((await titlesOf(t)) || [])[0] === "Hotel");
  // No sorting: the direction can't be chosen.
  await sortBy.selectOption({ label: "No sorting" });
  await t.settle(100);
  await t.check("without sorting, Direction is disabled", await dir.isDisabled());
  await sortBy.selectOption({ label: "Pages" });
  await t.check("and enabled again with a field", !(await dir.isDisabled()));
  await dir.selectOption({ label: "Descending" });
  await t.closeAll();
  // Unsaved until Save changes; then stored, and the order is back after a reload.
  await saveView(t);
  const stored = await storedView(t, ids.collections.books);
  const pagesId = ids.fields["books.pages"];
  await t.check("the view stores the sort", stored.blocks[0].sort.length === 1 && stored.blocks[0].sort[0].fieldId === pagesId && stored.blocks[0].sort[0].direction === "desc", JSON.stringify(stored.blocks[0].sort));
  await t.open(t.listPath(ids.collections.books));
  await t.until("after a reload the books are still longest first", async () => {
    const rows = (await titlesOf(t)) || [];
    return rows.length === BOOKS.length && sortedBy(rows, SORT_KEYS.Pages, true) && rows[0] === "Hotel";
  });
  await openBlock(t, "Sort and group");
  await t.check("and the panel shows it", (await panelOf(t).getByLabel("Sort by", { exact: true }).inputValue()) === pagesId && (await panelOf(t).getByLabel("Direction", { exact: true }).inputValue()) === "desc");
}, { viewport: "desktop" });

// --- group ----------------------------------------------------------------------------------------------

// The groups of each groupable field: [key, label] of every group an item falls in.
const GROUP_KEYS = {
  Read: (b) => [b.read ? ["yes", "Checked"] : ["no", "Not checked"]],
  Author: (b) => [b.author ? [b.author, authorName(b.author)] : ["", ""]],
  Tags: (b) => (b.tags.length ? b.tags.map((x) => [x, x]) : [["", ""]]),
  Pages: (b) => [b.pages === null ? ["", ""] : [String(b.pages), String(b.pages)]],
  Published: (b) => [b.pub === null ? ["", ""] : [pubDay(b), dateGroupOf(new Date(`${pubDay(b)}T12:00`), "day")[1]]],
  "Co-authors": (b) => (b.authors.length ? b.authors.map((a) => [a, authorName(a)]) : [["", ""]]),
};

/** What the groups should be: [label, titles] in the order of Group order, "(empty)" last. */
function groupsModel(field, order) {
  const groups = new Map();
  for (const b of BOOKS) for (const [key, label] of GROUP_KEYS[field](b)) {
    if (!groups.has(key)) groups.set(key, { key, label: label || "(empty)", titles: [] });
    groups.get(key).titles.push(b.title);
  }
  const sorted = [...groups.values()].sort((a, b) => {
    if (a.key === "" || b.key === "") return a.key === "" ? 1 : -1;
    if (order === "count" && a.titles.length !== b.titles.length) return b.titles.length - a.titles.length;
    // A date's groups are in time order (by their keys), the others by their labels.
    return compareKeys(field === "Published" ? a.key : a.label, field === "Published" ? b.key : b.label) * (order === "desc" ? -1 : 1);
  });
  return sorted.map((g) => [g.label, g.titles]);
}

/** The groups of the first block as shown: [label, titles, open]. */
async function groupsOf(t, block = 0) {
  return await t.page.evaluate((block) => {
    const b = document.querySelectorAll(".ws-pane--active .block")[block];
    return [...b.querySelectorAll(".cds--accordion__item")].map((g) => {
      const head = g.querySelector(".cds--accordion__heading");
      const open = head.getAttribute("aria-expanded") === "true";
      const rows = [...g.querySelectorAll("tbody tr"), ...g.querySelectorAll(".item-card__title")].map((r) => (r.querySelector("td")?.innerText || r.innerText || "").trim()).filter(Boolean);
      return [head.innerText.trim(), open ? rows : [], open];
    });
  }, block);
}

// Two tests, so that two browsers share the work (the first also keeps the grouping with the view).
for (const [label, fields] of [["Read, Author, Tags", ["Read", "Author", "Tags"]], ["Pages, Published, Co-authors", ["Pages", "Published", "Co-authors"]]]) {
test(`group: Group by ${label} and every Group order, rows per group @ desktop`, async (t) => {
  await t.boot();
  const ids = await t.seed(querySpec());
  await t.open(t.listPath(ids.collections.books));
  await openBlock(t, "Sort and group");
  const panel = panelOf(t);
  const groupBy = panel.getByLabel("Group by", { exact: true });
  const order = panel.getByLabel("Group order", { exact: true });
  const options = await optionsOf(groupBy);
  const must = ["No grouping", "Title", "Pages", "Read", "Published", "Logged", "Tags", "Author", "Co-authors"];
  await t.check("Group by offers the fields that can be grouped", must.every((o) => options.includes(o)) && !["Notes", "Snippet", "Todo", "Cover"].some((o) => options.includes(o)), JSON.stringify(options));
  await t.check("Group order is disabled without grouping", await order.isDisabled());
  await t.check("and offers Ascending, Descending, Most items first", JSON.stringify(await optionsOf(order)) === JSON.stringify(["Ascending", "Descending", "Most items first"]));
  for (const field of fields) {
    await groupBy.selectOption({ label: field });
    await t.check(`${field}: Group order is enabled`, !(await order.isDisabled()));
    for (const [label, key] of [["Ascending", "asc"], ["Descending", "desc"], ["Most items first", "count"]]) {
      await order.selectOption({ label });
      await t.settle(100);
      const model = groupsModel(field, key);
      await t.until(`${field}, ${label}: ${model.length} groups in order`, async () => {
        const groups = await groupsOf(t);
        const got = groups.map(([l, rows]) => [l, rows]);
        return JSON.stringify(got) === JSON.stringify(model) || `${JSON.stringify(got)} vs ${JSON.stringify(model)}`;
      });
    }
    if (field === "Tags" || field === "Author") await t.audit(`grouped by ${field}`, { shotOnFail: true });
  }
  if (fields[0] !== "Read") return;
  // An item in several groups is in each (Tags), and still counts once in the total.
  await groupBy.selectOption({ label: "Tags" });
  await order.selectOption({ label: "Ascending" });
  await t.until("Alpha is in both of its tags' groups", async () => {
    const groups = await groupsOf(t);
    return groups.filter(([, rows]) => rows.includes("Alpha")).map(([l]) => l).join() === "classic,fiction" || JSON.stringify(groups);
  });
  // Stored with the view; back after a reload.
  await groupBy.selectOption({ label: "Author" });
  await order.selectOption({ label: "Most items first" });
  await t.closeAll();
  await saveView(t);
  const stored = await storedView(t, ids.collections.books);
  await t.check("the view stores the grouping and its order", stored.blocks[0].groupBy === ids.fields["books.author"] && stored.blocks[0].groupOrder === "count", JSON.stringify([stored.blocks[0].groupBy, stored.blocks[0].groupOrder]));
  await t.open(t.listPath(ids.collections.books));
  const model = groupsModel("Author", "count");
  await t.until("reloaded: grouped by Author, most items first", async () => JSON.stringify((await groupsOf(t)).map(([l, r]) => [l, r])) === JSON.stringify(model) || JSON.stringify(await groupsOf(t)));
  await openBlock(t, "Sort and group");
  await t.check("and the panel shows it", (await panelOf(t).getByLabel("Group order", { exact: true }).inputValue()) === "count");
  // Ascending is the default and not stored.
  await panelOf(t).getByLabel("Group order", { exact: true }).selectOption({ label: "Ascending" });
  await t.closeAll();
  await saveView(t);
  const after = await storedView(t, ids.collections.books);
  await t.check("Ascending is not stored (the default)", after.blocks[0].groupOrder === undefined, JSON.stringify(after.blocks[0].groupOrder));
  // No grouping: one list again.
  await openBlock(t, "Sort and group");
  await panelOf(t).getByLabel("Group by", { exact: true }).selectOption({ label: "No grouping" });
  await t.closeAll();
  await expectRows(t, "No grouping: a plain table", TITLES, { ordered: true });
  await t.check("no groups on screen", (await groupsOf(t)).length === 0);
}, { viewport: "desktop" });
}

// --- group dates by year, month, week, day or hour ------------------------------------------------

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
/** The ISO week (Monday to Sunday, week 1 holds the first Thursday) of a local day, worked out here apart from the app. */
function isoWeekOf(d) {
  const x = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  x.setUTCDate(x.getUTCDate() + 4 - (x.getUTCDay() || 7));
  return { year: x.getUTCFullYear(), week: Math.ceil(((x - Date.UTC(x.getUTCFullYear(), 0, 1)) / DAY_MS + 1) / 7) };
}
/** [key, label] of the group a local moment falls in by `part`. */
function dateGroupOf(d, part) {
  const y = d.getFullYear();
  const day = `${d.getDate()} ${MONTH_NAMES[d.getMonth()].slice(0, 3)} ${y}`;
  const ymdKey = `${y}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  if (part === "year") return [String(y), String(y)];
  if (part === "month") return [`${y}-${pad2(d.getMonth() + 1)}`, `${MONTH_NAMES[d.getMonth()]} ${y}`];
  if (part === "week") {
    const w = isoWeekOf(d);
    return [`${w.year}-W${pad2(w.week)}`, `Week ${w.week}, ${w.year}`];
  }
  if (part === "hour") return [`${ymdKey}T${pad2(d.getHours())}`, `${day}, ${pad2(d.getHours())}:00`];
  return [ymdKey, day];
}

// Fixed moments (local), across a year's end and the ISO weeks that differ from the calendar's.
const ENTRIES = [
  { title: "Anna", day: "2026-10-28", at: new Date(2026, 9, 28, 14, 30) },
  { title: "Bert", day: "2026-10-26", at: new Date(2026, 9, 28, 14, 5) },
  { title: "Cora", day: "2025-12-30", at: new Date(2026, 0, 3, 9, 0) },
  { title: "Dirk", day: "2026-11-02", at: new Date(2026, 10, 2, 0, 15) },
  { title: "Eva", day: null, at: null },
  { title: "Finn", day: "2026-10-28", at: new Date(2026, 9, 28, 23, 59) },
  { title: "Gus", day: "2024-12-30", at: new Date(2027, 0, 1, 10, 0) },
];
const entryDate = (e, field) => (field === "Day" ? (e.day ? new Date(`${e.day}T12:00`) : null) : e.at);
function dateSpec() {
  return {
    collections: [
      {
        key: "entries", name: "Entry", plural: "Entries", icon: "Calendar",
        fields: [{ key: "title", name: "Title", kind: "string" }, { key: "day", name: "Day", kind: "date" }, { key: "at", name: "At", kind: "datetime" }],
        items: ENTRIES.map((e) => ({ key: e.title.toLowerCase(), values: { title: e.title, day: e.day, at: e.at ? e.at.toISOString() : null } })),
        views: [{ name: "All", blocks: [{ kind: "table" }] }],
      },
    ],
  };
}
/** What the groups of a date field should be: [label, titles] by `part` and Group order, "(empty)" last. */
function dateGroupsModel(field, part, order) {
  const groups = new Map();
  for (const e of ENTRIES) {
    const d = entryDate(e, field);
    const [key, label] = d ? dateGroupOf(d, part) : ["", "(empty)"];
    if (!groups.has(key)) groups.set(key, { key, label, titles: [] });
    groups.get(key).titles.push(e.title);
  }
  const sorted = [...groups.values()].sort((a, b) => {
    if (a.key === "" || b.key === "") return a.key === "" ? 1 : -1;
    if (order === "count" && a.titles.length !== b.titles.length) return b.titles.length - a.titles.length;
    return (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) * (order === "desc" ? -1 : 1);
  });
  return sorted.map((g) => [g.label, g.titles.sort()]);
}

test("group: a date by year, month, week, day or hour, in time order; stored, kept after a reload @ desktop", async (t) => {
  await t.boot();
  const ids = await t.seed(dateSpec());
  await t.open(t.listPath(ids.collections.entries));
  await openBlock(t, "Sort and group");
  const panel = panelOf(t);
  const groupBy = panel.getByLabel("Group by", { exact: true });
  const by = panel.getByLabel("Group dates by", { exact: true });
  const order = panel.getByLabel("Group order", { exact: true });
  const shown = async (label, model) =>
    t.until(label, async () => {
      const got = (await groupsOf(t)).map(([l, rows]) => [l, [...rows].sort()]);
      return JSON.stringify(got) === JSON.stringify(model) || `${JSON.stringify(got)} vs ${JSON.stringify(model)}`;
    });
  await t.check("without grouping: no Group dates by", (await by.count()) === 0);
  await groupBy.selectOption({ label: "Title" });
  await t.check("grouped by a text field: none either", (await by.count()) === 0);

  for (const [field, parts] of [["Day", ["year", "month", "week", "day"]], ["At", ["year", "month", "week", "day", "hour"]]]) {
    await groupBy.selectOption({ label: field });
    await order.selectOption({ label: "Ascending" });
    const offered = await optionsOf(by);
    const expected = parts.map((p) => p[0].toUpperCase() + p.slice(1));
    await t.check(`${field}: Group dates by offers ${expected.join(", ")} (an hour only of a date & time)`, JSON.stringify(offered) === JSON.stringify(expected), JSON.stringify(offered));
    await t.check(`${field}: Day is the default`, (await by.inputValue()) === "day");
    await shown(`${field}: by day, with readable labels`, dateGroupsModel(field, "day", "asc"));
    for (const part of parts) {
      await by.selectOption({ label: part[0].toUpperCase() + part.slice(1) });
      await t.settle(100);
      for (const o of ["asc", "desc", "count"]) {
        await order.selectOption({ value: o });
        await t.settle(100);
        await shown(`${field} by ${part}, order ${o}: ${dateGroupsModel(field, part, o).map((g) => g[0]).join(" | ")}`, dateGroupsModel(field, part, o));
      }
      await order.selectOption({ value: "asc" });
      if (field === "At" && (part === "week" || part === "hour")) await t.audit(`grouped by ${field} by ${part}`, { shotOnFail: true });
    }
  }

  // The readable labels, spelled out once (apart from the model above).
  await groupBy.selectOption({ label: "At" });
  await by.selectOption({ label: "Week" });
  await t.until("a week reads 'Week 44, 2026' (ISO)", async () => (await groupsOf(t)).some(([l, rows]) => l === "Week 44, 2026" && rows.length === 3) || JSON.stringify(await groupsOf(t)));
  await by.selectOption({ label: "Hour" });
  await t.until("an hour reads '28 Oct 2026, 14:00'", async () => (await groupsOf(t)).some(([l, rows]) => l === "28 Oct 2026, 14:00" && rows.length === 2) || JSON.stringify(await groupsOf(t)));

  // Stored with the view (the default, day, is not), and back after a reload.
  await by.selectOption({ label: "Month" });
  await order.selectOption({ label: "Descending" });
  await t.closeAll();
  await saveView(t);
  const stored = await storedView(t, ids.collections.entries);
  await t.check("the view stores the date grouping and the order", stored.blocks[0].groupBy === ids.fields["entries.at"] && stored.blocks[0].groupDate === "month" && stored.blocks[0].groupOrder === "desc", JSON.stringify(stored.blocks[0]));
  await t.open(t.listPath(ids.collections.entries));
  await shown("reloaded: by month, newest first", dateGroupsModel("At", "month", "desc"));
  await openBlock(t, "Sort and group");
  await t.check("and the panel shows it", (await panelOf(t).getByLabel("Group dates by", { exact: true }).inputValue()) === "month");
  await t.audit("sort and group popover, a date grouped by month", { shotOnFail: true });

  // Hours are of a date & time: another date field falls back to days; day is not stored.
  await panelOf(t).getByLabel("Group dates by", { exact: true }).selectOption({ label: "Hour" });
  await panelOf(t).getByLabel("Group by", { exact: true }).selectOption({ label: "Day" });
  await shown("a date field after hours: by day", dateGroupsModel("Day", "day", "desc"));
  await t.check("a date has no Hour to choose", !(await optionsOf(panelOf(t).getByLabel("Group dates by", { exact: true }))).includes("Hour"));
  await panelOf(t).getByLabel("Group dates by", { exact: true }).selectOption({ label: "Year" });
  await panelOf(t).getByLabel("Group by", { exact: true }).selectOption({ label: "At" });
  await shown("another date field keeps the year", dateGroupsModel("At", "year", "desc"));
  await panelOf(t).getByLabel("Group by", { exact: true }).selectOption({ label: "Title" });
  await t.check("a text field: no Group dates by", (await panelOf(t).getByLabel("Group dates by", { exact: true }).count()) === 0);
  await t.closeAll();
  await saveView(t);
  const after = await storedView(t, ids.collections.entries);
  await t.check("grouped by text: no date grouping stored", after.blocks[0].groupDate === undefined, JSON.stringify(after.blocks[0]));
}, { viewport: "desktop" });

test("group: collapsed groups and blocks are kept @ desktop", async (t) => {
  await t.boot();
  const ids = await t.seed(querySpec({ views: [{ name: "By author", blocks: [{ kind: "table", groupBy: "author" }] }] }));
  await t.open(t.listPath(ids.collections.books));
  const model = groupsModel("Author", "asc");
  await t.until("grouped by Author, all open", async () => {
    const groups = await groupsOf(t);
    return (groups.length === model.length && groups.every((g) => g[2])) || JSON.stringify(groups);
  });
  const head = (label) => t.page.locator(".ws-pane--active .block .cds--accordion__heading").filter({ hasText: label }).first();
  const stateOf = async (label) => (await groupsOf(t)).find((g) => g[0] === label);
  await head("Ada").click();
  await t.until("clicking Ada's heading collapses it, hiding its rows", async () => {
    const g = await stateOf("Ada");
    return (g && !g[2] && g[1].length === 0) || JSON.stringify(g);
  });
  await t.check("the other groups stay open with their rows", (await groupsOf(t)).filter((g) => g[0] !== "Ada").every((g) => g[2] && g[1].length > 0));
  await t.until("it is stored right away (no Save needed)", async () => {
    const v = await storedView(t, ids.collections.books);
    const entries = Object.values(v.collapsed.groups).flat();
    return (entries.length === 1 && entries[0].startsWith(ids.fields["books.author"] + "/")) || JSON.stringify(v.collapsed);
  });
  await head("(empty)").click();
  await t.until("a second group can be collapsed too", async () => (await groupsOf(t)).filter((g) => !g[2]).map((g) => g[0]).sort().join() === "(empty),Ada");
  await t.audit("two groups collapsed", { shotOnFail: true });
  // After a reload they are still collapsed.
  await t.open(t.listPath(ids.collections.books));
  await t.until("reloaded: the same two groups are collapsed", async () => (await groupsOf(t)).filter((g) => !g[2]).map((g) => g[0]).sort().join() === "(empty),Ada");
  await head("Ada").click();
  await t.until("expanding Ada shows its rows again", async () => {
    const g = await stateOf("Ada");
    return (g && g[2] && g[1].join() === groupsModel("Author", "asc").find((m) => m[0] === "Ada")[1].join()) || JSON.stringify(g);
  });
  await t.until("and takes it out of the stored view", async () => Object.values((await storedView(t, ids.collections.books)).collapsed.groups).flat().length === 1);
  // Another grouping field has its own groups: nothing of Author's collapsed state carries over.
  await openBlock(t, "Sort and group");
  await panelOf(t).getByLabel("Group by", { exact: true }).selectOption({ label: "Read" });
  await t.closeAll();
  await t.until("grouped by Read: both groups open", async () => {
    const groups = await groupsOf(t);
    return (groups.length === 2 && groups.every((g) => g[2])) || JSON.stringify(groups);
  });
  // The whole block collapses by its caret and stays so.
  const caret = t.page.locator(".ws-pane--active .block").first().getByRole("button", { name: "Collapse", exact: true });
  await caret.click();
  await t.until("the block collapses: no table on screen", async () => ((await titlesOf(t)) || []).length === 0);
  await t.until("and is stored", async () => (await storedView(t, ids.collections.books)).collapsed.blocks.length === 1);
  await t.open(t.listPath(ids.collections.books));
  await t.until("a collapsed block stays collapsed after a reload", async () => ((await titlesOf(t)) || []).length === 0 && (await t.page.locator(".ws-pane--active .block").first().getByRole("button", { name: "Expand", exact: true }).count()) === 1);
  await t.page.locator(".ws-pane--active .block").first().getByRole("button", { name: "Expand", exact: true }).click();
  await t.until("expanding shows the books again", async () => ((await titlesOf(t)) || []).length === BOOKS.length - 0 || ((await titlesOf(t)) || []).length > 0);
  await t.audit("expanded again", { shotOnFail: true });
}, { viewport: "desktop" });

// --- date period ------------------------------------------------------------------------------------

const dp = (t) => panelOf(t).locator(".date-period");
const periodLabelOf = async (t) => (await dp(t).locator(".date-period__label").innerText()).trim();
const kindTab = (t, name) => dp(t).getByRole("tab", { name, exact: true });
const whichSelect = (t) => panelOf(t).getByLabel("Which", { exact: true });
const pubIn = (first, last) => (b) => pubDay(b) !== null && pubDay(b) >= first && pubDay(b) <= last;
const inDays = (first, last) => names(BOOKS.filter(pubIn(first, last)));
const WORDS = { day: ["Today", "Yesterday", "Tomorrow", "days"], week: ["This week", "Last week", "Next week", "weeks"], month: ["This month", "Last month", "Next month", "months"], year: ["This year", "Last year", "Next year", "years"] };

test("date period: Day to Year counted from today, Previous / Next, the calendar button, Any date @ desktop", async (t) => {
  await t.boot();
  const ids = await t.seed(querySpec());
  await t.open(t.listPath(ids.collections.books));
  await openView(t);
  await t.check("a filter starts at Any date, on the first date field", (await periodLabelOf(t)) === "Any date" && (await dp(t).getByLabel("by", { exact: true }).locator("option:checked").innerText()) === "Published");
  await t.check("with no Previous / Next / Any date until a period is set", (await dp(t).getByRole("button", { name: "Previous" }).count()) === 0 && (await dp(t).getByRole("button", { name: "Any date" }).count()) === 0);
  await t.check("the kinds are Hour, Day, Week, Month, Year, Range", JSON.stringify(await dp(t).getByRole("tab").allInnerTexts()) === JSON.stringify(["Hour", "Day", "Week", "Month", "Year", "Range"]));
  await t.audit("date period, no period yet", { shotOnFail: true });
  for (const kind of ["day", "week", "month", "year"]) {
    const [cur, last, next, unit] = WORDS[kind];
    await kindTab(t, kind[0].toUpperCase() + kind.slice(1)).click();
    await t.settle(100);
    await expectRows(t, `${cur}`, inDays(...periodDays(kind, 0)));
    await t.check(`${cur}: labelled, tagged Rolling, Which is "Counted from today"`, (await periodLabelOf(t)).startsWith(cur) && (await dp(t).locator(".date-period__rolling").count()) === 1 && (await whichSelect(t).locator("option:checked").innerText()) === "Counted from today", await periodLabelOf(t));
    const step = async (button, offset, text) => {
      await dp(t).getByRole("button", { name: button, exact: true }).click();
      await t.settle(100);
      await expectRows(t, `${kind} ${offset >= 0 ? "+" : ""}${offset}`, inDays(...periodDays(kind, offset)));
      await t.check(`${kind} ${offset}: labelled "${text}"`, (await periodLabelOf(t)).startsWith(text), await periodLabelOf(t));
    };
    await step("Previous", -1, last);
    await step("Previous", -2, `2 ${unit} ago`);
    await step("Next", -1, last);
    await step("Next", 0, cur);
    await step("Next", 1, next);
    await step("Next", 2, `In 2 ${unit}`);
    await step(cur, 0, cur);
    if (kind === "week") await t.audit("this week", { shotOnFail: true });
  }
  // Month, one back: stored as month-1; reload.
  await kindTab(t, "Month").click();
  await dp(t).getByRole("button", { name: "Previous", exact: true }).click();
  await expectRows(t, "last month", inDays(...periodDays("month", -1)));
  await t.closeAll();
  await saveView(t);
  const stored = await storedView(t, ids.collections.books);
  await t.check("stored as the one between rule month-1 on Published", stored.filters.length === 1 && stored.filters[0].operator === "between" && stored.filters[0].value === "month-1" && stored.filters[0].fieldId === ids.fields["books.pub"], JSON.stringify(stored.filters));
  await t.open(t.listPath(ids.collections.books));
  await expectRows(t, "reloaded: still last month", inDays(...periodDays("month", -1)));
  await openView(t);
  await t.check("and the panel says so", (await periodLabelOf(t)).startsWith("Last month") && (await kindTab(t, "Month").getAttribute("aria-selected")) === "true");
  await t.check("the period is not among the listed rules", (await rulesOf(t).count()) === 0);
  await t.check("the Filter button counts it", (await t.page.locator(".views-bar").getByRole("button", { name: "Filter (1)", exact: true }).count()) > 0);
  // Any date takes it away.
  await dp(t).getByRole("button", { name: "Any date", exact: true }).click();
  await t.settle(100);
  await expectRows(t, "Any date: everything", TITLES);
  await t.check("no period, no Rolling tag", (await periodLabelOf(t)) === "Any date" && (await dp(t).locator(".date-period__rolling").count()) === 0);
}, { viewport: "desktop", smoke: true });

const WINDOW_OPTIONS = {
  Hour: ["Counted from now", "Last n hours", "Last n minutes", "A chosen hour"],
  Day: ["Counted from today", "Last n days", "A chosen day"],
  Week: ["Counted from today", "Week to date", "Last n weeks", "A chosen week"],
  Month: ["Counted from today", "Month to date", "Last n months", "A chosen month"],
  Year: ["Counted from today", "Year to date", "Last n years", "A chosen year"],
};

/** Types a date into a date picker's input and confirms it. */
async function typeDate(t, input, text) {
  await input.click();
  await input.fill(text);
  await input.press("Enter");
  await t.settle(150);
}

test("date period: Which (so far, the last n, a chosen one) and Range @ desktop", async (t) => {
  await t.boot();
  const ids = await t.seed(querySpec());
  await t.open(t.listPath(ids.collections.books));
  await openView(t);
  const today = dayStr(0);
  const [weekFirst] = periodDays("week", 0);
  for (const kind of ["Day", "Week", "Month", "Year"]) {
    await kindTab(t, kind).click();
    await t.settle(100);
    await t.check(`${kind}: Which offers ${WINDOW_OPTIONS[kind].join(" / ")}`, JSON.stringify(await optionsOf(whichSelect(t))) === JSON.stringify(WINDOW_OPTIONS[kind]), JSON.stringify(await optionsOf(whichSelect(t))));
  }
  // Week to date, Month to date, Year to date: the period so far, nothing before or after it.
  for (const kind of ["week", "month", "year"]) {
    await kindTab(t, kind[0].toUpperCase() + kind.slice(1)).click();
    await whichSelect(t).selectOption({ label: `${kind[0].toUpperCase() + kind.slice(1)} to date` });
    await t.settle(100);
    await expectRows(t, `${kind} to date`, inDays(periodDays(kind, 0)[0], today));
    await t.check(`${kind} to date: labelled and tagged Rolling, Previous / Next are off`, (await periodLabelOf(t)).startsWith(`${kind[0].toUpperCase() + kind.slice(1)} to date`) && (await dp(t).locator(".date-period__rolling").count()) === 1 && (await dp(t).getByRole("button", { name: "Previous", exact: true }).isDisabled()) && (await dp(t).getByRole("button", { name: "Next", exact: true }).isDisabled()), await periodLabelOf(t));
  }
  // Last n: its own count per unit, changed by typing it.
  const lastN = { day: [7, (n) => [dayStr(1 - n), today], "Days"], week: [4, (n) => [periodDays("week", 1 - n)[0], periodDays("week", 0)[1]], "Weeks"], month: [12, (n) => [periodDays("month", 1 - n)[0], periodDays("month", 0)[1]], "Months"], year: [3, (n) => [periodDays("year", 1 - n)[0], periodDays("year", 0)[1]], "Years"] };
  for (const [kind, [n, range, unitLabel]] of Object.entries(lastN)) {
    await kindTab(t, kind[0].toUpperCase() + kind.slice(1)).click();
    await whichSelect(t).selectOption({ label: `Last n ${kind}s` });
    await t.settle(100);
    const count = panelOf(t).getByRole("spinbutton", { name: unitLabel, exact: true });
    await t.check(`Last n ${kind}s starts at ${n}`, (await count.inputValue()) === String(n), await count.inputValue());
    await expectRows(t, `last ${n} ${kind}s`, inDays(...range(n)));
    await count.fill("2");
    await t.settle(150);
    await expectRows(t, `last 2 ${kind}s`, inDays(...range(2)));
    await t.check(`label: Last 2 ${kind}s`, (await periodLabelOf(t)).startsWith(`Last 2 ${kind}s`), await periodLabelOf(t));
    await t.check("Previous / Next are off for the last n", await dp(t).getByRole("button", { name: "Previous", exact: true }).isDisabled());
  }
  await t.audit("last 2 years", { shotOnFail: true });
  // A chosen day: typed into its date input; Previous / Next move by a day.
  await kindTab(t, "Day").click();
  await whichSelect(t).selectOption({ label: "A chosen day" });
  await t.settle(100);
  const day = panelOf(t).getByLabel("Day", { exact: true });
  await typeDate(t, day, dayStr(-8));
  await expectRows(t, "a chosen day", inDays(dayStr(-8), dayStr(-8)));
  await dp(t).getByRole("button", { name: "Previous", exact: true }).click();
  await expectRows(t, "its day before", inDays(dayStr(-9), dayStr(-9)));
  await dp(t).getByRole("button", { name: "Next", exact: true }).click();
  await dp(t).getByRole("button", { name: "Next", exact: true }).click();
  await expectRows(t, "and two days on", inDays(dayStr(-7), dayStr(-7)));
  await typeDate(t, day, dayStr(-3));
  await expectRows(t, "another chosen day", names(BOOKS.filter(pubIn(dayStr(-3), dayStr(-3)))));
  await t.check("a chosen period is not tagged Rolling", (await dp(t).locator(".date-period__rolling").count()) === 0);
  // A chosen week by any of its days.
  await kindTab(t, "Week").click();
  await t.settle(100);
  await t.check("Week keeps the choice: a chosen week (of that day)", (await whichSelect(t).locator("option:checked").innerText()) === "A chosen week");
  await expectRows(t, "the week of that day", inDays(...weekOf(dayStr(-3))));
  await typeDate(t, panelOf(t).getByLabel("A day of the week", { exact: true }), dayStr(-20));
  await expectRows(t, "a chosen week: the week of -20 days", inDays(...weekOf(dayStr(-20))));
  // A chosen month: its month and year; a chosen year.
  const old = dayAt(-400);
  await kindTab(t, "Month").click();
  await t.settle(100);
  await panelOf(t).getByLabel("Month", { exact: true }).selectOption({ value: String(old.getMonth() + 1) });
  await panelOf(t).getByLabel("Year", { exact: true }).selectOption({ value: String(old.getFullYear()) });
  await t.settle(150);
  const monthDays = [ymd(new Date(old.getFullYear(), old.getMonth(), 1)), ymd(new Date(old.getFullYear(), old.getMonth() + 1, 0))];
  await expectRows(t, "a chosen month (400 days ago)", inDays(...monthDays));
  await t.check("it is labelled with its month and year", (await periodLabelOf(t)).includes(String(old.getFullYear())), await periodLabelOf(t));
  await dp(t).getByRole("button", { name: "Next", exact: true }).click();
  const nextMonth = new Date(old.getFullYear(), old.getMonth() + 1, 1);
  await expectRows(t, "Next: the month after", inDays(ymd(nextMonth), ymd(new Date(nextMonth.getFullYear(), nextMonth.getMonth() + 1, 0))));
  await kindTab(t, "Year").click();
  await t.settle(100);
  await panelOf(t).getByLabel("Year", { exact: true }).selectOption({ value: String(old.getFullYear()) });
  await expectRows(t, "a chosen year", inDays(`${old.getFullYear()}-01-01`, `${old.getFullYear()}-12-31`));
  const years = await optionsOf(panelOf(t).getByLabel("Year", { exact: true }));
  await t.check("the years run from this one a century back", years[0] === String(dayAt(0).getFullYear()) && years.length === 101, `${years[0]} … ${years[years.length - 1]} (${years.length})`);
  await t.audit("a chosen year", { shotOnFail: true });
  // Range: two chosen days, both included.
  await dp(t).getByRole("button", { name: "Any date", exact: true }).click();
  await kindTab(t, "Range").click();
  await t.settle(100);
  await t.check("a range with no days yet", (await periodLabelOf(t)) === "Choose the first and last day");
  await expectRows(t, "and no filter yet", TITLES);
  await typeDate(t, panelOf(t).getByLabel("First day", { exact: true }), dayStr(-20));
  await typeDate(t, panelOf(t).getByLabel("Last day", { exact: true }), dayStr(-1));
  await expectRows(t, "a range of days, both ends included", inDays(dayStr(-20), dayStr(-1)));
  await dp(t).getByRole("button", { name: "Next", exact: true }).click();
  await expectRows(t, "Next moves the range on by its length (20 days)", inDays(dayStr(0), dayStr(19)));
  await t.closeAll();
  await saveView(t);
  const stored = await storedView(t, ids.collections.books);
  await t.check("stored as its two fixed days", stored.filters.length === 1 && stored.filters[0].value === `${dayStr(0)}..${dayStr(19)}`, JSON.stringify(stored.filters));
  await t.open(t.listPath(ids.collections.books));
  await expectRows(t, "reloaded: the same range", inDays(dayStr(0), dayStr(19)));
}, { viewport: "desktop" });

/** The Sunday-to-Saturday week a day is in. */
function weekOf(day) {
  const d = new Date(`${day}T12:00:00`);
  const s = sundayOf(d);
  const e = new Date(s);
  e.setDate(e.getDate() + 6);
  return [ymd(s), ymd(e)];
}

test("date period: by Published, Logged, Created or Updated; hours and minutes @ desktop", async (t) => {
  await t.boot();
  const ids = await t.seed(querySpec());
  await t.open(t.listPath(ids.collections.books));
  await openView(t);
  const by = dp(t).getByLabel("by", { exact: true });
  const fields = await optionsOf(by);
  await t.check("the period goes by a date field, Created or Updated", JSON.stringify(fields.slice(0, 2)) === JSON.stringify(["Published", "Logged"]) && fields.length === 4, JSON.stringify(fields));
  // Created and Updated are today, for every book.
  for (const field of fields.slice(2)) {
    await by.selectOption({ label: field });
    await kindTab(t, "Day").click();
    await t.settle(100);
    await expectRows(t, `${field}, today: every book`, TITLES);
    await dp(t).getByRole("button", { name: "Any date", exact: true }).click();
    await t.settle(100);
  }
  // A date & time by hours: nothing was logged within this hour, five books in the last 24.
  await by.selectOption({ label: "Logged" });
  await kindTab(t, "Hour").click();
  await t.settle(150);
  await expectRows(t, "Logged, this hour: none", []);
  await t.check("Hour's Which: from now, the last n hours or minutes, a chosen hour", JSON.stringify(await optionsOf(whichSelect(t))) === JSON.stringify(WINDOW_OPTIONS.Hour));
  await t.check("labelled This hour", (await periodLabelOf(t)).startsWith("This hour"), await periodLabelOf(t));
  await whichSelect(t).selectOption({ label: "Last n hours" });
  await t.settle(150);
  const within = (hours) => names(BOOKS.filter((b) => b.hours <= hours));
  await expectRows(t, "the last 24 hours", within(24));
  const count = panelOf(t).getByRole("spinbutton", { name: "Hours", exact: true });
  await t.check("starts at 24", (await count.inputValue()) === "24");
  await count.fill("5");
  await expectRows(t, "the last 5 hours", within(5));
  await whichSelect(t).selectOption({ label: "Last n minutes" });
  await t.settle(150);
  await expectRows(t, "the last 30 minutes: none", []);
  await panelOf(t).getByRole("spinbutton", { name: "Minutes", exact: true }).fill("100");
  await expectRows(t, "the last 100 minutes: Alpha, logged an hour ago", ["Alpha"]);
  // A chosen hour: the one Alpha was logged in.
  const alpha = new Date(ago(3600000));
  await whichSelect(t).selectOption({ label: "A chosen hour" });
  await t.settle(100);
  await typeDate(t, panelOf(t).getByLabel("Day", { exact: true }), ymd(alpha));
  await panelOf(t).getByLabel("Hour", { exact: true }).selectOption({ value: pad2(alpha.getHours()) });
  await t.settle(150);
  await expectRows(t, "a chosen hour", ["Alpha"]);
  await dp(t).getByRole("button", { name: "Next", exact: true }).click();
  await expectRows(t, "the hour after: none", []);
  await dp(t).getByRole("button", { name: "Previous", exact: true }).click();
  await expectRows(t, "and back", ["Alpha"]);
  await t.audit("a chosen hour", { shotOnFail: true });
  // Going by another field keeps the period.
  await by.selectOption({ label: "Published" });
  await t.settle(150);
  await t.check("going by another field keeps the period", (await kindTab(t, "Hour").getAttribute("aria-selected")) === "true");
  // Go by Logged again and keep it: stored with its field.
  await by.selectOption({ label: "Logged" });
  await t.closeAll();
  await saveView(t);
  const stored = await storedView(t, ids.collections.books);
  await t.check("stored on the field it goes by", stored.filters.length === 1 && stored.filters[0].fieldId === ids.fields["books.logged"] && /^\d{4}-\d\d-\d\dT\d\d:00\.\.\d{4}-\d\d-\d\dT\d\d:59$/.test(stored.filters[0].value), JSON.stringify(stored.filters));
  await t.open(t.listPath(ids.collections.books));
  await expectRows(t, "reloaded: the chosen hour", ["Alpha"]);
}, { viewport: "desktop" });

test("date period: it frames the other rules, a block's Or can step outside it @ desktop", async (t) => {
  await t.boot();
  const ids = await t.seed(querySpec({ views: [{ name: "Two", blocks: [{ kind: "table", title: "First" }, { kind: "table", title: "Second" }] }] }));
  await t.open(t.listPath(ids.collections.books));
  await openView(t);
  await kindTab(t, "Day").click();
  await whichSelect(t).selectOption({ label: "Last n days" });
  await panelOf(t).getByRole("spinbutton", { name: "Days", exact: true }).fill("30");
  await t.settle(150);
  const recent = (b) => pubIn(dayStr(-29), dayStr(0))(b);
  await expectRows(t, "the last 30 days", names(BOOKS.filter(recent)));
  // Read Or Pages > 300, and-ed with the period wherever it sits in the list.
  await setRule(t, await addRule(t), { field: "Read", cond: "is checked" });
  await setRule(t, await addRule(t), { field: "Pages", cond: ">", value: "300", join: "Or" });
  const rest = (b) => b.read || (b.pages !== null && b.pages > 300);
  await expectRows(t, "period AND (Read OR Pages > 300)", names(BOOKS.filter((b) => recent(b) && rest(b))));
  await t.check("the Or rule does not let the period go", !names(BOOKS.filter((b) => recent(b) && rest(b))).includes("Hotel") && !(await titlesOf(t)).includes("Hotel"));
  await t.check("two listed rules (the period is above them), Filter (3)", (await rulesOf(t).count()) === 2 && (await t.page.locator(".views-bar").getByRole("button", { name: "Filter (3)", exact: true }).count()) > 0);
  await t.audit("a period and two rules", { shotOnFail: true });
  await t.closeAll();
  // A block builds on it: its Or rule steps outside the view's period, its And rule stays inside.
  await openBlock(t, FILTER, 1);
  await setRule(t, await addRule(t), { field: "Title", cond: "is", value: "Golf", join: "Or" });
  await expectRows(t, "the second block: the view's rows, or Golf (100 days ago)", names(BOOKS.filter((b) => (recent(b) && rest(b)) || b.title === "Golf")), { block: 1 });
  await expectRows(t, "the first block is as the view says", names(BOOKS.filter((b) => recent(b) && rest(b))), { block: 0 });
  await setRule(t, rulesOf(t).first(), { join: "And" });
  await expectRows(t, "joined with And, nothing steps outside", names(BOOKS.filter((b) => recent(b) && rest(b) && b.title === "Golf")), { block: 1 });
  // The block's own period frames its own rules and what it builds on.
  await setRule(t, rulesOf(t).first(), { join: "Or" });
  await kindTab(t, "Month").click();
  await t.settle(150);
  const month = periodDays("month", 0);
  await expectRows(t, "a period of its own frames everything the block shows", names(BOOKS.filter((b) => pubIn(...month)(b) && ((recent(b) && rest(b)) || b.title === "Golf"))), { block: 1 });
  await t.closeAll();
  await saveView(t);
  await t.open(t.listPath(ids.collections.books));
  await expectRows(t, "reloaded: the second block", names(BOOKS.filter((b) => pubIn(...month)(b) && ((recent(b) && rest(b)) || b.title === "Golf"))), { block: 1 });
  await expectRows(t, "reloaded: the first block", names(BOOKS.filter((b) => recent(b) && rest(b))), { block: 0 });
}, { viewport: "desktop" });

// --- item pages: values from the page's item, Counted from, Filter all blocks ------------------------------

// The Author page: a block of Books and a block of Authors.
const AUTHOR_PAGE = [{
  name: "Page",
  layout: {
    fields: ["name", "top", "debut", "mentor", "nation", "books", "authors"],
    blocks: [{ id: "books", kind: "table", collection: "books", title: "Books" }, { id: "authors", kind: "table", collection: "authors", title: "Authors" }],
  },
}];
const authorPath = (t, ids, key) => t.itemPath(ids.collections.authors, ids.items[`authors/${key}`]);
const byAuthor = (key) => names(BOOKS.filter((b) => b.author === key));
const topOf = (key) => AUTHORS.find((a) => a.key === key).top;
const debutOf = (key) => AUTHORS.find((a) => a.key === key).debut;
const storedPage = (t, collectionId) => t.page.evaluate(async (cid) => (await window.kubus.repo.listCollections()).find((c) => c.id === cid).itemViews[0], collectionId);

test("item page: a filter value from the page's item (This Author, its Mentor, Top pages, Debut) @ desktop", async (t) => {
  await t.boot();
  const ids = await t.seed(querySpec({ authorViews: AUTHOR_PAGE }));
  await t.open(authorPath(t, ids, "ada"));
  await expectRows(t, "the Books block lists every book", TITLES, { block: 0 });
  await expectRows(t, "the Authors block lists every author", ["Ada", "Bram", "Cleo"], { block: 1 });
  await openBlock(t, FILTER, 0);
  const rule = await addRule(t);
  await setRule(t, rule, { field: "Author", cond: "is" });
  const value = rule.getByLabel("Value", { exact: true });
  const options = await optionsOf(value);
  await t.check("an Author value can be this Author, its Mentor, or an author", ["This Author", "This Author’s Mentor", "Ada", "Bram", "Cleo"].every((o) => options.includes(o)), JSON.stringify(options));
  await expectRows(t, "a rule without its value filters nothing yet", TITLES, { block: 0 });
  await setRule(t, rule, { value: "This Author" });
  await expectRows(t, "Author is This Author (Ada)", byAuthor("ada"), { block: 0 });
  await t.audit("block filter with a value from the page's item", { shotOnFail: true });
  await setRule(t, rule, { value: "This Author’s Mentor" });
  await expectRows(t, "Author is This Author's Mentor (Bram)", byAuthor("bram"), { block: 0 });
  // Fields of the same kind: Value from the page's item, or A value.
  await setRule(t, rule, { field: "Pages", cond: "<" });
  const from = rule.getByLabel("Value from", { exact: true });
  await t.check("a number can be compared with a number of the page's item", JSON.stringify(await optionsOf(from)) === JSON.stringify(["A value", "This Author’s Top pages"]), JSON.stringify(await optionsOf(from)));
  await from.selectOption({ label: "This Author’s Top pages" });
  await t.settle(100);
  await t.check("the typed value gives way to the choice", (await rule.getByRole("textbox", { name: "Value", exact: true }).count()) === 0);
  await expectRows(t, "Pages < this Author's Top pages (200)", names(BOOKS.filter((b) => b.pages !== null && b.pages < topOf("ada"))), { block: 0 });
  await setRule(t, rule, { field: "Published", cond: "is after" });
  await t.check("and a date with a date", JSON.stringify(await optionsOf(rule.getByLabel("Value from", { exact: true }))) === JSON.stringify(["A value", "This Author’s Debut"]));
  await rule.getByLabel("Value from", { exact: true }).selectOption({ label: "This Author’s Debut" });
  await expectRows(t, "Published is after this Author's Debut", names(BOOKS.filter((b) => pubDay(b) !== null && pubDay(b) > debutOf("ada"))), { block: 0 });
  await setRule(t, rule, { field: "Title", cond: "contains" });
  await t.check("text with the page's text", JSON.stringify(await optionsOf(rule.getByLabel("Value from", { exact: true }))) === JSON.stringify(["A value", "This Author’s Name", "This Author’s Nation"]), JSON.stringify(await optionsOf(rule.getByLabel("Value from", { exact: true }))));
  await rule.getByLabel("Value from", { exact: true }).selectOption({ label: "This Author’s Nation" });
  await expectRows(t, "Title contains this Author's Nation (English): none", [], { block: 0 });
  await rule.getByLabel("Value from", { exact: true }).selectOption({ label: "A value" });
  await rule.getByLabel("Value", { exact: true }).fill("o");
  await expectRows(t, "back to a typed value", names(BOOKS.filter((b) => b.title.toLowerCase().includes("o"))), { block: 0 });
  // Keep Pages < Top pages: worked out for each page's item.
  await setRule(t, rule, { field: "Pages", cond: "<" });
  await rule.getByLabel("Value from", { exact: true }).selectOption({ label: "This Author’s Top pages" });
  await t.closeAll();
  await saveView(t);
  const stored = await storedPage(t, ids.collections.authors);
  const block = stored.layout.blocks.find((b) => b.id === "books");
  await t.check("stored with the page's item view as $item.<field>", block.filters.length === 1 && block.filters[0].value === `$item.${ids.fields["authors.top"]}`, JSON.stringify(block.filters));
  for (const key of ["ada", "bram", "cleo"]) {
    await t.open(authorPath(t, ids, key));
    await expectRows(t, `${authorName(key)}'s page: Pages < ${topOf(key)}`, names(BOOKS.filter((b) => b.pages !== null && b.pages < topOf(key))), { block: 0 });
  }
  await openBlock(t, FILTER, 0);
  await t.check("the saved choice is shown by name", (await rulesOf(t).first().getByLabel("Value from", { exact: true }).locator("option:checked").innerText()) === "This Author’s Top pages");
  // A reference to the page's Mentor: for an Author without one (Bram) the rule has no value.
  await setRule(t, rulesOf(t).first(), { field: "Author", cond: "is", value: "This Author’s Mentor" });
  await t.closeAll();
  await saveView(t);
  await t.open(authorPath(t, ids, "cleo"));
  await expectRows(t, "Cleo's page: Author is her Mentor (Ada)'s books", byAuthor("ada"), { block: 0 });
  await t.open(authorPath(t, ids, "bram"));
  await t.until("Bram has no Mentor: the books block shows no one's books", async () => {
    const rows = (await titlesOf(t, 0)) || [];
    return rows.length === 0 || `shows ${rows.length} books`;
  });
}, { viewport: "desktop", smoke: true });

test("item page: Counted from the page's item's date; filtering the Authors block by the item itself @ desktop", async (t) => {
  await t.boot();
  const ids = await t.seed(querySpec({ authorViews: AUTHOR_PAGE }));
  await t.open(authorPath(t, ids, "ada"));
  await openBlock(t, FILTER, 0);
  await t.check("no 'Counted from' before a rolling period is set", (await panelOf(t).getByLabel("Counted from", { exact: true }).count()) === 0);
  await kindTab(t, "Day").click();
  await whichSelect(t).selectOption({ label: "Last n days" });
  await panelOf(t).getByRole("spinbutton", { name: "Days", exact: true }).fill("15");
  await t.settle(150);
  await expectRows(t, "the last 15 days from today", inDays(dayStr(-14), dayStr(0)), { block: 0 });
  const from = panelOf(t).getByLabel("Counted from", { exact: true });
  await t.check("Counted from offers Today or the page item's date", JSON.stringify(await optionsOf(from)) === JSON.stringify(["Today", "This Author's Debut"]), JSON.stringify(await optionsOf(from)));
  await from.selectOption({ label: "This Author's Debut" });
  await t.settle(150);
  await expectRows(t, "the 15 days up to Ada's debut (10 days ago)", inDays(dayStr(-24), dayStr(-10)), { block: 0 });
  await t.check("labelled as counted from it", (await periodLabelOf(t)).includes("counted from this Author's Debut"), await periodLabelOf(t));
  await t.check("Previous / Next are off", await dp(t).getByRole("button", { name: "Previous", exact: true }).isDisabled());
  await t.audit("a period counted from the page item's date", { shotOnFail: true });
  await t.closeAll();
  // The Authors block can be filtered by the item itself.
  await openBlock(t, FILTER, 1);
  const rule = await addRule(t);
  const fields = await optionsOf(rule.getByLabel("Field", { exact: true }));
  await t.check("an Authors block on an Author's page can go by the Item itself", fields.includes("Item") && fields.includes("Mentor"), JSON.stringify(fields));
  await setRule(t, rule, { field: "Item", cond: "is", value: "This Author" });
  await expectRows(t, "Item is This Author: the page's own author", ["Ada"], { block: 1 });
  await setRule(t, rule, { field: "Mentor", cond: "is", value: "This Author" });
  await expectRows(t, "Mentor is This Author: whom Ada mentors", ["Cleo"], { block: 1 });
  await setRule(t, rule, { field: "Item", cond: "is not", value: "This Author" });
  await expectRows(t, "Item is not This Author: the others", ["Bram", "Cleo"], { block: 1 });
  await t.closeAll();
  await saveView(t);
  const stored = await storedPage(t, ids.collections.authors);
  const books = stored.layout.blocks.find((b) => b.id === "books");
  await t.check("stored: the period counted from the Debut field", books.filters.length === 1 && books.filters[0].value === `day-14..day+0@$item.${ids.fields["authors.debut"]}`, JSON.stringify(books.filters));
  const expectedFor = { ada: [dayStr(-24), dayStr(-10)], bram: [dayStr(-64), dayStr(-50)], cleo: [dayStr(-16), dayStr(-2)] };
  for (const key of ["cleo", "bram", "ada"]) {
    await t.open(authorPath(t, ids, key));
    await expectRows(t, `${authorName(key)}'s page: the 15 days up to the debut`, inDays(...expectedFor[key]), { block: 0 });
    await expectRows(t, `${authorName(key)}'s page: Item is not this Author`, ["Ada", "Bram", "Cleo"].filter((n) => n !== authorName(key)), { block: 1 });
  }
}, { viewport: "desktop" });

test("item page: Filter all blocks applies to the blocks whose collection has the field @ desktop", async (t) => {
  await t.boot();
  const ids = await t.seed(querySpec({ authorViews: AUTHOR_PAGE }));
  const header = t.page.locator(".ws-pane--active .page-header");
  // Only with more than one block listing items.
  await t.open(t.itemPath(ids.collections.books, ids.items["books/alpha"]));
  await t.check("a page with no blocks has no 'Filter all blocks'", (await header.getByRole("button", { name: /^Filter all blocks/ }).count()) === 0);
  await t.open(authorPath(t, ids, "ada"));
  await expectRows(t, "both blocks unfiltered", TITLES, { block: 0 });
  await t.openPanel(header, /^Filter all blocks/);
  await t.check("an empty page-wide filter says each block keeps its own", (await panelOf(t).innerText()).includes("every block shows what its own filter lets through"), await panelOf(t).innerText());
  const nation = await addRule(t);
  const fields = await optionsOf(nation.getByLabel("Field", { exact: true }));
  await t.check("it goes by the fields of both collections", ["Name", "Nation", "Title", "Pages", "Read", "Published"].every((f) => fields.includes(f)), JSON.stringify(fields));
  await setRule(t, nation, { field: "Nation", cond: "is", value: "Dutch" });
  await expectRows(t, "Nation is Dutch: the Authors block narrows", ["Bram"], { block: 1 });
  await expectRows(t, "the Books block has no Nation and is left alone", TITLES, { block: 0 });
  const read = await addRule(t);
  await setRule(t, read, { field: "Read", cond: "is checked" });
  await expectRows(t, "Read is checked: the Books block narrows", names(BOOKS.filter((b) => b.read)), { block: 0 });
  await expectRows(t, "the Authors block stays as it was", ["Bram"], { block: 1 });
  await t.check("the button counts the rules", (await header.getByRole("button", { name: "Filter all blocks (2)", exact: true }).count()) === 1);
  await t.audit("page-wide filter", { shotOnFail: true });
  // A block builds on it: its own Or rule lets more in.
  await t.closeAll();
  await openBlock(t, FILTER, 0);
  await t.check("a block says it uses the page's filter", (await panelOf(t).innerText()).includes("Only the page's filter"), await panelOf(t).innerText());
  await setRule(t, await addRule(t), { field: "Title", cond: "is", value: "Golf", join: "Or" });
  await expectRows(t, "the block's Or rule adds Golf (read anyway)", names(BOOKS.filter((b) => b.read || b.title === "Golf")), { block: 0 });
  await setRule(t, rulesOf(t).first(), { field: "Title", cond: "is", value: "Hotel", join: "Or" });
  await expectRows(t, "or Hotel (not read)", names(BOOKS.filter((b) => b.read || b.title === "Hotel")), { block: 0 });
  await t.closeAll();
  // A date period works across both: by Published reaches the Books block only.
  await t.openPanel(header, /^Filter all blocks/);
  await panelOf(t).getByLabel("by", { exact: true }).selectOption({ label: "Published" });
  await kindTab(t, "Week").click();
  await t.settle(150);
  await expectRows(t, "this week by Published: the Books block", names(BOOKS.filter((b) => (pubIn(...periodDays("week", 0))(b) && b.read) || b.title === "Hotel")), { block: 0 });
  await t.closeAll();
  // Unsaved until Save changes: lost on a reload, kept once saved.
  await t.open(authorPath(t, ids, "ada"));
  await expectRows(t, "reloaded without saving: nothing filtered", TITLES, { block: 0 });
  await t.openPanel(header, /^Filter all blocks/);
  await setRule(t, await addRule(t), { field: "Nation", cond: "is", value: "Dutch" });
  await t.closeAll();
  await saveView(t);
  const stored = await storedPage(t, ids.collections.authors);
  await t.check("stored with the page's layout", stored.layout.filters.length === 1 && stored.layout.filters[0].fieldId === ids.fields["authors.nation"], JSON.stringify(stored.layout.filters));
  await t.open(authorPath(t, ids, "cleo"));
  await expectRows(t, "saved: another Author's page is filtered too", ["Bram"], { block: 1 });
  await expectRows(t, "and the Books block is whole", TITLES, { block: 0 });
  await t.check("with the count on its button", (await header.getByRole("button", { name: "Filter all blocks (1)", exact: true }).count()) === 1);
}, { viewport: "desktop" });

// --- a reference field's Choices ---------------------------------------------------------------------------

test("choices: a reference field offers the items its filter lets through @ desktop", async (t) => {
  await t.boot();
  const ids = await t.seed(querySpec({ choice: [{ field: "nation", operator: "is", value: "Dutch" }] }));
  const echo = t.itemPath(ids.collections.books, ids.items["books/echo"]);
  /** The authors the Author field of Echo (who has none) offers. */
  const offered = async () => {
    await t.open(echo);
    const edit = t.page.getByRole("button", { name: "Edit Author", exact: true });
    await edit.scrollIntoViewIfNeeded();
    await edit.click();
    await t.editorReady();
    await t.page.keyboard.press("ArrowDown");
    await t.settle(200);
    const options = await t.page.locator("[role=option]").allInnerTexts();
    await t.page.keyboard.press("Escape");
    return options.map((o) => o.trim()).sort();
  };
  await t.until("Nation is Dutch: only Bram is offered", async () => {
    const o = await offered();
    return JSON.stringify(o) === JSON.stringify(["Bram"]) || JSON.stringify(o);
  });
  await t.audit("the Author field's choices", { shotOnFail: true });
  // The collection editor shows the filter under the field, as a view's filter is edited.
  await t.open(`/collections/${ids.collections.books}/edit`);
  const row = t.page.locator(".ws-pane--active .field-row").filter({ has: t.page.locator('input[value="Author"]') });
  const rule = row.locator(".query-editor__rule");
  await t.check("the field shows its Choices: one rule, Nation is Dutch", (await row.innerText()).includes("Choices") && (await rule.count()) === 1 && (await rule.first().getByLabel("Field", { exact: true }).locator("option:checked").innerText()) === "Nation" && (await rule.first().getByLabel("Value", { exact: true }).inputValue()) === "Dutch");
  await t.check("the Choices go by the Authors' fields", JSON.stringify(await optionsOf(rule.first().getByLabel("Field", { exact: true }))).includes("Top pages"));
  await t.audit("collection editor with Choices", { shotOnFail: true });
  // Or Nation is English: all three.
  await row.getByRole("button", { name: "Add filter" }).click();
  await t.settle(100);
  await setRule(t, rule.last(), { field: "Nation", cond: "is", value: "English", join: "Or" });
  await t.page.getByRole("button", { name: "Save changes" }).click();
  await t.until("saved: the collection's page", async () => (await t.page.locator(".ws-pane--active .page-header__title").innerText().catch(() => "")).includes("Books"));
  const stored = await t.page.evaluate(async (id) => (await window.kubus.repo.listCollections()).find((c) => c.id === id).fields.find((f) => f.name === "Author").choiceFilter, ids.collections.books);
  await t.check("stored: two rules, the second joined with Or", stored.length === 2 && stored[1].join === "or" && stored[1].value === "English", JSON.stringify(stored));
  await t.until("Dutch or English: all three authors", async () => {
    const o = await offered();
    return JSON.stringify(o) === JSON.stringify(["Ada", "Bram", "Cleo"]) || JSON.stringify(o);
  });
  // Without rules, any author.
  await t.open(`/collections/${ids.collections.books}/edit`);
  const row2 = t.page.locator(".ws-pane--active .field-row").filter({ has: t.page.locator('input[value="Author"]') });
  await row2.locator(".query-editor__rule").last().getByRole("button", { name: "Remove filter" }).click();
  await row2.locator(".query-editor__rule").last().getByRole("button", { name: "Remove filter" }).click();
  await t.settle(100);
  await t.check("no rules: 'Any Author can be chosen.'", (await row2.innerText()).includes("Any Author can be chosen."), await row2.innerText());
  await t.page.getByRole("button", { name: "Save changes" }).click();
  await t.until("saved again", async () => (await t.page.locator(".ws-pane--active .page-header__title").innerText().catch(() => "")).includes("Books"));
  await t.until("every author is offered", async () => {
    const o = await offered();
    return JSON.stringify(o) === JSON.stringify(["Ada", "Bram", "Cleo"]) || JSON.stringify(o);
  });
}, { viewport: "desktop" });

// --- the panels at other sizes ------------------------------------------------------------------------------

for (const vp of ["phone", "laptop"]) {
  test(`panels: filter with rules and a period, sort and group, rows asserted @ ${vp}`, async (t) => {
    await t.boot();
    const ids = await t.seed(querySpec());
    await t.open(t.listPath(ids.collections.books));
    await expectRows(t, "unfiltered", TITLES);
    const bar = t.page.locator(".views-bar").first();
    await t.openPanel(bar, FILTER);
    await t.audit("filter panel, no rules", { shotOnFail: true });
    const add = panelOf(t).getByRole("button", { name: "Add filter" });
    await t.popoverStep("adding a rule", () => add.click());
    await setRule(t, rulesOf(t).last(), { field: "Pages", cond: ">", value: "100" });
    await expectRows(t, "Pages > 100", names(BOOKS.filter((b) => b.pages !== null && b.pages > 100)));
    await t.popoverStep("adding a second rule", () => add.click());
    await setRule(t, rulesOf(t).last(), { field: "Read", cond: "is checked", join: "Or" });
    await expectRows(t, "Pages > 100 Or Read", names(BOOKS.filter((b) => (b.pages !== null && b.pages > 100) || b.read)));
    await t.popoverStep("picking a period", () => kindTab(t, "Year").click());
    const shown = BOOKS.filter((b) => pubIn(...periodDays("year", 0))(b) && ((b.pages !== null && b.pages > 100) || b.read));
    await expectRows(t, "and this year (Published)", names(shown));
    await t.audit("filter panel: a period and two rules", { shotOnFail: true });
    await t.escapeCloses("Escape closes the filter panel");
    if (!t.phone) await t.until("the Filter button counts three", async () => (await t.page.getByRole("button", { name: "Filter (3)", exact: true }).count()) > 0);
    await t.audit("filtered list", { shotOnFail: true });
    // Sort and group in the block's header.
    const header = t.page.locator(".ws-pane--active .block").first().locator(".section-header").first();
    await t.openPanel(header, "Sort and group");
    await panelOf(t).getByLabel("Sort by", { exact: true }).selectOption({ label: "Pages" });
    await panelOf(t).getByLabel("Direction", { exact: true }).selectOption({ label: "Descending" });
    await panelOf(t).getByLabel("Group by", { exact: true }).selectOption({ label: "Read" });
    await panelOf(t).getByLabel("Group order", { exact: true }).selectOption({ label: "Descending" });
    await t.until("grouped by Read, Not checked first, longest first", async () => {
      const groups = await groupsOf(t);
      const model = [["Not checked", shown.filter((b) => !b.read)], ["Checked", shown.filter((b) => b.read)]].filter(([, l]) => l.length);
      const got = groups.map(([label, rows]) => [label, rows.length]);
      const want = model.map(([label, l]) => [label, l.length]);
      return JSON.stringify(got) === JSON.stringify(want) || JSON.stringify([got, want]);
    });
    await t.audit("sort and group panel", { shotOnFail: true });
    await t.closeAll();
    await t.audit("grouped, filtered list", { shotOnFail: true });
  }, { viewport: vp });
}

test("blocks: a block's filter, sort and group carry over when it is shown as Cards (and back) @ desktop", async (t) => {
  await t.boot();
  const ids = await t.seed(querySpec());
  await t.open(t.listPath(ids.collections.books));
  await openBlock(t, FILTER, 0);
  await setRule(t, await addRule(t), { field: "Pages", cond: ">", value: "70" });
  await t.closeAll();
  await openBlock(t, "Sort and group", 0);
  await panelOf(t).getByLabel("Sort by", { exact: true }).selectOption({ label: "Pages" });
  await panelOf(t).getByLabel("Direction", { exact: true }).selectOption({ label: "Descending" });
  await panelOf(t).getByLabel("Group by", { exact: true }).selectOption({ label: "Read" });
  await t.closeAll();
  const shown = BOOKS.filter((b) => b.pages !== null && b.pages > 70);
  const model = [["Checked", shown.filter((b) => b.read)], ["Not checked", shown.filter((b) => !b.read)]];
  const sortedPages = (list) => [...list].sort((a, b) => b.pages - a.pages).map((b) => b.title);
  const groupsShown = async () => (await groupsOf(t)).map(([label, rows]) => [label, rows]);
  const wanted = model.map(([label, list]) => [label, sortedPages(list)]);
  await t.until("a table: filtered, longest first, grouped by Read", async () => JSON.stringify(await groupsShown()) === JSON.stringify(wanted) || JSON.stringify(await groupsShown()));
  // Block settings → Show as: Cards.
  const showAs = async (kind) => {
    await openBlock(t, "Block settings", 0);
    await panelOf(t).getByRole("combobox", { name: /Show as/ }).click();
    await t.page.getByRole("option", { name: kind, exact: true }).click();
    await t.settle(200);
    await t.closeAll();
  };
  await showAs("Cards");
  await t.until("on cards the same groups with the same cards in the same order", async () => JSON.stringify(await groupsShown()) === JSON.stringify(wanted) || JSON.stringify(await groupsShown()));
  await t.check("they are cards, not rows", (await t.count(".ws-pane--active .item-card")) === shown.length && (await t.count(".ws-pane--active tbody tr")) === 0);
  await t.audit("grouped cards", { shotOnFail: true });
  // The cards' filter button still counts its rule, and the rule is the same.
  await openBlock(t, FILTER, 0);
  await t.check("the rule is still there", (await rulesOf(t).count()) === 1 && (await rulesOf(t).first().getByLabel("Value", { exact: true }).inputValue()) === "70");
  await setRule(t, rulesOf(t).first(), { value: "200" });
  await t.closeAll();
  const more = BOOKS.filter((b) => b.pages !== null && b.pages > 200);
  await t.until("a changed filter reaches the cards", async () => JSON.stringify(await groupsShown()) === JSON.stringify([["Checked", sortedPages(more.filter((b) => b.read))], ["Not checked", sortedPages(more.filter((b) => !b.read))]].filter(([, l]) => l.length)) || JSON.stringify(await groupsShown()));
  await showAs("Table");
  await t.until("and back to a table, still filtered and grouped", async () => (await t.count(".ws-pane--active tbody tr")) > 0 && (await groupsShown()).length === 2);
  // Stored with the block (type and query together).
  await saveView(t);
  const stored = await storedView(t, ids.collections.books);
  await t.check("stored: table, one rule, sorted by Pages descending, grouped by Read", stored.blocks[0].kind === "table" && stored.blocks[0].filters.length === 1 && stored.blocks[0].sort[0].direction === "desc" && stored.blocks[0].groupBy === ids.fields["books.read"], JSON.stringify(stored.blocks[0]));
}, { viewport: "desktop" });
