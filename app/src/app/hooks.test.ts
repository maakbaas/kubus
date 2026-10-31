// @vitest-environment node
// The app's hooks over the store, run in the hook host (test/hooks.ts) with a stand-in store.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MAP_STYLE } from "../../../shared/settings";
import type { DataChange, Repository } from "../data/repository";
import type { Collection, Item } from "../domain/model";
import { renderHook } from "../test/hooks";
import { AiService } from "./ai";
import { ItemCache } from "./itemCache";

const m = vi.hoisted(() => ({
  store: {} as Record<string, unknown>,
  openRelated: vi.fn(),
  openExternal: vi.fn(async () => {}),
}));
vi.mock("./store", () => ({ useStore: () => m.store, useComponents: () => m.store.components }));
vi.mock("../workspace/Workspace", () => ({ useOpenRelated: () => m.openRelated }));
vi.mock("../platform/openExternal", () => ({ openExternal: m.openExternal }));

const { useAiCellState, useAiFill, useAiProgress, useServerAi } = await import("./useAi");
const { useDataChanges } = await import("./useDataChanges");
const { useItemCounts } = await import("./useItemCounts");
const { useItems } = await import("./useItems");
const { useLinks } = await import("./useLinks");
const { useRemotesShown } = await import("./useRemotes");

/** A repository's sync side: settings that can change, and listeners to tell. */
function fakeSync(config = { url: "", token: "" }) {
  const listeners = new Set<() => void>();
  return {
    config,
    status: "idle" as unknown,
    subscribe: (l: () => void) => (listeners.add(l), () => void listeners.delete(l)),
    changed: () => listeners.forEach((l) => l()),
  };
}

beforeEach(() => {
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  vi.stubGlobal("fetch", async () => Response.json({ available: false, fieldModel: "", codeModel: "" }));
  m.openRelated.mockClear();
  m.openExternal.mockClear();
});
afterEach(() => vi.unstubAllGlobals());

describe("AI hooks", () => {
  function setup() {
    const repo = { sync: fakeSync(), getItem: async () => undefined, setGenerated: async () => {}, acceptEdit: async () => {} };
    const ai = new AiService(repo as unknown as Repository);
    m.store = { ai, components: [] };
    return ai;
  }

  it("useServerAi gives the server's offer, with its problem while there is none", async () => {
    const ai = setup();
    const h = renderHook(() => useServerAi());
    expect(h.result.current.problem).toMatch(/No server/);
    expect(h.result.current).toBe(ai.serverOffer);
  });

  it("useAiProgress and useAiCellState follow the queue", async () => {
    const ai = setup();
    const progress = renderHook(() => useAiProgress());
    const cell = renderHook(() => useAiCellState("i1", "f1"));
    expect(progress.result.current.working).toBe(0);
    expect(cell.result.current).toBe("");
    ai.setProblems([["i1", "f1", "Write a prompt"]]);
    await cell.settle();
    expect(cell.result.current).toBe("error: Write a prompt");
  });

  describe("useAiFill", () => {
    const collection = (kinds: ("string" | "ai")[]) =>
      ({
        id: "c", name: "Book", pluralName: "Books", fields: kinds.map((kind, i) => ({ id: `f${i}`, name: `F${i}`, kind, code: kind === "ai" ? "Say {{ $item.F0 }}" : null, output: kind === "ai" ? "string" : null, componentId: null, position: i })),
      }) as unknown as Collection;
    const items = [{ id: "i1", collectionId: "c", spaceId: "s", values: { f0: "hi" }, createdAt: "", updatedAt: "" }] as Item[];

    it("offers what needs generating, records what was typed, and clears moot questions", () => {
      const ai = { setProblems: vi.fn(), offer: vi.fn(), adopt: vi.fn(), offerOverrides: vi.fn() };
      m.store = { ai, components: [] };
      renderHook(() => useAiFill(collection(["string", "ai"]), items, () => ""));
      expect(ai.setProblems).toHaveBeenCalled();
      const offered = ai.offer.mock.calls[0][0];
      expect(offered).toHaveLength(1);
      expect(offered[0]).toMatchObject({ itemId: "i1", request: { prompt: "Say hi" } });
      expect(ai.adopt).toHaveBeenCalledWith([]);
      expect(ai.offerOverrides).toHaveBeenCalledWith([], []);
    });

    it("does nothing while loading, not ready, or without an AI field", () => {
      const ai = { setProblems: vi.fn(), offer: vi.fn(), adopt: vi.fn(), offerOverrides: vi.fn() };
      m.store = { ai, components: [] };
      renderHook(() => useAiFill(collection(["string", "ai"]), null, () => ""));
      renderHook(() => useAiFill(collection(["string", "ai"]), items, () => "", false));
      renderHook(() => useAiFill(collection(["string"]), items, () => ""));
      expect(ai.setProblems).not.toHaveBeenCalled();
      expect(ai.offer).not.toHaveBeenCalled();
    });

    it("looks again only when the items change, not at every render", () => {
      const ai = { setProblems: vi.fn(), offer: vi.fn(), adopt: vi.fn(), offerOverrides: vi.fn() };
      m.store = { ai, components: [] };
      const c = collection(["ai"]);
      const label = () => "";
      const h = renderHook(() => useAiFill(c, items, label));
      h.rerender();
      expect(ai.offer).toHaveBeenCalledTimes(1);
    });
  });
});

describe("useDataChanges", () => {
  it("calls the latest callback for each change, and stops after unmount", () => {
    let handler: (c: DataChange) => void = () => {};
    const off = vi.fn();
    m.store = { repo: { subscribe: (h: (c: DataChange) => void) => ((handler = h), off) } };
    const first = vi.fn();
    const second = vi.fn();
    const h = renderHook(({ cb }: { cb: (c: DataChange) => void }) => useDataChanges(cb), { props: { cb: first } });
    handler({ scope: "items" } as DataChange);
    h.rerender({ cb: second });
    handler({ scope: "collections" } as DataChange);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledWith({ scope: "collections" });
    h.unmount();
    expect(off).toHaveBeenCalled();
  });
});

describe("useItemCounts", () => {
  it("counts items of every space, again after item changes only", async () => {
    let handler: (c: DataChange) => void = () => {};
    let counts: Record<string, number> = { a: 1 };
    const count = vi.fn(async () => counts);
    m.store = { repo: { countItemsByCollection: count, subscribe: (h: (c: DataChange) => void) => ((handler = h), () => {}) } };
    const h = renderHook(() => useItemCounts());
    expect(h.result.current).toEqual({});
    await h.settle();
    expect(count).toHaveBeenCalledWith(null);
    expect(h.result.current).toEqual({ a: 1 });

    counts = { a: 2 };
    handler({ scope: "collections" } as DataChange);
    await h.settle();
    expect(count).toHaveBeenCalledTimes(1);
    handler({ scope: "items", collectionId: "a" } as DataChange);
    await h.settle();
    expect(h.result.current).toEqual({ a: 2 });
  });

  it("logs a failure instead of throwing, and keeps what it had", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    m.store = { repo: { countItemsByCollection: async () => Promise.reject(new Error("db")), subscribe: () => () => {} } };
    const h = renderHook(() => useItemCounts());
    await h.settle();
    expect(log).toHaveBeenCalled();
    expect(h.result.current).toEqual({});
    log.mockRestore();
  });

  it("ignores an answer that arrives after unmount", async () => {
    let answer!: (n: Record<string, number>) => void;
    m.store = { repo: { countItemsByCollection: () => new Promise((r) => (answer = r)), subscribe: () => () => {} } };
    const h = renderHook(() => useItemCounts());
    h.unmount();
    answer({ a: 1 });
    await h.settle();
    expect(h.result.current).toEqual({});
  });
});

describe("useItems", () => {
  it("gives the shared snapshot of a collection and follows it", async () => {
    const collection = { id: "c", fields: [{ id: "f" }] } as unknown as Collection;
    const table = [{ id: "a", spaceId: "s" }] as Item[];
    const repo = { listItems: async () => table, getItem: async () => table[0], listLabels: async () => [], subscribe: () => () => {} };
    const cache = new ItemCache(repo as unknown as Repository, () => collection, () => "s");
    m.store = { cache };
    const h = renderHook(() => useItems(collection));
    expect(h.result.current.items).toBeNull();
    await h.settle();
    expect(h.result.current.items?.map((i) => i.id)).toEqual(["a"]);
    cache.items.patch("c", "a", (i) => ({ ...i, spaceId: "t" }));
    await h.settle();
    expect(h.result.current.items?.[0].spaceId).toBe("t");
    h.unmount();
  });
});

describe("useRemotesShown", () => {
  const local = { id: "l" } as Collection;
  const remote = { id: "r", source: { name: "CRM" } } as Collection;
  function setup(config: { url: string; token: string }, list: () => Promise<unknown[]>, collections: Collection[] = []) {
    const sync = fakeSync(config);
    let refresh: (id: string | null) => void = () => {};
    m.store = {
      repo: { sync },
      collections,
      sources: { list, onRefresh: (l: (id: string | null) => void) => ((refresh = l), () => {}) },
    };
    return { sync, refresh: (id: string | null) => refresh(id) };
  }

  it("is false without a server, even when its list would offer something", async () => {
    const list = vi.fn(async () => [{}]);
    setup({ url: "", token: "" }, list);
    const h = renderHook(() => useRemotesShown());
    await h.settle();
    expect(h.result.current).toBe(false);
    expect(list).not.toHaveBeenCalled();
  });

  it("is true when the server has a source, and asked again when the server's settings were saved", async () => {
    let sources: unknown[] = [];
    const s = setup({ url: "https://s", token: "t" }, async () => sources);
    const h = renderHook(() => useRemotesShown());
    await h.settle();
    expect(h.result.current).toBe(false);
    sources = [{}];
    s.refresh("some-collection"); // another collection's refresh is not about the sources
    await h.settle();
    expect(h.result.current).toBe(false);
    s.refresh(null);
    await h.settle();
    expect(h.result.current).toBe(true);
  });

  it("stays as it was when the server can't be reached", async () => {
    setup({ url: "https://s", token: "t" }, () => Promise.reject(new Error("offline")));
    const h = renderHook(() => useRemotesShown());
    await h.settle();
    expect(h.result.current).toBe(false);
  });

  it("is true while remote collections exist, so they stay reachable offline or after their source is gone", async () => {
    setup({ url: "", token: "" }, async () => [], [local, remote]);
    const h = renderHook(() => useRemotesShown());
    await h.settle();
    expect(h.result.current).toBe(true);
  });

  it("goes false again when the server is taken away", async () => {
    const s = setup({ url: "https://s", token: "t" }, async () => [{}]);
    const h = renderHook(() => useRemotesShown());
    await h.settle();
    expect(h.result.current).toBe(true);
    s.sync.config = { url: "", token: "" };
    (m.store.repo as { sync: unknown }).sync = s.sync;
    s.sync.changed();
    h.rerender();
    await h.settle();
    expect(h.result.current).toBe(false);
  });
});

describe("useLinks", () => {
  const books = { id: "c1", name: "Book", pluralName: "Books", fields: [], itemViews: [] } as unknown as Collection;
  const setup = () => {
    m.store = {
      repo: { listViews: async () => [], listLabels: async () => [{ id: "i1", label: "Dune", spaceId: "s" }] },
      space: { id: "s" },
      collections: [books],
    };
    return renderHook(() => useLinks());
  };

  it("stores a link typed by name as its id form, and shows a stored one by name", async () => {
    const links = setup().result.current;
    expect(await links.toStored("book/dune")).toBe("#/collections/c1/items/i1");
    expect(await links.toShown("#/collections/c1/items/i1")).toBe("book/dune");
    // What names nothing stays as typed.
    expect(await links.toStored("https://example.org")).toBe("https://example.org");
    expect(await links.toShown("https://example.org")).toBe("https://example.org");
    expect(await links.toStored("nothing/here")).toBe("nothing/here");
  });

  it("falls back to the href when the data cannot be read", async () => {
    m.store = { repo: { listViews: async () => Promise.reject(new Error("x")), listLabels: async () => Promise.reject(new Error("x")) }, space: { id: "s" }, collections: [books] };
    const links = renderHook(() => useLinks()).result.current;
    expect(await links.toStored("book/dune")).toBe("book/dune");
  });

  it("opens a page of the app in the tab, a name link after resolving it, anything else outside", async () => {
    const { open } = setup().result.current;
    await open("#/collections/c1/items", "tab");
    expect(m.openRelated).toHaveBeenLastCalledWith("/collections/c1/items", "tab");
    await open("book/dune");
    expect(m.openRelated).toHaveBeenLastCalledWith("/collections/c1/items/i1", "here");
    await open("https://example.org/x");
    expect(m.openExternal).toHaveBeenCalledWith("https://example.org/x");
    expect(m.openRelated).toHaveBeenCalledTimes(2);
  });

  it("keeps its functions while nothing it reads changed", () => {
    const h = setup();
    const first = h.result.current;
    h.rerender();
    expect(h.result.current).toBe(first);
  });
});

describe("the display settings", () => {
  /** A repository holding these settings, telling of its changes. */
  function settingsRepo(stored: Record<string, unknown>, config = { url: "", token: "" }) {
    const listeners = new Set<(c: DataChange) => void>();
    const repo = {
      sync: fakeSync(config),
      stored,
      getSettings: vi.fn(async () => ({ ...repo.stored })),
      setSetting: vi.fn(async (key: string, value: unknown) => {
        repo.stored = { ...repo.stored, [key]: value };
        listeners.forEach((l) => l({ scope: "settings" }));
      }),
      subscribe: (l: (c: DataChange) => void) => (listeners.add(l), () => void listeners.delete(l)),
    };
    return repo;
  }
  const load = async (items = new Map<string, string>()) => {
    vi.stubGlobal("localStorage", { getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, v: string) => items.set(k, v) });
    vi.resetModules();
    return { items, mod: await import("./settings") };
  };

  it("start from the device's copy (a value that is no setting: the default), before the database answers", async () => {
    const { mod } = await load(new Map([["kubus.theme", "dark"], ["kubus.mapStyle", "neon"]]));
    expect(renderHook(() => mod.useDisplaySettings()).result.current).toEqual({ theme: "dark", mapStyle: DEFAULT_MAP_STYLE });
  });

  it("follow the database, a synced change too, and keep a copy on the device", async () => {
    const { items, mod } = await load();
    const repo = settingsRepo({ theme: "light", mapStyle: "dark" });
    m.store = { repo, sources: { serverSettings: vi.fn() } };
    await renderHook(() => mod.DisplaySettingsSync()).settle();
    const h = renderHook(() => mod.useDisplaySettings());
    expect(h.result.current).toEqual({ theme: "light", mapStyle: "dark" });
    expect(items.get("kubus.theme")).toBe("light");
    await mod.setDisplaySetting(repo, "theme", "dark");
    await h.settle();
    expect(h.result.current.theme).toBe("dark");
    expect(repo.stored.theme).toBe("dark");
    expect(items.get("kubus.theme")).toBe("dark");
  });

  it("start a database without a map style from the server's (it was the server's setting), else the device's own", async () => {
    let { mod } = await load();
    const serverSettings = vi.fn().mockResolvedValue({ map: { style: "positron" } });
    let repo = settingsRepo({}, { url: "https://s", token: "t" });
    m.store = { repo, sources: { serverSettings } };
    await renderHook(() => mod.DisplaySettingsSync()).settle();
    expect(repo.setSetting).toHaveBeenCalledWith("mapStyle", "positron");

    ({ mod } = await load(new Map([["kubus.mapStyle", "liberty"]])));
    repo = settingsRepo({});
    m.store = { repo, sources: { serverSettings } };
    await renderHook(() => mod.DisplaySettingsSync()).settle();
    expect(repo.setSetting).toHaveBeenCalledWith("mapStyle", "liberty");
    expect(serverSettings).toHaveBeenCalledTimes(1); // no server: not asked

    // One already set is left alone.
    repo = settingsRepo({ mapStyle: "bright" }, { url: "https://s", token: "t" });
    m.store = { repo, sources: { serverSettings } };
    await renderHook(() => mod.DisplaySettingsSync()).settle();
    expect(repo.setSetting).not.toHaveBeenCalled();
  });
});
