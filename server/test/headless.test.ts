// @vitest-environment node
// Loading the headless device (src/headless.ts): what /api/v1 says while it isn't there.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HeadlessOptions } from "../../shared/api.ts";

const bundle = vi.hoisted(() => ({ exists: true, stub: "", start: async (_options: unknown): Promise<unknown> => ({ handle: async () => ({ status: 200 }) }) }));

vi.mock("node:fs", async (importOriginal) => ({ ...(await importOriginal<typeof import("node:fs")>()), existsSync: () => bundle.exists }));
// The bundle (built by `npm run build:headless`, git-ignored) is replaced by a stand-in module that
// calls the test's function, so this needs no build: the host imports whatever address it is given.
vi.mock("node:url", async (importOriginal) => ({ ...(await importOriginal<typeof import("node:url")>()), pathToFileURL: () => new URL(bundle.stub) }));

const dir = mkdtempSync(join(tmpdir(), "kubus-headless-"));
writeFileSync(join(dir, "index.js"), "export const startHeadless = (options) => globalThis.__startHeadless(options);");
bundle.stub = `file://${join(dir, "index.js")}`;
(globalThis as Record<string, unknown>).__startHeadless = (options: unknown) => bundle.start(options);

const { HeadlessHost } = await import("../src/headless.ts");

describe("the headless device's host", () => {
  const options = (log: string[]): HeadlessOptions => ({ serverUrl: "http://127.0.0.1:1", token: "t", cursor: () => 0, webhooks: { urls: [], secret: null }, log: (m) => log.push(m) });

  beforeEach(() => {
    bundle.exists = true;
    bundle.start = async () => ({ handle: async () => ({ status: 200 }) });
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
    bundle.start = async (o) => ((given = o), { handle: async () => ({ status: 200 }) });
    const host = new HeadlessHost();
    const o = options(log);
    await host.start(o);
    expect(host.device).not.toBeNull();
    expect(given).toBe(o);
    expect(log).toEqual(["API ready at /api/v1"]);
  });

  it("keeps the reason when the device can't start, and tries again", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const log: string[] = [];
    let attempts = 0;
    bundle.start = async () => {
      if (++attempts === 1) throw new Error("the server isn't up");
      return { handle: async () => ({ status: 200 }) };
    };
    const host = new HeadlessHost();
    await host.start(options(log));
    expect(host.device).toBeNull();
    expect(host.problem).toBe("The API couldn't start: the server isn't up");
    expect(log).toEqual(["The API couldn't start: the server isn't up (trying again in 30 s)"]);
    vi.advanceTimersByTime(30_000);
    for (let i = 0; i < 100 && !host.device; i++) await new Promise((r) => setImmediate(r)); // its import is real I/O
    expect(host.device).not.toBeNull();
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
});
