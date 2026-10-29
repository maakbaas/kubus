// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("maplibre-gl");
  vi.doUnmock("maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url");
});

describe("loadMapLibre", () => {
  function mock(options: { failing?: boolean } = {}) {
    const setWorkerUrl = vi.fn();
    let loads = 0;
    vi.doMock("maplibre-gl", () => {
      loads++;
      if (options.failing && loads === 1) throw new Error("offline");
      return { setWorkerUrl };
    });
    vi.doMock("maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url", () => ({ default: "/assets/worker.js" }));
    return { setWorkerUrl, loads: () => loads };
  }

  it("loads the library once, pointing it at the bundled worker", async () => {
    const m = mock();
    const { loadMapLibre } = await import("./mapLibre");
    const [a, b] = await Promise.all([loadMapLibre(), loadMapLibre()]);
    expect(a).toBe(b);
    expect(m.setWorkerUrl).toHaveBeenCalledTimes(1);
    expect(m.setWorkerUrl).toHaveBeenCalledWith("/assets/worker.js");
    await loadMapLibre();
    expect(m.loads()).toBe(1);
  });

  it("a failure is not kept: a later map tries again", async () => {
    const m = mock({ failing: true });
    const { loadMapLibre } = await import("./mapLibre");
    await expect(loadMapLibre()).rejects.toThrow();
    await expect(loadMapLibre()).resolves.toBeTruthy();
    expect(m.setWorkerUrl).toHaveBeenCalledTimes(1);
  });
});
