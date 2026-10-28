// @vitest-environment node
// The sync environments (data/sync/environment.ts): the browser's, with its globals replaced, and the memory one.
import { afterEach, describe, expect, it, vi } from "vitest";
import { browserEnvironment, memoryEnvironment } from "./environment";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const storageOf = (store: Map<string, string>) => ({
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
});

describe("browserEnvironment storage", () => {
  it("keeps settings in localStorage", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", storageOf(store));
    const { storage } = browserEnvironment;
    expect(storage.get("k")).toBeNull();
    storage.set("k", "v");
    expect(store.get("k")).toBe("v");
    expect(storage.get("k")).toBe("v");
    storage.remove("k");
    expect(storage.get("k")).toBeNull();
  });

  it("never throws where storage is blocked", () => {
    const blocked = () => {
      throw new DOMException("blocked", "SecurityError");
    };
    vi.stubGlobal("localStorage", { getItem: blocked, setItem: blocked, removeItem: blocked });
    const { storage } = browserEnvironment;
    expect(storage.get("k")).toBeNull();
    expect(() => storage.set("k", "v")).not.toThrow();
    expect(() => storage.remove("k")).not.toThrow();
  });

  it("keeps files on the device", () => {
    expect(browserEnvironment.keepFiles).toBe(true);
  });
});

describe("browserEnvironment.defaultUrl", () => {
  const at = (protocol: string, hostname: string) => vi.stubGlobal("location", { protocol, hostname, origin: `${protocol}//${hostname}` });

  it("suggests the server that serves the page (the installed home-screen app)", () => {
    vi.stubEnv("DEV", false);
    at("https:", "notes.example.com");
    expect(browserEnvironment.defaultUrl()).toBe("https://notes.example.com");
    at("http:", "192.168.1.5");
    expect(browserEnvironment.defaultUrl()).toBe("http://192.168.1.5");
  });

  it("suggests none in development (the page is the dev server) nor inside the desktop shell or from a file", () => {
    at("https:", "notes.example.com");
    vi.stubEnv("DEV", true);
    expect(browserEnvironment.defaultUrl()).toBe("");
    vi.stubEnv("DEV", false);
    at("https:", "tauri.localhost");
    expect(browserEnvironment.defaultUrl()).toBe("");
    at("tauri:", "localhost");
    expect(browserEnvironment.defaultUrl()).toBe("");
  });
});

describe("browserEnvironment.watch", () => {
  it("syncs when the device comes online and when the app is shown again, not when hidden", () => {
    const window = new EventTarget();
    const document = Object.assign(new EventTarget(), { visibilityState: "hidden" });
    vi.stubGlobal("addEventListener", window.addEventListener.bind(window));
    vi.stubGlobal("document", document);
    const sync = vi.fn();
    browserEnvironment.watch(sync);
    window.dispatchEvent(new Event("online"));
    expect(sync).toHaveBeenCalledTimes(1);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(sync).toHaveBeenCalledTimes(1);
    document.visibilityState = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(sync).toHaveBeenCalledTimes(2);
  });
});

describe("memoryEnvironment", () => {
  it("keeps settings in memory only, suggests no server, watches nothing", () => {
    const env = memoryEnvironment();
    expect(env.storage.get("k")).toBeNull();
    env.storage.set("k", "v");
    expect(env.storage.get("k")).toBe("v");
    env.storage.remove("k");
    expect(env.storage.get("k")).toBeNull();
    expect(env.defaultUrl()).toBe("");
    expect(() => env.watch(() => {})).not.toThrow();
    expect(env.keepFiles).toBe(true);
    expect(memoryEnvironment({ keepFiles: false }).keepFiles).toBe(false);
    expect(memoryEnvironment().storage.get("k")).toBeNull(); // each its own
  });
});
