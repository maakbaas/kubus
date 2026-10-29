// Remotes, collections and search: the Remotes page against a fake server (a remote source's
// tables, columns and pages of rows, routes on the test's browser context), the Collections page
// (new, edit, duplicate, delete, description, sort, per-space visibility), the collection editor
// (add / remove / rename fields, the title, remote vs local) and global search (hit groups, the
// 50+ count, highlights, nothing found, a ?q= deep link, the search bar in a pane). Every step is
// followed by what it did: the page shown, what was stored (window.kubus.repo), and again after a reload.

const CRM_URL = "https://remote.test";
/** The columns the fake source's customers table has. */
const COLUMNS = [
  { name: "id", type: "integer", kind: "number" },
  { name: "name", type: "text", kind: "string" },
  { name: "city", type: "text", kind: "string" },
  { name: "active", type: "boolean", kind: "checkbox" },
];

/** The customers table with a date column too (`fake.columns = DATED_COLUMNS`): joined, in January (rows 1 to 60), February (61 to 100) or March (101 on) 2026. */
const DATED_COLUMNS = [...COLUMNS, { name: "joined", type: "date", kind: "date" }];
const joinedOf = (i) => `2026-0${i < 60 ? 1 : i < 100 ? 2 : 3}-${String(1 + (i % 28)).padStart(2, "0")}`;

/**
 * A fake Kubus server at `url` that offers remote sources: GET /api/sources, /tables, POST /describe,
 * /query (pages of `fake.total` made-up customers, at most `fake.pageCap` per answer, `fake.hold`
 * (a promise) keeps the answers back from `fake.holdFrom` on), anything else 404. `fake.sources = []`
 * is a server without a remote connection. The device is given its address and token with `connectTo`.
 */
async function fakeRemotes(t, url = CRM_URL) {
  const fake = {
    requests: [],
    queries: [],
    describes: 0,
    sources: [{ name: "CRM", connector: "postgres" }, { name: "Files", connector: "csv", problem: "unreachable" }],
    tables: [{ schema: "public", name: "customers", type: "table" }, { schema: "public", name: "order_items", type: "table" }, { schema: "public", name: "recent_orders", type: "view" }],
    columns: COLUMNS,
    total: 250,
    pageCap: 100,
    hold: null,
    holdFrom: 1,
    fail: null,
  };
  await t.context.route(`${url}/api/**`, async (route) => {
    const req = route.request();
    const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS" };
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    const path = req.url().slice(url.length);
    if (path === "/api/events") return route.fulfill({ status: 204, headers: cors });
    if (path === "/api/health") return route.fulfill({ status: 200, headers: cors, json: { ok: true } });
    fake.requests.push(`${req.method()} ${path}`);
    if (path === "/api/sources") return route.fulfill({ status: 200, headers: cors, json: fake.sources });
    if (/^\/api\/sources\/[^/]+\/tables$/.test(path)) return route.fulfill({ status: 200, headers: cors, json: fake.tables });
    if (/^\/api\/sources\/[^/]+\/describe$/.test(path)) {
      fake.describes += 1;
      return route.fulfill({ status: 200, headers: cors, json: { columns: fake.columns, key: ["id"], dropped: [{ name: "secret", type: "bytea" }] } });
    }
    if (/^\/api\/sources\/[^/]+\/query$/.test(path)) {
      const body = JSON.parse(req.postData() || "{}");
      fake.queries.push(body);
      if (fake.hold && body.offset >= fake.holdFrom) await fake.hold;
      if (fake.fail) return route.fulfill({ status: 502, headers: cors, json: { error: fake.fail } });
      const end = Math.min(body.offset + Math.min(body.limit, fake.pageCap), fake.total);
      const rows = [];
      for (let i = body.offset; i < end; i++) {
        const cell = { id: i + 1, name: `Customer ${i + 1}`, city: `City ${i % 7}`, active: i % 2 === 0, joined: joinedOf(i) };
        rows.push({ key: String(i + 1), values: body.columns.map((c) => (c in cell ? cell[c] : null)) });
      }
      return route.fulfill({ status: 200, headers: cors, json: { rows, more: end < fake.total, ...(body.counts && { total: fake.total }) } });
    }
    return route.fulfill({ status: 404, headers: cors, json: { error: "Not found" } });
  });
  return fake;
}

/** Gives the device the server's address and token (without switching sync on); the next load reads them. */
const connectTo = (t, url = CRM_URL) =>
  t.page.evaluate((url) => localStorage.setItem("kubus.sync", JSON.stringify({ url, token: "tok", enabled: false, originals: "always" })), url);

/** Stores a remote collection reading the fake source's customers table, as the editor would; `block` is merged into its view's blocks. */
const makeRemote = (t, { name = "Customer", plural = "Customers", spaceIds = null, block = null, columns = COLUMNS } = {}) =>
  t.page.evaluate(
    async ([name, plural, columns, spaceIds, block]) => {
      const repo = window.kubus.repo;
      const id = crypto.randomUUID();
      const fields = columns.map((c) => ({
        id: crypto.randomUUID(), name: c.name, kind: c.kind, targetCollectionId: null, componentId: null, code: null, output: null, frameRatio: null,
        choiceFilter: [], toggleIcon: null, strikeThrough: false, column: c.name,
      }));
      const source = { name: "CRM", target: { table: { schema: "public", name: "customers" } }, key: "id", columns };
      await repo.saveCollection({ id, name, pluralName: plural, icon: "DataBase", description: "", spaceIds, source, titleField: null, fields }, "default");
      if (block) {
        // "@joined" in the block names the field of that column.
        const named = (v) =>
          typeof v === "string" && v.startsWith("@") ? (fields.find((f) => f.column === v.slice(1))?.id ?? v)
          : Array.isArray(v) ? v.map(named)
          : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, named(x)]))
          : v;
        const [v] = await repo.listViews(id, "default");
        await repo.saveView({ ...v, blocks: v.blocks.map((b) => ({ ...b, ...named(block) })) });
      }
      return id;
    },
    [name, plural, columns, spaceIds, block],
  );

const pane = (t) => t.page.locator(".ws-pane--active");
const paneText = async (t) => (await pane(t).innerText().catch(() => "")).replace(/\s+/g, " ");
const modal = (t) => t.page.locator(".cds--modal.is-visible");
const navNode = (t, id) => t.page.locator(`.nav-tree li[id="${id}"]`);
/** Whether the collection editor is on screen. */
const onEditor = async (t) => (await pane(t).locator(".form-page").count()) === 1;
const breadcrumbs = async (t) => (await pane(t).locator(".cds--breadcrumb a").allInnerTexts()).map((s) => s.trim());

/** A Carbon dropdown / combo box inside `scope`, by its title. */
const dropdown = (t, scope, title) =>
  scope.locator(".cds--dropdown__wrapper, .cds--combo-box, .cds--list-box__wrapper").filter({ has: t.page.locator(".cds--label", { hasText: new RegExp(`^${title}$`) }) }).first();
const menuOptions = async (t) => (await t.page.getByRole("option").filter({ visible: true }).allInnerTexts()).map((s) => s.trim());
async function choose(t, scope, title, option) {
  await dropdown(t, scope, title).locator(".cds--list-box__field").first().click();
  await t.settle(80);
  await t.page.getByRole("option", { name: option, exact: true }).filter({ visible: true }).first().click();
  await t.settle(80);
}

/** Every collection as stored, as plain data. */
const storedCollections = (t) => t.page.evaluate(async () => JSON.parse(JSON.stringify(await window.kubus.repo.listCollections())));
const storedBy = async (t, plural) => (await storedCollections(t)).find((c) => c.pluralName === plural) ?? null;

/** Scrolls everything back to the top (a sticky header over scrolled rows is not what the audit looks at). */
const toTop = (t) => t.page.evaluate(() => document.querySelectorAll("*").forEach((el) => el.scrollTop > 0 && (el.scrollTop = 0)));

/** The rows of the first table block on the page. */
const tableRows = (t) => pane(t).locator(".block table tbody tr");

// ---------------------------------------------------------------------------------------------
// Remotes
// ---------------------------------------------------------------------------------------------

test("remotes: the side nav branch follows the server's sources and remote collections", async (t) => {
  await t.boot();
  const fake = await fakeRemotes(t);
  await t.seed({ collections: [{ key: "books", name: "Book", fields: [{ key: "title", name: "Title", kind: "string" }], items: [{ values: { title: "Dune" } }] }] });
  // No server set up: nothing to read remote collections from.
  await t.open("/collections");
  await t.check("without a server there is no Remotes branch", (await navNode(t, "remotes").count()) === 0);
  await t.check("the Collections branch is there", (await navNode(t, "collections").count()) === 1);
  // A server without a remote connection: still none.
  await connectTo(t);
  fake.sources = [];
  await t.open("/collections");
  await t.until("the server was asked for its sources", () => fake.requests.includes("GET /api/sources"));
  await t.settle();
  await t.check("a server without sources shows no Remotes branch", (await navNode(t, "remotes").count()) === 0);
  // A server with a remote connection: the branch shows, with no collection below it yet.
  fake.sources = [{ name: "CRM", connector: "postgres" }];
  await t.open("/collections");
  await t.until("a server with a source shows the Remotes branch", async () => (await navNode(t, "remotes").count()) === 1);
  await t.audit("side nav with an empty Remotes branch");
  await t.check("the branch has no collections below it", (await navNode(t, "remotes").locator("li").count()) === 0);
  await navNode(t, "remotes").locator(".cds--tree-node__label").first().click();
  await t.until("the Remotes node opens the Remotes page", async () => (await paneText(t)).includes("Tables and queries of the server's remote connections"));
  await t.check("the page says there are no remote collections", (await paneText(t)).includes("No remote collections yet"));
  await t.check("the node is the selected one", (await navNode(t, "remotes").getAttribute("aria-selected")) === "true");
  await t.audit("Remotes page, empty");
  // A remote collection: its node lists it, and it stays after the server stops offering sources (offline, source gone).
  const id = await makeRemote(t);
  await t.until("the remote collection is listed below Remotes", async () => (await navNode(t, "remotes").innerText()).includes("Customers"));
  await t.check("not in the Collections branch", !(await navNode(t, "collections").innerText()).includes("Customers"));
  await t.check("the Collections branch keeps the native collection", (await navNode(t, "collections").innerText()).includes("Books"));
  fake.sources = [];
  await t.open("/collections");
  await t.until("the Remotes branch stays while a remote collection exists", async () => (await navNode(t, "remotes").count()) === 1);
  await navNode(t, `collection-${id}`).locator(".cds--tree-node__label").first().click();
  await t.until("a remote collection's node opens its items", async () => (await paneText(t)).includes("Customer 1"));
  await t.check("the node is selected", (await navNode(t, `collection-${id}`).getAttribute("aria-selected")) === "true");
  await t.audit("a remote collection's page from the side nav");
}, { viewport: "desktop" });

for (const vp of ["desktop", "phone"]) {
  test(`remotes: new remote collection from a source's table, listed, read, edited @ ${vp}`, async (t) => {
    await t.boot();
    const fake = await fakeRemotes(t);
    await t.seed({ collections: [{ key: "books", name: "Book", fields: [{ key: "title", name: "Title", kind: "string" }] }] });
    await connectTo(t);
    await t.open("/remotes");
    await t.check("an empty Remotes page", (await paneText(t)).includes("No remote collections yet"));
    await t.page.getByRole("button", { name: "New remote collection" }).filter({ visible: true }).first().click();
    await t.until("New remote collection opens the editor", () => onEditor(t));
    await t.check("its breadcrumb leads back to Remotes", (await breadcrumbs(t)).includes("Remotes"), (await breadcrumbs(t)).join(","));
    const form = pane(t).locator("form");
    await t.check("it asks for a Source, and has no fields until a table is read", (await form.innerText()).includes("Source") && (await form.locator(".field-row").count()) === 0);
    await t.audit("new remote collection, empty");
    // Saving without a source says what is missing.
    await t.page.getByRole("button", { name: "Add collection" }).click();
    await t.settle();
    await t.check("saving nothing is refused, naming the singular name", (await form.innerText()).includes("Singular name is required"));
    // The source: the server's, with the one that can't be read marked.
    await dropdown(t, form, "Source").locator(".cds--list-box__field").first().click();
    await t.settle(100);
    const sources = await menuOptions(t);
    await t.check("the Source menu lists the server's sources, a problem named", JSON.stringify(sources) === JSON.stringify(["CRM", "Files (unreachable)"]), sources.join(" | "));
    await t.audit("source menu open");
    await t.page.getByRole("option", { name: "CRM", exact: true }).click();
    await t.until("choosing a source asks for its tables", () => fake.requests.includes("GET /api/sources/CRM/tables"));
    const table = form.getByRole("combobox", { name: "Table" });
    await table.click();
    await t.settle(100);
    const tables = await menuOptions(t);
    await t.check("the Table menu lists tables and views", JSON.stringify(tables) === JSON.stringify(["public.customers", "public.order_items", "public.recent_orders (view)"]), tables.join(" | "));
    await t.page.getByRole("option", { name: "public.customers", exact: true }).click();
    await t.until("a table read gives a field for each column", async () => (await form.locator(".field-row").count()) === COLUMNS.length);
    await t.check("it described the table once", fake.describes === 1, String(fake.describes));
    await t.check("the names follow the table", (await pane(t).getByRole("textbox", { name: "Name" }).first().inputValue()) === "Customers" && (await form.getByRole("textbox", { name: "Singular name" }).inputValue()) === "Customer");
    const names = await form.locator(".field-row").getByRole("textbox", { name: "Field name" }).evaluateAll((els) => els.map((e) => e.value));
    await t.check("the fields are the columns", JSON.stringify(names) === JSON.stringify(COLUMNS.map((c) => c.name)), names.join(", "));
    const kinds = (await form.locator(".field-row .cds--list-box__field").allInnerTexts()).map((s) => s.trim());
    await t.check("a column's type is its field's: a checkbox for the boolean", kinds.includes("Checkbox") && kinds.includes("Number"), kinds.join("|"));
    await t.check("the key is the primary key", (await dropdown(t, form, "Key").innerText()).includes("id"));
    await t.check("columns that aren't read are named", (await form.innerText()).includes("Not read: secret (bytea)"));
    await t.check("a field says which column it shows", (await form.innerText()).includes("Column city (text)"));
    await t.audit("new remote collection, table read");
    await t.page.getByRole("button", { name: "Add collection" }).click();
    await t.until("saved: its items are shown, read from the source", async () => !(await onEditor(t)) && (await paneText(t)).includes("Customer 1"));
    await t.until("the first page is a hundred rows", async () => (await tableRows(t).count()) === 100);
    await t.check("the first query asked for the total and a page", fake.queries[0]?.counts === true && fake.queries[0]?.offset === 0 && fake.queries[0]?.limit === 100 && fake.queries[0]?.target.table.name === "customers", JSON.stringify(fake.queries[0]));
    await t.audit("a remote collection's items");
    // What was stored.
    const c = await storedBy(t, "Customers");
    await t.check("stored with its source, table and key", c?.source?.name === "CRM" && c.source.target.table.name === "customers" && c.source.key === "id" && c.source.columns.length === 4, JSON.stringify(c?.source));
    await t.check("stored with a field per column", c?.fields.length === 4 && c.fields.every((f) => f.column === f.name), JSON.stringify(c?.fields.map((f) => f.column)));
    // The Remotes page lists it with its source; the Collections page doesn't.
    await t.open("/remotes");
    await t.check("the Remotes page lists it", (await paneText(t)).includes("Customers"), await paneText(t));
    // A phone's list keeps the name column and the actions only.
    if (!t.phone) await t.check("with a Source column naming its source", (await pane(t).locator("thead").innerText()).includes("Source") && (await pane(t).locator("tbody tr").first().innerText()).includes("CRM"));
    await t.audit("Remotes page with a collection");
    await t.open("/collections");
    await t.check("the Collections page does not list it", !(await paneText(t)).includes("Customers") && (await paneText(t)).includes("Books"));
    // Opened under the other path, the editor sends a remote collection to its own.
    await t.open(`/collections/${c.id}/edit`);
    await t.until("a remote collection opened as a collection is edited under Remotes", async () => (await breadcrumbs(t)).includes("Remotes"));
    await t.check("the editor shows its source", (await paneText(t)).includes("Source") && (await paneText(t)).includes("CRM"));
    await t.audit("remote collection editor");
  }, { viewport: vp, smoke: vp === "desktop" });
}

test("remotes: edit — the source is fixed, columns read again or hidden, rows still read", async (t) => {
  await t.boot();
  const fake = await fakeRemotes(t);
  await connectTo(t);
  const id = await makeRemote(t);
  await t.open(`/remotes/${id}/edit`);
  const form = pane(t).locator("form");
  await t.until("the editor shows the collection", async () => (await form.locator(".field-row").count()) === 4);
  await t.check("the source cannot change any more", await dropdown(t, form, "Source").locator("button.cds--list-box__field").first().isDisabled());
  await t.check("columns can be read again", (await form.getByRole("button", { name: "Read columns again" }).count()) === 1);
  await t.settle(300);
  await t.check("opening the editor reads nothing from the table", fake.describes === 0, String(fake.describes));
  await form.getByRole("button", { name: "Read columns again" }).click();
  await t.until("Read columns again describes the table once", () => fake.describes === 1 || `${fake.describes}: ${fake.requests.join(", ")}`);
  await t.check("the fields stay as they were", (await form.locator(".field-row").count()) === 4);
  // Rename a field and hide a column.
  const rowOf = (column) => form.locator(".field-row").filter({ has: t.page.locator(`input[value="${column}"]`) }).first();
  await rowOf("city").getByRole("textbox", { name: "Field name" }).fill("Town");
  await t.check("a column's field is hidden, not removed", (await rowOf("active").getByRole("button", { name: "Hide column" }).count()) === 1);
  await rowOf("active").getByRole("button", { name: "Hide column" }).click();
  await t.until("a hidden column's field goes and the Hidden columns list appears", async () => (await form.locator(".field-row").count()) === 3 && (await form.innerText()).includes("Hidden columns"));
  await t.audit("remote collection editor, a column hidden");
  await t.page.getByRole("button", { name: "Save changes" }).click();
  await t.until("saved: back on its items", async () => !(await onEditor(t)) && (await paneText(t)).includes("Customer 1"));
  const c = await storedBy(t, "Customers");
  await t.check("stored: Town is the city column's field, active is hidden", c?.fields.some((f) => f.name === "Town" && f.column === "city") && !c.fields.some((f) => f.column === "active") && JSON.stringify(c.source.hiddenColumns) === JSON.stringify(["active"]), JSON.stringify([c?.fields.map((f) => f.name), c?.source.hiddenColumns]));
  const head = await pane(t).locator(".block thead").first().innerText();
  await t.check("the table has the renamed column and no hidden one", head.includes("Town") && !head.includes("active"), head);
  const last = fake.queries[fake.queries.length - 1];
  await t.check("only the shown columns are asked for", JSON.stringify(last.columns.slice().sort()) === JSON.stringify(["city", "id", "name"]), JSON.stringify(last.columns));
  // The hidden column is named in the editor again after a reload.
  await t.open(`/remotes/${id}/edit`);
  await t.until("the editor is back", async () => (await form.locator(".field-row").count()) === 3);
  await form.locator(".cds--multi-select__wrapper input").first().click();
  await t.settle(100);
  const hidden = t.page.getByRole("option", { name: "active", exact: true }).filter({ visible: true }).first();
  await t.check("Hidden columns offers active, ticked", (await hidden.count()) === 1 && (await hidden.getAttribute("aria-selected")) === "true", (await menuOptions(t)).join("|"));
  await t.escapeCloses("Escape closes the hidden columns menu");
  // Cancel keeps what was stored.
  await form.locator(".field-row").first().getByRole("textbox", { name: "Field name" }).fill("Changed");
  await t.page.getByRole("button", { name: "Cancel" }).click();
  await t.until("Cancel leaves the editor", async () => !(await onEditor(t)));
  await t.check("nothing was stored by Cancel", !(await storedBy(t, "Customers")).fields.some((f) => f.name === "Changed"));
}, { viewport: "desktop" });

test("remotes: row actions — duplicate, delete asks first and leaves the source alone", async (t) => {
  await t.boot();
  const fake = await fakeRemotes(t);
  await connectTo(t);
  const id = await makeRemote(t);
  await t.open("/remotes");
  const original = await storedBy(t, "Customers");
  await pane(t).locator("tbody tr").filter({ hasText: "Customers" }).getByRole("button", { name: "Duplicate Customers collection" }).click();
  await t.until("Duplicate adds a numbered copy under Remotes", async () => (await pane(t).locator("tbody tr").count()) === 2 && (await paneText(t)).includes("Customers 2"));
  const copy = await storedBy(t, "Customers 2");
  const had = new Set(original.fields.map((f) => f.id));
  await t.check("the copy reads the same source, key and columns", copy?.source?.name === "CRM" && copy.source.key === "id" && copy.fields.map((f) => f.column).join() === original.fields.map((f) => f.column).join(), JSON.stringify(copy?.source));
  await t.check("the copy has fields of its own", copy.fields.length === 4 && copy.fields.every((f) => !had.has(f.id)));
  await t.check("the copy is named Customer 2", copy.name === "Customer 2", copy.name);
  await t.audit("Remotes page, two collections");
  // Delete asks first; Cancel keeps it.
  const before = fake.queries.length;
  const rowOf = (name) => (name === "Customers 2" ? pane(t).locator("tbody tr").filter({ hasText: "Customers 2" }) : pane(t).locator("tbody tr").filter({ hasNotText: "Customers 2" }));
  await rowOf("Customers 2").getByRole("button", { name: "Delete Customers 2 collection" }).click();
  await t.until("Delete asks first", async () => (await modal(t).innerText().catch(() => "")).includes("Delete “Customers 2”?"));
  await t.check("it says the source is not affected", (await modal(t).innerText()).includes("CRM is not affected"));
  await t.audit("delete remote collection dialog");
  await modal(t).getByRole("button", { name: "Cancel" }).click();
  await t.until("Cancel closes the dialog", async () => (await modal(t).count()) === 0);
  await t.check("Cancel kept it", !!(await storedBy(t, "Customers 2")));
  await rowOf("Customers 2").getByRole("button", { name: "Delete Customers 2 collection" }).click();
  await t.until("asked again", async () => (await modal(t).count()) === 1);
  await modal(t).getByRole("button", { name: "Delete" }).click();
  await t.until("Delete removes the collection", async () => (await pane(t).locator("tbody tr").count()) === 1 && !(await storedBy(t, "Customers 2")));
  await t.check("the first one stays and nothing was asked of the source", !!(await storedBy(t, "Customers")) && fake.queries.length === before);
  // Edit opens the remote editor.
  await rowOf("Customers").getByRole("button", { name: "Edit Customers collection" }).click();
  await t.until("Edit opens the editor under Remotes", async () => (await onEditor(t)) && (await breadcrumbs(t)).includes("Remotes"));
  void id;
}, { viewport: "desktop" });

// A remote block reads a page at a time, from the source: Show more, the progress of loading every row and its Cancel.
test("remote block: pages, Show more, errors", async (t) => {
  await t.boot();
  const fake = await fakeRemotes(t);
  await connectTo(t);
  const id = await makeRemote(t);
  let release;
  fake.hold = new Promise((resolve) => (release = resolve));
  fake.holdFrom = 0;
  await t.open(t.listPath(id), { settle: false });
  await t.until("while the first page is on its way, a bar says rows are loading", async () => (await pane(t).locator(".block-more .cds--progress-bar").count()) === 1 && fake.queries.length === 1);
  await t.check("the bar has no Cancel for a block with a Limit", (await pane(t).locator(".block-more").getByRole("button", { name: "Cancel" }).count()) === 0);
  release();
  await t.until("the first hundred rows are in", async () => (await tableRows(t).count()) === 100);
  await t.until("the bar is gone", async () => (await pane(t).locator(".block-more .cds--progress-bar").count()) === 0);
  await t.check("the block says 100 of 250", (await pane(t).locator(".block-more").innerText()).replace(/\s+/g, " ").includes("100 of 250"));
  await t.audit("remote block, first page");
  fake.hold = null;
  await pane(t).getByRole("button", { name: "Show more" }).click();
  await t.until("Show more adds the next hundred", async () => (await tableRows(t).count()) === 200);
  await t.check("it asked from offset 100, without counting again", fake.queries[1]?.offset === 100 && fake.queries[1]?.counts === false, JSON.stringify(fake.queries[1]));
  await pane(t).getByRole("button", { name: "Show more" }).click();
  await t.until("the last page makes 250 and the button goes", async () => (await tableRows(t).count()) === 250 && (await pane(t).getByRole("button", { name: "Show more" }).count()) === 0);
  await t.check("the offsets were 0, 100, 200", JSON.stringify(fake.queries.map((q) => q.offset)) === JSON.stringify([0, 100, 200]), JSON.stringify(fake.queries.map((q) => q.offset)));
  await toTop(t);
  await t.audit("remote block, all pages");
  // A source that fails: the block says so, and reading again after it recovers shows the rows.
  fake.fail = "The source is down";
  await t.open(t.listPath(id));
  await t.until("a failing source is named in the block", async () => (await paneText(t)).includes("The source is down"));
  await t.check("no rows are shown", (await tableRows(t).count()) === 0);
  await t.audit("remote block, source failed");
  fake.fail = null;
  await t.open(t.listPath(id));
  await t.until("rows are back once the source answers", async () => (await tableRows(t).count()) === 100);
}, { viewport: "desktop" });

test("remote block: loading every row shows its progress, can be cancelled and goes on", async (t) => {
  await t.boot();
  const fake = await fakeRemotes(t);
  fake.total = 120;
  fake.pageCap = 40;
  await connectTo(t);
  // A table without a Limit loads every row, a page after the other.
  const id = await makeRemote(t, { block: { limit: 0 } });
  let release;
  fake.hold = new Promise((resolve) => (release = resolve));
  fake.holdFrom = 40; // the first page comes at once, the next is held
  await t.open(t.listPath(id), { settle: false });
  const bar = pane(t).locator(".block-more");
  await t.until("the bar counts the rows in, of the total", async () => (await bar.innerText().catch(() => "")).includes("Loading rows") && (await bar.locator("[aria-valuenow]").first().getAttribute("aria-valuenow").catch(() => null)) === "40", await bar.innerText().catch(() => ""));
  await t.check("the bar's label is Loading rows: 40 of 120", (await bar.innerText()).replace(/\s+/g, " ").includes("Loading rows: 40 of 120"), await bar.innerText());
  await t.check("it can be cancelled", (await bar.getByRole("button", { name: "Cancel" }).count()) === 1);
  await t.audit("loading every row, progress");
  await bar.getByRole("button", { name: "Cancel" }).click();
  release();
  await t.until("after Cancel the rows in stay and Load all rows is offered", async () => (await pane(t).getByRole("button", { name: "Load all rows" }).count()) === 1);
  await t.settle(400);
  const asked = fake.queries.length;
  await t.check("no more pages were asked for after the held one", asked <= 2, String(asked));
  const shown = await tableRows(t).count();
  await t.check("rows loaded so far stay (fewer than all)", shown >= 40 && shown < 120, String(shown));
  await t.check("the block says how many of how many", (await pane(t).locator(".block-more").innerText()).replace(/\s+/g, " ").includes(`${shown} of 120`), await pane(t).locator(".block-more").innerText());
  await toTop(t);
  await t.audit("loading cancelled, Load all rows");
  fake.hold = null;
  await pane(t).getByRole("button", { name: "Load all rows" }).click();
  await t.until("Load all rows goes on to the end", async () => (await tableRows(t).count()) === 120 && (await pane(t).getByRole("button", { name: "Load all rows" }).count()) === 0);
  await t.check("the progress bar is gone", (await pane(t).locator(".block-more .cds--progress-bar").count()) === 0);
  await t.check("pages were read in order without repeats", JSON.stringify(fake.queries.map((q) => q.offset)) === JSON.stringify([0, 40, 80]) || JSON.stringify(fake.queries.map((q) => q.offset).filter((o, i, a) => a.indexOf(o) === i)) === JSON.stringify([0, 40, 80]), JSON.stringify(fake.queries.map((q) => q.offset)));
}, { viewport: "desktop" });

// A remote block grouped by a date part other than the day (year, month, week, hour): the source groups
// by the value (a day), so the app loads every row and groups them itself.
const groupTitles = (t) => pane(t).locator(".block .table-group__title").allInnerTexts().then((l) => l.map((s) => s.trim()));
const groupSizes = (t) => pane(t).locator(".block .cds--accordion__item").evaluateAll((els) => els.map((e) => e.querySelectorAll("tbody tr").length));
const panelOf = (t) => t.page.locator(".toolbar-popover__panel:visible").last();

test("remote block: grouped by a month loads every row, groups them in the app, partial when stopped, resumed", async (t) => {
  await t.boot();
  const fake = await fakeRemotes(t);
  fake.columns = DATED_COLUMNS;
  fake.total = 120;
  fake.pageCap = 40;
  await connectTo(t);
  const id = await makeRemote(t, { columns: DATED_COLUMNS });
  await t.open(t.listPath(id));
  await t.until("the first page is in", async () => (await tableRows(t).count()) === 40);
  await t.openPanel(pane(t).locator(".block .section-header").first(), "Sort and group");
  const groupBy = panelOf(t).getByLabel("Group by", { exact: true });
  const by = panelOf(t).getByLabel("Group dates by", { exact: true });
  await t.check("a remote collection's date column can be grouped", (await groupBy.locator("option").allInnerTexts()).includes("joined"));
  await t.check("no Group dates by before a date is grouped", (await by.count()) === 0);
  await groupBy.selectOption({ label: "joined" });
  const parts = await by.locator("option").allInnerTexts();
  await t.check("Group dates by offers year, month, week and day (an hour is of a date & time)", JSON.stringify(parts) === JSON.stringify(["Year", "Month", "Week", "Day"]), JSON.stringify(parts));
  await t.until("by day the source groups, page by page", async () => fake.queries.at(-1)?.groupBy === "joined" && (await pane(t).locator(".block-more").innerText().catch(() => "")).includes("of 120"));
  const before = fake.queries.length;

  // By month: the source does not group; every row comes, the next page held back to look at the partial grouping.
  let release;
  fake.hold = new Promise((resolve) => (release = resolve));
  fake.holdFrom = 40;
  await by.selectOption({ label: "Month" });
  const bar = pane(t).locator(".block-more");
  await t.until("the bar counts the rows in so far", async () => (await bar.innerText().catch(() => "")).replace(/\s+/g, " ").includes("Loading rows: 40 of 120"), await bar.innerText().catch(() => ""));
  await t.check("the groups show what is in so far", JSON.stringify(await groupTitles(t)) === JSON.stringify(["January 2026"]) && JSON.stringify(await groupSizes(t)) === "[40]", JSON.stringify(await groupTitles(t)));
  await t.check("the source was asked for the rows without grouping, in big pages", fake.queries.slice(before).every((q) => q.groupBy === null && q.limit === 10000), JSON.stringify(fake.queries.slice(before)));
  await t.check("it can be stopped", (await bar.getByRole("button", { name: "Cancel" }).count()) === 1);
  await t.audit("grouped by month, loading");
  await bar.getByRole("button", { name: "Cancel" }).click();
  release();
  await t.until("stopped: the groups are marked as of the rows loaded so far, with Load all rows", async () => (await pane(t).getByRole("button", { name: "Load all rows" }).count()) === 1 && (await groupTitles(t)).length === 2);
  await t.settle(300);
  const note = (await pane(t).locator(".block-more").innerText()).replace(/\s+/g, " ");
  await t.check("the block says the groups are of the rows loaded so far: 80 of 120", note.includes("Groups of the rows loaded so far: 80 of 120"), note);
  await t.check("January 60 rows, February 20 so far", JSON.stringify(await groupTitles(t)) === JSON.stringify(["January 2026", "February 2026"]) && JSON.stringify(await groupSizes(t)) === "[60,20]", JSON.stringify(await groupSizes(t)));
  await t.check("no further page was asked", fake.queries.slice(before).filter((q) => q.groupBy === null).length === 2, JSON.stringify(fake.queries.map((q) => [q.offset, q.groupBy])));
  await t.audit("grouped by month, stopped (partial)");

  // Resumed: the rest comes, the note goes.
  fake.hold = null;
  await pane(t).getByRole("button", { name: "Load all rows" }).click();
  await t.until("all rows are in: January 60, February 40, March 20", async () => JSON.stringify(await groupSizes(t)) === "[60,40,20]", JSON.stringify(await groupSizes(t)));
  await t.until("the note and the bar are gone", async () => (await pane(t).locator(".block-more").count()) === 0);
  await t.check("the groups are labelled and in time order", JSON.stringify(await groupTitles(t)) === JSON.stringify(["January 2026", "February 2026", "March 2026"]), JSON.stringify(await groupTitles(t)));
  const asked = fake.queries.length;

  // The order and the part of the groups are the app's: no new request.
  await t.openPanel(pane(t).locator(".block .section-header").first(), "Sort and group");
  await panelOf(t).getByLabel("Group order", { exact: true }).selectOption({ label: "Descending" });
  await t.until("descending: March first", async () => JSON.stringify(await groupTitles(t)) === JSON.stringify(["March 2026", "February 2026", "January 2026"]), JSON.stringify(await groupTitles(t)));
  await t.check("the rows were not loaded again", fake.queries.length === asked, `${fake.queries.length} vs ${asked}`);
  await panelOf(t).getByLabel("Group dates by", { exact: true }).selectOption({ label: "Year" });
  await t.until("by year: one group of all 120", async () => JSON.stringify(await groupTitles(t)) === JSON.stringify(["2026"]) && JSON.stringify(await groupSizes(t)) === "[120]", JSON.stringify(await groupTitles(t)));
  await t.check("a year is grouped from the rows already in", fake.queries.length === asked, `${fake.queries.length} vs ${asked}`);
  await panelOf(t).getByLabel("Group dates by", { exact: true }).selectOption({ label: "Week" });
  await t.until("by week: ISO weeks, the latest first (Week 13 to Week 1)", async () => { const l = await groupTitles(t); return (l[0] === "Week 13, 2026" && l.at(-1) === "Week 1, 2026") || JSON.stringify(l); });
  await panelOf(t).getByLabel("Group dates by", { exact: true }).selectOption({ label: "Month" });
  await panelOf(t).getByLabel("Group order", { exact: true }).selectOption({ label: "Ascending" });
  await t.closeAll();

  // Stored with the view; after a reload the rows come again and are grouped.
  await t.page.locator(".views-bar").getByRole("button", { name: "Save changes to view" }).click();
  await t.settle(200);
  const stored = await t.page.evaluate(async (cid) => (await window.kubus.repo.listViews(cid, "default"))[0].blocks[0], id);
  await t.check("the view stores the date part", stored.groupDate === "month" && !!stored.groupBy, JSON.stringify(stored));
  await t.open(t.listPath(id));
  await t.until("reloaded: grouped by month again", async () => JSON.stringify(await groupSizes(t)) === "[60,40,20]", JSON.stringify(await groupSizes(t)));
  await toTop(t);
  await t.audit("grouped by month, all rows");
}, { viewport: "desktop" });

test("remote block: a chart by month of a remote collection loads every row", async (t) => {
  await t.boot();
  const fake = await fakeRemotes(t);
  fake.columns = DATED_COLUMNS;
  fake.total = 120;
  fake.pageCap = 40;
  await connectTo(t);
  const count = { id: "a", value: "count", field: null, label: "", style: null, axis: "left", transform: "none", window: 3 };
  const id = await makeRemote(t, { columns: DATED_COLUMNS, block: { kind: "chart", options: { chart: "bar", x: { by: "field", field: "@joined", dateStep: "month" }, series: [count] } } });
  await t.open(t.listPath(id));
  const bars = () => pane(t).locator(".chart-block path.bar").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
  await t.until("a bar per month, as high as its rows (60, 40, 20)", async () => {
    const h = await bars();
    return (h.length === 3 && Math.abs(h[0] / h[2] - 3) < 0.2 && Math.abs(h[1] / h[2] - 2) < 0.2) || JSON.stringify(h);
  }, { timeout: 15000 });
  await t.check("the pages were read in order, without the source grouping", JSON.stringify([...new Set(fake.queries.map((q) => q.offset))]) === "[0,40,80]" && fake.queries.every((q) => q.groupBy === null), JSON.stringify(fake.queries.map((q) => [q.offset, q.groupBy])));
  await t.audit("remote chart by month");
}, { viewport: "desktop" });

// ---------------------------------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------------------------------

/** Books (all spaces, with a self reference and an item view), People, and Films (only in the Work space). */
function collectionsSpec() {
  return {
    spaces: [{ key: "work", name: "Work" }],
    collections: [
      {
        key: "people", name: "Person", plural: "People", icon: "User", description: "Folks I know.",
        fields: [{ key: "name", name: "Name", kind: "string" }],
        items: [{ values: { name: "Ursula" } }, { values: { name: "Octavia" } }],
      },
      {
        key: "books", name: "Book", plural: "Books", icon: "Book", description: "Things I read.",
        fields: [
          { key: "title", name: "Title", kind: "string" },
          { key: "pages", name: "Pages", kind: "number" },
          { key: "author", name: "Author", kind: "item", target: "people" },
          { key: "related", name: "Related", kind: "item_list", target: "books" },
        ],
        items: [
          { key: "dune", values: { title: "Dune", pages: 412 } },
          { values: { title: "Kindred", pages: 264, author: { ref: "people/i1" } } },
          { values: { title: "Solaris", pages: 204 } },
        ],
        itemViews: [{ name: "Compact", layout: { fields: null } }],
      },
      {
        key: "films", name: "Film", plural: "Films", icon: "Movie", description: "Seen at the cinema.", spaces: ["work"], space: "work",
        fields: [{ key: "title", name: "Title", kind: "string" }],
        items: [{ space: "work", values: { title: "Arrival" } }],
      },
    ],
  };
}

const collectionRow = (t, plural) => pane(t).locator("tbody tr").filter({ has: t.page.locator(".icon-label__text", { hasText: new RegExp(`^${plural}$`) }) });
const rowNames = async (t) => (await pane(t).locator("tbody tr .icon-label__text").allInnerTexts()).map((s) => s.trim());
/** Items stored in a collection (every space). */
const itemCountOf = (t, id) => t.page.evaluate(async (id) => (await window.kubus.repo.countItemsByCollection(null))[id] ?? 0, id);

for (const vp of ["desktop", "phone"]) {
  test(`collections: the list — groups by space, links, sort, description edited in place @ ${vp}`, async (t) => {
    await t.boot();
    const ids = await t.seed(collectionsSpec());
    await t.open("/collections");
    const heads = await pane(t).locator(".table-group__title").allInnerTexts();
    await t.check("two groups: In this space and Not in this space", JSON.stringify(heads.map((s) => s.replace(/\s+/g, " ").trim())) === JSON.stringify(["In this space 2", "Not in this space 1"]), heads.join("|"));
    const names = await rowNames(t);
    await t.check("Books and People are in this space, Films is not", names.join() === "Books,People,Films", names.join());
    await t.check("a collection of this space links to its items", (await collectionRow(t, "Books").locator("a").first().getAttribute("href")) === `#/collections/${ids.collections.books}/items`);
    await t.check("one kept out of this space has no link (its items can't be shown here)", (await collectionRow(t, "Films").locator("a").count()) === 0 || (await collectionRow(t, "Films").locator("td").first().locator("a").count()) === 0);
    if (!t.phone) {
      const spaces = await pane(t).locator("tbody tr").evaluateAll((rows) => rows.map((r) => r.innerText.replace(/\s+/g, " ")));
      await t.check("the Spaces column says All, or the spaces it is kept in", spaces[0].includes("All") && spaces[2].includes("Work"), spaces.join(" | "));
      await t.check("the description is shown", spaces[0].includes("Things I read."));
    }
    await t.audit("collections list");
    // Sort by Name: ascending within each group, then descending.
    const nameHead = pane(t).locator("thead").first().getByRole("button", { name: /^Name/ });
    await nameHead.click();
    await t.settle(100);
    let sorted = await rowNames(t);
    await t.check("sorted by name: Books, People", sorted.slice(0, 2).join() === "Books,People", sorted.join());
    await nameHead.click();
    await t.settle(100);
    sorted = await rowNames(t);
    await t.check("sorted again: People, Books", sorted.slice(0, 2).join() === "People,Books", sorted.join());
    // A phone's list has no description column.
    if (t.phone) return;
    // The description: Enter saves, Escape leaves it, clicking away saves; a collection of another space is editable too.
    const edit = (plural) => pane(t).getByRole("button", { name: `Edit description of ${plural}` });
    await edit("Books").click();
    await t.editorReady();
    await t.page.keyboard.press("Control+A");
    await t.page.keyboard.type("Everything I have read");
    await t.audit("description being edited in place");
    await t.page.keyboard.press("Enter");
    await t.until("Enter stores the description", async () => (await storedBy(t, "Books"))?.description === "Everything I have read");
    await t.until("the new description is shown", async () => (await paneText(t)).includes("Everything I have read"));
    await edit("People").click();
    await t.editorReady();
    await t.page.keyboard.type(" and more");
    await t.page.keyboard.press("Escape");
    await t.settle(200);
    await t.check("Escape keeps the old description", (await storedBy(t, "People")).description === "Folks I know." && (await paneText(t)).includes("Folks I know."));
    await edit("Films").click();
    await t.editorReady();
    await t.page.keyboard.press("Control+A");
    await t.page.keyboard.type("Seen at home");
    await pane(t).locator(".page-header, h1, .cds--breadcrumb").first().click();
    await t.until("clicking away stores it, for a collection of another space too", async () => (await storedBy(t, "Films"))?.description === "Seen at home");
    await edit("Books").click();
    await t.editorReady();
    await t.page.keyboard.press("Control+A");
    await t.page.keyboard.press("Backspace");
    await t.page.keyboard.press("Enter");
    await t.until("an emptied description is stored empty", async () => (await storedBy(t, "Books"))?.description === "");
    await t.open("/collections");
    await t.check("it all survives a reload", (await storedBy(t, "Films")).description === "Seen at home" && (await paneText(t)).includes("Seen at home"));
  }, { viewport: vp, smoke: vp === "desktop" });
}

test("collections: switching space moves collections between the groups", async (t) => {
  await t.boot();
  const ids = await t.seed(collectionsSpec());
  await t.open("/collections");
  await t.page.locator(".side-nav-search .cds--dropdown button").first().click();
  await t.page.getByRole("option", { name: /Work/ }).click();
  await t.until("in the Work space Films is in this space and People too", async () => (await pane(t).locator(".table-group__title").count()) === 0 && (await rowNames(t)).join() === "Books,Films,People");
  await t.check("with nothing kept out there is one table, no groups", (await pane(t).locator(".table-group__title").count()) === 0);
  await t.check("Films is a link there", (await collectionRow(t, "Films").locator("a").getAttribute("href")) === `#/collections/${ids.collections.films}/items`);
  await t.audit("collections list in the Work space");
  await t.check("the nav lists Films in the Work space", (await navNode(t, "collections").innerText()).includes("Films"));
}, { viewport: "desktop" });

test("collections: duplicate copies fields, icon, description and item views, not the items", async (t) => {
  await t.boot();
  await t.seed(collectionsSpec());
  await t.open("/collections");
  const original = await storedBy(t, "Books");
  await collectionRow(t, "Books").getByRole("button", { name: "Duplicate Books collection" }).click();
  await t.until("a copy named Books 2 is listed", async () => (await rowNames(t)).includes("Books 2"));
  const copy = await storedBy(t, "Books 2");
  await t.check("the singular name is numbered too", copy?.name === "Book 2", copy?.name);
  await t.check("icon and description are copied", copy.icon === original.icon && copy.description === original.description);
  await t.check("the fields are copied with new ids", copy.fields.map((f) => f.name).join() === original.fields.map((f) => f.name).join() && copy.fields.every((f) => !original.fields.some((o) => o.id === f.id)));
  await t.check("a reference to the collection itself refers to the copy", copy.fields.find((f) => f.name === "Related").targetCollectionId === copy.id, JSON.stringify(copy.fields.find((f) => f.name === "Related")));
  await t.check("a reference to another collection stays", copy.fields.find((f) => f.name === "Author").targetCollectionId === original.fields.find((f) => f.name === "Author").targetCollectionId);
  await t.check("the item view is copied", copy.itemViews.some((v) => v.name === "Compact") && copy.itemViews.length === original.itemViews.length, JSON.stringify(copy.itemViews.map((v) => v.name)));
  await t.check("the items are not copied", (await itemCountOf(t, copy.id)) === 0 && (await itemCountOf(t, original.id)) === 3);
  await t.check("the original is unchanged", (await storedBy(t, "Books")).fields.length === original.fields.length);
  await t.check("the nav lists the copy", (await navNode(t, "collections").innerText()).includes("Books 2"));
  await collectionRow(t, "Books 2").getByRole("button", { name: "Duplicate Books 2 collection" }).click();
  await t.until("copying a copy goes on numbering: Books 3", async () => (await rowNames(t)).includes("Books 3"));
  await t.audit("collections list with copies");
  await t.open(`/collections/${copy.id}/items`);
  await t.until("the copy opens, empty", async () => (await paneText(t)).includes("Books 2"));
}, { viewport: "desktop" });

test("collections: delete asks first, says what goes, and removes the collection with its items", async (t) => {
  await t.boot();
  const ids = await t.seed(collectionsSpec());
  await t.open("/collections");
  await collectionRow(t, "Books").getByRole("button", { name: "Delete Books collection" }).click();
  await t.until("Delete asks first", async () => (await modal(t).innerText().catch(() => "")).includes("Delete “Books”?"));
  await t.check("it says how many items go", (await modal(t).innerText()).includes("its 3 Books"), await modal(t).innerText());
  await t.audit("delete collection dialog");
  await t.escapeCloses("Escape closes the delete dialog");
  await t.check("Escape kept the collection", !!(await storedBy(t, "Books")));
  await collectionRow(t, "Books").getByRole("button", { name: "Delete Books collection" }).click();
  await modal(t).getByRole("button", { name: "Cancel" }).click();
  await t.until("Cancel closes the dialog", async () => (await modal(t).count()) === 0);
  await t.check("Cancel kept the collection and its items", !!(await storedBy(t, "Books")) && (await itemCountOf(t, ids.collections.books)) === 3);
  // A collection with one item says "1 Person"... and Delete removes it.
  await collectionRow(t, "Films").getByRole("button", { name: "Delete Films collection" }).click();
  await t.until("asked for Films", async () => (await modal(t).innerText().catch(() => "")).includes("Delete “Films”?"));
  await t.check("one item is counted in the singular, items of other spaces too", (await modal(t).innerText()).includes("its 1 Film"), await modal(t).innerText());
  await modal(t).getByRole("button", { name: "Delete" }).click();
  await t.until("Delete removes it from the list", async () => !(await rowNames(t)).includes("Films"));
  await t.check("it is gone from the store, its items too", !(await storedBy(t, "Films")) && (await itemCountOf(t, ids.collections.films)) === 0);
  await collectionRow(t, "Books").getByRole("button", { name: "Delete Books collection" }).click();
  await modal(t).getByRole("button", { name: "Delete" }).click();
  await t.until("Books is gone", async () => !(await rowNames(t)).includes("Books"));
  await t.until("and from the side nav", async () => !(await navNode(t, "collections").innerText()).includes("Books"));
  await collectionRow(t, "People").getByRole("button", { name: "Delete People collection" }).click();
  await modal(t).getByRole("button", { name: "Delete" }).click();
  await t.until("deleting the last one leaves the empty state", async () => (await paneText(t)).includes("No collections yet"));
  await t.audit("collections, none left");
  await t.open("/collections");
  await t.check("it stays empty after a reload", (await paneText(t)).includes("No collections yet") && (await storedCollections(t)).length === 0);
}, { viewport: "desktop" });

// ---------------------------------------------------------------------------------------------
// Collection editor
// ---------------------------------------------------------------------------------------------

const rows = (t) => pane(t).locator(".field-row[data-field-id]");
const rowNamed = (t, name) => rows(t).filter({ has: t.page.locator(`input[value="${name}"]`) }).first();
const fieldNames = async (t) => rows(t).getByRole("textbox", { name: "Field name" }).evaluateAll((els) => els.map((e) => e.value));
const save = async (t, label = "Save changes") => t.page.getByRole("button", { name: label }).click();

for (const vp of ["desktop", "phone"]) {
  test(`editor: a new collection — names, fields, validation, title, created and shown @ ${vp}`, async (t) => {
    await t.boot();
    await t.seed({ spaces: [{ key: "work", name: "Work" }], collections: [{ key: "people", name: "Person", plural: "People", fields: [{ key: "name", name: "Name", kind: "string" }] }] });
    await t.open("/collections");
    await t.page.getByRole("button", { name: "New collection" }).filter({ visible: true }).first().click();
    await t.until("New collection opens the editor", () => onEditor(t));
    await t.check("its breadcrumb leads back to Collections", (await breadcrumbs(t)).includes("Collections"));
    await t.check("the name box has focus", await t.page.evaluate(() => document.activeElement?.id?.endsWith("collection-plural-name") === true));
    await t.check("it starts with one String field called Name", JSON.stringify(await fieldNames(t)) === JSON.stringify(["Name"]));
    await t.check("the one field cannot be removed", (await rows(t).first().getByRole("button", { name: "A collection needs at least one field" }).isDisabled()));
    await t.check("a collection has no Source", (await pane(t).locator("form").innerText()).indexOf("The databases the Kubus server reads") === -1);
    await t.check("a new field's type is free to choose", !(await rows(t).first().locator("button.cds--list-box__field").first().isDisabled()));
    await t.audit("new collection");
    // Validation: nothing typed.
    await save(t, "Create collection");
    await t.settle();
    const text = await paneText(t);
    await t.check("saving without names says what is missing", text.includes("Name is required") && text.includes("Singular name is required"), text.slice(0, 300));
    await t.check("nothing was stored", (await storedCollections(t)).length === 1);
    // The singular follows the plural until it is typed.
    const plural = pane(t).getByRole("textbox", { name: "Name", exact: true }).first();
    await plural.fill("Gadgets");
    const singular = pane(t).getByRole("textbox", { name: "Singular name" });
    await t.check("the singular follows the plural", (await singular.inputValue()) === "Gadget", await singular.inputValue());
    await plural.fill("Hobbies");
    await t.check("…through a y → ies plural", (await singular.inputValue()) === "Hobby", await singular.inputValue());
    await singular.fill("Pastime");
    await plural.fill("Pastimes");
    await t.check("a typed singular stays", (await singular.inputValue()) === "Pastime");
    await pane(t).getByRole("textbox", { name: "Description (optional)" }).fill("Ways to spend time.");
    // Fields: a duplicate name and an empty one are refused.
    await t.page.getByRole("button", { name: "Add field" }).click();
    await t.page.getByRole("button", { name: "Add field" }).click();
    await t.settle(100);
    await rows(t).nth(1).getByRole("textbox", { name: "Field name" }).fill("name");
    await save(t, "Create collection");
    await t.settle();
    const bad = await pane(t).locator("form").innerText();
    await t.check("a duplicate and an empty field name are refused", bad.includes("Duplicate field name") && bad.includes("Name is required"), bad);
    await t.check("still on the form, nothing stored", (await onEditor(t)) && (await storedCollections(t)).length === 1);
    await t.audit("new collection, field names refused");
    // Fix them: a Number field and a Date, then the title is chosen.
    await rows(t).nth(1).getByRole("textbox", { name: "Field name" }).fill("Hours");
    await choose(t, rows(t).nth(1), "Field type", "Number");
    await rows(t).nth(2).getByRole("textbox", { name: "Field name" }).fill("Since");
    await choose(t, rows(t).nth(2), "Field type", "Date");
    await dropdown(t, pane(t).locator("form"), "Title").locator(".cds--list-box__field").first().click();
    await t.settle(100);
    const titles = await menuOptions(t);
    await t.check("the Title menu offers the first text field, text / number / date fields, and no title", JSON.stringify(titles) === JSON.stringify(["The first text field with a value", "Name", "Hours", "Since", "No title"]), titles.join(" | "));
    await t.audit("title menu open");
    await t.page.getByRole("option", { name: "Since", exact: true }).click();
    await t.until("Since is the title", async () => (await dropdown(t, pane(t).locator("form"), "Title").innerText()).includes("Since"));
    // Remove the third row and add it again to check Remove works before saving, without a dialog.
    await rows(t).nth(2).getByRole("button", { name: "Remove field" }).click();
    await t.until("a field not yet saved is removed at once", async () => (await rows(t).count()) === 2);
    await t.until("the title falls back to the first text field", async () => (await dropdown(t, pane(t).locator("form"), "Title").innerText()).includes("The first text field with a value"));
    await t.page.getByRole("button", { name: "Add field" }).click();
    await rows(t).nth(2).getByRole("textbox", { name: "Field name" }).fill("Since");
    await choose(t, rows(t).nth(2), "Field type", "Date");
    // Spaces: chosen on a device with several.
    const spaces = pane(t).locator("form .cds--multi-select__wrapper");
    await t.check("Spaces starts as All spaces", (await spaces.innerText()).includes("All spaces"));
    await spaces.locator("button").first().click();
    await t.settle(100);
    await t.page.getByRole("option", { name: /Work/ }).click();
    await t.page.keyboard.press("Escape");
    await t.settle(100);
    await t.check("choosing Work shows it in the field", (await spaces.innerText()).includes("Work") && !(await spaces.innerText()).includes("All spaces"), await spaces.innerText());
    await t.audit("new collection, filled in");
    await save(t, "Create collection");
    await t.until("created: its (empty) items page is shown", async () => !(await onEditor(t)) && (await paneText(t)).includes("Pastimes"));
    const c = await storedBy(t, "Pastimes");
    await t.check("stored with names, description, icon and fields in order", c?.name === "Pastime" && c.description === "Ways to spend time." && c.icon === "Cube" && JSON.stringify(c.fields.map((f) => [f.name, f.kind])) === JSON.stringify([["Name", "string"], ["Hours", "number"], ["Since", "date"]]), JSON.stringify(c));
    await t.check("stored with the title field and its space", c.titleField === null || typeof c.titleField === "string");
    await t.check("shown only in the chosen space", c.spaceIds?.length === 1);
    await t.audit("the new collection's page");
    // It is in the Collections list (this space doesn't hold it: Work only) and again after a reload.
    await t.open("/collections");
    await t.check("it is listed under Not in this space", (await pane(t).locator(".table-group__title").allInnerTexts()).some((s) => s.includes("Not in this space")) && (await rowNames(t)).includes("Pastimes"));
  }, { viewport: vp, smoke: vp === "desktop" });
}

test("editor: an existing collection — rename, add, remove (asks first), title, spaces, cancel", async (t) => {
  await t.boot();
  const ids = await t.seed(collectionsSpec());
  const books = ids.collections.books;
  await t.go(`/collections/${books}/edit`);
  await t.until("the editor shows Books with its four fields", async () => (await rows(t).count()) === 4);
  await t.check("the header holds the plural name and the page says Edit Books", (await pane(t).getByRole("textbox", { name: "Name", exact: true }).first().inputValue()) === "Books" && (await paneText(t)).includes("Edit Books"));
  await t.check("saved fields' types are fixed", (await rows(t).evaluateAll((els) => els.every((e) => e.querySelector("button.cds--list-box__field")?.disabled))) === true);
  await t.check("the helper says so", (await paneText(t)).includes("A field's type cannot change once saved."));
  await t.check("the Spaces menu shows All spaces", (await pane(t).locator("form .cds--multi-select__wrapper").innerText()).includes("All spaces"));
  const before = await storedBy(t, "Books");
  const titleId = before.fields.find((f) => f.name === "Title").id;
  // Rename keeps the field (and so the items' values).
  await rowNamed(t, "Title").getByRole("textbox", { name: "Field name" }).fill("Name of the book");
  await save(t, "Save changes");
  await t.until("saved: the items page is shown", async () => !(await onEditor(t)) && (await paneText(t)).includes("Dune"));
  let c = await storedBy(t, "Books");
  await t.check("the field is renamed, same id", c.fields.find((f) => f.id === titleId)?.name === "Name of the book");
  await t.check("the items still have their titles", (await paneText(t)).includes("Dune") && (await paneText(t)).includes("Kindred") && (await paneText(t)).includes("Name of the book"));
  await t.audit("Books after renaming a field");
  // Add a field, and refuse a duplicate.
  await t.go(`/collections/${books}/edit`);
  await t.page.getByRole("button", { name: "Add field" }).click();
  const added = rows(t).last();
  await added.getByRole("textbox", { name: "Field name" }).fill("pages");
  await save(t, "Save changes");
  await t.settle();
  await t.check("a field named like another (any case) is refused", (await paneText(t)).includes("Duplicate field name") && (await onEditor(t)));
  await added.getByRole("textbox", { name: "Field name" }).fill("Rating");
  await choose(t, added, "Field type", "Number");
  await save(t, "Save changes");
  await t.until("saved with the new field", async () => !(await onEditor(t)));
  c = await storedBy(t, "Books");
  await t.check("the new field is last, a Number", c.fields.at(-1).name === "Rating" && c.fields.at(-1).kind === "number" && c.fields.length === 5, JSON.stringify(c.fields.map((f) => f.name)));
  // Remove asks, naming the field; Cancel keeps it.
  await t.go(`/collections/${books}/edit`);
  await rowNamed(t, "Rating").getByRole("button", { name: "Remove field" }).click();
  await t.until("the row is gone from the form", async () => (await rows(t).count()) === 4);
  await save(t, "Save changes");
  await t.until("Save asks Remove fields?", async () => (await modal(t).innerText().catch(() => "")).includes("Remove fields?"));
  await t.check("it names the field and what happens to its values", (await modal(t).innerText()).includes("“Rating”") && (await modal(t).innerText()).includes("will no longer be shown"), await modal(t).innerText());
  await t.audit("remove fields dialog");
  await modal(t).getByRole("button", { name: "Cancel" }).click();
  await t.until("Cancel closes the dialog", async () => (await modal(t).count()) === 0);
  await t.check("still on the form, nothing removed from the store", (await onEditor(t)) && (await storedBy(t, "Books")).fields.some((f) => f.name === "Rating"));
  await save(t, "Save changes");
  await t.until("asked again", async () => (await modal(t).count()) === 1);
  await modal(t).getByRole("button", { name: "Remove and save" }).click();
  await t.until("Remove and save stores it without the field", async () => !(await onEditor(t)) && !(await storedBy(t, "Books")).fields.some((f) => f.name === "Rating"));
  // The title: automatic, another field, no title.
  await t.go(`/collections/${books}/edit`);
  const form = pane(t).locator("form");
  await dropdown(t, form, "Title").locator(".cds--list-box__field").first().click();
  await t.settle(100);
  const titles = await menuOptions(t);
  await t.check("the Title menu lists the text and number fields", JSON.stringify(titles) === JSON.stringify(["The first text field with a value", "Name of the book", "Pages", "No title"]), titles.join(" | "));
  await t.page.getByRole("option", { name: "Pages", exact: true }).click();
  await save(t, "Save changes");
  await t.until("saved", async () => !(await onEditor(t)));
  c = await storedBy(t, "Books");
  await t.check("Pages is the title field", c.titleField === c.fields.find((f) => f.name === "Pages").id);
  const dune = t.itemPath(books, ids.items["books/dune"]);
  const itemTitle = async () => (await pane(t).locator(".cds--breadcrumb-item").last().innerText().catch(() => "")).trim();
  await t.go(dune);
  await t.check("an item is titled by the Pages field", (await itemTitle()) === "412", await itemTitle());
  await t.go(`/collections/${books}/edit`);
  await choose(t, form, "Title", "No title");
  await save(t, "Save changes");
  await t.until("saved with no title", async () => !(await onEditor(t)) && (await storedBy(t, "Books")).titleField === "none");
  await t.go(dune);
  await t.check("without a title an item is called by the collection's name", (await itemTitle()) === "Book", await itemTitle());
  await t.audit("an item without a title");
  await t.go(`/collections/${books}/edit`);
  await choose(t, form, "Title", "The first text field with a value");
  await save(t, "Save changes");
  await t.until("back to automatic", async () => !(await onEditor(t)) && (await storedBy(t, "Books")).titleField === null);
  // Spaces: Work only, so Books moves to Not in this space.
  await t.go(`/collections/${books}/edit`);
  const spaces = form.locator(".cds--multi-select__wrapper");
  await spaces.locator("button").first().click();
  await t.settle(100);
  await t.page.getByRole("option", { name: /Work/ }).click();
  await t.page.keyboard.press("Escape");
  await t.settle(100);
  await pane(t).getByRole("textbox", { name: "Description (optional)" }).fill("Read in the Work space.");
  await save(t, "Save changes");
  await t.until("saved", async () => (await storedBy(t, "Books")).spaceIds?.length === 1);
  await t.open("/collections");
  await t.check("Books is now listed under Not in this space, with Work as its space", (await pane(t).locator(".table-group__title").allInnerTexts()).length === 2 && (await collectionRow(t, "Books").innerText()).includes("Work") && (await collectionRow(t, "Books").innerText()).includes("Read in the Work space."));
  // Cancel returns to the items without storing.
  await t.go(`/collections/${books}/edit`);
  await pane(t).getByRole("textbox", { name: "Description (optional)" }).fill("Never stored");
  await t.page.getByRole("button", { name: "Cancel" }).click();
  await t.until("Cancel leaves the editor", async () => !(await onEditor(t)));
  await t.check("Cancel stored nothing", (await storedBy(t, "Books")).description === "Read in the Work space.");
}, { viewport: "desktop" });

test("editor: a remote collection's fields — a column's type, hiding, component fields of its own", async (t) => {
  await t.boot();
  const fake = await fakeRemotes(t);
  await connectTo(t);
  const id = await makeRemote(t);
  await t.open(`/remotes/${id}/edit`);
  const form = pane(t).locator("form");
  await t.until("the editor shows the columns as fields", async () => (await rows(t).count()) === 4);
  await t.check("the helper explains columns and component fields", (await paneText(t)).includes("Its fields show the source's columns"));
  const typeOf = (name) => rowNamed(t, name).locator("button.cds--list-box__field").first();
  await t.check("a number column's type is fixed", await typeOf("id").isDisabled());
  await t.check("a text column's type can be Markdown or HTML", !(await typeOf("name").isDisabled()));
  await choose(t, rowNamed(t, "name"), "Field type", "Markdown");
  // Own fields are component fields.
  await t.page.getByRole("button", { name: "Add field" }).click();
  const added = rows(t).last();
  await t.check("a field added to a remote collection is a Component field", (await added.locator("button.cds--list-box__field").first().innerText()).trim() === "Component");
  await added.getByRole("textbox", { name: "Field name" }).fill("Shout");
  await t.check("it brings a component's settings", (await added.getByRole("textbox", { name: "Code" }).count()) === 1);
  await added.getByRole("textbox", { name: "Code" }).fill("{{ $item.name }}!");
  await t.audit("remote editor, a component field added");
  await save(t, "Save changes");
  await t.until("saved", async () => !(await onEditor(t)));
  const c = await storedBy(t, "Customers");
  await t.check("name is now Markdown, still the name column", c.fields.find((f) => f.column === "name")?.kind === "markdown");
  await t.check("the added field has no column and is a component", c.fields.find((f) => f.name === "Shout")?.kind === "component" && c.fields.find((f) => f.name === "Shout")?.column === null, JSON.stringify(c.fields.find((f) => f.name === "Shout")));
  void fake;
}, { viewport: "desktop" });

// ---------------------------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------------------------

/** Animals (items matching "zebra" in every kind of field), three collections whose names match, and one that doesn't. */
function searchSpec() {
  return {
    spaces: [{ key: "work", name: "Work" }],
    collections: [
      {
        key: "animals", name: "Animal", plural: "Animals", icon: "Cube", description: "All about the zebra and other striped things",
        fields: [
          { key: "name", name: "Name", kind: "string" },
          { key: "notes", name: "Notes", kind: "markdown" },
          { key: "tags", name: "Tags", kind: "string_list" },
          { key: "todo", name: "Todo", kind: "checklist" },
          { key: "friend", name: "Friend", kind: "item", target: "animals" },
        ],
        items: [
          { values: { name: "Zebra", notes: "Likes **grass**" } },
          { values: { name: "Horse", notes: "Not a zebra, but friendly. Another zebra mention.\n\nA second paragraph about a zebra." } },
          { values: { name: "Lion", tags: ["zebra-hunter", "cat"] } },
          { values: { name: "Okapi", todo: ["[ ] Visit the zebra", "[x] Feed the okapi"] } },
          { values: { name: "Giraffe", friend: { ref: "animals/i0" } } },
          { values: { name: "Elephant", notes: "Grey." } },
          { space: "work", values: { name: "Quagga zebra" } },
        ],
        views: [{ name: "Care", blocks: [{ kind: "markdown", title: "Feeding notes", options: { text: "Feeding zebra: hay twice a day." } }] }],
      },
      { key: "crossings", name: "Crossing", plural: "Zebra crossings", icon: "Location", fields: [{ key: "name", name: "Name", kind: "string" }] },
      { key: "stripes", name: "Zebra", plural: "Stripes", icon: "Star", fields: [{ key: "name", name: "Name", kind: "string" }] },
      { key: "plants", name: "Plant", plural: "Plants", icon: "Folder", fields: [{ key: "name", name: "Name", kind: "string" }], items: [{ values: { name: "Fern" } }] },
    ],
  };
}

/** The lists on the search page: label → the titles of its hits. */
const searchLists = (t) =>
  pane(t).locator(".cds--contained-list").evaluateAll((lists) =>
    Object.fromEntries(
      lists.map((l) => [
        l.querySelector(".cds--contained-list__header")?.innerText.replace(/\s+/g, " ").trim(),
        [...l.querySelectorAll(".search-hit__title")].map((e) => e.innerText.replace(/\s+/g, " ").trim()),
      ]),
    ),
  );
/** The hit of a list (by its title text). */
const hitOf = (t, title) => pane(t).locator(".search-hit").filter({ has: t.page.locator(".search-hit__title", { hasText: title }) }).first();
/** The active tab's path as the workspace stores it. */
const tabPath = (t) =>
  t.page.evaluate(() => {
    const w = JSON.parse(localStorage.getItem("kubus.workspace.default") || "null");
    const panes = [];
    const walk = (n) => (n.kind === "pane" ? panes.push(n) : n.children.forEach(walk));
    walk(w.root);
    const p = panes.find((x) => x.id === w.activePaneId) || panes[0];
    return p.tabs.find((x) => x.id === p.activeTabId)?.path ?? "";
  });
const searchButton = (t) => t.page.getByRole("button", { name: "Search", exact: true }).first();
const bar = (t) => t.page.locator(".search-bar");

for (const vp of ["desktop", "phone"]) {
  test(`search: hit groups, highlights and where a hit leads @ ${vp}`, async (t) => {
    await t.boot();
    const ids = await t.seed(searchSpec());
    await t.open("/search?q=zebra");
    await t.until("the deep link searches", async () => (await paneText(t)).includes("Results for “zebra”") && (await pane(t).locator(".search-hit").count()) > 0);
    await t.settle(300);
    const lists = await searchLists(t);
    const labels = Object.keys(lists);
    await t.check("three lists: collections, Markdown blocks, items", JSON.stringify(labels) === JSON.stringify(["3 collections", "1 Markdown block", "5 items"]), labels.join(" | "));
    await t.check("collections match on plural name, singular name and description", JSON.stringify(lists["3 collections"].slice().sort()) === JSON.stringify(["Animals", "Stripes Zebra", "Zebra crossings"]), JSON.stringify(lists["3 collections"]));
    await t.check("the block is named, with its collection and view", lists["1 Markdown block"][0].startsWith("Feeding notes") && lists["1 Markdown block"][0].includes("Animals › Care"), JSON.stringify(lists["1 Markdown block"]));
    const items = lists["5 items"].map((s) => s.split(" ")[0]).sort();
    await t.check("items match in a title, Markdown, a list, a checklist and a reference", JSON.stringify(items) === JSON.stringify(["Giraffe", "Horse", "Lion", "Okapi", "Zebra"]), JSON.stringify(lists["5 items"]));
    await t.check("the other space's item and the unrelated ones are not listed", !JSON.stringify(lists).includes("Quagga") && !JSON.stringify(lists).includes("Elephant") && !JSON.stringify(lists).includes("Fern"));
    await t.check("an item names its collection", lists["5 items"].every((s) => s.endsWith("Animal")), JSON.stringify(lists["5 items"]));
    // Highlights: every mark is the query, in the title or the excerpt.
    const marks = await pane(t).locator("mark.search-mark").allInnerTexts();
    await t.check("matches are marked, each as typed", marks.length >= 10 && marks.every((m) => m.toLowerCase() === "zebra"), `${marks.length}: ${[...new Set(marks)].join(",")}`);
    const fields = await pane(t).locator(".search-hit__field").allInnerTexts();
    await t.check("excerpts name Notes, Tags, Todo and Friend", ["Notes", "Tags", "Todo", "Friend"].every((f) => fields.includes(f)), fields.join(","));
    await t.check("a Markdown excerpt shows the text around the match", (await hitOf(t, "Horse").innerText()).includes("Not a zebra, but friendly"), await hitOf(t, "Horse").innerText());
    await t.check("a checklist shows the entry that matched, not the others", (await hitOf(t, "Okapi").innerText()).includes("Visit the zebra") && !(await hitOf(t, "Okapi").innerText()).includes("Feed the okapi"));
    await t.check("a reference shows the label that matched", (await hitOf(t, "Giraffe").locator(".search-hit__snippet").innerText()).trim() === "Zebra");
    await t.audit("search results");
    // A case-insensitive match finds the same.
    await t.open("/search?q=ZEBRA");
    await t.until("a capitalised query finds the same", async () => Object.keys(await searchLists(t)).join() === "3 collections,1 Markdown block,5 items");
    // Where a hit leads.
    await t.open("/search?q=zebra");
    await t.until("results again", async () => (await pane(t).locator(".search-hit").count()) >= 9);
    await hitOf(t, "Animals").click();
    await t.until("a collection hit opens its items", async () => (await tabPath(t)) === `/collections/${ids.collections.animals}/items`);
    await t.open("/search?q=zebra");
    await t.until("results again", async () => (await pane(t).locator(".search-hit").count()) >= 9);
    await hitOf(t, "Feeding notes").click();
    await t.until("a block hit opens its view at the block", async () => (await tabPath(t)).startsWith(`/collections/${ids.collections.animals}/items?view=`) && (await tabPath(t)).includes("&block="), await tabPath(t));
    await t.until("the Markdown block is on the page", async () => (await paneText(t)).includes("Feeding zebra: hay twice a day."));
    await t.open("/search?q=zebra");
    await t.until("results again", async () => (await pane(t).locator(".search-hit").count()) >= 9);
    await hitOf(t, "Horse").click();
    await t.until("an item hit opens the item at the field that matched", async () => /\/items\/[^/?]+\?field=/.test(await tabPath(t)), await tabPath(t));
    await t.until("the item's page is shown", async () => (await pane(t).locator(".cds--breadcrumb-item").last().innerText().catch(() => "")).trim() === "Horse");
    await t.open("/search?q=zebra");
    await t.until("results again", async () => (await pane(t).locator(".search-hit").count()) >= 9);
    await hitOf(t, /^\s*Zebra\s*Animal\s*$/).click();
    await t.until("an item whose title matched opens at the top", async () => /\/items\/[^/?]+$/.test(await tabPath(t)), await tabPath(t));
  }, { viewport: vp, smoke: vp === "desktop" });
}

test("search: nothing typed, nothing found, a tag, a count that stops at 50", async (t) => {
  await t.boot();
  const notes = Array.from({ length: 60 }, (_, i) => ({ values: { title: `Zebra note ${i + 1}`, body: i === 0 ? "tagged #striped here" : i === 1 ? "tagged #stripedness here" : "" } }));
  await t.seed({ collections: [{ key: "notes", name: "Note", plural: "Notes", fields: [{ key: "title", name: "Title", kind: "string" }, { key: "body", name: "Body", kind: "markdown" }], items: notes }] });
  await t.open("/search");
  await t.check("without a query the page says what to do", (await paneText(t)).includes("Type in the search box to find collections, Markdown blocks and items."));
  await t.check("and lists nothing", (await pane(t).locator(".cds--contained-list").count()) === 0 && !(await paneText(t)).includes("Nothing found"));
  await t.audit("search, nothing typed");
  await t.open("/search?q=qqqzzz");
  await t.until("a query without a match says so", async () => (await paneText(t)).includes("Nothing found."));
  await t.check("the subtitle names the query", (await paneText(t)).includes("Results for “qqqzzz”"));
  await t.check("no lists", (await pane(t).locator(".cds--contained-list").count()) === 0);
  await t.audit("search, nothing found");
  // 60 items match: the list stops at 50 and says so.
  await t.open("/search?q=zebra");
  await t.until("60 matches are cut at 50, counted as 50+", async () => (await searchLists(t))["50+ items"]?.length === 50, JSON.stringify(Object.keys(await searchLists(t))));
  await t.audit("search, 50+ items");
  await t.open("/search?q=zebra note 5");
  await t.until("a narrower query counts exactly", async () => Object.keys(await searchLists(t)).join() === "11 items", Object.keys(await searchLists(t)).join());
  await t.check("without a plus", !(await paneText(t)).includes("+ items"));
  // A tag: typed it is text, opened from a tag it is exactly that tag.
  await t.open("/search?q=%23striped");
  await t.until("a typed #striped matches the longer tag too", async () => Object.keys(await searchLists(t)).join() === "2 items", Object.keys(await searchLists(t)).join());
  await t.open("/search?q=%23striped&tag=1");
  await t.until("a tag search matches exactly that tag", async () => Object.keys(await searchLists(t)).join() === "1 items" && (await paneText(t)).includes("Tagged “#striped”"), `${Object.keys(await searchLists(t)).join()} ${await paneText(t)}`);
  await t.audit("search, a tag");
}, { viewport: "desktop" });

test("search: a link address finds the page it names, once", async (t) => {
  await t.boot();
  const ids = await t.seed({
    collections: [
      {
        key: "notes", name: "Note", plural: "Notes",
        fields: [{ key: "title", name: "Title", kind: "string" }, { key: "body", name: "Body", kind: "string" }],
        views: [{ name: "Archive", blocks: [{ kind: "table", title: "All" }] }],
        items: [{ key: "a", values: { title: "Alpha", body: "" } }, { key: "b", values: { title: "Beta", body: "" } }],
      },
    ],
  });
  const cid = ids.collections.notes;
  const alpha = ids.items["notes/a"];
  const beta = ids.items["notes/b"];
  const viewId = await t.page.evaluate(async (c) => (await window.kubus.repo.listAllViews()).find((v) => v.collectionId === c && v.name === "Archive").id, cid);
  // Beta's body holds Alpha's address as plain text: Alpha is found by that text too.
  await t.page.evaluate(async ([c, id, text]) => {
    const col = (await window.kubus.repo.listCollections()).find((x) => x.id === c);
    await window.kubus.repo.updateItem(col, id, { [col.fields[0].id]: "Beta", [col.fields[1].id]: text });
  }, [cid, beta, `see #/collections/${cid}/items/${alpha}`]);
  const links = async () => (await searchLists(t))[Object.keys(await searchLists(t)).find((k) => /links?$/.test(k)) ?? ""] ?? [];
  const go = async (q) => {
    await t.open(`/search?q=${encodeURIComponent(q)}`);
    await t.until(`the search for ${q} is answered`, async () => (await paneText(t)).includes(`Results for “${q}”`) && (await pane(t).locator(".cds--contained-list, .helper").count()) > 0, q);
  };
  // A view's address, an item's, a field's: each is listed as a link to that page.
  await go(`#/collections/${cid}/items?view=${viewId}`);
  await t.until("a view's address lists the view", async () => (await links()).some((x) => x.includes("Archive")), JSON.stringify(await searchLists(t)));
  await hitOf(t, "Archive").click();
  await t.until("choosing the link opens the page", async () => (await tabPath(t)).includes(`view=${viewId}`), await tabPath(t));
  await go(`items/${alpha}`);
  await t.until("an item's address lists the item once", async () => (await links()).filter((x) => x.includes("Alpha")).length === 1, JSON.stringify(await searchLists(t)));
  await go("alpha#tit");
  await t.until("item#field lists the field", async () => (await links()).some((x) => x.includes("Title")), JSON.stringify(await searchLists(t)));
  // Alpha also matches as text (Beta's body names its address): it is shown once, in the items.
  await go(`collections/${cid}/items/${alpha}`);
  await t.until("the page is answered", async () => (await paneText(t)).includes("Results for"));
  const all = Object.values(await searchLists(t)).flat();
  await t.check("an item that matches twice is listed once", all.filter((x) => x.includes("Alpha")).length <= 1, JSON.stringify(await searchLists(t)));
  await go("qqq/zzz");
  await t.until("an address naming nothing says so", async () => (await paneText(t)).includes("Nothing found."));
  await t.audit("search, link hits");
}, { viewport: "desktop" });

for (const vp of ["desktop", "phone"]) {
  test(`search: the search bar — opens focused, searches as you type, closes @ ${vp}`, async (t) => {
    await t.boot();
    await t.seed(searchSpec());
    await t.open("/search?q=zebra");
    await t.until("results are shown", async () => (await pane(t).locator(".search-hit").count()) >= 9);
    await t.check("the bar is closed", (await bar(t).count()) === 0);
    await searchButton(t).click();
    await t.until("the Search button opens the bar", async () => (await bar(t).count()) === 1);
    const input = bar(t).locator("input");
    await t.check("it holds the page's query", (await input.inputValue()) === "zebra", await input.inputValue());
    await t.check("and has focus", await t.page.evaluate(() => document.activeElement === document.querySelector(".search-bar input")));
    await t.check(`it is ${t.phone ? "not " : ""}docked beside the side nav`, (await bar(t).evaluate((e) => e.classList.contains("search-bar--nav-docked"))) === !t.phone);
    await t.audit("search bar open with a query");
    // Typing searches (each keystroke replaces the tab's page).
    await t.page.keyboard.press("Control+A");
    await t.page.keyboard.type("horse");
    await t.until("typing searches: the page shows the new results", async () => (await paneText(t)).includes("Results for “horse”") && Object.keys(await searchLists(t)).join() === "1 items", Object.keys(await searchLists(t)).join());
    await t.check("the tab is on the search page for it", (await tabPath(t)) === "/search?q=horse", await tabPath(t));
    await t.check("the bar stays open and holds what was typed", (await bar(t).count()) === 1 && (await input.inputValue()) === "horse");
    await t.audit("search bar while typing");
    // Enter closes it, the results stay.
    await t.page.keyboard.press("Enter");
    await t.until("Enter closes the bar", async () => (await bar(t).count()) === 0);
    await t.check("the results stay", (await paneText(t)).includes("Results for “horse”") && (await hitOf(t, "Horse").count()) === 1);
    // Escape closes it too, and leaving it.
    await searchButton(t).click();
    await t.until("reopened with the query", async () => (await bar(t).count()) === 1 && (await bar(t).locator("input").inputValue()) === "horse");
    await t.page.keyboard.press("Escape");
    await t.until("Escape closes the bar", async () => (await bar(t).count()) === 0);
    await searchButton(t).click();
    await t.until("reopened", async () => (await bar(t).count()) === 1);
    await pane(t).locator(".cds--breadcrumb, .page-header").first().click();
    await t.until("leaving the bar closes it", async () => (await bar(t).count()) === 0);
    // Emptied, the page asks for a query again.
    await searchButton(t).click();
    await t.until("reopened again", async () => (await bar(t).count()) === 1);
    await t.page.keyboard.press("Control+A");
    await t.page.keyboard.press("Backspace");
    await t.until("an emptied box shows the plain search page", async () => (await paneText(t)).includes("Type in the search box") && (await tabPath(t)) === "/search", await tabPath(t));
    await t.page.keyboard.type("fern");
    await t.until("a query without matches in animals finds the plant", async () => (await paneText(t)).includes("Fern") || (await paneText(t)).includes("Nothing found") || (await paneText(t)).includes("Results for “fern”"));
    await t.audit("search bar, last state");
  }, { viewport: vp });
}

test("search: the bar searches in the pane that was active when Search was clicked", async (t) => {
  // The button sits in the right-most pane's strip but must not make that pane active first.
  for (const active of [0, 1]) {
    await t.boot();
    await t.seed(searchSpec());
    await t.seed({ prefs: { "kubus.workspace.default": wsLayout([["/collections"], ["/bookmarks"]], { active }) } });
    await t.open("/search?q=zebra", { keepTabs: true });
    await t.page.evaluate(() => 0);
    await t.settle();
    const panes = t.page.locator(".ws-pane");
    const label = active === 0 ? "left" : "right";
    const other = panes.nth(1 - active);
    const isActive = () => panes.nth(active).evaluate((e) => e.classList.contains("ws-pane--active"));
    const otherBefore = (await other.innerText()).replace(/\s+/g, " ");
    await t.check("two panes", (await panes.count()) === 2);
    await t.check(`the ${label} pane is the active one`, await isActive());
    await searchButton(t).click();
    await t.until("the bar opens", async () => (await bar(t).count()) === 1);
    await t.check(`clicking Search leaves the ${label} pane active`, await isActive());
    await t.page.keyboard.press("Control+A");
    await t.page.keyboard.type("horse");
    await t.until(`the ${label} (previously active) pane shows the results`, async () => (await panes.nth(active).innerText()).includes("Results for “horse”"));
    await t.check(`the ${label} pane is still the active one`, await isActive());
    await t.check("the other pane is untouched", !(await other.innerText()).includes("Results for") && (await other.innerText()).replace(/\s+/g, " ") === otherBefore, (await other.innerText()).slice(0, 100));
    await t.audit(`search bar in a split, ${label} pane active`);
    await t.page.keyboard.press("Enter");
    await t.until("closed", async () => (await bar(t).count()) === 0);
    await t.check("after closing, the results stay in that pane and the other still shows its page", (await panes.nth(active).innerText()).includes("Results for “horse”") && !(await other.innerText()).includes("Results for"));
  }
}, { viewport: "desktop" });
