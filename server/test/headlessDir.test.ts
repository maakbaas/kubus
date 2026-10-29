// @vitest-environment node
// The headless device with KUBUS_HEADLESS_DIR set, in the real server (a child process) on a
// database of its own: a restart resumes from disk instead of downloading everything, a server
// wiped while it was down makes it start over, and one directory serves one server process.
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADMIN, createDatabase, dropDatabase } from "./postgres.ts";
import { freePort, HEADLESS_BUILT, request, startServer, type RunningServer } from "./serve.ts";

const DB = "kubus_headless_dir_test";

describe.skipIf(!ADMIN || !HEADLESS_BUILT)("the headless device with a data directory", () => {
  let databaseUrl: string;
  let dir: string;
  let port: string;
  const running: RunningServer[] = [];

  /** Starts a server (the same address each time, as the image has) and waits until /api/v1 is up. */
  const start = async (env: Record<string, string> = {}, ready = true) => {
    const server = await startServer(databaseUrl, { PORT: port, ...env });
    running.push(server);
    if (ready) await waitFor(() => /API ready at/.test(server.output()), server);
    return server;
  };
  const stop = async (server: RunningServer) => {
    await server.stop();
    running.splice(running.indexOf(server), 1);
  };
  const waitFor = async (cond: () => boolean, server: RunningServer) => {
    for (let i = 0; i < 300 && !cond(); i++) await new Promise((r) => setTimeout(r, 50));
    if (!cond()) throw new Error(`timed out:\n${server.output()}`);
  };
  const spaces = async (server: RunningServer) => ((await (await request(server, "/api/v1/spaces")).json()) as { name: string }[]).map((s) => s.name);

  beforeAll(async () => {
    databaseUrl = await createDatabase(DB);
    port = String(await freePort());
  }, 30_000);
  afterAll(async () => {
    await Promise.all(running.map((s) => s.stop()));
    await dropDatabase(DB);
  });
  const fresh = () => (dir = join(mkdtempSync(join(tmpdir(), "kubus-headless-dir-")), "data"));
  const cleanup = () => rmSync(join(dir, ".."), { recursive: true, force: true });

  it("resumes after a restart: the saved database, a sync from its cursor, the data at once", async () => {
    fresh();
    try {
      const first = await start({ KUBUS_HEADLESS_DIR: dir });
      expect(first.output()).toMatch(/Nothing saved in .* yet: the first sync downloads everything/);
      expect((await request(first, "/api/v1/spaces", { method: "POST", json: { name: "Kept on disk" } })).status).toBeLessThan(300);
      await stop(first); // SIGTERM: the device saves before the process exits
      expect(readdirSync(dir).sort()).toEqual(["headless.db"]); // saved, and the lock given up

      const second = await start({ KUBUS_HEADLESS_DIR: dir });
      expect(second.output()).toMatch(/Resuming from .*: the saved database holds the server's data up to write \d+/);
      expect(second.output()).not.toMatch(/downloads everything/);
      expect(await spaces(second)).toContain("Kept on disk"); // answered straight away, not 503
      await stop(second);
    } finally {
      cleanup();
    }
  }, 60_000);

  it("starts over when the server was wiped while it was down", async () => {
    fresh();
    try {
      const first = await start({ KUBUS_HEADLESS_DIR: dir });
      await request(first, "/api/v1/spaces", { method: "POST", json: { name: "Before the wipe" } });
      await stop(first);

      const other = await start(); // without a directory: wipes the server's database
      expect((await request(other, "/api/wipe", { method: "POST", json: { confirm: "wipe" } })).status).toBe(200);
      await stop(other);

      const second = await start({ KUBUS_HEADLESS_DIR: dir });
      expect(second.output()).toContain("The server's database was replaced: the headless device starts over");
      expect(await spaces(second)).not.toContain("Before the wipe");
      await stop(second);
    } finally {
      cleanup();
    }
  }, 60_000);

  it("is used by one server process: a second one says so, and /api/v1 answers 503 with the reason", async () => {
    fresh();
    try {
      const first = await start({ KUBUS_HEADLESS_DIR: dir });
      const secondPort = String(await freePort());
      const second = await startServer(databaseUrl, { PORT: secondPort, KUBUS_HEADLESS_DIR: dir });
      running.push(second);
      await waitFor(() => /couldn't start/.test(second.output()), second);
      expect(second.output()).toMatch(/is in use by another Kubus server process .*only one may use KUBUS_HEADLESS_DIR/);
      const refused = await request(second, "/api/v1/spaces");
      expect(refused.status).toBe(503);
      expect(((await refused.json()) as { error: string }).error).toMatch(/in use by another Kubus server process/);
      // The first one is unharmed.
      expect((await request(first, "/api/v1/spaces")).status).toBe(200);
      await stop(second);
      await stop(first);
    } finally {
      cleanup();
    }
  }, 60_000);
});
