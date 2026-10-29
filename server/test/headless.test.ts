// @vitest-environment node
// Loading the headless device (src/headless.ts): what /api/v1 says while it isn't there.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HeadlessOptions } from "../../shared/api.ts";
import { SYNC_VERSION } from "../../shared/sync.ts";

const bundle = vi.hoisted(() => ({ exists: true, stub: "", start: async (_options: unknown): Promise<unknown> => ({ handle: async () => ({ status: 200 }), close: async () => {} }) }));

vi.mock("node:fs", async (importOriginal) => ({ ...(await importOriginal<typeof import("node:fs")>()), existsSync: () => bundle.exists }));
// The bundle (built by `npm run build:headless`, git-ignored) is replaced by a stand-in module that
// calls the test's function, so this needs no build: the host imports whatever address it is given.
vi.mock("node:url", async (importOriginal) => ({ ...(await importOriginal<typeof import("node:url")>()), pathToFileURL: () => new URL(bundle.stub) }));

const dir = mkdtempSync(join(tmpdir(), "kubus-headless-"));
writeFileSync(
  join(dir, "index.js"),
  `export let syncVersion = ${SYNC_VERSION};\nglobalThis.__setSyncVersion = (v) => { syncVersion = v; };\nexport const startHeadless = (options) => globalThis.__startHeadless(options);`,
);
bundle.stub = `file://${join(dir, "index.js")}`;
(globalThis as Record<string, unknown>).__startHeadless = (options: unknown) => bundle.start(options);

const setVersion = async (v: number | undefined) => {
  await import(/* @vite-ignore */ bundle.stub); // the stand-in's version, as the bundle would report it
  (globalThis as unknown as { __setSyncVersion(v: number | undefined): void }).__setSyncVersion(v);
};
const { HeadlessHost } = await import("../src/headless.ts");

describe("the headless device's host", () => {
  const options = (log: string[]): HeadlessOptions => ({ serverUrl: "http://127.0.0.1:1", token: "t", cursor: () => 0, webhooks: { urls: [], secret: null }, log: (m) => log.push(m) });

  beforeEach(async () => {
    bundle.exists = true;
    bundle.start = async () => ({ handle: async () => ({ status: 200 }), close: async () => {} });
    await setVersion(SYNC_VERSION);
  });
  afterEach(() => vi.useRealTimers());

  it("says it is starting before it has started", () => {
    const host = new HeadlessHost();
    expect(host.device).toBeNull();
    expect(host.problem).toBe("The API is starting");
  });

  it("says how to build it when the bundle isn't there", async () => {
    bundle.exists = false;
    const log: string[] = [];
    const host = new HeadlessHost();
    await host.start(options(log));
    expect(host.device).toBeNull();
    expect(host.problem).toMatch(/npm run build:headless/);
    expect(log).toEqual([host.problem]);
  });

  it("starts the device with the server's options and says when /api/v1 is ready", async () => {
    const log: string[] = [];
    let given: unknown;
    bundle.start = async (o) => ((given = o), { handle: async () => ({ status: 200 }), close: async () => {} });
    const host = new HeadlessHost();
    const o = options(log);
    await host.start(o);
    expect(host.device).not.toBeNull();
    expect(given).toBe(o);
    expect(log).toEqual(["API ready at /api/v1"]);
  });

  it("doesn't start a device built for another sync version than the server's (the strict gate would refuse it)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const log: string[] = [];
    let started = 0;
    bundle.start = async () => ((started += 1), { handle: async () => ({ status: 200 }), close: async () => {} });
    for (const version of [SYNC_VERSION - 1, SYNC_VERSION + 1, undefined]) {
      await setVersion(version);
      const host = new HeadlessHost();
      await host.start(options(log));
      expect(host.device).toBeNull();
      expect(host.problem).toBe(`The API couldn't start: The built API is for sync version ${version ?? "?"}, this server's is ${SYNC_VERSION}: run \`npm run build:headless\` and restart the server`);
      await host.close();
    }
    expect(started).toBe(0);
  });

  it("keeps the reason when the device can't start, and tries again", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const log: string[] = [];
    let attempts = 0;
    bundle.start = async () => {
      if (++attempts === 1) throw new Error("the server isn't up");
      return { handle: async () => ({ status: 200 }), close: async () => {} };
    };
    const host = new HeadlessHost();
    await host.start(options(log));
    expect(host.device).toBeNull();
    expect(host.problem).toBe("The API couldn't start: the server isn't up");
    expect(log).toEqual(["The API couldn't start: the server isn't up (trying again in 30 s)"]);
    vi.advanceTimersByTime(30_000);
    // The retry's import is real I/O, and the module runner may wait on timers of its own: real ones from here.
    vi.useRealTimers();
    await vi.waitFor(() => expect(host.device).not.toBeNull());
    expect(log.at(-1)).toBe("API ready at /api/v1");
  });

  it("names a failure that isn't an Error", async () => {
    vi.useFakeTimers();
    bundle.start = async () => {
      throw "boom";
    };
    const host = new HeadlessHost();
    await host.start(options([]));
    expect(host.problem).toBe("The API couldn't start: boom");
    vi.clearAllTimers();
  });

  it("closes the device when the server stops, and stops trying again", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    let closed = 0;
    bundle.start = async () => ({ handle: async () => ({ status: 200 }), close: async () => void closed++ });
    const host = new HeadlessHost();
    await host.start(options([]));
    await host.close();
    expect(closed).toBe(1);
    await new HeadlessHost().close(); // nothing started: nothing to close

    let attempts = 0;
    bundle.start = async () => {
      attempts++;
      throw new Error("down");
    };
    const failing = new HeadlessHost();
    await failing.start(options([]));
    await failing.close();
    vi.advanceTimersByTime(60_000);
    expect(attempts).toBe(1);
  });
});
