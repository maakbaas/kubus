// @vitest-environment node
// Every /api/v1 route with its errors (the happy paths of the main ones are in api.test.ts), against
// the headless device and FakeServer. Documented in app/src/help/api.md: a route or a status listed
// there is tested here.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Headless, HeadlessOptions } from "../../../shared/api";
import { HttpError, type ApiResponse } from "../../../shared/router";
import { bytes, FakeServer, SERVER_URL, TOKEN } from "../test/fakeServer";
import { createApi } from "./api";
import { HeadlessDevice, startHeadless } from "./index";

// Each test builds devices and a database: on a busy machine that outlasts the default 5 s.
vi.setConfig({ testTimeout: 30_000 });

let server: FakeServer;
let api: Headless;

const options = (): HeadlessOptions => ({ serverUrl: SERVER_URL, token: TOKEN, cursor: () => server.seq, webhooks: { urls: [], secret: null }, log: () => {} });

beforeEach(async () => {
  server = new FakeServer().install();
  api = await startHeadless(options());
});

type Answer = ApiResponse & { body: any };

/** A request to /api/v1 as the server makes it: the body refused beyond its limit (413). */
async function send(target: Pick<Headless, "handle">, method: string, path: string, body?: unknown, type = "application/json"): Promise<Answer> {
  const url = new URL(`http://localhost/api/v1${path}`);
  const data = body === undefined ? new Uint8Array() : body instanceof Uint8Array ? body : new TextEncoder().encode(typeof body === "string" ? body : JSON.stringify(body));
  const answer = await target.handle({
    method,
    path: url.pathname,
    query: url.searchParams,
    headers: type ? { "content-type": type } : {},
    body: async (limit) => {
      if (data.byteLength > limit) throw new HttpError(413, "The body is too large");
      return data;
    },
  });
  return { ...answer, body: answer.json };
}
const call = (method: string, path: string, body?: unknown, type?: string) => send(api, method, path, body, type);
const ok = async (method: string, path: string, body?: unknown) => {
  const answer = await call(method, path, body);
  expect(answer.status, `${method} ${path}: ${JSON.stringify(answer.body)}`).toBeLessThan(300);
  return answer.body;
};
const refused = async (status: number, method: string, path: string, body?: unknown) => {
  const answer = await call(method, path, body);
  expect(answer.status, `${method} ${path}: ${JSON.stringify(answer.body)}`).toBe(status);
  return answer.body.error as string;
};

const names = (list: { name: string }[]) => list.map((x) => x.name);

describe("requests", () => {
  it("must carry a JSON object", async () => {
    expect(await refused(400, "POST", "/spaces", "{nope")).toMatch(/isn't valid JSON/);
    expect(await refused(400, "POST", "/spaces", [1])).toBe("The body must be a JSON object");
    expect(await refused(400, "POST", "/spaces", "null")).toBe("`name` is required");
    expect(await refused(400, "POST", "/spaces", { name: 3 })).toBe("`name` must be text");
    expect(await refused(400, "POST", "/spaces", { name: "  " })).toBe("`name` can't be empty");
    expect(await refused(400, "POST", "/spaces", { name: "Ok", icon: 3 })).toBe("`icon` must be text");
  });

  it("are refused as too large beyond 5 MB of JSON", async () => {
    expect(await refused(413, "POST", "/spaces", { name: "x".repeat(5 * 1024 * 1024 + 1) })).toBe("The body is too large");
  });

  it("answer 404 for an unknown address and 405 for a wrong method", async () => {
    expect(await refused(404, "GET", "/nothing")).toBe("Not found");
    expect(await refused(405, "PUT", "/spaces")).toBe("Method not allowed");
    expect(await refused(405, "POST", "/items/abc")).toBe("Method not allowed");
  });
});

describe("spaces", () => {
  it("are listed, made, renamed and deleted", async () => {
    expect(names(await ok("GET", "/spaces"))).toEqual(["Space"]);
    const work = await ok("POST", "/spaces", { name: " Work ", icon: "Briefcase" });
    expect(work).toMatchObject({ name: "Work", icon: "Briefcase" });
    expect(await ok("PATCH", "/spaces/work", { name: "Office" })).toMatchObject({ id: work.id, name: "Office", icon: "Briefcase" });
    expect(await ok("PATCH", `/spaces/${work.id}`, { icon: null })).toMatchObject({ name: "Office", icon: null });
    expect(await ok("PATCH", "/spaces/OFFICE", {})).toMatchObject({ name: "Office" });
    expect(await ok("DELETE", "/spaces/office")).toEqual({ ok: true });
    expect(names(await ok("GET", "/spaces"))).toEqual(["Space"]);
  });

  it("answer 404 for an unknown space and 409 when it is the only one", async () => {
    expect(await refused(404, "PATCH", "/spaces/nowhere", { name: "x" })).toBe("No space “nowhere”");
    expect(await refused(404, "DELETE", "/spaces/nowhere")).toBe("No space “nowhere”");
    expect(await refused(409, "DELETE", "/spaces/default")).toMatch(/only space/);
    expect(await refused(400, "PATCH", "/spaces/default", { name: "" })).toBe("`name` can't be empty");
  });
});

const books = { name: "Book", fields: [{ name: "Title", kind: "string" }, { name: "Pages", kind: "number" }] };

describe("collections", () => {
  it("are made with every setting, in a space, and listed with item counts per space", async () => {
    await ok("POST", "/spaces", { name: "Work" });
    const made = await ok("POST", "/collections", { ...books, pluralName: " Volumes ", icon: "Book", description: "Things read", spaces: ["Work"], space: "work" });
    expect(made).toMatchObject({ name: "Book", pluralName: "Volumes", icon: "Book", description: "Things read" });
    expect(made.itemCount).toBeUndefined(); // counts come with the list
    expect(made.spaces).toHaveLength(1);
    expect((await ok("GET", "/collections/volumes/views?space=work"))[0].name).toBe("All");
    await ok("POST", "/collections/Book/items", { space: "work", values: { Title: "A" } });
    const all = await ok("GET", "/collections");
    expect(all).toHaveLength(1);
    expect(all[0].itemCount).toBe(1);
    expect((await ok("GET", "/collections?space=default"))[0].itemCount).toBe(0);
    expect((await ok("GET", "/collections?space=Work"))[0].itemCount).toBe(1);
    expect(await refused(404, "GET", "/collections?space=nope")).toMatch(/No space/);
  });

  it("must have a new name, a list of fields and valid spaces", async () => {
    await ok("POST", "/collections", books);
    expect(await refused(409, "POST", "/collections", { ...books, name: "book" })).toBe("There already is a collection “book”");
    expect(await refused(400, "POST", "/collections", { name: "Film" })).toBe("`fields` must list at least one field");
    expect(await refused(400, "POST", "/collections", { name: "Film", fields: [] })).toBe("`fields` must list at least one field");
    expect(await refused(400, "POST", "/collections", { name: "Film", fields: [{ name: "T", kind: "string" }], spaces: "default" })).toMatch(/`spaces` must be a list/);
    expect(await refused(404, "POST", "/collections", { name: "Film", fields: [{ name: "T", kind: "string" }], spaces: ["nope"] })).toMatch(/No space/);
    expect(await refused(400, "POST", "/collections", { name: "Film", fields: [null] })).toMatch(/`kind` must be one of/);
    expect(await refused(400, "POST", "/collections", { name: "Film", fields: [{ name: "T", kind: "sound" }] })).toMatch(/`kind` must be one of string, markdown/);
    expect(await refused(400, "POST", "/collections", { name: "Film", fields: [{ kind: "string" }] })).toBe("`name` is required");
    expect(await refused(400, "POST", "/collections", { name: "Film", fields: [{ name: "A", kind: "string" }, { name: "a", kind: "string" }] })).toMatch(/Duplicate field name/);
    expect(await refused(400, "POST", "/collections", { name: "Film", fields: [{ name: "Ref", kind: "item" }] })).toMatch(/needs `targetCollection`/);
    expect(await refused(404, "POST", "/collections", { name: "Film", fields: [{ name: "Ref", kind: "item", targetCollection: "Nothing" }] })).toBe("No collection “Nothing”");
    expect(names(await ok("GET", "/collections"))).toEqual(["Book"]);
  });

  it("let fields refer to the collection itself by its name or plural name, or to another", async () => {
    await ok("POST", "/collections", books);
    const made = await ok("POST", "/collections", {
      name: "Person",
      fields: [
        { name: "Name", kind: "string" },
        { name: "Friends", kind: "item_list", targetCollection: "persons" },
        { name: "Favourite", kind: "item", targetCollection: "Person" },
        { name: "Reads", kind: "item_list", targetCollection: "Books" },
      ],
    });
    const byName = Object.fromEntries(made.fields.map((f: { name: string; targetCollectionId: string }) => [f.name, f.targetCollectionId]));
    expect(byName.Friends).toBe(made.id);
    expect(byName.Favourite).toBe(made.id);
    expect(byName.Reads).not.toBe(made.id);
  });

  it("change their settings, and are read back by id, name or plural name", async () => {
    await ok("POST", "/spaces", { name: "Work" });
    const made = await ok("POST", "/collections", books);
    const changed = await ok("PATCH", "/collections/book", { name: "Volume", pluralName: "Volumes", icon: "Book", description: "d", spaces: ["default", "Work"] });
    expect(changed).toMatchObject({ id: made.id, name: "Volume", pluralName: "Volumes", icon: "Book", description: "d" });
    expect(changed.spaces).toHaveLength(2);
    expect((await ok("PATCH", `/collections/${made.id}`, { spaces: null })).spaces).toBeNull();
    expect(await ok("PATCH", "/collections/VOLUMES", {})).toMatchObject({ name: "Volume" });
    expect(await ok("GET", `/collections/${made.id}`)).toMatchObject({ name: "Volume" });
    expect(await refused(400, "PATCH", "/collections/volume", { name: " " })).toBe("`name` can't be empty");
    expect(await refused(400, "PATCH", "/collections/volume", { pluralName: "" })).toBe("`pluralName` can't be empty");
    expect(await refused(404, "PATCH", "/collections/nothing", { name: "x" })).toBe("No collection “nothing”");
  });

  it("take a title field by name or id, none, or null; and refuse one that can't be", async () => {
    const made = await ok("POST", "/collections", { name: "Task", fields: [{ name: "Name", kind: "string" }, { name: "Done", kind: "checkbox" }, { name: "Due", kind: "date" }] });
    const nameId = made.fields[0].id;
    expect((await ok("PATCH", "/collections/Task", { titleField: "Due" })).titleField).toBe(made.fields[2].id);
    expect((await ok("PATCH", "/collections/Task", { titleField: nameId })).titleField).toBe(nameId);
    expect((await ok("PATCH", "/collections/Task", { titleField: "none" })).titleField).toBe("none");
    expect((await ok("PATCH", "/collections/Task", { titleField: null })).titleField).toBeNull();
    expect(await refused(400, "PATCH", "/collections/Task", { titleField: "Done" })).toMatch(/isn't a text, number or date field/);
    expect(await refused(400, "PATCH", "/collections/Task", { titleField: 3 })).toMatch(/`titleField` is a text, number or date field's id or name/);
    expect(await refused(404, "PATCH", "/collections/Task", { titleField: "Nope" })).toBe("Task has no field “Nope”");
  });

  it("are deleted with their items, unless another collection refers to them", async () => {
    await ok("POST", "/collections", books);
    await ok("POST", "/collections", { name: "Review", fields: [{ name: "Of", kind: "item", targetCollection: "Book" }] });
    expect(await refused(409, "DELETE", "/collections/Book")).toMatch(/Still referenced by “Of” of Review/);
    expect(await ok("DELETE", "/collections/Review")).toEqual({ ok: true });
    expect(await ok("DELETE", "/collections/Book")).toEqual({ ok: true });
    expect(await ok("GET", "/collections")).toEqual([]);
    expect(await refused(404, "DELETE", "/collections/Book")).toBe("No collection “Book”");
  });
});

describe("fields", () => {
  beforeEach(async () => void (await ok("POST", "/collections", books)));

  it("are added and changed with the settings of their kind", async () => {
    const withTarget = await ok("POST", "/collections/Book/fields", { name: "Sequel", kind: "item", targetCollection: "Books", toggleIcon: "Star" });
    const sequel = withTarget.fields.find((f: { name: string }) => f.name === "Sequel");
    expect(sequel).toMatchObject({ kind: "item", targetCollectionId: withTarget.id, toggleIcon: "Star", strikeThrough: false });
    const done = await ok("POST", "/collections/Book/fields", { name: "Read", kind: "checkbox", toggleIcon: "Checkmark", strikeThrough: true });
    expect(done.fields.find((f: { name: string }) => f.name === "Read")).toMatchObject({ toggleIcon: "Checkmark", strikeThrough: true });
    const edited = await ok("PATCH", "/collections/Book/fields/Read", { strikeThrough: false, toggleIcon: null });
    expect(edited.fields.find((f: { name: string }) => f.name === "Read")).toMatchObject({ toggleIcon: null, strikeThrough: false });
    // The target of a reference can't be changed later; nor can the kind.
    const kept = await ok("PATCH", "/collections/Book/fields/Sequel", { name: "Next", targetCollection: "Nothing" });
    expect(kept.fields.find((f: { name: string }) => f.name === "Next").targetCollectionId).toBe(withTarget.id);
    expect(await refused(400, "PATCH", "/collections/Book/fields/Pages", { kind: "string" })).toBe("A field's kind can't be changed");
  });

  it("filter the choices of a reference by the target's fields", async () => {
    await ok("POST", "/collections", { name: "Person", fields: [{ name: "Name", kind: "string" }] });
    const added = await ok("POST", "/collections/Book/fields", {
      name: "Author", kind: "item", targetCollection: "Person", choiceFilter: [{ fieldId: "name", operator: "contains", value: "A" }],
    });
    const person = await ok("GET", "/collections/Person");
    const author = added.fields.find((f: { name: string }) => f.name === "Author");
    expect(author.choiceFilter).toEqual([expect.objectContaining({ fieldId: person.fields[0].id, operator: "contains", value: "A" })]);
    expect(await refused(400, "POST", "/collections/Book/fields", { name: "B", kind: "item", targetCollection: "Person", choiceFilter: "x" })).toBe("`choiceFilter` must be a list");
    expect(await refused(400, "POST", "/collections/Book/fields", { name: "B", kind: "item", targetCollection: "Person", choiceFilter: [{ operator: "is" }] })).toMatch(/needs a `fieldId`/);
    expect(await refused(400, "POST", "/collections/Book/fields", { name: "B", kind: "item", targetCollection: "Person", choiceFilter: [{ fieldId: "name", join: "xor" }] })).toBe("A filter's `join` is and or or");
    expect(await refused(404, "POST", "/collections/Book/fields", { name: "B", kind: "item", targetCollection: "Person", choiceFilter: [{ fieldId: "nope" }] })).toMatch(/has no field “nope”/);
  });

  it("can be computed by a shared or an own component, or ask AI", async () => {
    await ok("POST", "/components", { name: "Twice", code: "{{ $item.Pages * 2 }}", output: "number" });
    await ok("POST", "/components", { name: "Ask", code: "Rate {{ $item.Title }}", ai: true });
    const shared = await ok("POST", "/collections/Book/fields", { name: "Double", kind: "component", component: "twice" });
    expect(shared.fields.find((f: { name: string }) => f.name === "Double")).toMatchObject({ kind: "component", code: null, output: null });
    const own = await ok("POST", "/collections/Book/fields", { name: "Own", kind: "component", code: "{{ $item.Title }}" });
    expect(own.fields.find((f: { name: string }) => f.name === "Own")).toMatchObject({ code: "{{ $item.Title }}", output: "markdown", componentId: null });
    const html = await ok("POST", "/collections/Book/fields", { name: "Card", kind: "component", code: "<b>{{ $item.Title }}</b>", output: "html", frameRatio: "4/3" });
    expect(html.fields.find((f: { name: string }) => f.name === "Card")).toMatchObject({ output: "html", frameRatio: "4/3" });
    const ai = await ok("POST", "/collections/Book/fields", { name: "Rating", kind: "ai", component: "Ask" });
    expect(ai.fields.find((f: { name: string }) => f.name === "Rating")).toMatchObject({ kind: "ai", output: "string", componentId: expect.any(String) });
    const aiOwn = await ok("POST", "/collections/Book/fields", { name: "Score", kind: "ai", code: "Score {{ $item.Title }}", output: "number" });
    expect(aiOwn.fields.find((f: { name: string }) => f.name === "Score")).toMatchObject({ kind: "ai", output: "number" });
    // Edits keep what isn't sent.
    const renamed = await ok("PATCH", "/collections/Book/fields/Own", { name: "Mine", frameRatio: "1/1" });
    expect(renamed.fields.find((f: { name: string }) => f.name === "Mine")).toMatchObject({ code: "{{ $item.Title }}", output: "markdown" });
    const rewritten = await ok("PATCH", "/collections/Book/fields/Mine", { code: "{{ $item.Title }}!", output: "string" });
    expect(rewritten.fields.find((f: { name: string }) => f.name === "Mine")).toMatchObject({ code: "{{ $item.Title }}!", output: "string" });
    const switched = await ok("PATCH", "/collections/Book/fields/Mine", { component: "twice" });
    expect(switched.fields.find((f: { name: string }) => f.name === "Mine")).toMatchObject({ code: null, componentId: expect.any(String) });
  });

  it("refuse a component field that doesn't fit", async () => {
    await ok("POST", "/components", { name: "Ask", code: "Rate {{ $item.Title }}", ai: true });
    await ok("POST", "/components", { name: "Twice", code: "{{ $item.Pages }}", output: "number" });
    expect(await refused(400, "POST", "/collections/Book/fields", { name: "X", kind: "ai", component: "Twice" })).toBe("An AI field needs a component asking AI");
    expect(await refused(400, "POST", "/collections/Book/fields", { name: "X", kind: "component", component: "Ask" })).toBe("A component asking AI fills an AI field");
    expect(await refused(404, "POST", "/collections/Book/fields", { name: "X", kind: "component", component: "Nope" })).toBe("No component “Nope”");
    expect(await refused(400, "POST", "/collections/Book/fields", { name: "X", kind: "component", code: "x", output: "pdf" })).toBe("`output` must be markdown, string, number, image or html");
    expect(await refused(400, "POST", "/collections/Book/fields", { name: "X", kind: "component" })).toMatch(/Choose a component, or write it here/);
    expect(await refused(400, "POST", "/collections/Book/fields", { name: "X", kind: "component", code: "no item here" })).toMatch(/doesn't read the item/);
    await ok("POST", "/collections/Book/fields", { name: "Rating", kind: "ai", code: "Rate {{ $item.Title }}", output: "string" });
    expect(await refused(400, "PATCH", "/collections/Book/fields/Rating", { output: "number" })).toBe("An AI field's `output` can't be changed");
  });

  it("are reordered, with the ones left out after; and removed down to the last", async () => {
    const reordered = await ok("PUT", "/collections/Book/fields/order", ["Pages"]);
    expect(names(reordered.fields)).toEqual(["Pages", "Title"]);
    expect(await refused(400, "PUT", "/collections/Book/fields/order", { Pages: 1 })).toBe("Send the fields as a list (ids or names), in their new order");
    expect(await refused(404, "PUT", "/collections/Book/fields/order", ["Nope"])).toBe("Book has no field “Nope”");
    expect(names((await ok("DELETE", "/collections/Book/fields/Pages")).fields)).toEqual(["Title"]);
    expect(await refused(409, "DELETE", "/collections/Book/fields/Title")).toBe("A collection always keeps a field: add another one first");
    expect(await refused(404, "DELETE", "/collections/Book/fields/Pages")).toBe("Book has no field “Pages”");
    expect(await refused(404, "PATCH", "/collections/Book/fields/Pages", { name: "x" })).toBe("Book has no field “Pages”");
  });
});

describe("items", () => {
  beforeEach(async () => {
    await ok("POST", "/collections", {
      name: "Book",
      fields: [
        { name: "Title", kind: "string" }, { name: "Pages", kind: "number" }, { name: "Read", kind: "checkbox" }, { name: "Published", kind: "date" },
        { name: "Finished", kind: "datetime" }, { name: "Tags", kind: "string_list" }, { name: "Cover", kind: "image" },
        { name: "Summary", kind: "ai", code: "Summarize {{ $item.Title }}", output: "string" }, { name: "Score", kind: "ai", code: "Rate {{ $item.Title }}", output: "number" },
      ],
    });
  });

  it("are written as each field's kind takes them", async () => {
    const item = await ok("POST", "/collections/Book/items", { values: { Title: "Dune", Published: "1965-08-01", Finished: "2026-03-01T11:00:00+01:00", Tags: ["a", "b"], Read: true } });
    expect(item.values).toMatchObject({ Published: "1965-08-01", Finished: "2026-03-01T10:00:00.000Z", Tags: ["a", "b"], Read: true, Cover: null });
    const bad = (values: object) => refused(400, "PATCH", `/items/${item.id}`, { values });
    expect(await bad({ Pages: "x" })).toBe("“Pages” of Book takes a number");
    expect(await bad({ Read: "yes" })).toBe("“Read” of Book takes true or false");
    expect(await bad({ Title: 3 })).toBe("“Title” of Book takes text");
    expect(await bad({ Published: "1965-8-1" })).toBe("“Published” of Book takes a date (YYYY-MM-DD)");
    expect(await bad({ Published: "1965-13-45" })).toMatch(/takes a date/);
    expect(await bad({ Finished: "soon" })).toBe("“Finished” of Book takes a date and time (ISO 8601)");
    expect(await bad({ Tags: "a" })).toBe("“Tags” of Book takes a list of texts");
    expect(await bad({ Tags: [1] })).toBe("“Tags” of Book takes a list of texts");
    expect(await bad({ Cover: "not-a-file-id" })).toBe("“Cover” of Book takes a file id (from POST /api/v1/files)");
    expect(await bad({ Summary: 3 })).toBe("“Summary” of Book takes text");
    expect(await bad({ Score: "x" })).toBe("“Score” of Book takes a number");
    expect(await refused(404, "PATCH", `/items/${item.id}`, { values: { Nope: 1 } })).toBe("Book has no field “Nope”");
    expect(await refused(400, "PATCH", `/items/${item.id}`, { values: [] })).toBe("`values` must be an object of field names to values");
  });

  it("can have a value typed over an AI field's, and any value cleared with null", async () => {
    const item = await ok("POST", "/collections/Book/items", { values: { Title: "Dune", Pages: 5 } });
    const typed = await ok("PATCH", `/items/${item.id}`, { values: { Summary: "mine", Score: 3, Pages: null } });
    expect(typed.values).toMatchObject({ Summary: "mine", Score: 3, Pages: null });
  });

  it("are checked for references and checklists", async () => {
    await ok("POST", "/collections/Book/fields", { name: "Sequel", kind: "item", targetCollection: "Book" });
    await ok("POST", "/collections/Book/fields", { name: "Also", kind: "item_list", targetCollection: "Book" });
    await ok("POST", "/collections/Book/fields", { name: "Todo", kind: "checklist" });
    const a = await ok("POST", "/collections/Book/items", { values: { Title: "A" } });
    const b = await ok("POST", "/collections/Book/items", { values: { Title: "B", Sequel: a.id, Also: [a.id], Todo: [{ text: "x", done: true }, { text: "y" }, "[x] z", "w"] } });
    expect(b.values).toMatchObject({ Sequel: a.id, Also: [a.id], Todo: ["[x] x", "[ ] y", "[x] z", "[ ] w"] });
    expect(await refused(400, "PATCH", `/items/${b.id}`, { values: { Sequel: 3 } })).toBe("“Sequel” of Book takes an item id");
    expect(await refused(400, "PATCH", `/items/${b.id}`, { values: { Also: a.id } })).toBe("“Also” of Book takes a list of item ids");
    expect(await refused(400, "PATCH", `/items/${b.id}`, { values: { Also: [a.id, "ghost"] } })).toMatch(/no such item: ghost/);
    expect(await refused(400, "PATCH", `/items/${b.id}`, { values: { Todo: "x" } })).toBe("“Todo” of Book takes a list of { text, done } items");
    expect(await refused(400, "PATCH", `/items/${b.id}`, { values: { Todo: [3] } })).toBe("“Todo” of Book takes a list of { text, done } items");
    expect(await ok("PATCH", `/items/${b.id}`, { values: { Sequel: null, Also: [] } })).toMatchObject({ values: { Sequel: null, Also: null } }); // an empty list is no value
  });

  it("can't be created with a generated value, or into an unknown space, and accept no values at all", async () => {
    expect(await refused(400, "POST", "/collections/Book/items", { values: { Summary: "x" } })).toMatch(/AI fields are generated/);
    expect(await refused(404, "POST", "/collections/Book/items", { space: "nope" })).toMatch(/No space/);
    expect(await refused(400, "POST", "/collections/Book/items", { values: "x" })).toBe("`values` must be an object of field names to values");
    const empty = await ok("POST", "/collections/Book/items", {});
    expect(empty.values.Title).toBeNull();
    expect(empty.label).toBe("Book");
  });

  it("are listed per space in pages, past the end empty, with limits kept in bounds", async () => {
    await ok("POST", "/spaces", { name: "Work" });
    for (const t of ["A", "B", "C"]) await ok("POST", "/collections/Book/items", { values: { Title: t } });
    await ok("POST", "/collections/Book/items", { space: "work", values: { Title: "W" } });
    expect((await ok("GET", "/collections/Book/items")).total).toBe(3);
    expect((await ok("GET", "/collections/Book/items?space=work")).items.map((i: { label: string }) => i.label)).toEqual(["W"]);
    expect(await ok("GET", "/collections/Book/items?limit=0")).toMatchObject({ limit: 100, offset: 0 });
    expect(await ok("GET", "/collections/Book/items?limit=99999&offset=-4")).toMatchObject({ limit: 1000, offset: 0 });
    expect(await ok("GET", "/collections/Book/items?limit=abc&offset=abc")).toMatchObject({ limit: 100, offset: 0 });
    expect((await ok("GET", "/collections/Book/items?limit=2&offset=2")).items).toHaveLength(1);
    expect((await ok("GET", "/collections/Book/items?limit=2&offset=9")).items).toEqual([]);
  });

  it("are filtered with any of a field's operators, joined with and or or", async () => {
    for (const [Title, Pages] of [["Dune", 412], ["Emma", 474], ["Ubik", 202]] as const) await ok("POST", "/collections/Book/items", { values: { Title, Pages } });
    const list = async (filters: unknown, extra = "") => (await call("GET", `/collections/Book/items?filters=${encodeURIComponent(JSON.stringify(filters))}${extra}`));
    const labels = (a: Answer) => a.body.items.map((i: { label: string }) => i.label).sort();
    expect(labels(await list([{ fieldId: "Pages", operator: "gt", value: 300 }]))).toEqual(["Dune", "Emma"]);
    expect(labels(await list([{ fieldId: "Title", operator: "contains", value: "u" }]))).toEqual(["Dune", "Ubik"]);
    expect(labels(await list([{ fieldId: "Title", operator: "is", value: "Emma" }, { fieldId: "Title", operator: "is", value: "Ubik", join: "or" }]))).toEqual(["Emma", "Ubik"]);
    expect(labels(await list([{ fieldId: "Pages", operator: "isEmpty" }]))).toEqual([]);
    expect((await list([{ fieldId: "Pages", operator: "gt", value: "many" }])).status).toBe(400);
    expect((await list([{ fieldId: "Pages", operator: "nope", value: "1" }])).body.error).toMatch(/has no operator “nope”/);
    expect((await list({ fieldId: "Pages" })).body.error).toBe("`filters` must be a list");
    expect((await list([{ operator: "is" }])).body.error).toMatch(/needs a `fieldId`/);
    expect((await list([{ fieldId: "Pages", operator: "gt", value: 1, join: "xor" }])).body.error).toBe("A filter's `join` is and or or");
    expect((await list([{ fieldId: "Nope", operator: "is", value: 1 }])).body.error).toBe("Book has no field “Nope”");
  });

  it("are sorted ascending or descending, by name or id", async () => {
    for (const [Title, Pages] of [["Dune", 412], ["Emma", 474], ["Ubik", 202]] as const) await ok("POST", "/collections/Book/items", { values: { Title, Pages } });
    const sorted = async (sort: unknown) => (await ok("GET", `/collections/Book/items?sort=${encodeURIComponent(JSON.stringify(sort))}`)).items.map((i: { label: string }) => i.label);
    expect(await sorted([{ fieldId: "Pages", direction: "asc" }])).toEqual(["Ubik", "Dune", "Emma"]);
    expect(await sorted([{ fieldId: "pages", direction: "desc" }])).toEqual(["Emma", "Dune", "Ubik"]);
    expect(await sorted([{ fieldId: "Title", direction: "sideways" }])).toEqual(["Dune", "Emma", "Ubik"]);
    expect(await refused(400, "GET", `/collections/Book/items?sort=${encodeURIComponent('{"a":1}')}`)).toBe("`sort` must be a list");
    expect(await refused(400, "GET", "/collections/Book/items?sort=%5B")).toBe("`sort` must be a JSON list");
  });

  it("are read, changed and deleted by id; unknown or deleted ones are 404", async () => {
    const item = await ok("POST", "/collections/Book/items", { values: { Title: "Dune" } });
    expect(await ok("GET", `/items/${item.id}`)).toMatchObject({ id: item.id, label: "Dune", itemViewId: null });
    expect(await ok("PATCH", `/items/${item.id}`, { values: { Title: "Dune!" } })).toMatchObject({ label: "Dune!" });
    expect(await ok("PATCH", `/items/${item.id}`, {})).toMatchObject({ label: "Dune!" });
    expect(await ok("DELETE", `/items/${item.id}`)).toEqual({ ok: true });
    for (const [method, path] of [["GET", `/items/${item.id}`], ["PATCH", `/items/${item.id}`], ["DELETE", `/items/${item.id}`], ["POST", `/items/${item.id}/move`], ["PUT", `/items/${item.id}/item-view`]] as const) {
      expect(await refused(404, method, path, method === "GET" || method === "DELETE" ? undefined : { space: "default" })).toBe(`No item ${item.id}`);
    }
  });

  it("move to another space, unless their collection isn't shown there", async () => {
    await ok("POST", "/spaces", { name: "Work" });
    await ok("POST", "/spaces", { name: "Home" });
    const item = await ok("POST", "/collections/Book/items", { values: { Title: "Dune" } });
    expect(await refused(400, "POST", `/items/${item.id}/move`, {})).toBe("`space` is required");
    expect(await refused(404, "POST", `/items/${item.id}/move`, { space: "nope" })).toMatch(/No space/);
    await ok("PATCH", "/collections/Book", { spaces: ["default", "Work"] });
    expect(await refused(409, "POST", `/items/${item.id}/move`, { space: "Home" })).toBe("Books aren't shown in Home");
    expect((await ok("POST", `/items/${item.id}/move`, { space: "Work" })).spaceId).not.toBe("default");
  });

  it("are pinned to an item view by id or name, and back to the default", async () => {
    const item = await ok("POST", "/collections/Book/items", { values: { Title: "Dune" } });
    const views = await ok("PUT", "/collections/Book/item-views", [{ name: "Compact", layout: {} }, { name: "Wide", layout: {} }]);
    expect((await ok("PUT", `/items/${item.id}/item-view`, { itemView: "wide" })).itemViewId).toBe(views[1].id);
    expect((await ok("PUT", `/items/${item.id}/item-view`, { itemView: views[0].id })).itemViewId).toBe(views[0].id);
    expect((await ok("PUT", `/items/${item.id}/item-view`, { itemView: null })).itemViewId).toBeNull();
    expect((await ok("PUT", `/items/${item.id}/item-view`, {})).itemViewId).toBeNull();
    expect(await refused(404, "PUT", `/items/${item.id}/item-view`, { itemView: "Nope" })).toBe("Book has no item view “Nope”");
  });

  it("have AI values written for the prompt as it reads now, and accepted when typed over", async () => {
    const item = await ok("POST", "/collections/Book/items", { values: { Title: "Dune" } });
    expect((await ok("PUT", `/items/${item.id}/ai/Summary`, { value: "epic" })).values.Summary).toBe("epic");
    expect((await ok("PUT", `/items/${item.id}/ai/Score`, { value: 9.5 })).values.Score).toBe(9.5);
    expect((await ok("PUT", `/items/${item.id}/ai/summary`, { value: null })).values.Summary).toBeNull();
    expect((await ok("PUT", `/items/${item.id}/ai/Summary`, {})).values.Summary).toBeNull();
    await ok("PATCH", `/items/${item.id}`, { values: { Summary: "typed" } });
    expect((await ok("POST", `/items/${item.id}/ai/Summary/accept`)).values.Summary).toBe("typed");
    expect(await refused(400, "PUT", `/items/${item.id}/ai/Score`, { value: "high" })).toBe("“Score” takes a number");
    expect(await refused(400, "PUT", `/items/${item.id}/ai/Summary`, { value: 5 })).toBe("“Summary” takes text");
    expect(await refused(400, "PUT", `/items/${item.id}/ai/Title`, { value: "x" })).toBe("“Title” isn't an AI field");
    expect(await refused(400, "POST", `/items/${item.id}/ai/Title/accept`)).toBe("“Title” isn't an AI field");
    expect(await refused(404, "PUT", `/items/${item.id}/ai/Nope`, { value: "x" })).toBe("Book has no field “Nope”");
  });

  it("refuse AI values while the prompt is empty for the item", async () => {
    await ok("POST", "/collections/Book/fields", { name: "Bare", kind: "ai", code: "{{ $item.Title }}", output: "string" });
    const item = await ok("POST", "/collections/Book/items", { values: {} });
    expect(await refused(409, "PUT", `/items/${item.id}/ai/Bare`, { value: "x" })).toBe("The prompt is empty for this item");
    expect(await refused(409, "POST", `/items/${item.id}/ai/Bare/accept`)).toBe("The prompt is empty for this item");
  });

  it("are found by search in the space asked for, only among the collections shown there", async () => {
    await ok("POST", "/spaces", { name: "Work" });
    await ok("POST", "/collections", { name: "Memo", fields: [{ name: "Text", kind: "string" }], spaces: ["Work"] });
    const book = await ok("POST", "/collections/Book/items", { values: { Title: "Findable book" } });
    await ok("POST", "/collections/Memo/items", { space: "work", values: { Text: "Findable memo" } });
    const there = await ok("GET", "/search?q=findable&space=Work");
    expect(there.map((i: { collection: string }) => i.collection)).toEqual(["Memo"]);
    expect((await ok("GET", "/search?q=findable")).map((i: { id: string }) => i.id)).toEqual([book.id]);
    expect(await ok("GET", "/search")).toEqual([]);
    expect(await ok("GET", "/search?q=findable&limit=0")).toHaveLength(1);
    expect(await refused(404, "GET", "/search?q=x&space=nope")).toMatch(/No space/);
  });
});

describe("views", () => {
  beforeEach(async () => {
    await ok("POST", "/collections", { name: "Book", fields: [{ name: "Title", kind: "string" }, { name: "Pages", kind: "number" }] });
    await ok("POST", "/collections", { name: "Person", fields: [{ name: "Name", kind: "string" }] });
  });

  it("are made with blocks of other collections, filters and sorts resolved by field name", async () => {
    const view = await ok("POST", "/collections/Book/views", {
      name: "Mixed",
      editable: false,
      filters: [{ fieldId: "Pages", operator: "gt", value: "1" }],
      blocks: [
        { kind: "table", title: "Books", sort: [{ fieldId: "Title", direction: "desc" }], groupBy: "Pages", layout: { fields: ["Title"], hiddenLabels: ["Pages"] } },
        { kind: "cards", title: "People", collectionId: "Person", filters: [{ fieldId: "Name", operator: "contains", value: "A" }], layout: { fields: null } },
      ],
    });
    const book = await ok("GET", "/collections/Book");
    const person = await ok("GET", "/collections/Person");
    expect(view).toMatchObject({ name: "Mixed", editable: false, position: 1 });
    expect(view.blocks[0]).toMatchObject({ title: "Books", groupBy: book.fields[1].id, layout: expect.objectContaining({ fields: [book.fields[0].id], hiddenLabels: [book.fields[1].id] }) });
    expect(view.blocks[1]).toMatchObject({ collectionId: person.id, filters: [expect.objectContaining({ fieldId: person.fields[0].id })] });
    expect(view.collapsed).toBeUndefined();
  });

  it("are listed per space, changed in place, and deleted by id or name", async () => {
    await ok("POST", "/spaces", { name: "Work" });
    const made = await ok("POST", "/collections/Book/views", { name: "Plain", space: "Work" });
    expect(made.blocks).toHaveLength(1);
    // A collection's "All" view belongs to the space it was made in.
    expect(names(await ok("GET", "/collections/Book/views?space=work"))).toEqual(["Plain"]);
    expect(names(await ok("GET", "/collections/Book/views"))).toEqual(["All"]);
    const patched = await ok("PATCH", "/collections/Book/views/plain", { name: "Plainer", filters: [{ fieldId: "Pages", operator: "lt", value: "9" }], editable: true, blocks: [{ kind: "cards" }] });
    expect(patched).toMatchObject({ id: made.id, name: "Plainer", editable: true, spaceId: made.spaceId });
    expect(patched.blocks[0].kind).toBe("cards");
    expect(await ok("PATCH", `/collections/Book/views/${made.id}?space=work`, {})).toMatchObject({ name: "Plainer" });
    // "Show filter bar": set, kept when not sent, taken off.
    expect((await ok("PATCH", `/collections/Book/views/${made.id}?space=work`, { filterBar: true })).filterBar).toBe(true);
    expect((await ok("PATCH", `/collections/Book/views/${made.id}?space=work`, { name: "Plainer" })).filterBar).toBe(true);
    expect((await ok("PATCH", `/collections/Book/views/${made.id}?space=work`, { filterBar: false })).filterBar).toBeUndefined();
    expect(await ok("DELETE", "/collections/Book/views/Plainer?space=work")).toEqual({ ok: true });
    expect(await ok("GET", "/collections/Book/views?space=work")).toEqual([]);
  });

  it("refuse what a view can't be", async () => {
    const ten = { name: "V" };
    expect(await refused(400, "POST", "/collections/Book/views", {})).toBe("`name` is required");
    expect(await refused(400, "POST", "/collections/Book/views", { ...ten, blocks: [] })).toBe("`blocks` must be a list of at least one block");
    expect(await refused(400, "POST", "/collections/Book/views", { ...ten, blocks: "x" })).toBe("`blocks` must be a list of at least one block");
    expect(await refused(400, "POST", "/collections/Book/views", { ...ten, blocks: [3] })).toBe("A block must be an object");
    expect(await refused(400, "POST", "/collections/Book/views", { ...ten, blocks: [{ title: "No kind" }] })).toBe("A block needs a `kind` (table, cards, map, component, markdown, …)");
    expect(await refused(404, "POST", "/collections/Book/views", { ...ten, blocks: [{ kind: "table", collectionId: "Nope" }] })).toBe("No collection “Nope”");
    expect(await refused(404, "POST", "/collections/Book/views", { ...ten, blocks: [{ kind: "table", layout: { fields: ["Nope"] } }] })).toBe("Book has no field “Nope”");
    expect(await refused(404, "POST", "/collections/Book/views", { ...ten, space: "nope" })).toMatch(/No space/);
    expect(await refused(404, "PATCH", "/collections/Book/views/Nope", {})).toBe("Book has no view “Nope”");
    expect(await refused(404, "DELETE", "/collections/Book/views/Nope")).toBe("Book has no view “Nope”");
    expect(await refused(404, "GET", "/collections/Book/views/Nope/items")).toBe("Book has no view “Nope”");
    expect(await refused(400, "PATCH", "/collections/Book/views/All", { name: " " })).toBe("`name` can't be empty");
  });

  it("star a default per space, or none", async () => {
    await ok("POST", "/collections/Book/views", { name: "Second" });
    const views = await ok("PUT", "/collections/Book/default-view", { view: "Second" });
    expect(views.map((v: { name: string; isDefault: boolean }) => [v.name, v.isDefault])).toEqual([["All", false], ["Second", true]]);
    expect((await ok("PUT", "/collections/Book/default-view", { view: null })).every((v: { isDefault: boolean }) => !v.isDefault)).toBe(true);
    expect((await ok("PUT", "/collections/Book/default-view", {})).every((v: { isDefault: boolean }) => !v.isDefault)).toBe(true);
    expect(await refused(404, "PUT", "/collections/Book/default-view", { view: "Nope" })).toBe("Book has no view “Nope”");
  });

  it("show a block's items grouped, in pages, from a chosen space", async () => {
    await ok("POST", "/spaces", { name: "Work" });
    for (const [Title, Pages] of [["A", 1], ["B", 1], ["C", 2]] as const) await ok("POST", "/collections/Book/items", { space: "work", values: { Title, Pages } });
    await ok("POST", "/collections/Book/views", { name: "By pages", space: "work", blocks: [{ kind: "table", title: "Grouped", groupBy: "Pages" }, { kind: "cards", title: "Flat" }] });
    const grouped = await ok("GET", "/collections/Book/views/By%20pages/items?space=work&limit=2");
    expect(grouped).toMatchObject({ view: { name: "By pages" }, block: { title: "Grouped", kind: "table" }, total: 3, limit: 2, offset: 0 });
    expect(grouped.groups.map((g: { label: string; total: number; items: unknown[] }) => [g.label, g.total, g.items.length])).toEqual([["1", 2, 2]]);
    expect(grouped.items).toBeUndefined();
    const second = await ok("GET", "/collections/Book/views/By%20pages/items?space=work&limit=2&offset=2");
    expect(second.groups.map((g: { label: string; items: unknown[] }) => [g.label, g.items.length])).toEqual([["2", 1]]);
    const flat = await ok("GET", "/collections/Book/views/By%20pages/items?space=work&block=Flat");
    expect(flat.items).toHaveLength(3);
    expect(flat.groups).toBeUndefined();
    expect(await ok("GET", `/collections/Book/views/By%20pages/items?space=work&block=${grouped.block.id}`)).toMatchObject({ block: { title: "Grouped" } });
    expect(await refused(404, "GET", "/collections/Book/views/By%20pages/items?space=work&block=Nope")).toBe("The view “By pages” has no block “Nope”");
  });

  it("run a chart or map block in time order unless a sort was given, Title included", async () => {
    await ok("POST", "/collections", { name: "Log", fields: [{ name: "Title", kind: "string" }, { name: "Day", kind: "date" }] });
    for (const [Title, Day] of [["B", "2026-01-01"], ["A", "2026-03-01"], ["C", "2026-02-01"]] as const) await ok("POST", "/collections/Log/items", { values: { Title, Day } });
    await ok("POST", "/collections/Log/views", { name: "Charts", blocks: [{ kind: "chart", title: "Default" }, { kind: "chart", title: "Titled", sort: [{ fieldId: "Title", direction: "asc" }] }] });
    const titles = async (block: string) => (await ok("GET", `/collections/Log/views/Charts/items?block=${block}`)).items.map((i: { values: Record<string, string> }) => Object.values(i.values)[0]);
    expect(await titles("Default")).toEqual(["B", "C", "A"]);
    expect(await titles("Titled")).toEqual(["A", "B", "C"]);
  });

  it("have item views that are replaced as a list, with one default", async () => {
    expect((await ok("GET", "/collections/Book/item-views")).map((v: { name: string; isDefault: boolean }) => [v.name, v.isDefault])).toEqual([["Default", true]]);
    const views = await ok("PUT", "/collections/Book/item-views", [
      { name: "Compact", isDefault: true, layout: { fields: ["Title"], hiddenLabels: ["Title"], hideEmpty: true, editable: false } },
      { id: "wide", name: "Wide", isDefault: true, layout: { blocks: [{ id: "b1", kind: "table", title: "People", collectionId: "Person" }], fields: ["Title", "b1"], filters: [{ fieldId: "Name", operator: "is", value: "x" }] } },
    ]);
    const book = await ok("GET", "/collections/Book");
    expect(views.map((v: { name: string; isDefault: boolean }) => [v.name, v.isDefault])).toEqual([["Compact", true], ["Wide", false]]);
    expect(views[0].layout).toMatchObject({ fields: [book.fields[0].id], hiddenLabels: [book.fields[0].id], hideEmpty: true, editable: false });
    expect(views[1]).toMatchObject({ id: "wide" });
    expect(views[1].layout.fields).toEqual([book.fields[0].id, "b1"]);
    expect(views[1].layout.blocks).toHaveLength(1);
    expect(views[1].layout.filters).toHaveLength(1);
    // None marked default: the first one is.
    expect((await ok("PUT", "/collections/Book/item-views", [{ name: "One", layout: {} }, { name: "Two", layout: {} }])).map((v: { isDefault: boolean }) => v.isDefault)).toEqual([true, false]);
    expect(await refused(400, "PUT", "/collections/Book/item-views", [])).toBe("Send a list of at least one item view");
    expect(await refused(400, "PUT", "/collections/Book/item-views", { name: "x" })).toBe("Send a list of at least one item view");
    expect(await refused(400, "PUT", "/collections/Book/item-views", [{ layout: {} }])).toBe("`name` is required");
    expect(await refused(404, "PUT", "/collections/Book/item-views", [{ name: "x", layout: { fields: ["Nope"] } }])).toBe("Book has no field “Nope”");
    expect(await refused(404, "GET", "/collections/Nope/item-views")).toBe("No collection “Nope”");
  });
});

describe("dashboards", () => {
  beforeEach(async () => {
    await ok("POST", "/collections", { name: "Book", fields: [{ name: "Title", kind: "string" }, { name: "Read", kind: "date" }] });
    await ok("POST", "/collections", { name: "Person", fields: [{ name: "Title", kind: "string" }, { name: "Read", kind: "datetime" }] });
    await ok("POST", "/collections", { name: "Note", fields: [{ name: "Title", kind: "string" }] });
    await ok("POST", "/spaces", { name: "Work" });
  });

  it("are made in a space, shown only there unless told, changed and deleted with their tabs", async () => {
    const made = await ok("POST", "/dashboards", { name: "Home", icon: "Dashboard", description: "Mine" });
    expect(made).toMatchObject({ name: "Home", icon: "Dashboard", description: "Mine", spaces: ["default"], position: 0 });
    expect(names(await ok("GET", `/dashboards/${made.id}/views`))).toEqual(["Dashboard"]);
    const everywhere = await ok("POST", "/dashboards", { name: "All", space: "Work", spaces: null });
    expect(everywhere).toMatchObject({ spaces: null, position: 1 });
    expect(names(await ok("GET", "/dashboards"))).toEqual(["Home", "All"]);
    expect(names(await ok("GET", "/dashboards?space=work"))).toEqual(["All"]);
    expect(await ok("GET", "/dashboards/home")).toMatchObject({ id: made.id });
    expect(await ok("PATCH", "/dashboards/Home", { name: "Start", spaces: ["Work", "default"] })).toMatchObject({ name: "Start", icon: "Dashboard", spaces: [expect.any(String), "default"] });
    expect(names(await ok("GET", "/dashboards?space=work"))).toEqual(["Start", "All"]);
    expect(await ok("DELETE", "/dashboards/Start")).toEqual({ ok: true });
    expect(names(await ok("GET", "/dashboards"))).toEqual(["All"]);
  });

  it("refuse what a dashboard can't be", async () => {
    await ok("POST", "/dashboards", { name: "Home" });
    expect(await refused(400, "POST", "/dashboards", {})).toBe("`name` is required");
    expect(await refused(409, "POST", "/dashboards", { name: "home" })).toBe("There already is a dashboard “home”");
    expect(await refused(404, "POST", "/dashboards", { name: "X", space: "Nope" })).toBe("No space “Nope”");
    expect(await refused(400, "POST", "/dashboards", { name: "X", spaces: "Work" })).toBe("`spaces` must be a list of spaces (or null: every space)");
    expect(await refused(404, "GET", "/dashboards/Nope")).toBe("No dashboard “Nope”");
    expect(await refused(404, "PATCH", "/dashboards/Nope", {})).toBe("No dashboard “Nope”");
    expect(await refused(400, "PATCH", "/dashboards/Home", { name: "" })).toBe("`name` can't be empty");
    expect(await refused(404, "DELETE", "/dashboards/Nope")).toBe("No dashboard “Nope”");
  });

  it("have tabs per space: another space shows copies of the first space's, stored there once changed", async () => {
    const home = await ok("POST", "/dashboards", { name: "Home", spaces: null });
    const tab = await ok("POST", "/dashboards/Home/views", {
      name: "Reading",
      filters: [{ fieldId: "Date", operator: "between", value: "2026-01-01..2026-12-31" }, { fieldId: "Read", operator: "isNotEmpty", value: "" }],
      blocks: [{ kind: "table", title: "Books", collectionId: "Book", sort: [{ fieldId: "Title", direction: "desc" }] }, { kind: "cards", collectionIds: ["Book", "Person"], layout: { fields: ["Title"] } }],
      filterBar: true,
    });
    const book = await ok("GET", "/collections/Book");
    const person = await ok("GET", "/collections/Person");
    expect(tab).toMatchObject({ name: "Reading", dashboardId: home.id, spaceId: "default", position: 1, filterBar: true, editable: true });
    expect(tab.filters.map((r: { fieldId: string }) => r.fieldId)).toEqual(["$date", book.fields[1].id]);
    expect(tab.blocks[0]).toMatchObject({ collectionId: book.id, sort: [{ fieldId: book.fields[0].id, direction: "desc" }] });
    expect(tab.blocks[1]).toMatchObject({ collectionId: book.id, collectionIds: [book.id, person.id], layout: expect.objectContaining({ fields: ["merged:name:title"] }) });
    expect(tab.collapsed).toBeUndefined();
    // Work has no tabs of its own: it shows copies, which the first change there stores (all of them).
    const copies = await ok("GET", "/dashboards/Home/views?space=Work");
    expect(copies.map((v: { name: string; virtual?: boolean }) => [v.name, v.virtual])).toEqual([["Dashboard", true], ["Reading", true]]);
    const renamed = await ok("PATCH", "/dashboards/Home/views/Reading?space=Work", { name: "Work reading", filterBar: false });
    expect(renamed).toMatchObject({ name: "Work reading", spaceId: expect.not.stringMatching("default") });
    expect(renamed.filterBar).toBeUndefined();
    expect(renamed.virtual).toBeUndefined();
    expect(renamed.blocks).toEqual(tab.blocks);
    expect(names(await ok("GET", "/dashboards/Home/views?space=Work"))).toEqual(["Dashboard", "Work reading"]);
    expect(names(await ok("GET", "/dashboards/Home/views"))).toEqual(["Dashboard", "Reading"]);
    // Starred per space.
    const starred = await ok("PUT", "/dashboards/Home/default-view", { view: "Reading" });
    expect(starred.map((v: { name: string; isDefault: boolean }) => [v.name, v.isDefault])).toEqual([["Dashboard", false], ["Reading", true]]);
    expect((await ok("GET", "/dashboards/Home/views?space=Work")).every((v: { isDefault: boolean }) => !v.isDefault)).toBe(true);
    expect((await ok("PUT", "/dashboards/Home/default-view", { view: null })).every((v: { isDefault: boolean }) => !v.isDefault)).toBe(true);
    expect(await ok("DELETE", `/dashboards/Home/views/${tab.id}`)).toEqual({ ok: true });
    expect(names(await ok("GET", "/dashboards/Home/views"))).toEqual(["Dashboard"]);
    expect(await ok("DELETE", "/dashboards/Home/views/Work%20reading?space=Work")).toEqual({ ok: true });
    expect(names(await ok("GET", "/dashboards/Home/views?space=Work"))).toEqual(["Dashboard"]);
  });

  it("refuse what a tab or its blocks can't be", async () => {
    await ok("POST", "/dashboards", { name: "Home" });
    expect(await refused(400, "POST", "/dashboards/Home/views", {})).toBe("`name` is required");
    expect(await refused(409, "POST", "/dashboards/Home/views", { name: "T", space: "Work" })).toMatch(/Home isn't shown in Work/);
    expect(await refused(400, "POST", "/dashboards/Home/views", { name: "T", blocks: "x" })).toBe("`blocks` must be a list of blocks");
    expect(await refused(400, "POST", "/dashboards/Home/views", { name: "T", blocks: [{ kind: "table" }] })).toBe("A dashboard's block needs `collectionId` (a collection's id or name) or `collectionIds`");
    expect(await refused(404, "POST", "/dashboards/Home/views", { name: "T", blocks: [{ kind: "table", collectionIds: ["Book", "Nope"] }] })).toBe("No collection “Nope”");
    expect(await refused(404, "POST", "/dashboards/Home/views", { name: "T", blocks: [{ kind: "table", collectionId: "Book", groupBy: "Nope" }] })).toBe("Book has no field “Nope”");
    expect(await refused(404, "POST", "/dashboards/Home/views", { name: "T", blocks: [{ kind: "table", collectionId: "Book" }], filters: [{ fieldId: "Nope", operator: "is", value: "" }] })).toBe("Dashboard has no field “Nope”");
    expect(await refused(404, "PATCH", "/dashboards/Home/views/Nope", {})).toBe("Home has no tab “Nope”");
    expect(await refused(404, "DELETE", "/dashboards/Home/views/Nope")).toBe("Home has no tab “Nope”");
    expect(await refused(404, "PUT", "/dashboards/Home/default-view", { view: "Nope" })).toBe("Home has no tab “Nope”");
    expect(await refused(404, "GET", "/dashboards/Home/views/Nope/items")).toBe("Home has no tab “Nope”");
    expect(await refused(404, "GET", "/dashboards/Home/views/Dashboard/items")).toBe("The tab “Dashboard” has no blocks");
  });

  it("show a block's items through the tab's filter, its Date each block's own, several collections merged", async () => {
    await ok("POST", "/collections/Book/items", { values: { Title: "Dune", Read: "2026-02-01" } });
    await ok("POST", "/collections/Book/items", { values: { Title: "Emma", Read: "2025-02-01" } });
    await ok("POST", "/collections/Person/items", { values: { Title: "Ada", Read: "2026-05-01T10:00:00.000Z" } });
    await ok("POST", "/collections/Person/items", { values: { Title: "Bob", Read: "1990-05-01T10:00:00.000Z" } });
    await ok("POST", "/collections/Note/items", { values: { Title: "Undated" } });
    await ok("POST", "/dashboards", { name: "Home" });
    await ok("POST", "/dashboards/Home/views", {
      name: "This year",
      filters: [{ fieldId: "Date", operator: "between", value: "2026-01-01..2026-12-31" }],
      blocks: [
        { kind: "table", title: "Books", collectionId: "Book" },
        { kind: "table", title: "Notes", collectionId: "Note" },
        { kind: "table", title: "Both", collectionIds: ["Book", "Person"], sort: [{ fieldId: "Title", direction: "asc" }] },
      ],
    });
    const titles = async (block: string) => (await ok("GET", `/dashboards/Home/views/This%20year/items?block=${block}`)).items.map((i: { values: { Title: string } }) => i.values.Title);
    expect(await titles("Books")).toEqual(["Dune"]);
    expect(await titles("Notes")).toEqual(["Undated"]); // no date field: the period leaves it alone
    expect(await titles("Both")).toEqual(["Ada", "Dune"]); // each by its own date (merged by name: a date and a date & time)
    const first = await ok("GET", "/dashboards/Home/views/This%20year/items?limit=1");
    expect(first).toMatchObject({ view: { name: "This year" }, block: { title: "Books" }, total: 1, limit: 1 });
    expect(first.blocks.map((b: { title: string }) => b.title)).toEqual(["Books", "Notes", "Both"]);
    expect(await refused(404, "GET", "/dashboards/Home/views/This%20year/items?block=Nope")).toBe("The tab “This year” has no block “Nope”");
    await ok("DELETE", "/collections/Note");
    expect(await refused(409, "GET", "/dashboards/Home/views/This%20year/items?block=Notes")).toBe("A collection this block lists was deleted");
  });
});

describe("bookmarks", () => {
  let itemId: string;
  beforeEach(async () => {
    await ok("POST", "/collections", { name: "Book", fields: [{ name: "Title", kind: "string" }] });
    await ok("POST", "/spaces", { name: "Work" });
    itemId = (await ok("POST", "/collections/Book/items", { values: { Title: "Dune" } })).id;
  });

  it("are made for an item or a view, listed per space, renamed and removed", async () => {
    const item = await ok("POST", "/bookmarks", { kind: "item", target: itemId, label: "My book" });
    expect(item).toMatchObject({ kind: "item", targetId: itemId, label: "My book", position: 0 });
    const view = await ok("POST", "/bookmarks", { kind: "view", collection: "Book", target: "All" });
    expect(view).toMatchObject({ kind: "view", label: "Books / All", position: 1 });
    expect(await ok("GET", "/bookmarks")).toHaveLength(2);
    expect(await ok("GET", "/bookmarks?space=Work")).toEqual([]);
    expect(await ok("PATCH", `/bookmarks/${itemId}`, { label: "Renamed" })).toEqual({ ok: true });
    expect((await ok("GET", "/bookmarks"))[0].label).toBe("Renamed");
    expect(await ok("DELETE", `/bookmarks/${itemId}`)).toEqual({ ok: true });
    expect(await ok("DELETE", `/bookmarks/${view.targetId}?space=default`)).toEqual({ ok: true });
    expect(await ok("GET", "/bookmarks")).toEqual([]);
  });

  it("are made for a dashboard's tab, a copied one stored first, and go with their dashboard", async () => {
    await ok("POST", "/dashboards", { name: "Home", spaces: null });
    const mark = await ok("POST", "/bookmarks", { kind: "dashboard", dashboard: "Home", target: "Dashboard" });
    expect(mark).toMatchObject({ kind: "dashboard", collectionId: null, dashboardId: expect.any(String), label: "Home / Dashboard" });
    expect(await refused(409, "POST", "/bookmarks", { kind: "dashboard", dashboard: "Home", target: "Dashboard" })).toBe("Already bookmarked");
    // In Work the tab is a copy of the default space's: bookmarking it stores it there.
    const work = await ok("POST", "/bookmarks", { kind: "dashboard", dashboard: "Home", target: "Dashboard", space: "Work" });
    expect(work.targetId).not.toBe(mark.targetId);
    expect((await ok("GET", "/dashboards/Home/views?space=Work"))[0]).toMatchObject({ id: work.targetId });
    expect(await refused(400, "POST", "/bookmarks", { kind: "dashboard", target: "Dashboard" })).toBe("`dashboard` is required");
    expect(await refused(404, "POST", "/bookmarks", { kind: "dashboard", dashboard: "Home", target: "Nope" })).toBe("Home has no tab “Nope”");
    await ok("DELETE", "/dashboards/Home");
    expect(await ok("GET", "/bookmarks")).toEqual([]);
    expect(await ok("GET", "/bookmarks?space=Work")).toEqual([]);
  });

  it("are refused for what can't be bookmarked", async () => {
    await ok("POST", "/bookmarks", { kind: "item", target: itemId });
    expect(await refused(409, "POST", "/bookmarks", { kind: "item", target: itemId })).toBe("Already bookmarked");
    expect(await refused(409, "POST", "/bookmarks", { kind: "item", target: itemId, space: "Work" })).toBe("The item is in another space");
    expect(await refused(404, "POST", "/bookmarks", { kind: "item", target: "ghost" })).toBe("No item ghost");
    expect(await refused(400, "POST", "/bookmarks", { kind: "tab", target: itemId })).toBe("`kind` must be item, view or dashboard");
    expect(await refused(400, "POST", "/bookmarks", { kind: "item" })).toBe("`target` is required");
    expect(await refused(400, "POST", "/bookmarks", { kind: "view", target: "All" })).toBe("`collection` is required");
    expect(await refused(404, "POST", "/bookmarks", { kind: "view", collection: "Book", target: "Nope" })).toBe("Book has no view “Nope”");
    expect(await refused(404, "POST", "/bookmarks", { kind: "view", collection: "Nope", target: "All" })).toBe("No collection “Nope”");
    expect(await refused(400, "PATCH", `/bookmarks/${itemId}`, {})).toBe("`label` is required");
    expect(await refused(404, "GET", "/bookmarks?space=nope")).toMatch(/No space/);
  });
});

describe("components", () => {
  it("are made, listed with their code, read by name, changed and deleted", async () => {
    const made = await ok("POST", "/components", { name: " Badge ", code: "{{ $item.Title }}", description: "A badge", frameRatio: "4/3", output: "html" });
    expect(made).toMatchObject({ name: "Badge", description: "A badge", output: "html", frameRatio: "4/3", ai: false });
    const prompt = await ok("POST", "/components", { name: "Ask", code: "Rate {{ $item.Title }}", ai: true });
    expect(prompt).toMatchObject({ ai: true, output: "string" });
    expect((await ok("POST", "/components", { name: "Plain" })).code).toBe("");
    expect(names(await ok("GET", "/components"))).toEqual(["Ask", "Badge", "Plain"]);
    expect(await ok("GET", "/components/badge")).toMatchObject({ id: made.id });
    expect(await ok("GET", `/components/${made.id}`)).toMatchObject({ name: "Badge" });
    expect(await ok("PATCH", "/components/Badge", { description: null, frameRatio: null, name: "Pin" })).toMatchObject({ name: "Pin", description: "", frameRatio: null, code: "{{ $item.Title }}" });
    expect(await ok("DELETE", "/components/Ask")).toEqual({ ok: true });
    expect(names(await ok("GET", "/components"))).toEqual(["Pin", "Plain"]);
  });

  it("refuse what a component can't be", async () => {
    expect(await refused(400, "POST", "/components", { code: "x" })).toBe("`name` is required");
    expect(await refused(400, "POST", "/components", { name: " " })).toBe("`name` can't be empty");
    expect(await refused(400, "POST", "/components", { name: "X", output: "pdf" })).toBe("`output` must be markdown, string, number, image or html");
    expect(await refused(404, "GET", "/components/nope")).toBe("No component “nope”");
    expect(await refused(404, "PATCH", "/components/nope", {})).toBe("No component “nope”");
    expect(await refused(404, "DELETE", "/components/nope")).toBe("No component “nope”");
  });

  it("can't change what the fields showing them need", async () => {
    await ok("POST", "/components", { name: "Badge", code: "{{ $item.Title }}" });
    await ok("POST", "/collections", { name: "Book", fields: [{ name: "Title", kind: "string" }, { name: "Shown", kind: "component", component: "Badge" }] });
    expect(await refused(409, "PATCH", "/components/Badge", { ai: true, output: "string" })).toBe("Fields show this component: whether it asks AI can't change");
    expect(await refused(409, "PATCH", "/components/Badge", { code: "no item here" })).toMatch(/^Fields show this component: /);
    expect(await ok("PATCH", "/components/Badge", { code: "{{ $item.Title }}!" })).toMatchObject({ code: "{{ $item.Title }}!" });
    expect(await refused(409, "DELETE", "/components/Badge")).toMatch(/Still used by “Shown” of Book/);
    await ok("POST", "/collections", { name: "Solo", fields: [{ name: "Only", kind: "component", component: "Badge" }] });
    expect(await refused(409, "DELETE", "/components/Badge?withFields=true")).toMatch(/Solo would be left without fields/);
    await ok("DELETE", "/collections/Solo");
    expect(await ok("DELETE", "/components/Badge?withFields=true")).toEqual({ ok: true });
    expect(names((await ok("GET", "/collections/Book")).fields)).toEqual(["Title"]);
  });
});

describe("files", () => {
  const png = bytes("not really a png");

  it("take the bytes of an image of a known type, whatever its case or parameters", async () => {
    const stored = await call("POST", "/files", png, "Image/PNG; charset=binary");
    expect(stored.status).toBe(201);
    expect(stored.body.src).toBe(`files/${stored.body.id}`);
    expect((await call("POST", "/files", png, "image/svg+xml")).status).toBe(201);
    // The same content is the same file.
    expect((await call("POST", "/files", png, "image/webp")).body.id).toBe(stored.body.id);
  });

  it("refuse an empty body, another type, a missing type and a body beyond 20 MB", async () => {
    expect((await call("POST", "/files", new Uint8Array(), "image/png")).body.error).toBe("The body is empty");
    expect((await call("POST", "/files", png, "application/pdf")).status).toBe(415);
    expect((await call("POST", "/files", png, "")).status).toBe(415);
    expect((await call("POST", "/files", new Uint8Array(20 * 1024 * 1024 + 1), "image/png")).status).toBe(413);
  });
});

describe("remote collections", () => {
  it("can't have items made through the API: it answers 409, not an error of its own", async () => {
    const headless = await HeadlessDevice.start(options());
    const direct = createApi(headless.repo);
    const source = { name: "CRM", target: { table: { schema: null, name: "people" } }, key: "id", columns: [{ name: "id", type: "integer", kind: "number" as const }] };
    const draft = {
      id: "remote", name: "Person", pluralName: "People", icon: null, description: "", spaceIds: null, source,
      fields: [{ id: "f-id", name: "Id", kind: "number" as const, targetCollectionId: null, componentId: null, code: null, output: null, frameRatio: null, choiceFilter: [], toggleIcon: null, strikeThrough: false, column: "id" }],
    };
    await headless.repo.saveCollection(draft, "default");
    expect((await send(direct, "POST", "/collections/People/items", { values: { Id: 1 } })).status).toBe(409);
    expect((await send(direct, "GET", "/collections")).body.map((c: { name: string }) => c.name)).toEqual(["Person"]);
    // A dashboard block reading it (alone or merged) has no items in the API.
    await send(direct, "POST", "/collections", { name: "Book", fields: [{ name: "Title", kind: "string" }] });
    await send(direct, "POST", "/dashboards", { name: "Home" });
    await send(direct, "POST", "/dashboards/Home/views", { name: "T", blocks: [{ kind: "table", title: "Mixed", collectionIds: ["Book", "People"] }] });
    const answer = await send(direct, "GET", "/dashboards/Home/views/T/items");
    expect([answer.status, answer.body.error]).toEqual([400, "The block reads People, a remote collection: its rows aren't items in the API"]);
  });
});
