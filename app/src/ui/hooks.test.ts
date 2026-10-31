// @vitest-environment node
// Small UI hooks, in the hook host (test/hooks.ts) with just enough of a window and document.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerSettingsView } from "../../../shared/settings";
import { renderHook } from "../test/hooks";

const m = vi.hoisted(() => ({ store: {} as Record<string, unknown> }));
vi.mock("../app/store", () => ({ useStore: () => m.store }));
vi.mock("./useConfirm", () => ({ errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)) }));

const { useBuffered } = await import("./useBuffered");
const { useTableSort } = await import("./useTableSort");
const { returnFocus, useMountedDialog } = await import("./useMountedDialog");
const { findBlock, useLinkTarget } = await import("./useLinkTarget");
const { updateOf, useServerSettings } = await import("./useServerSettings");
const { readPref, writePref } = await import("./localPrefs");

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("window", {
    setTimeout: (...a: Parameters<typeof setTimeout>) => setTimeout(...a),
    clearTimeout: (...a: Parameters<typeof clearTimeout>) => clearTimeout(...a),
    setInterval: (...a: Parameters<typeof setInterval>) => setInterval(...a),
    clearInterval: (...a: Parameters<typeof clearInterval>) => clearInterval(...a),
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useBuffered", () => {
  function setup(value = "a", delay?: number) {
    const commit = vi.fn();
    const h = renderHook(({ v }: { v: string }) => useBuffered(v, commit, delay), { props: { v: value } });
    return { h, commit, draft: () => h.result.current[0], type: (v: string) => h.result.current[1](v), flush: () => h.result.current[2]() };
  }

  it("shows what is typed at once and stores it after a pause in typing", async () => {
    const t = setup();
    t.type("ab");
    await t.h.settle();
    expect(t.draft()).toBe("ab");
    expect(t.commit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(399);
    expect(t.commit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(t.commit).toHaveBeenCalledOnce();
    expect(t.commit).toHaveBeenCalledWith("ab");
  });

  it("each keystroke restarts the pause, and only the last value is stored", async () => {
    const t = setup("", 100);
    t.type("a");
    await vi.advanceTimersByTimeAsync(80);
    t.type("ab");
    await vi.advanceTimersByTimeAsync(80);
    t.type("abc");
    await vi.advanceTimersByTimeAsync(100);
    expect(t.commit.mock.calls).toEqual([["abc"]]);
  });

  it("flush stores a waiting edit at once, and only once", async () => {
    const t = setup();
    t.flush(); // nothing waiting
    expect(t.commit).not.toHaveBeenCalled();
    t.type("x");
    t.flush();
    expect(t.commit).toHaveBeenCalledWith("x");
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.commit).toHaveBeenCalledTimes(1);
  });

  it("stores a waiting edit when the editor goes away", () => {
    const t = setup();
    t.type("bye");
    t.h.unmount();
    expect(t.commit).toHaveBeenCalledWith("bye");
  });

  it("takes a change from elsewhere, unless an edit is waiting", async () => {
    const t = setup("a");
    t.h.rerender({ v: "b" });
    await t.h.settle();
    expect(t.draft()).toBe("b");
    t.type("mine");
    t.h.rerender({ v: "c" });
    await t.h.settle();
    expect(t.draft()).toBe("mine");
    t.flush();
    t.h.rerender({ v: "d" });
    await t.h.settle();
    expect(t.draft()).toBe("d");
  });

  it("calls the latest commit function", async () => {
    const first = vi.fn();
    const second = vi.fn();
    const h = renderHook(({ commit }: { commit: (v: string) => void }) => useBuffered<string>("a", commit), { props: { commit: first } });
    h.result.current[1]("x");
    h.rerender({ commit: second });
    h.result.current[2]();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith("x");
  });
});

describe("useTableSort", () => {
  interface Row {
    name: string;
    n: number;
  }
  const rows: Row[] = [{ name: "b10", n: 3 }, { name: "B2", n: 1 }, { name: "a", n: 2 }];
  const setup = () => renderHook(() => useTableSort<Row, "name" | "n">({ name: (r) => r.name, n: (r) => r.n }));
  const names = (h: ReturnType<typeof setup>) => h.result.current.sort(rows).map((r) => r.name);

  it("keeps the rows in their own order until a column is clicked", () => {
    const h = setup();
    expect(h.result.current.sort(rows)).toBe(rows);
    expect(h.result.current.header("name")).toMatchObject({ isSortable: true, isSortHeader: false, sortDirection: "NONE" });
  });

  it("clicking sorts ascending, again descending, again ascending", async () => {
    const h = setup();
    h.result.current.header("n").onClick();
    await h.settle();
    expect(h.result.current.header("n")).toMatchObject({ isSortHeader: true, sortDirection: "ASC" });
    expect(h.result.current.sort(rows).map((r) => r.n)).toEqual([1, 2, 3]);
    h.result.current.header("n").onClick();
    await h.settle();
    expect(h.result.current.header("n").sortDirection).toBe("DESC");
    expect(h.result.current.sort(rows).map((r) => r.n)).toEqual([3, 2, 1]);
    h.result.current.header("n").onClick();
    await h.settle();
    expect(h.result.current.header("n").sortDirection).toBe("ASC");
  });

  it("text sorts naturally and without regard to case, numbers by value; another column starts ascending", async () => {
    const h = setup();
    h.result.current.header("name").onClick();
    await h.settle();
    expect(names(h)).toEqual(["a", "B2", "b10"]);
    expect(h.result.current.header("n").sortDirection).toBe("NONE");
    h.result.current.header("name").onClick();
    await h.settle();
    expect(names(h)).toEqual(["b10", "B2", "a"]);
    h.result.current.header("n").onClick();
    await h.settle();
    expect(h.result.current.header("n").sortDirection).toBe("ASC");
    expect(h.result.current.header("name").isSortHeader).toBe(false);
  });

  it("does not change the rows it was given", async () => {
    const h = setup();
    h.result.current.header("n").onClick();
    await h.settle();
    h.result.current.sort(rows);
    expect(rows.map((r) => r.name)).toEqual(["b10", "B2", "a"]);
  });
});

describe("dialog focus", () => {
  class FakeElement {
    connected = true;
    focus = vi.fn();
    get isConnected() {
      return this.connected;
    }
  }
  const documentWith = (activeElement: unknown) => vi.stubGlobal("document", { activeElement, body: "BODY" });

  beforeEach(() => vi.stubGlobal("HTMLElement", FakeElement));

  it("gives focus back to the opener when nothing else has it", async () => {
    const launcher = new FakeElement();
    documentWith(null);
    returnFocus(launcher as never);
    await vi.advanceTimersByTimeAsync(0);
    expect(launcher.focus).toHaveBeenCalled();
  });

  it("also when focus is on the page itself or still inside the closed dialog", async () => {
    const launcher = new FakeElement();
    documentWith("BODY");
    returnFocus(launcher as never);
    await vi.advanceTimersByTimeAsync(0);
    expect(launcher.focus).toHaveBeenCalledTimes(1);
    documentWith({ closest: (s: string) => (s === ".cds--modal:not(.is-visible)" ? {} : null) });
    returnFocus(launcher as never);
    await vi.advanceTimersByTimeAsync(0);
    expect(launcher.focus).toHaveBeenCalledTimes(2);
  });

  it("not when something else took focus, or the opener is gone", async () => {
    const launcher = new FakeElement();
    documentWith({ closest: () => null });
    returnFocus(launcher as never);
    await vi.advanceTimersByTimeAsync(0);
    expect(launcher.focus).not.toHaveBeenCalled();
    documentWith(null);
    launcher.connected = false;
    returnFocus(launcher as never);
    returnFocus(null);
    returnFocus({} as never);
    await vi.advanceTimersByTimeAsync(0);
    expect(launcher.focus).not.toHaveBeenCalled();
  });

  it("a dialog is open from the render after it mounts, and gives focus back when it goes", async () => {
    const launcher = new FakeElement();
    documentWith(launcher);
    const h = renderHook(() => useMountedDialog());
    expect(h.result.current).toBe(false);
    await h.settle();
    expect(h.result.current).toBe(true);
    documentWith(null);
    h.unmount();
    await vi.advanceTimersByTimeAsync(0);
    expect(launcher.focus).toHaveBeenCalled();
  });
});

describe("link targets", () => {
  /** An element that records what was done to it. */
  const target = () => {
    const classes = new Set<string>();
    return {
      classes,
      scrollIntoView: vi.fn(),
      offsetWidth: 1,
      classList: { add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c) },
    };
  };

  it("scrolls to it and flashes it, for a moment", async () => {
    const el = target();
    renderHook(() => useLinkTarget("b1", () => el as never));
    expect(el.scrollIntoView).toHaveBeenCalledWith({ block: "center", behavior: "smooth" });
    expect(el.classes.has("link-target")).toBe(true);
    await vi.advanceTimersByTimeAsync(2200);
    expect(el.classes.has("link-target")).toBe(false);
  });

  it("tries again while the page is loading, and gives up after a few seconds", async () => {
    let found: ReturnType<typeof target> | undefined;
    const find = vi.fn(() => found as never);
    renderHook(() => useLinkTarget("b1", find));
    await vi.advanceTimersByTimeAsync(500);
    expect(find.mock.calls.length).toBeGreaterThan(3);
    found = target();
    await vi.advanceTimersByTimeAsync(100);
    expect(found.scrollIntoView).toHaveBeenCalledOnce();
    const calls = find.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(find.mock.calls.length).toBe(calls); // found: no more looking

    const never = vi.fn(() => undefined as never);
    renderHook(() => useLinkTarget("b2", never));
    await vi.advanceTimersByTimeAsync(10_000);
    const looked = never.mock.calls.length;
    expect(looked).toBeGreaterThan(30);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(never.mock.calls.length).toBe(looked);
  });

  it("does nothing without a target or before the page is ready; stops looking when it goes away", async () => {
    const find = vi.fn(() => undefined as never);
    renderHook(() => useLinkTarget(null, find));
    renderHook(() => useLinkTarget("x", find, false));
    await vi.advanceTimersByTimeAsync(1000);
    expect(find).not.toHaveBeenCalled();
    const h = renderHook(() => useLinkTarget("x", find));
    await vi.advanceTimersByTimeAsync(300);
    h.unmount();
    const calls = find.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(find.mock.calls.length).toBe(calls);
  });

  it("is scrolled to again while blocks above it fill in, until the user scrolls", async () => {
    const listeners = new Map<string, () => void>();
    Object.assign(window, {
      addEventListener: (e: string, f: () => void) => listeners.set(e, f),
      removeEventListener: (e: string) => listeners.delete(e),
    });
    let top = 100;
    const el = { ...target(), isConnected: true, parentElement: null, getBoundingClientRect: () => ({ top }) };
    renderHook(() => useLinkTarget("b1", () => el as never));
    expect(el.scrollIntoView).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(300);
    expect(el.scrollIntoView).toHaveBeenCalledOnce(); // not moved: left alone
    top = 600; // a block above got its items
    await vi.advanceTimersByTimeAsync(100);
    expect(el.scrollIntoView).toHaveBeenCalledTimes(2);
    listeners.get("wheel")!();
    top = 900;
    await vi.advanceTimersByTimeAsync(1000);
    expect(el.scrollIntoView).toHaveBeenCalledTimes(2);
    expect(listeners.size).toBe(0);
  });

  it("looks for the target again only when it changes", async () => {
    const find = vi.fn(() => target() as never);
    const h = renderHook(({ id }: { id: string }) => useLinkTarget(id, find), { props: { id: "a" } });
    h.rerender({ id: "a" });
    expect(find).toHaveBeenCalledTimes(1);
    h.rerender({ id: "b" });
    expect(find).toHaveBeenCalledTimes(2);
  });

  it("findBlock skips blocks in tabs that are not shown", () => {
    const hidden = { closest: (s: string) => (s === "[hidden]" ? {} : null) };
    const shown = { closest: () => null };
    vi.stubGlobal("CSS", { escape: (s: string) => s });
    vi.stubGlobal("document", { querySelectorAll: (q: string) => (q === '[data-block-id="b1"]' ? [hidden, shown] : []) });
    expect(findBlock("b1")).toBe(shown);
    expect(findBlock("b2")).toBeNull();
  });
});

describe("local preferences", () => {
  function storage(initial: Record<string, string> = {}) {
    const items = new Map(Object.entries(initial));
    vi.stubGlobal("localStorage", { getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, v: string) => items.set(k, v), removeItem: (k: string) => items.delete(k) });
    return items;
  }

  it("stores JSON and reads it back; removes with undefined", () => {
    const items = storage();
    writePref("k", { a: [1, 2] });
    expect(items.get("k")).toBe('{"a":[1,2]}');
    expect(readPref("k", null)).toEqual({ a: [1, 2] });
    writePref("k", undefined);
    expect(items.has("k")).toBe(false);
  });

  it("gives the fallback for nothing stored or an unreadable value", () => {
    storage({ bad: "{not json" });
    expect(readPref("missing", 7)).toBe(7);
    expect(readPref("bad", "fallback")).toBe("fallback");
  });

  it("works without storage: nothing is remembered and nothing throws", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("full");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    });
    expect(readPref("k", "fallback")).toBe("fallback");
    expect(() => writePref("k", 1)).not.toThrow();
    expect(() => writePref("k", undefined)).not.toThrow();
  });
});

describe("useServerSettings", () => {
  const view = (extra: Partial<ServerSettingsView> = {}) =>
    ({
      ai: { url: "https://llm", fieldModel: "f", codeModel: "c", hasKey: true },
      sources: [{ id: "s1", name: "CRM", kind: "postgres", fields: { host: "h" }, schemas: ["public"], timeoutSeconds: 30, hasPassword: true }],
      ...extra,
    }) as unknown as ServerSettingsView;

  function setup(config = { url: "https://s", token: "t" }) {
    let current = view();
    const sync = { config, status: "idle", subscribe: () => () => {} };
    const sources = {
      serverSettings: vi.fn(async () => current),
      saveServerSettings: vi.fn(async (update: unknown) => ((current = view({ ai: { ...current.ai, fieldModel: (update as { ai: { fieldModel: string } }).ai.fieldModel } })), current)),
      refresh: vi.fn(),
    };
    const ai = { serverChanged: vi.fn() };
    m.store = { sources, ai, repo: { sync } };
    return { sources, ai };
  }

  it("updateOf keeps what is set and leaves secrets out", () => {
    expect(updateOf(view())).toEqual({
      ai: { url: "https://llm", fieldModel: "f", codeModel: "c" },
      sources: [{ id: "s1", name: "CRM", kind: "postgres", fields: { host: "h" }, schemas: ["public"], timeoutSeconds: 30 }],
    });
    expect(updateOf(view({ map: { style: "dark" } }))).toHaveProperty("map", { style: "dark" });
  });

  it("reads the server's settings when connected", async () => {
    const { sources } = setup();
    const h = renderHook(() => useServerSettings());
    expect(h.result.current).toMatchObject({ connected: true, url: "https://s", view: null });
    await h.settle();
    expect(sources.serverSettings).toHaveBeenCalledTimes(1);
    expect(h.result.current.view?.ai.fieldModel).toBe("f");
    expect(h.result.current.error).toBeUndefined();
  });

  it("does not ask without a server", async () => {
    const { sources } = setup({ url: "", token: "" });
    const h = renderHook(() => useServerSettings());
    await h.settle();
    expect(h.result.current).toMatchObject({ connected: false, view: null });
    expect(sources.serverSettings).not.toHaveBeenCalled();
  });

  it("says why it could not read them", async () => {
    const { sources } = setup();
    sources.serverSettings.mockRejectedValue(new Error("The server answered 401"));
    const h = renderHook(() => useServerSettings());
    await h.settle();
    expect(h.result.current.error).toBe("The server answered 401");
  });

  it("saves its part on top of what the server holds now, then tells the AI service and the sources", async () => {
    const { sources, ai } = setup();
    const h = renderHook(() => useServerSettings());
    await h.settle();
    const saved = await h.result.current.save((current) => ({ ...current, ai: { ...current.ai, fieldModel: "new" } }));
    expect(sources.saveServerSettings).toHaveBeenCalledWith(expect.objectContaining({ ai: { url: "https://llm", fieldModel: "new", codeModel: "c" } }));
    expect(saved.ai.fieldModel).toBe("new");
    expect(ai.serverChanged).toHaveBeenCalled();
    expect(sources.refresh).toHaveBeenCalledWith(null);
    await h.settle();
    expect(h.result.current.view?.ai.fieldModel).toBe("new");
  });
});
