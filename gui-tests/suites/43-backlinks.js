// Backlinks: the items that link to an item, as a block on its page. The Backlinks collection is offered
// in the Collection picker of an item page's block only; its table, cards, chart and component blocks list
// one row per link (a Markdown link in another item's text, a reference field's item, a list of items),
// filtered, sorted and grouped like any collection's items, current as links change in other items (the
// rows appear and disappear without a reload), read-only, also for a remote collection's row. Every step is
// followed by what the page shows and, where it is stored, what window.kubus.repo holds.

const BACKLINKS = "$backlinks";
/** The fields a new Backlinks block shows (domain/backlinks.ts BACKLINKS_FIELDS). */
const SHOWN = ["title", "collection", "field", "$updated"];

// ---- data ---------------------------------------------------------------------------------------

/**
 * People (the ones linked to), Notes (Markdown body, a reference to a person, a list of people) and Books
 * (a Markdown review, an author). The People's item view "Page" has a table of the backlinks at the bottom.
 */
function linkSpec({ block = {}, withView = true } = {}) {
  const layout = { fields: ["name", "bio", "bl"], blocks: [{ id: "bl", kind: "table", title: "Backlinks", collection: BACKLINKS, layout: { fields: SHOWN }, ...block }] };
  return {
    spaces: [{ key: "work", name: "Work" }],
    collections: [
      {
        key: "people", name: "Person", plural: "People", icon: "User",
        fields: [{ key: "name", name: "Name", kind: "string" }, { key: "bio", name: "Bio", kind: "markdown" }],
        ...(withView ? { itemViews: [{ name: "Page", layout }] } : {}),
        items: [{ key: "ada", values: { name: "Ada", bio: "Mathematician" } }, { key: "bram", values: { name: "Bram" } }, { key: "cleo", values: { name: "Cleo" } }],
      },
      {
        key: "notes", name: "Note", plural: "Notes", icon: "Document",
        fields: [
          { key: "title", name: "Title", kind: "string" },
          { key: "body", name: "Body", kind: "markdown" },
          { key: "about", name: "About", kind: "item", target: "people" },
          { key: "others", name: "Others", kind: "item_list", target: "people" },
        ],
        items: [
          { key: "reading", values: { title: "Reading list", body: "" } },
          { key: "meeting", values: { title: "Meeting", body: "" } },
          { key: "plan", values: { title: "Plan", about: { ref: "people/ada" }, others: { refs: ["people/ada", "people/cleo"] } } },
          { key: "draft", values: { title: "Draft", body: "Nothing linked yet" } },
        ],
      },
      {
        key: "books", name: "Book", plural: "Books", icon: "Book",
        fields: [
          { key: "title", name: "Title", kind: "string" },
          { key: "review", name: "Review", kind: "markdown" },
          { key: "author", name: "Author", kind: "item", target: "people" },
        ],
        items: [{ key: "dune", values: { title: "Dune" } }, { key: "emma", values: { title: "Emma", author: { ref: "people/bram" } } }],
      },
    ],
  };
}

/** `[label](#/collections/<c>/items/<i>)`: the stored form of a link to an item, optionally to a field of it. */
const link = (ids, key, label = "link", anchor = "") => {
  const [c] = key.split("/");
  return `[${label}](#/collections/${ids.collections[c]}/items/${ids.items[key]}${anchor})`;
};

/** Writes values of an item (field keys of its collection) through the repository, as a save from its page would. */
const setValues = (t, ids, key, values) =>
  t.page.evaluate(
    async ([collectionId, itemId, byField]) => {
      const repo = window.kubus.repo;
      const collection = (await repo.listCollections()).find((c) => c.id === collectionId);
      await repo.updateItem(collection, itemId, byField);
    },
    [ids.collections[key.split("/")[0]], ids.items[key], Object.fromEntries(Object.entries(values).map(([k, v]) => [ids.fields[`${key.split("/")[0]}.${k}`], v]))],
  );

/** Ada's links as seeded: notes and a book link to her in Markdown, a note refers to her in two fields. */
async function linkAda(t, ids) {
  await setValues(t, ids, "notes/reading", { body: `Read ${link(ids, "people/ada", "Ada")} first` });
  await setValues(t, ids, "notes/meeting", { body: `With ${link(ids, "people/ada", "her bio", "?field=" + ids.fields["people.bio"])} and ${link(ids, "people/bram", "Bram")}` });
  await setValues(t, ids, "books/dune", { review: `Written for ${link(ids, "people/ada", "Ada")}` });
}

/** The rows of block `block` in pane `pane` (the active one by default), as cells ([title, collection, field, updated]). */
const rowsOf = (t, block = 0, pane = null) =>
  t.page.evaluate(([block, pane]) => {
    const root = pane === null ? document.querySelector(".ws-pane--active") : document.querySelectorAll(".ws-pane")[pane];
    const b = root?.querySelectorAll(".block")[block];
    if (!b) return null;
    return [...b.querySelectorAll("tbody tr")].filter((r) => r.checkVisibility()).map((r) => [...r.querySelectorAll("td")].map((td) => td.innerText.trim()));
  }, [block, pane]);
const sorted = (rows) => rows.map((r) => r.join(" | ")).sort();

/** Waits until the block lists exactly these rows (their first cells, as a set). */
async function expectRows(t, label, expected, { block = 0, pane = null, cells = 3 } = {}) {
  let last = null;
  return t.until(label, async () => {
    last = await rowsOf(t, block, pane);
    if (!last) return "no block";
    const got = sorted(last.map((r) => r.slice(0, cells)));
    const want = sorted(expected);
    return JSON.stringify(got) === JSON.stringify(want) || `shows ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`;
  }, { timeout: 8000 });
}

const paneOf = (t, i = null) => (i === null ? t.page.locator(".ws-pane--active") : t.page.locator(".ws-pane").nth(i));
const header = (t, block = 0) => paneOf(t).locator(".block").nth(block).locator(".section-header").first();
const rulesOf = (t) => toolbarPanel(t).locator(".query-editor__rule");

/** The first block of the page as stored in the People's item view. */
const storedBlock = (t, ids) => t.page.evaluate(async (c) => (await window.kubus.repo.listCollections()).find((x) => x.id === c).itemViews[0].layout.blocks[0], ids.collections.people);

/** Block settings of the block, "Show as" set to `kind`. */
async function showAs(t, kind, block = 0) {
  await t.openPanel(header(t, block), "Block settings");
  await pickOption(t, shownPopover(t), "Show as", kind);
  await t.closeAll();
}

/** The groups of a block as shown: [heading, rows' first cells (when open)]. */
const groupsOf = (t, block = 0) =>
  t.page.evaluate((block) => {
    const b = document.querySelectorAll(".ws-pane--active .block")[block];
    return [...b.querySelectorAll(".cds--accordion__item")].map((g) => {
      const head = g.querySelector(".cds--accordion__heading");
      const rows = [...g.querySelectorAll("tbody tr")].filter((r) => r.checkVisibility()).map((r) => (r.querySelector("td")?.innerText || "").trim());
      return [head.innerText.replace(/\s+/g, " ").trim(), rows];
    });
  }, block);

/** The titles on the cards of a block. */
const cardTitles = (t, block = 0) =>
  t.page.evaluate((block) => [...document.querySelectorAll(".ws-pane--active .block")[block].querySelectorAll(".item-card__title")].map((c) => c.innerText.trim()), block);

/** The title of the item page shown. */
const itemTitle = (t) => paneOf(t).locator(".item-title").first().innerText().then((s) => s.trim(), () => "");
const adaPath = (t, ids) => t.itemPath(ids.collections.people, ids.items["people/ada"]);

/** What `Repository.listBacklinks` says about an item, as "source item/field" strings. */
const storedLinks = (t, ids, key) =>
  t.page.evaluate(async ([c, i]) => (await window.kubus.repo.listBacklinks(c, i, "default")).map((l) => `${l.sourceItemId}/${l.fieldId}`).sort(), [ids.collections[key.split("/")[0]], ids.items[key]]);
const linkKey = (ids, item, field) => `${ids.items[item]}/${ids.fields[field]}`;

const ADA_ROWS = [
  ["Reading list", "Notes", "Body"],
  ["Meeting", "Notes", "Body"],
  ["Plan", "Notes", "About"],
  ["Plan", "Notes", "Others"],
  ["Dune", "Books", "Review"],
];

// ---- the table ----------------------------------------------------------------------------------

test("backlinks: a table at the bottom of an item page lists the items that link to it", async (t) => {
  await t.boot();
  const ids = await t.seed(linkSpec());
  await linkAda(t, ids);
  await t.open(adaPath(t, ids));
  await expectRows(t, "one row for each link to Ada", ADA_ROWS);
  const heading = await header(t).innerText();
  await t.check("the block is headed Backlinks", heading.includes("Backlinks"), heading);
  await t.check("each row has the linking item's date", (await rowsOf(t)).every((r) => r.length >= 4 && r[3].length > 0), JSON.stringify(await rowsOf(t)));
  await t.audit("Ada's page with her backlinks");
  // What the repository reads is what the page shows, also after a reload.
  const expected = [linkKey(ids, "notes/reading", "notes.body"), linkKey(ids, "notes/meeting", "notes.body"), linkKey(ids, "notes/plan", "notes.about"), linkKey(ids, "notes/plan", "notes.others"), linkKey(ids, "books/dune", "books.review")].sort();
  await t.check("the repository gives the same links", JSON.stringify(await storedLinks(t, ids, "people/ada")) === JSON.stringify(expected), JSON.stringify(await storedLinks(t, ids, "people/ada")));
  await t.open(adaPath(t, ids));
  await expectRows(t, "after a reload the rows are the same", ADA_ROWS);
  // A title opens the linking item.
  await paneOf(t).locator(".block tbody tr").filter({ hasText: "Dune" }).locator("a").first().click();
  await t.until("the title opens the book", async () => (await itemTitle(t)) === "Dune");
}, { smoke: true });

test("backlinks: the Collection picker of an item page's block offers Backlinks, and nothing else does", async (t) => {
  await t.boot();
  const spec = linkSpec({ withView: false });
  spec.collections[0].itemViews = [{ name: "Page", layout: { fields: ["name", "bio", "blk"], blocks: [{ id: "blk", kind: "table", collection: "notes", title: "Notes" }] } }];
  const ids = await t.seed(spec);
  await linkAda(t, ids);
  await t.open(adaPath(t, ids));
  await t.until("the block lists the four notes", async () => ((await rowsOf(t)) || []).filter((r) => r[0]).length === 4);
  await t.openPanel(header(t), "Block settings");
  await dropdownOf(t, shownPopover(t), "Collection").locator(".cds--list-box__field").first().click();
  const offered = (await t.page.getByRole("option").filter({ visible: true }).allInnerTexts()).map((s) => s.trim());
  await t.check("the picker lists the collections and Backlinks", ["Books", "Notes", "People", "Backlinks"].every((o) => offered.includes(o)), offered.join(", "));
  await t.check("Backlinks comes after the collections", offered.indexOf("Backlinks") === offered.length - 1, offered.join(", "));
  await t.audit("the Collection picker with Backlinks");
  await t.page.getByRole("option", { name: "Backlinks", exact: true }).click();
  await t.until("the block stores the Backlinks collection with the fields a new block shows", async () => {
    const b = await storedBlock(t, ids);
    return (b.collectionId === BACKLINKS && JSON.stringify(b.layout.fields) === JSON.stringify(SHOWN) && !(b.filters && b.filters.length)) || JSON.stringify(b);
  });
  await expectRows(t, "it lists Ada's backlinks", ADA_ROWS);
  await t.closeAll();
  await t.open(adaPath(t, ids));
  await expectRows(t, "after a reload the block still lists them", ADA_ROWS);
  // To a collection and back: each starts afresh.
  await t.openPanel(header(t), "Block settings");
  await pickOption(t, shownPopover(t), "Collection", "Books");
  await t.until("another collection: the block lists its items", async () => (await storedBlock(t, ids)).collectionId === ids.collections.books);
  await t.closeAll();
  // (Books refer to People, so the new block is filtered to the books by this person: Ada has none.)
  await t.until("filtered to this person's books: none", async () => (await storedBlock(t, ids)).filters.length === 1 && ((await rowsOf(t)) || []).filter((r) => r[0]).length === 0);
  // Nowhere else is it a collection.
  await t.open("/collections");
  const text = (await t.page.locator("body").innerText()).replace(/\s+/g, " ");
  await t.check("the Collections page and the side nav don't list it", !text.includes("Backlink"), text.slice(0, 300));
  await t.open(t.listPath(ids.collections.books));
  await t.openPanel(header(t), "Block settings");
  await t.check("a collection view's block has no Collection picker", (await dropdownOf(t, shownPopover(t), "Collection").count()) === 0 || !(await dropdownOf(t, shownPopover(t), "Collection").isVisible()));
  await t.closeAll();
});

test("backlinks: rows appear and disappear as links change in another item's Markdown", async (t) => {
  await t.boot();
  const ids = await t.seed(linkSpec());
  await linkAda(t, ids);
  const ada = adaPath(t, ids);
  const draft = t.itemPath(ids.collections.notes, ids.items["notes/draft"]);
  await t.seed({ prefs: { "kubus.workspace.default": wsLayout([[ada], [draft]], { active: 1 }) } });
  await t.open(draft, { keepTabs: true });
  await expectRows(t, "Ada's page is in the first pane, with her five rows", ADA_ROWS, { pane: 0 });
  // Typing a link to Ada into the Draft's Body, by name as a person would.
  const edit = paneOf(t, 1).getByRole("button", { name: "Edit Body", exact: true }).first();
  await edit.click({ position: await t.visiblePoint(edit) });
  const pm = paneOf(t, 1).locator(".ProseMirror");
  await pm.waitFor({ timeout: 5000 });
  await t.wait(200);
  await pm.click({ position: { x: 4, y: 4 } });
  await t.page.keyboard.press("Control+End");
  await t.page.keyboard.type(" See [Ada](person/ada");
  await t.page.keyboard.type(")");
  await t.until("the typed link is stored by id", async () => ((await pm.locator("a").filter({ hasText: "Ada" }).getAttribute("href").catch(() => "")) || "").startsWith("#/collections/"));
  await t.page.keyboard.press("Control+Enter");
  await t.until("the editor closed", async () => (await paneOf(t, 1).locator(".ProseMirror").count()) === 0);
  await expectRows(t, "the first pane's table gets a row for the Draft, without a reload", [...ADA_ROWS, ["Draft", "Notes", "Body"]], { pane: 0 });
  await t.check("the repository agrees", (await storedLinks(t, ids, "people/ada")).includes(linkKey(ids, "notes/draft", "notes.body")));
  await t.audit("two panes: the page and the note linking to it");
  // Replacing the text takes the link away: the row goes.
  const again = paneOf(t, 1).getByRole("button", { name: "Edit Body", exact: true }).first();
  await again.click({ position: await t.visiblePoint(again) });
  await paneOf(t, 1).locator(".ProseMirror").waitFor({ timeout: 5000 });
  await t.wait(200);
  await t.page.keyboard.press("Control+a");
  await t.page.keyboard.type("No links any more");
  await t.page.keyboard.press("Control+Enter");
  await t.until("the editor closed again", async () => (await paneOf(t, 1).locator(".ProseMirror").count()) === 0);
  await expectRows(t, "the row goes, five are left", ADA_ROWS, { pane: 0 });
  await t.check("the repository agrees: no link from the Draft", !(await storedLinks(t, ids, "people/ada")).includes(linkKey(ids, "notes/draft", "notes.body")));
}, { smoke: true });

test("backlinks: rows follow reference fields and lists of items, on each person's own page", async (t) => {
  await t.boot();
  const ids = await t.seed(linkSpec());
  await linkAda(t, ids);
  await t.open(adaPath(t, ids));
  await expectRows(t, "Ada's rows", ADA_ROWS);
  const draftAbout = ["Draft", "Notes", "About"];
  const draftOthers = ["Draft", "Notes", "Others"];
  // A reference field.
  await setValues(t, ids, "notes/draft", { about: ids.items["people/ada"] });
  await expectRows(t, "About: a row for the Draft", [...ADA_ROWS, draftAbout]);
  // A list of items: one row for the field, however many items it holds.
  await setValues(t, ids, "notes/draft", { others: [ids.items["people/ada"], ids.items["people/bram"], ids.items["people/cleo"]] });
  await expectRows(t, "Others: one more row", [...ADA_ROWS, draftAbout, draftOthers]);
  // Pointing elsewhere takes the row away; a list that no longer holds Ada too.
  await setValues(t, ids, "notes/plan", { about: ids.items["people/bram"], others: [ids.items["people/cleo"]] });
  const withoutPlan = ADA_ROWS.filter((r) => r[0] !== "Plan");
  await expectRows(t, "Plan no longer points at Ada", [...withoutPlan, draftAbout, draftOthers]);
  await setValues(t, ids, "notes/draft", { about: null, others: [] });
  await expectRows(t, "an emptied field takes its row away", withoutPlan);
  const expected = [linkKey(ids, "notes/reading", "notes.body"), linkKey(ids, "notes/meeting", "notes.body"), linkKey(ids, "books/dune", "books.review")].sort();
  await t.check("the repository agrees", JSON.stringify(await storedLinks(t, ids, "people/ada")) === JSON.stringify(expected), JSON.stringify(await storedLinks(t, ids, "people/ada")));
  // Bram's page: his own rows, found the same way.
  await t.open(t.itemPath(ids.collections.people, ids.items["people/bram"]));
  await expectRows(t, "Bram's rows: a Markdown link, a book's author, a note's reference", [["Meeting", "Notes", "Body"], ["Emma", "Books", "Author"], ["Plan", "Notes", "About"]]);
  await t.audit("Bram's page");
});

test("backlinks: what counts as a link", async (t) => {
  await t.boot();
  const ids = await t.seed(linkSpec());
  const people = ids.collections.people;
  const cleo = ids.items["people/cleo"];
  await t.open(t.itemPath(people, cleo));
  await expectRows(t, "Cleo has one row (the Plan's list)", [["Plan", "Notes", "Others"]]);
  // To the item, however its page is named; not to a collection, a view, the new item form or something outside.
  const text = [
    link(ids, "people/cleo", "plain"),
    link(ids, "people/cleo", "field", "?field=" + ids.fields["people.bio"]),
    link(ids, "people/cleo", "view", "?view=x&block=y"),
    `[collection](#/collections/${people}/items)`,
    `[view](#/collections/${people}/items?view=x)`,
    `[new](#/collections/${people}/items/new)`,
    `[web](https://example.com/#/collections/${people}/items/${cleo})`,
    "[by name](person/cleo)",
  ].join("\n\n");
  await setValues(t, ids, "notes/draft", { body: text });
  const expected = [["Plan", "Notes", "Others"], ["Draft", "Notes", "Body"]];
  await expectRows(t, "one row for the Draft, however many links to Cleo it holds", expected);
  // A plain text field is not read for links.
  await setValues(t, ids, "notes/meeting", { title: link(ids, "people/cleo") });
  await expectRows(t, "a String field is not scanned", expected);
  // A person linking to herself is not her own backlink.
  await setValues(t, ids, "people/cleo", { bio: `I am ${link(ids, "people/cleo", "me")}` });
  await expectRows(t, "an item's own link is left out", expected);
  // A link to an item that doesn't exist counts for no one on this page.
  await setValues(t, ids, "notes/draft", { body: `[gone](#/collections/${people}/items/00000000-0000-4000-8000-000000000000)` });
  await expectRows(t, "no more link to Cleo", [["Plan", "Notes", "Others"]]);
  await t.audit("Cleo's page");
});

// ---- the block's own menus ----------------------------------------------------------------------

test("backlinks: group by Collection, the groups' order, kept with the page", async (t) => {
  await t.boot();
  const ids = await t.seed(linkSpec());
  await linkAda(t, ids);
  await t.open(adaPath(t, ids));
  await expectRows(t, "ungrouped", ADA_ROWS);
  await t.openPanel(header(t), "Sort and group");
  const panel = toolbarPanel(t);
  const groupBy = panel.getByLabel("Group by", { exact: true });
  const options = await groupBy.locator("option").allInnerTexts();
  await t.check("Group by offers the Backlinks' fields that can be grouped", ["No grouping", "Title", "Collection", "Field"].every((o) => options.includes(o)) && !options.includes("Item"), options.join(", "));
  await groupBy.selectOption({ label: "Collection" });
  await t.until("two groups, Books and Notes, with their rows", async () => {
    const groups = await groupsOf(t);
    return (groups.length === 2 && /^Books/.test(groups[0][0]) && /^Notes/.test(groups[1][0]) && groups[0][1].join() === "Dune" && groups[1][1].length === 4) || JSON.stringify(groups);
  });
  await panel.getByLabel("Group order", { exact: true }).selectOption({ label: "Most items first" });
  await t.until("most items first: Notes, then Books", async () => {
    const groups = await groupsOf(t);
    return (groups.length === 2 && /^Notes/.test(groups[0][0]) && /^Books/.test(groups[1][0])) || JSON.stringify(groups);
  });
  await t.audit("grouped by Collection");
  await groupBy.selectOption({ label: "Field" });
  await t.until("by Field: About, Body, Others, Review", async () => {
    const names = (await groupsOf(t)).map(([h]) => h.replace(/\s*\(?\d+\)?$/, "")).sort();
    return JSON.stringify(names) === JSON.stringify(["About", "Body", "Others", "Review"]) || names.join();
  });
  await groupBy.selectOption({ label: "Collection" });
  await t.closeAll();
  // Unsaved until Save changes; then stored with the block.
  await t.until("the page offers to save", async () => (await t.page.getByRole("button", { name: "Save changes to view" }).count()) === 1);
  await t.page.getByRole("button", { name: "Save changes to view" }).click();
  await t.until("stored: grouped by Collection, most items first", async () => {
    const b = await storedBlock(t, ids);
    return (b.groupBy === "collection" && b.groupOrder === "count") || JSON.stringify(b);
  });
  await t.open(adaPath(t, ids));
  await t.until("after a reload the groups are there", async () => (await groupsOf(t)).length === 2 || JSON.stringify(await groupsOf(t)));
  // A group collapses, and stays collapsed.
  await paneOf(t).locator(".block .cds--accordion__heading").filter({ hasText: "Notes" }).first().click();
  const notesRows = async () => (await groupsOf(t)).find(([h]) => h.startsWith("Notes"))[1].length;
  await t.until("the Notes group is closed", async () => (await notesRows()) === 0);
  await t.open(adaPath(t, ids));
  await t.until("and closed after a reload", async () => (await notesRows()) === 0 || String(await notesRows()));
});

test("backlinks: filter and sort the rows", async (t) => {
  await t.boot();
  const ids = await t.seed(linkSpec());
  await linkAda(t, ids);
  await t.open(adaPath(t, ids));
  await expectRows(t, "unfiltered", ADA_ROWS);
  await t.openPanel(header(t), "Filter");
  await toolbarPanel(t).getByRole("button", { name: "Add filter" }).click();
  await t.settle(100);
  const rule = rulesOf(t).last();
  const fields = await rule.getByLabel("Field", { exact: true }).locator("option").allInnerTexts();
  await t.check("a rule can use the Backlinks' fields", ["Title", "Collection", "Field", "Item", "Created", "Updated"].every((f) => fields.includes(f)), fields.join(", "));
  const set = async (field, cond, value) => {
    await rule.getByLabel("Field", { exact: true }).selectOption({ label: field });
    await rule.getByLabel("Condition", { exact: true }).selectOption({ label: cond });
    if (value !== undefined) await rule.getByLabel("Value", { exact: true }).fill(value);
    await t.settle(100);
  };
  await set("Collection", "is", "Books");
  await expectRows(t, "Collection is Books", [["Dune", "Books", "Review"]]);
  await set("Collection", "is not", "Books");
  await expectRows(t, "Collection is not Books", ADA_ROWS.filter((r) => r[1] !== "Books"));
  await set("Field", "contains", "o");
  await expectRows(t, "Field contains o", ADA_ROWS.filter((r) => r[2].toLowerCase().includes("o")));
  await set("Title", "contains", "zz");
  await expectRows(t, "Title contains zz", []);
  await set("Title", "contains", "e");
  await expectRows(t, "Title contains e", ADA_ROWS.filter((r) => r[0].toLowerCase().includes("e")));
  await t.audit("a filter on Title", { shotOnFail: true });
  await rule.getByRole("button", { name: "Remove filter" }).click();
  await expectRows(t, "Remove filter shows all again", ADA_ROWS);
  await t.closeAll();
  // Sort by Field, descending, then ascending, then by Title.
  await t.openPanel(header(t), "Sort and group");
  const sort = toolbarPanel(t).getByLabel("Sort by", { exact: true });
  const column = async (i) => ((await rowsOf(t)) || []).map((r) => r[i]).join();
  await sort.selectOption({ label: "Field" });
  await toolbarPanel(t).getByLabel("Direction", { exact: true }).selectOption({ label: "Descending" });
  await t.until("sorted by Field, descending", async () => (await column(2)) === "Review,Others,Body,Body,About" || (await column(2)));
  await toolbarPanel(t).getByLabel("Direction", { exact: true }).selectOption({ label: "Ascending" });
  await t.until("and ascending", async () => (await column(2)) === "About,Body,Body,Others,Review" || (await column(2)));
  await sort.selectOption({ label: "Title" });
  await t.until("by Title", async () => (await column(0)) === "Dune,Meeting,Plan,Plan,Reading list" || (await column(0)));
  await t.closeAll();
});

// ---- the other block types ------------------------------------------------------------------------

test("backlinks: cards, with the linking items' titles and fields", async (t) => {
  await t.boot();
  const ids = await t.seed(linkSpec({ block: { kind: "cards", options: { coverFieldId: null, cardWidth: 16, coverRatio: "auto", showTitle: true, coverBeside: false } } }));
  await linkAda(t, ids);
  await t.open(adaPath(t, ids));
  await t.until("five cards, titled with the linking items", async () => (await cardTitles(t)).sort().join() === ["Dune", "Meeting", "Plan", "Plan", "Reading list"].join() || (await cardTitles(t)).join());
  const text = await paneOf(t).locator(".block").first().innerText();
  await t.check("a card shows its collection and field", /Notes/.test(text) && /Books/.test(text) && /Review/.test(text) && /Others/.test(text), text.slice(0, 400));
  await t.audit("backlinks as cards");
  await paneOf(t).locator(".block .item-card").filter({ hasText: "Reading list" }).locator("a.item-card__link").click();
  await t.until("a card opens the linking item", async () => (await itemTitle(t)) === "Reading list");
  // Show as, in the UI: table, then cards again.
  await t.open(adaPath(t, ids));
  await showAs(t, "Table");
  await expectRows(t, "as a table", ADA_ROWS);
  await showAs(t, "Cards");
  await t.until("and as cards again", async () => (await cardTitles(t)).length === 5);
  await t.until("stored as cards over Backlinks", async () => {
    const b = await storedBlock(t, ids);
    return (b.kind === "cards" && b.collectionId === BACKLINKS) || JSON.stringify(b);
  });
});

test("backlinks: a Component block reads them as $items, $groups and $fields", async (t) => {
  await t.boot();
  const spec = linkSpec({ block: { kind: "component", componentKey: "list", groupBy: "collection" } });
  spec.components = [
    {
      key: "list", name: "Backlink list",
      code: '**{{ $items.length }} links** from {{ $groups.length }} collections ({{ $fields.map((f) => f.name).join(", ") }})\n\n{{ $groups.map((g) => "### " + g.label + "\\n" + g.items.map((i) => "- " + i.Title + " via " + i.Field + " (" + i.Collection + ")").join("\\n")).join("\\n\\n") }}',
    },
    { key: "links", name: "Backlink links", code: '{{ $items.map((i) => "- " + i.Item).join("\\n") }}' },
  ];
  const ids = await t.seed(spec);
  await linkAda(t, ids);
  await t.open(adaPath(t, ids));
  const shown = () => paneOf(t).locator(".component-block").first().innerText().then((s) => s.replace(/\s+/g, " "), () => "");
  await t.until("the component lists the rows by group", async () => {
    const text = await shown();
    return (/5 links from 2 collections/.test(text) && /Dune via Review \(Books\)/.test(text) && /Reading list via Body \(Notes\)/.test(text) && /Plan via Others \(Notes\)/.test(text)) || text;
  });
  await t.check("$fields names the block's fields", /Title, Collection, Field, Updated/.test(await shown()), await shown());
  await t.audit("a component over backlinks");
  // The block's Filter narrows $items, as for any collection.
  await t.openPanel(header(t), "Filter");
  await toolbarPanel(t).getByRole("button", { name: "Add filter" }).click();
  const rule = rulesOf(t).last();
  await rule.getByLabel("Field", { exact: true }).selectOption({ label: "Collection" });
  await rule.getByLabel("Condition", { exact: true }).selectOption({ label: "is" });
  await rule.getByLabel("Value", { exact: true }).fill("Books");
  await t.until("only the book is in $items", async () => /1 links from 1 collections/.test(await shown()) || (await shown()));
  await t.closeAll();
  // $item.Item is a link to the linking item.
  await t.openPanel(header(t), "Block settings");
  await pickOption(t, shownPopover(t), "Component", "Backlink links");
  await t.closeAll();
  await t.until("the other component lists links", async () => (await paneOf(t).locator(".component-block a").count()) >= 1);
  await paneOf(t).locator(".component-block a").first().click();
  await t.until("a link of $item.Item opens the linking item", async () => (await itemTitle(t)) === "Dune");
});

test("backlinks: a chart counts them by collection", async (t) => {
  await t.boot();
  const series = { id: "a", value: "count", field: null, label: "", style: null, axis: "left", transform: "none", window: 3 };
  const ids = await t.seed(linkSpec({ block: { kind: "chart", layout: { fields: null }, options: { chart: "bar", x: { by: "field", field: "@collection" }, series: [series] } } }));
  await linkAda(t, ids);
  await t.open(adaPath(t, ids));
  const bars = () => t.count(".ws-pane--active .block path.bar");
  await t.until("a bar for each collection", async () => (await bars()) === 2 || `${await bars()} bars: ${(await paneOf(t).locator(".block").first().innerText()).slice(0, 200)}`, { timeout: 15000 });
  const ticks = await t.page.evaluate(() => [...new Set([...document.querySelectorAll(".ws-pane--active .block g.axis.bottom g.tick text")].map((e) => e.textContent.trim()))].sort());
  await t.check("labelled Books and Notes", ticks.join() === "Books,Notes", ticks.join());
  await t.audit("a chart over backlinks");
  // The bars follow the links.
  await setValues(t, ids, "books/dune", { review: "no link" });
  await t.until("one bar when the book stops linking", async () => (await bars()) === 1 || `${await bars()} bars`, { timeout: 15000 });
});

// ---- read-only ----------------------------------------------------------------------------------

test("backlinks: read-only, unlike an ordinary table beside it", async (t) => {
  await t.boot();
  const spec = linkSpec();
  const layout = spec.collections[0].itemViews[0].layout;
  layout.fields = ["name", "bio", "bl", "notes-block"];
  layout.blocks.push({ id: "notes-block", kind: "table", collection: "notes", title: "Notes" });
  const ids = await t.seed(spec);
  await linkAda(t, ids);
  await t.open(adaPath(t, ids));
  await expectRows(t, "backlinks", ADA_ROWS, { block: 0 });
  await t.until("the notes table is there too", async () => ((await rowsOf(t, 1)) || []).filter((r) => r[0]).length === 4);
  const surface = (block) =>
    t.page.evaluate((block) => {
      const b = document.querySelectorAll(".ws-pane--active .block")[block];
      const buttons = [...b.querySelectorAll("tbody button, tbody [role=button]")].map((x) => (x.getAttribute("aria-label") || x.innerText || "").trim()).filter(Boolean);
      return { buttons, inputs: b.querySelectorAll("tbody input, tbody textarea, tbody select").length };
    }, block);
  const notes = await surface(1);
  const links = await surface(0);
  await t.check("the notes table has row actions (the contrast)", notes.buttons.length > 0, JSON.stringify(notes));
  await t.check("the backlinks table has none: no delete, duplicate or edit", links.buttons.length === 0, JSON.stringify(links));
  await t.check("and no inputs", links.inputs === 0, JSON.stringify(links));
  const names = await paneOf(t).locator(".block").first().getByRole("button").evaluateAll((els) => els.map((e) => (e.getAttribute("aria-label") || e.textContent || "").trim()));
  await t.check("no way to add an item to it", !names.some((n) => /^(Add|New|Create)\b/i.test(n) && !/^Add filter/i.test(n)), names.join(" | "));
  // Clicking a cell doesn't edit it.
  const before = JSON.stringify(await rowsOf(t));
  await paneOf(t).locator(".block").first().locator("tbody tr").first().locator("td").nth(2).click();
  await t.settle(200);
  await t.check("a cell is not edited by clicking it", (await t.count(".ws-pane--active .block .field-editor, .ws-pane--active .block tbody input")) === 0);
  await t.check("and the rows are as they were", JSON.stringify(await rowsOf(t)) === before);
  // Sorting by a column header works, as it does for a remote collection's rows.
  await paneOf(t).locator(".block").first().locator("thead th").filter({ hasText: "Field" }).locator("button").first().click();
  await t.until("a click on the Field header sorts by it", async () => ((await rowsOf(t)) || []).map((r) => r[2]).join() === "About,Body,Body,Others,Review" || ((await rowsOf(t)) || []).map((r) => r[2]).join());
  await t.audit("the two tables");
});

test("backlinks: rows leave with deleted or moved items, removed fields and deleted collections", async (t) => {
  await t.boot();
  const ids = await t.seed(linkSpec());
  await linkAda(t, ids);
  await t.open(adaPath(t, ids));
  await expectRows(t, "all five", ADA_ROWS);
  // Deleting the linking item.
  await t.page.evaluate((id) => window.kubus.repo.deleteItem(id), ids.items["notes/reading"]);
  await expectRows(t, "a deleted item's row goes", ADA_ROWS.filter((r) => r[0] !== "Reading list"));
  // Moving an item to another space (the page lists its own space's items only), and back.
  await t.page.evaluate(([id, space]) => window.kubus.repo.moveItem(id, space), [ids.items["notes/meeting"], ids.spaces.work]);
  await expectRows(t, "an item in another space is left out", ADA_ROWS.filter((r) => !["Reading list", "Meeting"].includes(r[0])));
  await t.page.evaluate((id) => window.kubus.repo.moveItem(id, "default"), ids.items["notes/meeting"]);
  await expectRows(t, "and listed again when it is back", ADA_ROWS.filter((r) => r[0] !== "Reading list"));
  // Removing the field that holds a link (Others), then a whole collection (Books).
  await t.page.evaluate(async (c) => {
    const repo = window.kubus.repo;
    const collection = (await repo.listCollections()).find((x) => x.id === c);
    const fields = collection.fields.filter((f) => f.name !== "Others").map(({ collectionId: _c, position: _p, ...f }) => f);
    await repo.saveCollection({ id: collection.id, name: collection.name, pluralName: collection.pluralName, icon: collection.icon, description: collection.description, spaceIds: collection.spaceIds, source: null, titleField: collection.titleField ?? null, fields }, "default");
  }, ids.collections.notes);
  await expectRows(t, "a removed field's row goes", ADA_ROWS.filter((r) => r[0] !== "Reading list" && r[2] !== "Others"));
  await t.page.evaluate((c) => window.kubus.repo.deleteCollection(c), ids.collections.books);
  await expectRows(t, "a deleted collection's rows go", [["Meeting", "Notes", "Body"], ["Plan", "Notes", "About"]]);
  await t.check("the repository agrees", (await storedLinks(t, ids, "people/ada")).length === 2, JSON.stringify(await storedLinks(t, ids, "people/ada")));
  await t.audit("after the links were taken away");
});

// ---- a remote collection's row --------------------------------------------------------------------

const CRM_URL = "https://remote.test";
const CRM_COLUMNS = [
  { name: "id", type: "integer", kind: "number" },
  { name: "name", type: "text", kind: "string" },
];

/** A fake Kubus server with a CRM source of 20 customers (keys "1" to "20"): their table's pages and one row by key. */
async function fakeCrm(t) {
  await t.context.route(`${CRM_URL}/api/**`, async (route) => {
    const req = route.request();
    const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS" };
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    const path = req.url().slice(CRM_URL.length);
    if (path === "/api/events") return route.fulfill({ status: 204, headers: cors });
    if (path === "/api/health") return route.fulfill({ status: 200, headers: cors, json: { ok: true } });
    if (path === "/api/sources") return route.fulfill({ status: 200, headers: cors, json: [{ name: "CRM", connector: "postgres" }] });
    const body = JSON.parse(req.postData() || "{}");
    const cell = (i) => ({ id: i, name: `Customer ${i}` });
    if (/\/row$/.test(path)) {
      const i = Number(body.keyValue);
      return route.fulfill({ status: 200, headers: cors, json: { row: i >= 1 && i <= 20 ? { key: String(i), values: body.columns.map((c) => cell(i)[c] ?? null) } : null } });
    }
    if (/\/query$/.test(path)) {
      const end = Math.min(body.offset + body.limit, 20);
      const rows = [];
      for (let i = body.offset + 1; i <= end; i++) rows.push({ key: String(i), values: body.columns.map((c) => cell(i)[c] ?? null) });
      return route.fulfill({ status: 200, headers: cors, json: { rows, more: end < 20, ...(body.counts && { total: 20 }) } });
    }
    return route.fulfill({ status: 404, headers: cors, json: { error: "Not found" } });
  });
}

test("backlinks: a remote collection's row lists the native items that link to it", async (t) => {
  await t.boot();
  await fakeCrm(t);
  const ids = await t.seed(linkSpec());
  await t.page.evaluate((url) => localStorage.setItem("kubus.sync", JSON.stringify({ url, token: "tok", enabled: false, originals: "always" })), CRM_URL);
  // The remote collection (as the editor stores it), with an item view that has a Backlinks block.
  const remote = await t.page.evaluate(
    async ([columns, shown]) => {
      const repo = window.kubus.repo;
      const id = crypto.randomUUID();
      const fields = columns.map((c) => ({ id: crypto.randomUUID(), name: c.name, kind: c.kind, targetCollectionId: null, componentId: null, code: null, output: null, frameRatio: null, choiceFilter: [], toggleIcon: null, strikeThrough: false, column: c.name }));
      const source = { name: "CRM", target: { table: { schema: "public", name: "customers" } }, key: "id", columns };
      await repo.saveCollection({ id, name: "Customer", pluralName: "Customers", icon: "DataBase", description: "", spaceIds: null, source, titleField: null, fields }, "default");
      const block = { id: "bl", title: "Backlinks", kind: "table", filters: null, sort: [{ fieldId: "$title", direction: "asc" }], groupBy: null, layout: { fields: shown, editable: true, hiddenLabels: [], hideEmpty: false }, collectionId: "$backlinks", options: { titleLink: true, editable: true } };
      await repo.saveItemViews(id, [{ id: crypto.randomUUID(), name: "Page", isDefault: true, collapsed: { blocks: [], groups: {} }, layout: { fields: null, filters: [], hiddenLabels: [], blocks: [block], editable: false, hideEmpty: false } }]);
      return id;
    },
    [CRM_COLUMNS, SHOWN],
  );
  // A row's item id is the base64url of its key.
  const rowId = (key) => t.page.evaluate((k) => btoa(k).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""), key);
  const three = await rowId("3");
  const four = await rowId("4");
  await setValues(t, ids, "notes/reading", { body: `The customer: [Customer 3](#/collections/${remote}/items/${three})` });
  await setValues(t, ids, "books/dune", { review: `[a customer](#/collections/${remote}/items/${three}) and [another](#/collections/${remote}/items/${four})` });
  await t.open(t.itemPath(remote, three));
  await t.until("the remote row is shown", async () => /Customer 3/.test(await paneOf(t).innerText()));
  await expectRows(t, "its backlinks: the note and the book", [["Reading list", "Notes", "Body"], ["Dune", "Books", "Review"]]);
  await t.audit("a remote row's backlinks");
  await t.open(t.itemPath(remote, four));
  await t.until("the other row is shown", async () => /Customer 4/.test(await paneOf(t).innerText()));
  await expectRows(t, "another row: only the book", [["Dune", "Books", "Review"]]);
  // Live, as on a native page.
  await setValues(t, ids, "notes/meeting", { body: `Also [customer 4](#/collections/${remote}/items/${four})` });
  await expectRows(t, "a new link appears", [["Dune", "Books", "Review"], ["Meeting", "Notes", "Body"]]);
  await paneOf(t).locator(".block tbody tr").filter({ hasText: "Meeting" }).locator("a").first().click();
  await t.until("a row opens the native item", async () => (await itemTitle(t)) === "Meeting");
});

// ---- other sizes and themes ---------------------------------------------------------------------

for (const [label, opts] of [["phone", { viewport: "phone" }], ["dark theme", { dark: true }]]) {
  test(`backlinks: table, groups and cards, audited @ ${label}`, async (t) => {
    await t.boot();
    const ids = await t.seed(linkSpec());
    await linkAda(t, ids);
    await t.open(adaPath(t, ids));
    await expectRows(t, "the rows", ADA_ROWS);
    await t.audit(`backlinks table, ${label}`);
    await t.openPanel(header(t), "Sort and group");
    await toolbarPanel(t).getByLabel("Group by", { exact: true }).selectOption({ label: "Collection" });
    await t.until("grouped", async () => (await groupsOf(t)).length === 2);
    await t.audit(`backlinks grouped, ${label} (sort and group open)`);
    await t.closeAll();
    await t.audit(`backlinks grouped, ${label}`);
    await showAs(t, "Cards");
    await t.until("cards", async () => (await cardTitles(t)).length === 5);
    await t.audit(`backlinks as cards, ${label}`);
    await t.openPanel(header(t), "Block settings");
    await dropdownOf(t, shownPopover(t), "Collection").locator(".cds--list-box__field").first().click();
    await t.audit(`the Collection picker with Backlinks, ${label}`);
    await t.closeAll();
  }, opts);
}

test("backlinks: a page without any shows an empty table, and rows come when links are made", async (t) => {
  await t.boot();
  const ids = await t.seed(linkSpec());
  await t.open(t.itemPath(ids.collections.people, ids.items["people/cleo"]));
  await expectRows(t, "Cleo has one row", [["Plan", "Notes", "Others"]]);
  await setValues(t, ids, "notes/plan", { others: [] });
  await t.until("then none: the table is empty, the block still there", async () => ((await rowsOf(t)) || ["x"]).length === 0 && (await t.count(".ws-pane--active .block")) === 1);
  await t.audit("a page without backlinks");
  await setValues(t, ids, "books/emma", { review: link(ids, "people/cleo", "Cleo") });
  await expectRows(t, "a link made later shows", [["Emma", "Books", "Review"]]);
});

// @@END@@
