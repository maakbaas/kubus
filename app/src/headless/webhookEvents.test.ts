// @vitest-environment node
// The events a sync becomes (webhooks.ts `buildEvents`), from the rows it carried, and how the
// hooks deliver them: to several addresses, each in order, one failing without holding up the others.
import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WireChanges } from "../../../shared/sync";
import { newId, type Collection, type FieldDef } from "../domain/model";
import { device } from "../test/fakeServer";
import { buildEvents, signature, Webhooks, type WebhookPayload } from "./webhooks";

// Each test builds devices and a database: on a busy machine that outlasts the default 5 s.
vi.setConfig({ testTimeout: 30_000 });

type Repo = Awaited<ReturnType<typeof device>>;
let repo: Repo;
let book: Collection;
let known: Set<string>;

const field = (name: string): FieldDef => ({
  id: newId(), collectionId: "", name, kind: "string", targetCollectionId: null, componentId: null, code: null, output: null,
  frameRatio: null, choiceFilter: [], toggleIcon: null, strikeThrough: false, position: 0,
});

beforeEach(async () => {
  repo = await device({ connect: false });
  const id = newId();
  await repo.saveCollection({ id, name: "Book", pluralName: "Books", icon: null, description: "", spaceIds: null, fields: [field("Title")] }, "default");
  book = (await repo.listCollections()).find((c) => c.id === id)!;
  known = new Set();
});

const types = (events: { type: string }[]) => events.map((e) => e.type);

describe("buildEvents", () => {
  it("names each changed collection once, whether its row or its fields changed", async () => {
    const changes: WireChanges = {
      collections: [{ id: "c1" }, { id: "c1" }, { id: "c2" }],
      fields: [{ id: "f1", collection_id: "c2" }, { id: "f2", collection_id: "c3" }],
    };
    expect(await buildEvents(repo, changes, known)).toEqual([
      { type: "collection.changed", id: "c1" }, { type: "collection.changed", id: "c2" }, { type: "collection.changed", id: "c3" },
    ]);
  });

  it("reports spaces, components, bookmarks and views by id", async () => {
    const changes: WireChanges = {
      spaces: [{ id: "s" }], components: [{ id: "x" }], bookmarks: [{ id: "b" }], views: [{ id: "v", collection_id: "c" }],
    };
    expect(await buildEvents(repo, changes, known)).toEqual([
      { type: "view.changed", id: "v", collectionId: "c" }, { type: "space.changed", id: "s" }, { type: "component.changed", id: "x" }, { type: "bookmark.changed", id: "b" },
    ]);
  });

  it("makes an item created the first time it is seen, then updated, with the item as the API shows it", async () => {
    const id = await repo.createItem(book, { [book.fields[0].id]: "Dune" }, "default");
    const row = { id, collection_id: book.id, space_id: "default", deleted_at: null };
    const first = await buildEvents(repo, { items: [row] }, known);
    expect(first).toEqual([
      { type: "item.created", id, collection: "Book", collectionId: book.id, spaceId: "default", item: expect.objectContaining({ id, label: "Dune", values: { Title: "Dune" } }) },
    ]);
    expect(known.has(id)).toBe(true);
    const again = await buildEvents(repo, { items: [row] }, known);
    expect(types(again)).toEqual(["item.updated"]);
  });

  it("finds the item behind a changed value, and its collection", async () => {
    const id = await repo.createItem(book, { [book.fields[0].id]: "Dune" }, "default");
    known.add(id);
    const events = await buildEvents(repo, { field_values: [{ item_id: id, field_id: book.fields[0].id }, { item_id: id, field_id: "other" }] }, known);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "item.updated", id, collection: "Book", item: { values: { Title: "Dune" } } });
  });

  it("reports a deleted item with where it was, once", async () => {
    const id = await repo.createItem(book, { [book.fields[0].id]: "Dune" }, "default");
    await repo.deleteItem(id);
    const events = await buildEvents(repo, { items: [{ id, collection_id: book.id, space_id: "default", deleted_at: "2026-10-28T10:00:00.000Z" }] }, known);
    expect(events).toEqual([{ type: "item.deleted", id, collection: "Book", collectionId: book.id, spaceId: "default" }]);
  });

  it("finds the collection of a deleted item whose row didn't say, and of a value of a deleted item says nothing", async () => {
    const id = await repo.createItem(book, {}, "default");
    await repo.deleteItem(id);
    const events = await buildEvents(repo, { items: [{ id, deleted_at: "2026-10-28T10:00:00.000Z", space_id: "default" }] }, known);
    expect(events).toEqual([{ type: "item.deleted", id, collection: "Book", collectionId: book.id, spaceId: "default" }]);
    expect(await buildEvents(repo, { field_values: [{ item_id: id, field_id: book.fields[0].id }] }, new Set())).toEqual([]);
  });

  it("leaves out items whose collection is gone, and items nobody knows", async () => {
    expect(await buildEvents(repo, { items: [{ id: "i1", collection_id: "gone", space_id: "default", deleted_at: null }] }, known)).toEqual([]);
    expect(await buildEvents(repo, { field_values: [{ item_id: "ghost", field_id: "f" }] }, known)).toEqual([]);
  });

  it("computes the items of each collection and space together, in the order of the rows", async () => {
    await repo.saveSpace({ id: "work", name: "Work", icon: null });
    const a = await repo.createItem(book, { [book.fields[0].id]: "A" }, "default");
    const b = await repo.createItem(book, { [book.fields[0].id]: "B" }, "work");
    const events = await buildEvents(
      repo,
      { items: [{ id: b, collection_id: book.id }, { id: a, collection_id: book.id }] },
      known,
    );
    expect(events.map((e) => [e.id, (e as { spaceId: string }).spaceId])).toEqual([[b, "work"], [a, "default"]]);
  });
});

describe("signature", () => {
  it("is sha256= and the HMAC of the body, in hex", () => {
    expect(signature("body", "k1")).toBe(`sha256=${createHmac("sha256", "k1").update("body").digest("hex")}`);
    expect(signature("", "k1")).toBe(`sha256=${createHmac("sha256", "k1").update("").digest("hex")}`);
    expect(signature("body", "k1")).not.toBe(signature("body", "k2"));
    expect(signature("body", "k1")).not.toBe(signature("Body", "k1"));
    expect(signature("body", "k1")).toBe(signature("body", "k1"));
  });
});

describe("Webhooks delivery", () => {
  const A = "https://a.test/hook";
  const B = "https://b.test/hook";
  let calls: { url: string; body: WebhookPayload; headers: Headers }[];
  let down: Set<string>;
  const payload = (cursor: number): WebhookPayload => ({ database: "d", cursor, events: [{ type: "space.changed", id: "s" }] });

  beforeEach(() => {
    calls = [];
    down = new Set();
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)), headers: new Headers(init.headers) });
      return new Response(null, { status: down.has(url) ? 500 : 200 });
    });
  });

  it("sends nothing and listens to nothing without addresses", async () => {
    const hooks = new Webhooks(repo, { urls: [], secret: null }, () => {});
    const listen = vi.spyOn(repo.sync, "onPulled");
    hooks.attach();
    expect(listen).not.toHaveBeenCalled();
    hooks.send(payload(1));
    await hooks.idle();
    expect(calls).toEqual([]);
  });

  it("posts the same JSON to every address, each in order, one failing without holding up the other", async () => {
    const logged: string[] = [];
    down.add(A);
    const hooks = new Webhooks(repo, { urls: [A, B], secret: "s3" }, (m) => void logged.push(m), async () => {});
    hooks.send(payload(1));
    hooks.send(payload(2));
    await hooks.idle();
    expect(calls.filter((c) => c.url === B).map((c) => c.body.cursor)).toEqual([1, 2]);
    expect(calls.filter((c) => c.url === A)).toHaveLength(8); // 4 tries for each of the 2 deliveries
    expect(logged).toHaveLength(2);
    expect(logged[0]).toMatch(new RegExp(`Webhook to ${A} dropped after 4 tries: HTTP 500`));
    const call = calls.find((c) => c.url === B)!;
    expect(call.headers.get("Content-Type")).toBe("application/json");
    expect(call.headers.get("User-Agent")).toBe("Kubus");
    expect(call.headers.get("X-Kubus-Signature")).toBe(signature(JSON.stringify(payload(1)), "s3"));
  });

  it("sends no signature without a secret, and counts a network error as a failed try", async () => {
    const logged: string[] = [];
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("connection refused");
    });
    const hooks = new Webhooks(repo, { urls: [A], secret: null }, (m) => void logged.push(m), async () => {});
    hooks.send(payload(1));
    await hooks.idle();
    expect(logged).toEqual([`Webhook to ${A} dropped after 4 tries: connection refused`]);
  });

  it("remembers the items of a first download without telling anybody, then reports changes with the rows sent too", async () => {
    const hooks = new Webhooks(repo, { urls: [A], secret: null }, () => {});
    hooks.attach();
    const id = await repo.createItem(book, { [book.fields[0].id]: "Dune" }, "default");
    const handle = (pulled: object) => (hooks as unknown as { handle(p: object): void }).handle(pulled);
    handle({ initial: true, changes: { items: [{ id }] }, pushed: {}, cursor: 1, database: "d" });
    await hooks.idle();
    expect(calls).toEqual([]);
    // A later sync: the item is known (updated, not created); a space this device pushed is reported too.
    handle({ initial: false, changes: { items: [{ id, collection_id: book.id }] }, pushed: { spaces: [{ id: "s" }] }, cursor: 2, database: "d" });
    await hooks.idle();
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toMatchObject({ database: "d", cursor: 2 });
    expect(types(calls[0].body.events)).toEqual(["space.changed", "item.updated"]);
  });

  it("logs a failure to build events, and goes on with the next sync", async () => {
    const logged: string[] = [];
    const hooks = new Webhooks(repo, { urls: [A], secret: null }, (m) => void logged.push(m));
    const handle = (pulled: object) => (hooks as unknown as { handle(p: object): void }).handle(pulled);
    handle({ initial: false, changes: { items: [{ id: "x", collection_id: "c" }] }, pushed: null, cursor: 1, database: "d" }); // pushed missing: breaks
    await hooks.idle();
    expect(logged[0]).toMatch(/^Webhook events failed: /);
    handle({ initial: false, changes: { spaces: [{ id: "s" }] }, pushed: {}, cursor: 2, database: "d" });
    await hooks.idle();
    expect(calls.map((c) => c.body.cursor)).toEqual([2]);
  });

  it("reports nothing for a sync that changed nothing", async () => {
    const hooks = new Webhooks(repo, { urls: [A], secret: null }, () => {});
    const handle = (pulled: object) => (hooks as unknown as { handle(p: object): void }).handle(pulled);
    handle({ initial: false, changes: {}, pushed: {}, cursor: 3, database: "d" });
    await hooks.idle();
    expect(calls).toEqual([]);
  });
});
