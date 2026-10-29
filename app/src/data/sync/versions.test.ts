// @vitest-environment node
// The strict version gate (shared/sync.ts SYNC_VERSION, docs/migrations.md): a device and a server
// sync only when their versions are equal. A refused device keeps working offline with its outbox
// untouched, says which side to update, and syncs what it queued once the versions match.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { device, FakeServer, SERVER_URL, settled, TOKEN } from "../../test/fakeServer";
import { openTestClient } from "../../test/engine";
import { SYNC_OUTDATED } from "../repository";
import { SqliteRepository } from "../sqlite/SqliteRepository";
import { memoryEnvironment } from "./environment";
import { SYNC_VERSION } from "../../../../shared/sync";

let server: FakeServer;
beforeEach(() => {
  server = new FakeServer().install();
});
afterEach(() => {
  vi.doUnmock("../../../../shared/sync");
  vi.resetModules();
});

const spaceNames = () => server.rows("spaces").map((r) => r.name);
const settings = { url: SERVER_URL, token: TOKEN, enabled: true, originals: "always" } as const;

/** A device that keeps hold of its database and settings, to open it again (a reload, or another build). */
async function reopenable() {
  const client = await openTestClient();
  const env = memoryEnvironment();
  const repo = await SqliteRepository.open(client, env);
  await repo.sync.configure(settings);
  await settled(repo);
  return { client, env, repo };
}
const queued = (client: Awaited<ReturnType<typeof openTestClient>>) =>
  client.select<{ n: number }>("SELECT count(*) AS n FROM sync_outbox").then((r) => r[0].n);

describe("the strict version gate", () => {
  it("refuses a device older than the server: update this device, its changes stay queued, and they go once the versions match", async () => {
    const repo = await device();
    server.version = SYNC_VERSION + 1;
    await repo.saveSpace({ id: "work", name: "Work", icon: null });
    await settled(repo);
    expect(repo.sync.status).toMatchObject({ state: "error", error: null, outdated: "app" });
    expect(SYNC_OUTDATED.app).toBe("Update Kubus to keep syncing");
    expect(spaceNames()).toEqual([]);
    expect((await repo.listSpaces()).map((s) => s.name)).toContain("Work"); // still works, offline
    server.version = SYNC_VERSION; // this device was updated (or the server went back)
    await settled(repo);
    expect(repo.sync.status).toMatchObject({ state: "idle", outdated: null });
    expect(spaceNames()).toEqual(["Work"]);
  });

  it("refuses a device newer than the server: the server needs updating", async () => {
    const repo = await device();
    server.version = SYNC_VERSION - 1;
    await repo.saveSpace({ id: "work", name: "Work", icon: null });
    await settled(repo);
    expect(repo.sync.status).toMatchObject({ state: "error", error: null, outdated: "server" });
    expect(SYNC_OUTDATED.server).toBe("The server needs updating");
    expect(spaceNames()).toEqual([]);
    server.version = SYNC_VERSION;
    await settled(repo);
    expect(repo.sync.status.outdated).toBeNull();
    expect(spaceNames()).toEqual(["Work"]);
  });

  it("keeps the whole outbox while refused (nothing is dropped or marked as sent), however often it tries", async () => {
    const { client, repo } = await reopenable();
    server.version = SYNC_VERSION + 1;
    await repo.saveSpace({ id: "a", name: "A", icon: null });
    await repo.saveSpace({ id: "b", name: "B", icon: null });
    const before = await client.select("SELECT tbl, pk FROM sync_outbox ORDER BY id");
    expect(before.length).toBeGreaterThan(0);
    for (let i = 0; i < 3; i++) await repo.sync.syncNow();
    expect(await client.select("SELECT tbl, pk FROM sync_outbox ORDER BY id")).toEqual(before);
    expect(server.rows("spaces")).toEqual([]);
  });

  it("is still refused after a reload with the same build, and syncs after the other side is updated", async () => {
    const { client, env, repo } = await reopenable();
    server.version = SYNC_VERSION + 1;
    await repo.saveSpace({ id: "work", name: "Work", icon: null });
    await repo.sync.syncNow();
    expect(repo.sync.status.outdated).toBe("app");
    // Reload: the same database and settings, a new engine, which tries right away.
    const again = await SqliteRepository.open(client, env);
    await again.sync.idle();
    expect(again.sync.status).toMatchObject({ state: "error", outdated: "app" });
    expect(await queued(client)).toBeGreaterThan(0);
    server.version = SYNC_VERSION;
    await settled(again);
    expect(again.sync.status).toMatchObject({ state: "idle", outdated: null });
    expect(await queued(client)).toBe(0);
    expect(spaceNames()).toEqual(["Work"]);
  });

  it("syncs the queued changes when the device is updated to the server's version (the same database opened by the new build)", async () => {
    const { client, env, repo } = await reopenable();
    server.version = SYNC_VERSION + 1; // the server was updated first
    await repo.saveSpace({ id: "work", name: "Work", icon: null });
    await repo.sync.syncNow();
    expect(repo.sync.status.outdated).toBe("app");
    expect(spaceNames()).toEqual([]);
    // The new build: the same code with the next SYNC_VERSION, opening the old build's database.
    vi.resetModules();
    vi.doMock("../../../../shared/sync", async (original) => ({ ...(await original<typeof import("../../../../shared/sync")>()), SYNC_VERSION: SYNC_VERSION + 1 }));
    const { SqliteRepository: Updated } = await import("../sqlite/SqliteRepository");
    const updated = await Updated.open(client, env);
    for (let i = 0; i < 3; i++) {
      await updated.sync.syncNow();
      await updated.sync.idle();
    }
    expect(updated.sync.status).toMatchObject({ state: "idle", outdated: null });
    expect(spaceNames()).toEqual(["Work"]);
    expect(await queued(client)).toBe(0);
  });

  it("refuses a first connection too, touching nothing on the device", async () => {
    server.version = SYNC_VERSION + 1;
    const repo = await device({ connect: false });
    await repo.saveSpace({ id: "mine", name: "Mine", icon: null });
    await repo.sync.configure(settings);
    expect(repo.sync.status).toMatchObject({ state: "error", outdated: "app" });
    expect(repo.sync.isNewServer(SERVER_URL)).toBe(true); // not connected: nothing replaced or uploaded
    expect((await repo.listSpaces()).map((s) => s.name)).toContain("Mine");
    server.version = SYNC_VERSION;
    await settled(repo);
    expect(repo.sync.status.outdated).toBeNull();
    expect(spaceNames()).toEqual(["Mine"]); // an empty server takes this device's data
  });

  it("checks the version a server answers with too, applying nothing from another one", async () => {
    const repo = await device();
    server.extra = () => ({ version: SYNC_VERSION - 1 });
    await repo.saveSpace({ id: "work", name: "Work", icon: null });
    await repo.sync.syncNow();
    expect(repo.sync.status).toMatchObject({ state: "error", outdated: "server" });
    server.extra = () => ({ version: SYNC_VERSION + 1 });
    await repo.sync.syncNow();
    expect(repo.sync.status).toMatchObject({ state: "error", outdated: "app" });
    server.extra = () => ({});
    await settled(repo);
    expect(repo.sync.status.outdated).toBeNull();
  });

  it("tells a server of another version before connecting (the test of its address)", async () => {
    const repo = await device({ connect: false });
    await expect(repo.sync.testServer(SERVER_URL, TOKEN)).resolves.toBeUndefined();
    server.version = SYNC_VERSION + 1;
    await expect(repo.sync.testServer(SERVER_URL, TOKEN)).rejects.toThrow(SYNC_OUTDATED.app);
    server.version = SYNC_VERSION - 1;
    await expect(repo.sync.testServer(SERVER_URL, TOKEN)).rejects.toThrow(SYNC_OUTDATED.server);
  });

  it("clears the notice when sync is switched off", async () => {
    const repo = await device();
    server.version = SYNC_VERSION + 1;
    await repo.sync.syncNow();
    expect(repo.sync.status.outdated).toBe("app");
    await repo.sync.pause();
    expect(repo.sync.status).toMatchObject({ state: "off", outdated: null });
  });
});
