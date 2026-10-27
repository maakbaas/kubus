// @vitest-environment node
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import type { Headless, HeadlessOptions } from "../../../shared/api";
import type { ApiResponse } from "../../../shared/router";
import { bytes, device, FakeServer, SERVER_URL, settled, TOKEN } from "../test/fakeServer";
import { startHeadless } from "./index";

let server: FakeServer;
let api: Headless;

const options = (): HeadlessOptions => ({
  serverUrl: SERVER_URL,
  token: TOKEN,
  files: { marked: async () => [], unmark: async () => {}, delete: async () => [] },
  unusedFileDays: 7,
  cleanUpEveryMs: 60 * 60 * 1000,
  webhooks: { urls: [], secret: null },
  log: () => {},
});

beforeEach(async () => {
  server = new FakeServer().install();
  api = await startHeadless(options());
});

/** A request to /api/v1; `body` is sent as JSON unless it is bytes. */
async function call(method: string, path: string, body?: unknown, type = "application/json"): Promise<ApiResponse & { body: any }> {
  const url = new URL(`http://localhost/api/v1${path}`);
  const data = body === undefined ? new Uint8Array() : body instanceof Uint8Array ? body : new TextEncoder().encode(JSON.stringify(body));
  const answer = await api.handle({
    method,
    path: url.pathname,
    query: url.searchParams,
    headers: { "content-type": type },
    body: async () => data,
  });
  return { ...answer, body: answer.json };
}

const books = {
  name: "Book",
  fields: [
    { name: "Title", kind: "string" },
    { name: "Pages", kind: "number" },
    { name: "Read", kind: "checkbox" },
    { name: "Cover", kind: "image" },
    { name: "Sequel", kind: "item", targetCollection: "Book" },
    { name: "Tasks", kind: "checklist" },
  ],
};

describe("the HTTP API", () => {
  it("creates a collection and items by field name, and every device sees them", async () => {
    const created = await call("POST", "/collections", books);
    expect(created.status).toBe(201);
    expect(created.body.pluralName).toBe("Books");
    expect(created.body.fields.map((f: { name: string }) => f.name)).toEqual(["Title", "Pages", "Read", "Cover", "Sequel", "Tasks"]);
    expect(created.body.fields[4].targetCollectionId).toBe(created.body.id);

    const first = await call("POST", "/collections/books/items", { values: { title: "Dune", pages: 412, Tasks: [{ text: "Buy", done: true }, "[ ] Read"] } });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ collection: "Book", label: "Dune", spaceId: "default" });
    expect(first.body.values).toMatchObject({ Title: "Dune", Pages: 412, Read: null, Tasks: ["[x] Buy", "[ ] Read"] });
    const second = await call("POST", "/collections/Book/items", { values: { Title: "Dune Messiah", Sequel: null } });
    const linked = await call("PATCH", `/items/${first.body.id}`, { values: { Sequel: second.body.id } });
    expect(linked.body.values).toMatchObject({ Title: "Dune", Sequel: second.body.id });

    // Synced before the answer: a device connecting now has them.
    const other = await device();
    const collection = (await other.listCollections()).find((c) => c.name === "Book")!;
    expect((await other.listItems(collection, "default")).map((i) => i.id).sort()).toEqual([first.body.id, second.body.id].sort());

    const list = await call("GET", "/collections/Books/items?limit=1");
    expect(list.body).toMatchObject({ total: 2, limit: 1, offset: 0 });
    expect(list.body.items).toHaveLength(1);
  });

  it("checks values against their field's kind, and names what is unknown", async () => {
    await call("POST", "/collections", books);
    expect((await call("POST", "/collections/Book/items", { values: { Pages: "many" } })).status).toBe(400);
    expect((await call("POST", "/collections/Book/items", { values: { Sequel: "nope" } })).body.error).toMatch(/no such item/);
    expect((await call("POST", "/collections/Book/items", { values: { Author: "x" } })).status).toBe(404);
    expect((await call("GET", "/collections/Films/items")).status).toBe(404);
    expect((await call("GET", "/items/unknown")).status).toBe(404);
    expect((await call("GET", "/nothing")).status).toBe(404);
    expect((await call("DELETE", "/spaces")).status).toBe(405);
  });

  it("includes computed values, and refuses to write them", async () => {
    const component = await call("POST", "/components", { name: "Twice", code: "{{ $n * 2 }}", output: "number" });
    expect(component.status).toBe(201);
    await call("POST", "/collections", { name: "Thing", fields: [{ name: "Name", kind: "string" }, { name: "N", kind: "number" }] });
    const withField = await call("POST", "/collections/Thing/fields", { name: "Double", kind: "component", component: "twice", componentArgs: { n: { field: "N" } } });
    expect(withField.status).toBe(201);
    const item = await call("POST", "/collections/Thing/items", { values: { Name: "a", N: 21 } });
    expect(item.body.values.Double).toBe(42);
    expect((await call("PATCH", `/items/${item.body.id}`, { values: { Double: 1 } })).body.error).toMatch(/computed/);
  });

  it("runs component code apart from the server, with a time limit", async () => {
    await call("POST", "/components", { name: "Env", code: "{{ typeof process }}", output: "string" });
    await call("POST", "/components", { name: "Forever", code: "{{ (() => { for (;;) {} })() }}", output: "string" });
    await call("POST", "/collections", {
      name: "Probe",
      fields: [{ name: "Name", kind: "string" }, { name: "Env", kind: "component", component: "Env" }, { name: "Loop", kind: "component", component: "Forever" }],
    });
    const item = await call("POST", "/collections/Probe/items", { values: { Name: "p" } });
    expect(item.body.values.Env).toBe("undefined");
    expect(item.body.values.Loop).toMatch(/longer than/);
  });

  it("edits fields as the collection editor does", async () => {
    await call("POST", "/collections", books);
    const renamed = await call("PATCH", "/collections/Book/fields/Pages", { name: "Page count" });
    expect(renamed.body.fields.map((f: { name: string }) => f.name)).toContain("Page count");
    expect((await call("PATCH", "/collections/Book/fields/Title", { kind: "number" })).status).toBe(400);
    const ordered = await call("PUT", "/collections/Book/fields/order", ["Read", "Title"]);
    expect(ordered.body.fields.slice(0, 2).map((f: { name: string }) => f.name)).toEqual(["Read", "Title"]);
    const removed = await call("DELETE", "/collections/Book/fields/Read");
    expect(removed.body.fields.map((f: { name: string }) => f.name)).not.toContain("Read");
    expect((await call("POST", "/collections/Book/fields", { name: "title", kind: "string" })).status).toBe(400); // taken
  });

  it("stores files, for image fields", async () => {
    await call("POST", "/collections", books);
    const png = bytes("not really a png, but bytes");
    const file = await call("POST", "/files", png, "image/png");
    expect(file.status).toBe(201);
    expect(file.body.id).toBe(createHash("sha256").update(png).digest("hex"));
    expect(server.files.get(file.body.id)?.data).toEqual(png); // uploaded before the answer
    const item = await call("POST", "/collections/Book/items", { values: { Title: "Pictured", Cover: file.body.id } });
    expect(item.body.values.Cover).toBe(file.body.id);
    expect((await call("POST", "/files", png, "text/plain")).status).toBe(415);
  });

  it("saves views with fields named, and sets the default", async () => {
    await call("POST", "/collections", books);
    const view = await call("POST", "/collections/Book/views", {
      name: "Unread",
      filters: [{ fieldId: "Read", operator: "is_false", value: "" }],
      blocks: [{ kind: "table", sort: [{ fieldId: "Title", direction: "asc" }], layout: { fields: ["Title", "Pages"] } }],
    });
    expect(view.status).toBe(201);
    const collection = (await call("GET", "/collections/Book")).body;
    const id = (name: string) => collection.fields.find((f: { name: string }) => f.name === name).id;
    expect(view.body.blocks[0].layout.fields).toEqual([id("Title"), id("Pages")]);
    expect(view.body.filters[0].fieldId).toBe(id("Read"));
    const views = await call("PUT", "/collections/Book/default-view", { view: "unread" });
    expect(views.body.find((v: { name: string }) => v.name === "Unread").isDefault).toBe(true);
    expect((await call("DELETE", "/collections/Book/views/Unread")).status).toBe(200);
  });

  it("writes AI values with the fingerprint of the prompt as it reads now", async () => {
    await call("POST", "/collections", {
      name: "Note",
      fields: [{ name: "Text", kind: "string" }, { name: "Summary", kind: "ai", aiPrompt: "Summarize {{ $item.Text }}" }],
    });
    const note = await call("POST", "/collections/Note/items", { values: { Text: "long" } });
    const written = await call("PUT", `/items/${note.body.id}/ai/Summary`, { value: "short" });
    expect(written.status).toBe(200);
    expect(written.body.values.Summary).toBe("short");
  });

  it("moves items, searches, bookmarks, and manages spaces", async () => {
    await call("POST", "/collections", books);
    const work = await call("POST", "/spaces", { name: "Work" });
    expect(work.status).toBe(201);
    const item = await call("POST", "/collections/Book/items", { values: { Title: "Findable" } });
    expect((await call("GET", "/search?q=findable")).body.map((i: { id: string }) => i.id)).toEqual([item.body.id]);
    const moved = await call("POST", `/items/${item.body.id}/move`, { space: "work" });
    expect(moved.body.spaceId).toBe(work.body.id);
    expect((await call("GET", "/search?q=findable")).body).toEqual([]);
    const bookmark = await call("POST", "/bookmarks", { kind: "item", target: item.body.id, space: "Work" });
    expect(bookmark.body).toMatchObject({ label: "Findable", targetId: item.body.id });
    expect((await call("GET", "/bookmarks?space=Work")).body).toHaveLength(1);
    expect((await call("DELETE", `/items/${item.body.id}`)).status).toBe(200);
    expect((await call("GET", `/items/${item.body.id}`)).status).toBe(404);
  });

  it("starts over when the server's database is replaced", async () => {
    await call("POST", "/collections", books);
    server.wipe();
    const after = await call("GET", "/collections");
    expect(after.status).toBe(200);
    expect(after.body).toEqual([]);
  });
});

describe("the headless device's file clean-up", () => {
  it("deletes only the marked files no live item uses", async () => {
    const asked: string[][] = [];
    const deleted: string[][] = [];
    let marked: string[] = [];
    const local = await startHeadless({
      ...options(),
      files: {
        marked: async () => marked,
        unmark: async (ids) => void asked.push(ids),
        delete: async (ids) => (deleted.push(ids), ids),
      },
    });
    api = local;
    await call("POST", "/collections", books);
    const used = (await call("POST", "/files", bytes("used"), "image/png")).body.id;
    const unused = (await call("POST", "/files", bytes("unused"), "image/png")).body.id;
    await call("POST", "/collections/Book/items", { values: { Title: "x", Cover: used } });
    marked = [used, unused];
    // The clean-up runs at start and hourly; run it now through a second device sharing the server.
    const { HeadlessDevice } = await import("./index");
    const cleaner = await HeadlessDevice.start({ ...options(), files: { marked: async () => marked, unmark: async (ids) => void asked.push(ids), delete: async (ids) => (deleted.push(ids), ids) } });
    await settled(cleaner.repo);
    expect(await cleaner.cleanUpFiles()).toEqual([unused]);
    expect(asked.at(-1)).toEqual([used]);
  });
});
