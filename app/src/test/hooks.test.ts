// The hook host itself: it must behave like React for the hooks the app's tests rely on.
import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderHook } from "./hooks";

describe("renderHook", () => {
  it("keeps state between renders and re-renders after a change", async () => {
    const h = renderHook(() => {
      const [n, setN] = useState(() => 1);
      return { n, inc: () => setN((x) => x + 1) };
    });
    expect(h.result.current.n).toBe(1);
    h.result.current.inc();
    h.result.current.inc();
    await h.settle();
    expect(h.result.current.n).toBe(3);
    expect(h.renders).toBe(2); // the two changes were batched
  });

  it("does not render for a state set to the same value", async () => {
    const h = renderHook(() => useState(5));
    h.result.current[1](5);
    await h.settle();
    expect(h.renders).toBe(1);
  });

  it("runs an effect after render, cleans up before the next run, and on unmount", async () => {
    const log: string[] = [];
    const h = renderHook(({ dep }: { dep: number }) => {
      useEffect(() => {
        log.push(`run ${dep}`);
        return () => void log.push(`clean ${dep}`);
      }, [dep]);
    }, { props: { dep: 1 } });
    expect(log).toEqual(["run 1"]);
    h.rerender({ dep: 1 });
    expect(log).toEqual(["run 1"]); // same deps
    h.rerender({ dep: 2 });
    expect(log).toEqual(["run 1", "clean 1", "run 2"]);
    h.unmount();
    expect(log).toEqual(["run 1", "clean 1", "run 2", "clean 2"]);
  });

  it("an effect without deps runs every render; with [] only once", () => {
    const every = vi.fn();
    const once = vi.fn();
    const h = renderHook(() => {
      useEffect(every);
      useEffect(once, []);
    });
    h.rerender();
    h.rerender();
    expect(every).toHaveBeenCalledTimes(3);
    expect(once).toHaveBeenCalledTimes(1);
  });

  it("memoizes by deps, and useCallback keeps the function", () => {
    const make = vi.fn((n: number) => ({ n }));
    const h = renderHook(({ n, other }: { n: number; other: number }) => ({ memo: useMemo(() => make(n), [n]), cb: useCallback(() => other, [n]) }), { props: { n: 1, other: 1 } });
    const first = h.result.current;
    h.rerender({ n: 1, other: 2 });
    expect(h.result.current.memo).toBe(first.memo);
    expect(h.result.current.cb).toBe(first.cb);
    h.rerender({ n: 2, other: 2 });
    expect(h.result.current.memo).not.toBe(first.memo);
    expect(make).toHaveBeenCalledTimes(2);
  });

  it("refs are stable", () => {
    const h = renderHook(() => useRef(0));
    const ref = h.result.current;
    h.rerender();
    expect(h.result.current).toBe(ref);
  });

  it("reduces", async () => {
    const h = renderHook(() => useReducer((s: number, a: number) => s + a, 10));
    h.result.current[1](5);
    await h.settle();
    expect(h.result.current[0]).toBe(15);
  });

  it("reads context values given, else the context's default", () => {
    const Ctx = createContext("default");
    expect(renderHook(() => useContext(Ctx)).result.current).toBe("default");
    expect(renderHook(() => useContext(Ctx), { contexts: [[Ctx as never, "given"]] }).result.current).toBe("given");
  });

  it("follows an external store: subscribes, re-renders on a change, unsubscribes", async () => {
    let value = 1;
    const listeners = new Set<() => void>();
    const subscribe = (l: () => void) => (listeners.add(l), () => listeners.delete(l));
    const h = renderHook(() => useSyncExternalStore(subscribe, () => value));
    expect(h.result.current).toBe(1);
    expect(listeners.size).toBe(1);
    value = 2;
    listeners.forEach((l) => l());
    await h.settle();
    expect(h.result.current).toBe(2);
    h.unmount();
    expect(listeners.size).toBe(0);
  });

  it("an external store that changed between render and subscribing is noticed", async () => {
    let value = 1;
    const h = renderHook(() => useSyncExternalStore((l) => ((value = 2), void l, () => {}), () => value));
    await h.settle();
    expect(h.result.current).toBe(2);
  });

  it("stops rendering after unmount", async () => {
    const h = renderHook(() => useState(0));
    const set = h.result.current[1];
    h.unmount();
    set(1);
    await h.settle();
    expect(h.renders).toBe(1);
  });
});
