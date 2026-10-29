// A remote collection made from a fake server's source table (routes on the test's browser context):
// listed, read a page at a time, edited.

const CRM_URL = "https://remote.test";

/** The columns the fake source's customers table has. */
const COLUMNS = [
  { name: "id", type: "integer", kind: "number" },
  { name: "name", type: "text", kind: "string" },
  { name: "city", type: "text", kind: "string" },
  { name: "active", type: "boolean", kind: "checkbox" },
];

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
    if (/^\/api\/sources\/[^/]+\/row$/.test(path)) {
      // One row by its key (an item page of a remote collection).
      const body = JSON.parse(req.postData() || "{}");
      const i = Number(body.keyValue) - 1;
      if (!(i >= 0 && i < fake.total)) return route.fulfill({ status: 200, headers: cors, json: { row: null } });
      const cell = { id: i + 1, name: `Customer ${i + 1}`, city: `City ${i % 7}`, active: i % 2 === 0 };
      return route.fulfill({ status: 200, headers: cors, json: { row: { key: String(i + 1), values: body.columns.map((c) => (c in cell ? cell[c] : null)) } } });
    }
    return route.fulfill({ status: 404, headers: cors, json: { error: "Not found" } });
  });
  return fake;
}

/** Gives the device the server's address and token (without switching sync on); the next load reads them. */
const connectTo = (t, url = CRM_URL) =>
  t.page.evaluate((url) => localStorage.setItem("kubus.sync", JSON.stringify({ url, token: "tok", enabled: false, originals: "always" })), url);

const pane = (t) => t.page.locator(".ws-pane--active");

const paneText = async (t) => (await pane(t).innerText().catch(() => "")).replace(/\s+/g, " ");

/** Whether the collection editor is on screen. */
const onEditor = async (t) => (await pane(t).locator(".form-page").count()) === 1;

const breadcrumbs = async (t) => (await pane(t).locator(".cds--breadcrumb a").allInnerTexts()).map((s) => s.trim());

/** Every collection as stored, as plain data. */
const storedCollections = (t) => t.page.evaluate(async () => JSON.parse(JSON.stringify(await window.kubus.repo.listCollections())));

const storedBy = async (t, plural) => (await storedCollections(t)).find((c) => c.pluralName === plural) ?? null;

/** The rows of the first table block on the page. */
const tableRows = (t) => pane(t).locator(".block table tbody tr");

test("remotes: new remote collection from a source's table, listed, read, edited @ desktop", async (t) => {
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
  await dropdownOf(t, form, "Source").locator(".cds--list-box__field").first().click();
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
  await t.check("the key is the primary key", (await dropdownOf(t, form, "Key").innerText()).includes("id"));
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
  await t.check("a new remote collection is only in the space it was added in", JSON.stringify(c?.spaceIds) === JSON.stringify(["default"]), JSON.stringify(c?.spaceIds));
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
}, { viewport: "desktop", smoke: true });

const rows = (t) => pane(t).locator(".field-row[data-field-id]");
