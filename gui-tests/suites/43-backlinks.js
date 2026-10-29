// Backlinks: a table block on an item page listing the items that link to it (Markdown links, reference
// fields, lists of items), read back from the repository.

const BACKLINKS = "$backlinks";

/** The fields a new Backlinks block shows (domain/backlinks.ts BACKLINKS_FIELDS). */
const SHOWN = ["title", "collection", "field", "$updated"];

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
