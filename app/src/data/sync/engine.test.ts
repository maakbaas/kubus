// @vitest-environment node
// The sync engine's own behaviour (SyncEngine.ts) against FakeServer: its settings, status and errors,
// when it syncs (debounce, concurrent requests, the server's change signal), disconnecting and pausing,
// and how it handles files that can't be uploaded or fetched. Merging is in merge.test.ts, first
// connections in connect.test.ts, files and thumbnails in files.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newId, type Collection, type FieldDef } from "../../domain/model";
import { openTestClient } from "../../test/engine";
import { bytes, device as makeDevice, FakeServer, SERVER_URL, settled, TOKEN } from "../../test/fakeServer";
import { SqliteRepository } from "../sqlite/SqliteRepository";
import { memoryEnvironment } from "./environment";

// Each test builds devices and a database: on a busy machine that outlasts the default 5 s.
vi.setConfig({ testTimeout: 30_000 });

let server: FakeServer;
type Repo = Awaited<ReturnType<typeof makeDevice>>;

// Every device listens for the server's change signal until it is paused: stop them after each test,
// or they go on (and retry) against the next test's server.
const repos: Repo[] = [];
const device: typeof makeDevice = async (options) => {
  const repo = await makeDevice(options);
  repos.push(repo);
  return repo;
};
const openDevice = async (env: ReturnType<typeof memoryEnvironment>) => {
  const repo = await SqliteRepository.open(await openTestClient(), env);
  repos.push(repo);
  return repo;
};

beforeEach(() => {
  server = new FakeServer().install();
});
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(repos.splice(0).map((r) => r.sync.pause().catch(() => {})));
  vi.unstubAllGlobals();
});

const field = (name: string, kind: FieldDef["kind"] = "string"): FieldDef => ({
  id: newId(), collectionId: "", name, kind, targetCollectionId: null, componentId: null, code: null, output: null,
  frameRatio: null, choiceFilter: [], toggleIcon: null, strikeThrough: false, position: 0,
});

async function notes(repo: Repo, ...kinds: FieldDef["kind"][]): Promise<Collection> {
  const id = newId();
  await repo.saveCollection({ id, name: "Note", pluralName: "Notes", icon: null, description: "", spaceIds: null, fields: [field("Title"), ...kinds.map((k) => field(k, k))] }, "default");
  return (await repo.listCollections()).find((c) => c.id === id)!;
}

const syncs = () => server.log.filter((l) => l === "POST /api/sync").length;
/** Routes some paths elsewhere; the rest goes to the server. */
function route(handlers: Record<string, (init: RequestInit) => Response | Promise<Response>>) {
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const request = `${init.method ?? "GET"} ${url.slice(SERVER_URL.length)}`;
    const handler = handlers[request];
    if (!handler) return server.fetch(url, init);
    server.log.push(request);
    return handler(init);
  });
}
const settings = { url: SERVER_URL, token: TOKEN, enabled: true, originals: "always" as const };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("settings", () => {
  it("are tidied, saved per device, and restored when the device opens again", async () => {
    const env = memoryEnvironment();
    const first = await openDevice(env);
    await first.sync.configure({ url: ` ${SERVER_URL}/// `, token: TOKEN, enabled: true, originals: "opened" });
    expect(first.sync.config).toEqual({ url: SERVER_URL, token: TOKEN, enabled: true, originals: "opened" });
    expect(JSON.parse(env.storage.get("kubus.sync")!)).toEqual(first.sync.config);
    await first.sync.configure({ ...settings, originals: "everything" as never });
    expect(first.sync.config.originals).toBe("always");

    const again = await openDevice(env);
    expect(again.sync.config).toEqual(first.sync.config);
    await again.sync.idle();
  });

  it("start from nothing where nothing usable was saved", async () => {
    for (const saved of ["{nope", "null", ""]) {
      const env = memoryEnvironment();
      if (saved) env.storage.set("kubus.sync", saved);
      const repo = await openDevice(env);
      expect(repo.sync.config).toEqual({ url: "", token: "", enabled: false, originals: "always" });
      expect(repo.sync.status).toEqual({ state: "off", lastSync: null, error: null, replaced: null });
    }
  });

  it("fill in what a partial saved setting lacks", async () => {
    const env = memoryEnvironment();
    env.storage.set("kubus.sync", JSON.stringify({ enabled: true, originals: "opened" }));
    const repo = await openDevice(env);
    expect(repo.sync.config).toEqual({ url: "", token: "", enabled: true, originals: "opened" });
    expect(syncs()).toBe(0); // enabled but no server: nothing to sync with
  });

  it("do nothing when sync is off or incomplete", async () => {
    const repo = await device({ connect: false });
    await repo.sync.syncNow();
    expect(repo.sync.status.state).toBe("off");
    await repo.sync.configure({ url: SERVER_URL, token: "", enabled: true, originals: "always" });
    await repo.sync.configure({ url: SERVER_URL, token: TOKEN, enabled: false, originals: "always" });
    expect(server.log).toEqual([]);
  });

  it("say whether connecting to an address would replace the device's data", async () => {
    const repo = await device({ connect: false });
    expect(repo.sync.isNewServer(SERVER_URL)).toBe(true);
    await repo.sync.configure(settings);
    await settled(repo);
    expect(repo.sync.isNewServer(SERVER_URL)).toBe(false);
    expect(repo.sync.isNewServer(` ${SERVER_URL}/ `)).toBe(false);
    expect(repo.sync.isNewServer("https://other.test")).toBe(true);
  });
});

describe("status", () => {
  it("is idle with the time of the last sync after a good one, and tells its listeners", async () => {
    const repo = await device({ connect: false });
    const seen: string[] = [];
    const stop = repo.sync.subscribe(() => seen.push(repo.sync.status.state));
    await repo.sync.configure(settings);
    await settled(repo);
    expect(repo.sync.status.state).toBe("idle");
    expect(Date.parse(repo.sync.status.lastSync!)).not.toBeNaN();
    expect(seen).toContain("syncing");
    stop();
    const count = seen.length;
    await repo.sync.syncNow();
    expect(seen).toHaveLength(count);
  });

  it("says why a sync failed, and recovers with the next", async () => {
    const repo = await device();
    route({ "POST /api/sync": () => new Response(null, { status: 500 }) });
    await repo.sync.syncNow();
    expect(repo.sync.status).toMatchObject({ state: "error", error: "Server error 500" });
    route({ "POST /api/sync": () => {
      throw new TypeError("offline");
    } });
    await repo.sync.syncNow();
    expect(repo.sync.status.error).toBe(`Cannot reach ${SERVER_URL}`);
    server.install();
    await repo.sync.syncNow();
    expect(repo.sync.status).toMatchObject({ state: "idle", error: null });
  });

  it("says when the server doesn't accept the token", async () => {
    const repo = await device({ connect: false });
    await repo.sync.configure({ ...settings, token: "wrong" });
    expect(repo.sync.status).toMatchObject({ state: "error", error: "The server did not accept the token" });
  });

  it("says when the app and the server are of versions that can't sync", async () => {
    const repo = await device();
    server.compatible = 99;
    await repo.sync.syncNow();
    expect(repo.sync.status).toMatchObject({ state: "error", error: "Update the app" });
    server.compatible = 1;
    server.version = 0;
    await repo.sync.syncNow();
    expect(repo.sync.status.error).toBe("Update the server");
  });
});

describe("when it syncs", () => {
  it("runs a request that comes while one is running once more afterwards, not once per request", async () => {
    const repo = await device();
    server.log.length = 0;
    await Promise.all([repo.sync.syncNow(), repo.sync.syncNow(), repo.sync.syncNow()]);
    expect(syncs()).toBe(2);
  });

  it("sends a local change shortly after it, once for changes close together, and not for what it just received", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const a = await device();
    const n = await notes(a);
    server.log.length = 0;
    await vi.advanceTimersByTimeAsync(1900);
    expect(syncs()).toBe(0);
    await a.createItem(n, {}, "default");
    await a.createItem(n, {}, "default");
    await vi.advanceTimersByTimeAsync(1999);
    expect(syncs()).toBe(0);
    await vi.advanceTimersByTimeAsync(2);
    await a.sync.idle();
    expect(syncs()).toBe(1);
    expect(server.rows("items")).toHaveLength(2);
    // What arrives from the server is no local change: no sync follows it.
    const b = await device();
    await b.sync.syncNow();
    server.log.length = 0;
    await vi.advanceTimersByTimeAsync(5000);
    expect(syncs()).toBe(0);
  });

  it("waits no longer than a sync when a sync is already due", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const a = await device();
    const n = await notes(a);
    await a.createItem(n, {}, "default");
    await a.sync.syncNow(); // sends it now: the pending debounced sync finds nothing and is dropped
    server.log.length = 0;
    await vi.advanceTimersByTimeAsync(3000);
    expect(syncs()).toBe(0);
  });

  it("polls every 30 seconds", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const a = await device();
    server.log.length = 0;
    await vi.advanceTimersByTimeAsync(30_000);
    await a.sync.idle();
    expect(syncs()).toBeGreaterThanOrEqual(1);
  });

  it("syncs when the environment says so (the device came online)", async () => {
    let wake = () => {};
    const env = { ...memoryEnvironment(), watch: (sync: () => void) => void (wake = sync) };
    const repo = await openDevice(env);
    await repo.sync.configure(settings);
    await settled(repo);
    server.log.length = 0;
    wake();
    await vi.waitFor(() => expect(syncs()).toBe(1), { timeout: 20_000 });
  });

  it("catches up only when the server has news: not when the device already has its latest write", async () => {
    const a = await device();
    const n = await notes(a);
    await a.createItem(n, {}, "default");
    await settled(a);
    server.log.length = 0;
    await a.sync.catchUp(server.seq);
    expect(syncs()).toBe(0);
    await a.sync.catchUp(server.seq + 5); // the server is ahead
    expect(syncs()).toBe(1);
    await a.sync.catchUp(0); // 0: since a wipe, always sync
    expect(syncs()).toBe(2);
  });

  it("catches up after an error even when the cursor matches", async () => {
    const a = await device();
    route({ "POST /api/sync": () => new Response(null, { status: 503 }) });
    await a.sync.syncNow();
    server.install();
    server.log.length = 0;
    await a.sync.catchUp(server.seq || 1);
    expect(syncs()).toBe(1);
    expect(a.sync.status.state).toBe("idle");
  });
});

describe("the server's change signal", () => {
  /** An /api/events stream the test writes to. */
  function stream() {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const response = () => new Response(new ReadableStream<Uint8Array>({ start: (c) => void (controller = c) }));
    const send = (text: string) => controller.enqueue(new TextEncoder().encode(text));
    return { response, send, end: () => controller.close() };
  }

  it("makes the device sync when the server has a write it doesn't have, also one split across reads", async () => {
    const events = stream();
    route({ "GET /api/events": events.response });
    const a = await device();
    await vi.waitFor(() => expect(server.log).toContain("GET /api/events"), { timeout: 20_000 });
    server.log.length = 0;
    events.send("data: 99\n");
    await vi.waitFor(() => expect(syncs()).toBe(1), { timeout: 20_000 });
    events.send("da");
    events.send("ta: 100\n: a comment\n\nid: 7\n");
    await vi.waitFor(() => expect(syncs()).toBe(2), { timeout: 20_000 });
    expect(a.sync.status.state).toBe("idle");
  });

  it("is ignored for a write the device has already (its own push), and always followed after a wipe (0)", async () => {
    const events = stream();
    route({ "GET /api/events": events.response });
    const a = await device();
    const n = await notes(a);
    await a.createItem(n, {}, "default");
    await settled(a);
    await vi.waitFor(() => expect(server.log).toContain("GET /api/events"), { timeout: 20_000 });
    server.log.length = 0;
    events.send(`data: ${server.seq}\n`);
    await sleep(50);
    expect(syncs()).toBe(0);
    events.send("data: 0\n");
    await vi.waitFor(() => expect(syncs()).toBe(1), { timeout: 20_000 });
    events.send("data: nonsense\n"); // not a number: treated as a wipe
    await vi.waitFor(() => expect(syncs()).toBe(2), { timeout: 20_000 });
  });

  it("is listened to again after a failure, waiting longer each time", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    route({ "GET /api/events": () => new Response(null, { status: 502 }) });
    await device();
    const attempts = () => server.log.filter((l) => l === "GET /api/events").length;
    await vi.advanceTimersByTimeAsync(0);
    expect(attempts()).toBe(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(attempts()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(attempts()).toBe(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(attempts()).toBe(3);
    await vi.advanceTimersByTimeAsync(4000);
    expect(attempts()).toBe(4);
  });

  it("is listened to again when the stream ends, and closed when syncing is paused", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const events = stream();
    route({ "GET /api/events": events.response });
    const a = await device();
    const attempts = () => server.log.filter((l) => l === "GET /api/events").length;
    await vi.advanceTimersByTimeAsync(0);
    expect(attempts()).toBe(1);
    events.end();
    await vi.advanceTimersByTimeAsync(600);
    expect(attempts()).toBe(2);
    await a.sync.pause();
    const before = attempts();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(attempts()).toBe(before);
  });
});

describe("leaving a server", () => {
  it("pauses, keeping the address and token, so switching on again is a first connection", async () => {
    const a = await device();
    const n = await notes(a);
    await a.createItem(n, {}, "default");
    await settled(a);
    await a.sync.pause();
    expect(a.sync.config).toEqual({ ...settings, enabled: false });
    expect(a.sync.status).toMatchObject({ state: "off", error: null });
    expect(a.sync.isNewServer(SERVER_URL)).toBe(true);
    server.log.length = 0;
    await a.sync.syncNow();
    expect(server.log).toEqual([]);
    await a.sync.configure({ ...settings });
    await settled(a);
    expect(a.sync.status.state).toBe("idle");
    expect((await a.listCollections()).map((c) => c.id)).toEqual([n.id]); // the server's data came back
  });

  it("disconnects, forgetting the server and what was queued for it, keeping the data", async () => {
    const a = await device();
    const n = await notes(a);
    await settled(a);
    await a.createItem(n, {}, "default"); // queued, not sent
    await a.sync.disconnect();
    expect(a.sync.config).toEqual({ url: "", token: "", enabled: false, originals: "always" });
    expect(a.sync.status).toEqual({ state: "off", lastSync: null, error: null, replaced: null });
    expect((await a.listItems(n, "default"))).toHaveLength(1);
    // Connecting again to an empty server uploads everything, the item queued earlier included.
    server.wipe();
    await a.sync.configure(settings);
    await settled(a);
    expect(server.rows("items")).toHaveLength(1);
  });

  it("wipes the server's data, then pauses; a refusal is an error and leaves sync on", async () => {
    const a = await device();
    const n = await notes(a);
    await settled(a);
    route({ "POST /api/wipe": () => new Response(null, { status: 403 }) });
    await expect(a.sync.wipeServer()).rejects.toThrow("Server error 403");
    expect(a.sync.config.enabled).toBe(true);
    route({ "POST /api/wipe": (init) => {
      expect(JSON.parse(String(init.body))).toEqual({ confirm: "wipe" });
      server.wipe();
      return Response.json({ ok: true });
    } });
    await a.sync.wipeServer();
    expect(a.sync.config.enabled).toBe(false);
    expect(server.rows("collections")).toEqual([]);
    expect((await a.listCollections()).map((c) => c.id)).toEqual([n.id]); // this device keeps its data
    await a.sync.configure(settings);
    await settled(a);
    expect(server.rows("collections")).toHaveLength(1); // and uploads it
  });

  it("stops at a replaced server database, remembers that across a restart, and syncs again when told to", async () => {
    const env = memoryEnvironment();
    const first = await openDevice(env);
    await first.sync.configure(settings);
    await settled(first);
    server.wipe();
    await first.sync.syncNow();
    expect(first.sync.status.replaced).toEqual({ createdAt: server.database.createdAt, empty: true });
    expect(first.sync.config).toMatchObject({ url: SERVER_URL, token: TOKEN, enabled: false });
    expect(JSON.parse(env.storage.get("kubus.syncReplaced")!)).toEqual({ createdAt: server.database.createdAt, empty: true });

    const restarted = await openDevice(env);
    expect(restarted.sync.status.replaced).toEqual({ createdAt: server.database.createdAt, empty: true });
    server.log.length = 0;
    await restarted.sync.syncNow();
    expect(syncs()).toBe(0); // paused until the user answers
    await restarted.sync.reconnect();
    expect(restarted.sync.status).toMatchObject({ state: "idle", replaced: null });
    expect(env.storage.get("kubus.syncReplaced")).toBeNull();
  });

  it("forgets a stored 'replaced' note that isn't one", async () => {
    const env = memoryEnvironment();
    for (const bad of ["{nope", JSON.stringify({ createdAt: 5 }), "null"]) {
      env.storage.set("kubus.syncReplaced", bad);
      const repo = await openDevice(env);
      expect(repo.sync.status.replaced).toBeNull();
    }
  });
});

describe("files the engine can't move", () => {
  const photos = async (repo: Repo) => {
    const c = await notes(repo, "image");
    return { c, image: c.fields[1] };
  };

  it("doesn't upload a file the server already has: only its row goes", async () => {
    const a = await device();
    const { c, image } = await photos(a);
    const file = await a.putFile(bytes("already there"), "image/png");
    server.files.set(file, { mime: "image/png", data: bytes("already there") });
    await a.createItem(c, { [image.id]: file }, "default");
    server.log.length = 0;
    await settled(a);
    expect(server.log).toContain(`HEAD /api/files/${file}`);
    expect(server.log).not.toContain(`PUT /api/files/${file}`);
    expect(server.rows("files").map((r) => r.id)).toEqual([file]);
  });

  it("holds back a file the server refuses (too large or wrong), without blocking the rest, and warns", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const a = await device();
    const { c, image } = await photos(a);
    const file = await a.putFile(bytes("refused"), "image/png");
    server.failures.set(`PUT ${file}`, 413);
    const item = await a.createItem(c, { [image.id]: file }, "default");
    await settled(a);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`The server refused file ${file} (413)`));
    expect(server.rows("files")).toEqual([]);
    expect(server.rows("items").map((r) => r.id)).toContain(item);
    // Not queued again: the refusal is final until the file changes.
    server.log.length = 0;
    await settled(a);
    expect(server.log).not.toContain(`PUT /api/files/${file}`);
    warn.mockRestore();
  });

  it("holds back the row of a file nobody can serve (listed by the server, which lost the bytes)", async () => {
    const a = await device({ keepFiles: false });
    const { c, image } = await photos(a);
    const file = await a.putFile(bytes("gone"), "image/png");
    await a.createItem(c, { [image.id]: file }, "default");
    await settled(a);
    expect(server.files.has(file)).toBe(true); // uploaded; the headless-style device let go of the bytes
    // The server loses the file; the device has no bytes to send again.
    server.files.clear();
    await (a as unknown as { db: { write(s: unknown[]): Promise<void> } }).db.write([{ sql: "INSERT INTO sync_outbox (tbl, pk) VALUES ('files', ?1)", bind: [file] }]);
    server.log.length = 0;
    await a.sync.syncNow();
    expect(server.log).toContain(`HEAD /api/files/${file}`);
    expect(server.log).not.toContain(`PUT /api/files/${file}`);
    expect(a.sync.status.state).toBe("idle");
  });

  it("waits with the files after one the server failed on, and goes on right away when uploads work", async () => {
    const a = await device();
    const { c, image } = await photos(a);
    const first = await a.putFile(bytes("one"), "image/png");
    const second = await a.putFile(bytes("two"), "image/png");
    await a.createItem(c, { [image.id]: first }, "default");
    await a.createItem(c, { [image.id]: second }, "default");
    server.failures.set(`PUT ${first}`, 503);
    server.failures.set(`PUT ${second}`, 503);
    await a.sync.syncNow();
    expect(server.rows("files")).toEqual([]);
    expect(a.sync.status.state).toBe("idle"); // a failing upload is not a failing sync
    server.failures.clear();
    await settled(a);
    expect(server.rows("files").map((r) => r.id).sort()).toEqual([first, second].sort());
  });

  it("answers null for a file when sync is off, the server lacks it or can't be reached", async () => {
    const off = await device({ connect: false });
    expect(await off.getFile("f".repeat(64))).toBeNull();
    const a = await device();
    expect(await a.getFile("a".repeat(64))).toBeNull(); // 404
    route({ [`GET /api/files/${"b".repeat(64)}`]: () => new Response(null, { status: 500 }) });
    expect(await a.getFile("b".repeat(64))).toBeNull();
    route({ [`GET /api/files/${"c".repeat(64)}`]: () => {
      throw new TypeError("offline");
    } });
    expect(await a.getFile("c".repeat(64))).toBeNull();
  });

  it("fetches a file once for several askers, keeps it, and gives a missing type the generic one", async () => {
    const a = await device();
    const other = await device();
    const { c, image } = await photos(other);
    const file = await other.putFile(bytes("shared bytes"), "image/png");
    await other.createItem(c, { [image.id]: file }, "default");
    await settled(other);
    // The server hands the bytes out without a type.
    route({ [`GET /api/files/${file}`]: () => new Response(bytes("shared bytes")) });
    server.log.length = 0;
    const [x, y] = await Promise.all([a.sync.fetchFile(file), a.sync.fetchFile(file)]);
    expect(x).toBe(y);
    expect(x).toEqual({ data: bytes("shared bytes"), mime: "application/octet-stream" });
    expect(server.log.filter((l) => l.startsWith("GET /api/files"))).toHaveLength(1);
  });

  it("deletes the server's copies of long unused files, as many as the server lets go of before it can't be reached", async () => {
    const a = await device();
    const { c, image } = await photos(a);
    const ids: string[] = [];
    for (const t of ["x", "y", "z"]) {
      const id = await a.putFile(bytes(t), "image/png");
      server.files.set(id, { mime: "image/png", data: bytes(t) });
      ids.push(id);
      await a.createItem(c, { [image.id]: id }, "default");
    }
    expect(await a.sync.deleteFromServer(ids)).toEqual(ids);
    expect(server.files.size).toBe(0);
    let calls = 0;
    route({ [`DELETE /api/files/${ids[1]}`]: () => {
      calls++;
      throw new TypeError("offline");
    } });
    server.files.set(ids[0], { mime: "image/png", data: bytes("x") });
    expect(await a.sync.deleteFromServer(ids)).toEqual([ids[0]]); // stops at the first it can't reach
    expect(calls).toBe(1);
  });

  it("leaves deciding which files go to the apps where it keeps no files or doesn't sync", async () => {
    const off = await device({ connect: false });
    expect(await off.sync.deleteFromServer(["a", "b"])).toEqual(["a", "b"]);
    const cache = await device({ keepFiles: false });
    server.log.length = 0;
    expect(await cache.sync.deleteFromServer(["a", "b"])).toEqual(["a", "b"]);
    expect(server.log).toEqual([]);
  });

  it("releases a file the server says is gone, and forgets a file of this device's that no item uses", async () => {
    const a = await device();
    const { c, image } = await photos(a);
    const file = await a.putFile(bytes("lost"), "image/png");
    const item = await a.createItem(c, { [image.id]: file }, "default");
    await settled(a);
    await a.deleteItem(item);
    server.files.delete(file);
    expect(await a.sync.fetchFile(file)).toBeNull(); // 404 from the server marks it unused here
    const rows = await (a as unknown as { db: { select<R>(q: string, b: unknown[]): Promise<R[]> } }).db.select<{ unused_since: string | null }>("SELECT unused_since FROM files WHERE id = ?1", [file]);
    expect(rows[0].unused_since).not.toBeNull();
  });
});
