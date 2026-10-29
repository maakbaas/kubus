// Filter conditions of every field kind, with the table's rows asserted against the data.

const ago = (ms) => new Date(Date.now() - ms).toISOString();

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

const rulesOf = (t) => toolbarPanel(t).locator(".query-editor__rule");

/** Opens the view's Filter panel (in the views bar), or a block's menu (`name`) in its header. */
async function openView(t, name = FILTER) {
  await t.openPanel(t.page.locator(".views-bar").first(), name);
  return toolbarPanel(t);
}

async function addRule(t) {
  await toolbarPanel(t).getByRole("button", { name: "Add filter" }).click();
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
