// @vitest-environment node
// The headless device (index.ts): starting, syncing around each request, and failing the way the
// server expects (503 when it can't sync, anything else is the server's 500 to answer).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HeadlessOptions } from "../../../shared/api";
import { SqliteRepository } from "../data/sqlite/SqliteRepository";
import { SYNC_COMPATIBLE, SYNC_VERSION } from "../../../shared/sync";
import { FakeServer, SERVER_URL, TOKEN } from "../test/fakeServer";
import { HeadlessDevice, startHeadless } from "./index";

// Each test builds devices and a database: on a busy machine that outlasts the default 5 s.
vi.setConfig({ testTimeout: 30_000 });

let server: FakeServer;
let logged: string[];
let calls: number;

const options = (over: Partial<HeadlessOptions> = {}): HeadlessOptions => ({
  serverUrl: SERVER_URL, token: TOKEN, cursor: () => server.seq, webhooks: { urls: [], secret: null }, log: (m) => void logged.push(m), ...over,
});

beforeEach(() => {
  server = new FakeServer().install();
  logged = [];
  calls = 0;
});
afterEach(() => vi.restoreAllMocks());

const get = (api: Awaited<ReturnType<typeof startHeadless>>, path: string, method = "GET", body?: unknown) => {
  const url = new URL(`http://localhost/api/v1${path}`);
  const data = new TextEncoder().encode(body === undefined ? "" : JSON.stringify(body));
  return api.handle({ method, path: url.pathname, query: url.searchParams, headers: {}, body: async () => data });
};

describe("starting", () => {
  it("fails with 503 and the reason when the server can't be synced with", async () => {
    server.compatible = 99;
    await expect(startHeadless(options())).rejects.toMatchObject({ status: 503, message: "The server's headless device can't sync: Update the app" });
  });

  it("fails with 503 when the server can't be reached or refuses the token", async () => {
    await expect(startHeadless(options({ token: "wrong" }))).rejects.toMatchObject({ status: 503, message: expect.stringContaining("did not accept the token") });
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("down");
    });
    await expect(startHeadless(options())).rejects.toMatchObject({ status: 503, message: expect.stringContaining("Cannot reach") });
  });

  it("downloads what the server holds, but not the bytes of files", async () => {
    const first = await startHeadless(options());
    await get(first, "/spaces", "POST", { name: "Work" });
    const second = await HeadlessDevice.start(options());
    expect((await second.repo.listSpaces()).map((s) => s.name)).toEqual(["Space", "Work"]);
    expect(second.repo.storage.persistent).toBe(false);
  });
});

describe("a request", () => {
  it("is answered on the latest data: a read first asks the server only when it has news", async () => {
    const api = await startHeadless(options());
    await get(api, "/spaces", "POST", { name: "Home" }); // the server has a write now (an empty one has none, and is always asked)
    server.log.length = 0;
    await get(api, "/spaces");
    expect(server.log.filter((l) => l === "POST /api/sync")).toHaveLength(0);
    server.sync({ since: 0, changes: { spaces: [{ id: "elsewhere", name: "Elsewhere", icon: null, position: 3, created_at: "2026-10-28T10:00:00.000Z", updated_at: "2026-10-28T10:00:00.000Z", deleted_at: null }] }, version: 1, compatible: 1 });
    expect((await get(api, "/spaces")).json).toEqual(expect.arrayContaining([expect.objectContaining({ id: "elsewhere" })]));
  });

  it("is answered 503 when the server stops answering, and again normally once it does", async () => {
    const api = await startHeadless(options());
    const real = server.fetch;
    let down = true;
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      if (down) throw new TypeError("down");
      return real(url, init);
    });
    server.seq += 1; // news the device can't fetch
    const refused = await get(api, "/spaces");
    expect(refused.status).toBe(503);
    expect((refused.json as { error: string }).error).toMatch(/can't sync: Cannot reach/);
    down = false;
    expect((await get(api, "/spaces")).status).toBe(200);
  });

  it("is answered 503 when a write can't be sent on, though it was made here", async () => {
    const api = await startHeadless(options());
    const real = server.fetch;
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      if (url.endsWith("/api/sync") && calls++ >= 1) throw new TypeError("down");
      return real(url, init);
    });
    const answer = await get(api, "/spaces", "POST", { name: "Work" });
    expect(answer.status).toBe(503);
  });

  it("rejects, for the server to answer 500, with an error that isn't an HTTP one", async () => {
    const api = await startHeadless(options());
    vi.spyOn(SqliteRepository.prototype, "listSpaces").mockRejectedValueOnce(new Error("database broke"));
    await expect(get(api, "/spaces")).rejects.toThrow("database broke");
    expect((await get(api, "/spaces")).status).toBe(200); // the next one is served
  });

  it("does not run a write when the request is refused, and sends no sync for it", async () => {
    const api = await startHeadless(options());
    await get(api, "/spaces", "POST", { name: "Home" });
    server.log.length = 0;
    expect((await get(api, "/spaces", "POST", { name: "" })).status).toBe(400);
    expect(server.log.filter((l) => l === "POST /api/sync")).toHaveLength(0);
  });
});

describe("serial", () => {
  it("runs tasks one at a time in order, and goes on after a task fails", async () => {
    const device = await HeadlessDevice.start(options());
    const order: string[] = [];
    const slow = device.serial(async () => {
      await new Promise((r) => setTimeout(r, 30));
      order.push("slow");
      return 1;
    });
    const failing = device.serial(async () => {
      order.push("failing");
      throw new Error("no");
    });
    const last = device.serial(async () => {
      order.push("last");
      return 3;
    });
    await expect(failing).rejects.toThrow("no");
    expect([await slow, await last]).toEqual([1, 3]);
    expect(order).toEqual(["slow", "failing", "last"]);
  });
});

describe("a replaced server database", () => {
  it("makes the device start over with what the server holds now, and say so", async () => {
    const api = await startHeadless(options());
    await get(api, "/spaces", "POST", { name: "Old" });
    server.wipe();
    const spaces = (await get(api, "/spaces")).json as { name: string }[];
    expect(spaces.map((s) => s.name)).toEqual(["Space"]);
    expect(logged).toEqual(["The server's database was replaced: the headless device starts over"]);
  });

  it("notices a replaced database although the new one has had fewer writes than this device's cursor", async () => {
    const api = await startHeadless(options());
    for (const name of ["A", "B", "C", "D", "E"]) await get(api, "/spaces", "POST", { name });
    const before = server.seq;
    expect(before).toBeGreaterThanOrEqual(5);
    // The wipe restarts the server's counter; another device then makes two writes. No /api/events signal reaches the device.
    server.wipe();
    const row = (id: string, name: string) => ({ id, name, icon: null, position: 1, created_at: "2026-10-28T10:00:00.000Z", updated_at: "2026-10-28T10:00:00.000Z", deleted_at: null });
    server.sync({ since: 0, changes: { spaces: [row("n1", "New 1"), row("n2", "New 2")] }, version: SYNC_VERSION, compatible: SYNC_COMPATIBLE });
    expect(server.seq).toBeGreaterThan(0);
    expect(server.seq).toBeLessThan(before);
    const names = ((await get(api, "/spaces")).json as { name: string }[]).map((s) => s.name);
    expect(names).toEqual(expect.arrayContaining(["New 1", "New 2"]));
    expect(names).not.toContain("A");
    expect(logged).toEqual(["The server's database was replaced: the headless device starts over"]);
  });
});
