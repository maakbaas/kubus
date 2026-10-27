// @vitest-environment node
import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HeadlessOptions } from "../../../shared/api";
import { device, FakeServer, SERVER_URL, settled, TOKEN } from "../test/fakeServer";
import { HeadlessDevice, startHeadless } from "./index";
import { Webhooks, type WebhookPayload } from "./webhooks";

const HOOK = "https://hooks.test/kubus";
const SECRET = "shh";

let server: FakeServer;
let received: { body: WebhookPayload; signature: string | null }[];
/** Answers for the next webhook requests (then 200). */
let failures: number[];

beforeEach(() => {
  server = new FakeServer();
  received = [];
  failures = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    if (!url.startsWith(HOOK)) return server.fetch(url, init);
    const status = failures.shift() ?? 200;
    if (status === 200) received.push({ body: JSON.parse(String(init.body)), signature: new Headers(init.headers).get("X-Kubus-Signature") });
    return new Response(null, { status });
  });
});

const options = (): HeadlessOptions => ({
  serverUrl: SERVER_URL,
  token: TOKEN,
  cursor: () => server.seq,
  files: { marked: async () => [], unmark: async () => {}, delete: async () => [] },
  unusedFileDays: 7,
  cleanUpEveryMs: 60 * 60 * 1000,
  webhooks: { urls: [HOOK], secret: SECRET },
  log: () => {},
});

async function call(api: Awaited<ReturnType<typeof startHeadless>>, method: string, path: string, body?: unknown) {
  const url = new URL(`http://localhost/api/v1${path}`);
  const data = new TextEncoder().encode(body === undefined ? "" : JSON.stringify(body));
  return (await api.handle({ method, path: url.pathname, query: url.searchParams, headers: {}, body: async () => data })).json as any;
}

const types = () => received.flatMap((r) => r.body.events.map((e) => e.type));

describe("webhooks", () => {
  it("send what the API changes, signed, with the item as the API shows it", async () => {
    const headless = await HeadlessDevice.start(options());
    const api = await startHeadless({ ...options(), webhooks: { urls: [], secret: null } }); // a second device, without hooks
    // The watched device syncs after each change (changes one sync brings come as one: an item
    // created and deleted in between is only deleted).
    const step = async (work: Promise<unknown>) => {
      const result = await work;
      await settled(headless.repo);
      return result;
    };
    await step(call(api, "POST", "/collections", { name: "Book", fields: [{ name: "Title", kind: "string" }] }));
    const item = (await step(call(api, "POST", "/collections/Book/items", { values: { Title: "Dune" } }))) as { id: string };
    await step(call(api, "PATCH", `/items/${item.id}`, { values: { Title: "Dune!" } }));
    await step(call(api, "DELETE", `/items/${item.id}`));
    await headless.webhooks.idle();

    // A new collection comes with its "All" view.
    expect(types()).toEqual(["collection.changed", "view.changed", "item.created", "item.updated", "item.deleted"]);
    const created = received[1].body.events[0];
    expect(created).toMatchObject({ type: "item.created", id: item.id, collection: "Book", item: { values: { Title: "Dune" } } });
    const raw = JSON.stringify(received[1].body);
    expect(received[1].signature).toBe(`sha256=${createHmac("sha256", SECRET).update(raw).digest("hex")}`);
    expect(received[1].body.database).toBe(server.database.id);
  });

  it("send what the watched device's own API changes (the server doesn't send its rows back)", async () => {
    const api = await startHeadless(options());
    await call(api, "POST", "/collections", { name: "Book", fields: [{ name: "Title", kind: "string" }] });
    const item = (await call(api, "POST", "/collections/Book/items", { values: { Title: "Dune" } })) as { id: string };
    await vi.waitFor(() => expect(types()).toContain("item.created"));
    expect(received.flatMap((r) => r.body.events).find((e) => e.type === "item.created")).toMatchObject({ id: item.id, item: { values: { Title: "Dune" } } });
  });

  it("send what other devices change, but not the first download", async () => {
    const phone = await device();
    await phone.saveCollection(
      { id: "c1", name: "Note", pluralName: "Notes", icon: null, description: "", spaceIds: null, fields: [{ id: "f1", name: "Text", kind: "string", targetCollectionId: null, componentId: null, componentArgs: {}, choiceFilter: [], toggleIcon: null, strikeThrough: false, aiPrompt: null, aiOutput: null }] },
      "default",
    );
    const [collection] = await phone.listCollections();
    await phone.createItem(collection, { f1: "before" }, "default");
    await settled(phone);

    const headless = await HeadlessDevice.start(options());
    await headless.webhooks.idle();
    expect(received).toEqual([]); // what was there before isn't news

    await phone.createItem(collection, { f1: "after" }, "default");
    await settled(phone);
    await settled(headless.repo);
    await headless.webhooks.idle();
    expect(types()).toEqual(["item.created"]);
    expect(received[0].body.events[0]).toMatchObject({ item: { values: { Text: "after" } } });
  });

  it("retry a failed delivery, then drop it", async () => {
    const waits: number[] = [];
    const logged: string[] = [];
    const repo = (await device({ connect: false }));
    const hooks = new Webhooks(repo, { urls: [HOOK], secret: null }, (m) => void logged.push(m), async (ms) => void waits.push(ms));
    failures = [500, 503];
    hooks.send({ database: "d", cursor: 1, events: [{ type: "space.changed", id: "s" }] });
    await hooks.idle();
    expect(received).toHaveLength(1);
    expect(waits).toEqual([1000, 5000]);

    failures = [500, 500, 500, 500];
    hooks.send({ database: "d", cursor: 2, events: [{ type: "space.changed", id: "s" }] });
    await hooks.idle();
    expect(received).toHaveLength(1);
    expect(logged[0]).toMatch(/dropped after 4 tries/);
  });
});
