// @vitest-environment node
// openRepository (data/index.ts): one database connection per page, retried after a failure.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DirectSqlClient } from "./sqlite/direct";

const open = vi.fn();
vi.mock("./sqlite/client", () => ({ WorkerSqlClient: { open: () => open() }, terminateWorkers: vi.fn() }));

let persist: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.resetModules();
  open.mockReset().mockImplementation(() => DirectSqlClient.open());
  persist = vi.fn().mockResolvedValue(true);
  vi.stubGlobal("navigator", { storage: { persist } });
  vi.stubGlobal("localStorage", { getItem: () => null, setItem() {}, removeItem() {} });
  vi.stubGlobal("addEventListener", () => {});
  vi.stubGlobal("document", { addEventListener() {}, visibilityState: "visible" });
  vi.stubGlobal("location", { protocol: "https:", hostname: "notes.example.com", origin: "https://notes.example.com" });
});
afterEach(() => vi.unstubAllGlobals());

// Each test loads the module graph afresh (the module keeps the connection): slow on a busy machine.
describe("openRepository", { timeout: 30_000 }, () => {
  it("asks the browser not to evict the storage, then opens one repository for every caller", async () => {
    const { openRepository } = await import("./index");
    const [a, b] = await Promise.all([openRepository(), openRepository()]);
    expect(a).toBe(b);
    expect(await openRepository()).toBe(a);
    expect(open).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(a.storage).toEqual({ persistent: false });
    expect(await a.listSpaces()).toHaveLength(1);
  });

  it("opens where the browser can't persist storage", async () => {
    vi.stubGlobal("navigator", {});
    const { openRepository } = await import("./index");
    await expect(openRepository()).resolves.toBeDefined();
  });

  it("goes on when asking for persistence is refused", async () => {
    persist.mockRejectedValue(new Error("denied"));
    const { openRepository } = await import("./index");
    await expect(openRepository()).resolves.toBeDefined();
  });

  it("tries again after a failure (say, once the other tab is closed)", async () => {
    open.mockRejectedValueOnce(new Error("Kubus is open in another tab or window."));
    const { openRepository } = await import("./index");
    await expect(openRepository()).rejects.toThrow("another tab");
    await vi.waitFor(async () => expect(await openRepository()).toBeDefined());
    expect(open).toHaveBeenCalledTimes(2);
  });
});
