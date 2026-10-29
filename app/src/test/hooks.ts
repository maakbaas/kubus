// A minimal host for React hooks, for tests: it runs a hook function the way React does (state, refs,
// memos, effects with their clean-ups, external stores, context values), re-rendering after a state
// change, without a DOM or a renderer (the tests run in node; the GUI suite covers what is drawn).
//
// It implements the hooks the app's own hooks use and throws on the others. It sits on React's
// internal dispatcher slot, so a React upgrade that moves it fails these tests loudly, not silently.
import * as React from "react";

type Cleanup = void | (() => void);
interface Dispatcher {
  [hook: string]: (...args: never[]) => unknown;
}
const internals = (React as unknown as Record<string, { H: Dispatcher | null }>).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;

interface EffectSlot {
  /** Queued to run at least once. */
  queued: boolean;
  deps: readonly unknown[] | undefined;
  create: () => Cleanup;
  cleanup: Cleanup;
}

const same = (a: readonly unknown[] | undefined, b: readonly unknown[] | undefined) => !!a && !!b && a.length === b.length && a.every((x, i) => Object.is(x, b[i]));

class Host<P, R> {
  private slots: unknown[] = [];
  private at = 0;
  private dirty = false;
  private scheduled = false;
  private live = true;
  private pending: EffectSlot[] = [];
  readonly result = { current: undefined as R };
  renders = 0;

  constructor(
    private fn: (props: P) => R,
    public props: P,
    private contexts: Map<React.Context<unknown>, unknown>,
  ) {
    this.render();
  }

  /** The slot of the hook being called, made on the first render. */
  private slot<T>(make: () => T): T {
    if (this.at === this.slots.length) this.slots.push(make());
    return this.slots[this.at++] as T;
  }

  private invalidate() {
    if (!this.live) return;
    this.dirty = true;
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      if (this.dirty) this.render();
    });
  }

  private dispatcher(): Dispatcher {
    const host = this;
    const effect = (create: () => Cleanup, deps?: readonly unknown[]) => {
      const slot = host.slot<EffectSlot>(() => ({ queued: false, deps: undefined, create, cleanup: undefined }));
      if (!slot.queued || deps === undefined || !same(slot.deps, deps)) {
        slot.queued = true;
        slot.create = create;
        slot.deps = deps;
        host.pending.push(slot);
      }
    };
    const state = <T>(initial: T | (() => T)) => {
      const s = host.slot(() => {
        const box = { value: typeof initial === "function" ? (initial as () => T)() : initial, set: (_: T | ((p: T) => T)) => {} };
        box.set = (next) => {
          const value = typeof next === "function" ? (next as (p: T) => T)(box.value) : next;
          if (Object.is(value, box.value)) return;
          box.value = value;
          host.invalidate();
        };
        return box;
      });
      return [s.value, s.set] as const;
    };
    const memo = <T>(make: () => T, deps: readonly unknown[]) => {
      const s = host.slot<{ deps: readonly unknown[] | null; value: T }>(() => ({ deps: null, value: undefined as T }));
      if (!s.deps || !same(s.deps, deps)) {
        s.value = make();
        s.deps = deps;
      }
      return s.value;
    };
    return {
      useState: state,
      useReducer: <S, A>(reducer: (s: S, a: A) => S, initial: S, init?: (i: S) => S) => {
        const s = host.slot(() => ({ value: init ? init(initial) : initial, dispatch: (_: A) => {} }));
        s.dispatch = (action) => {
          const value = reducer(s.value, action);
          if (!Object.is(value, s.value)) {
            s.value = value;
            host.invalidate();
          }
        };
        return [s.value, s.dispatch] as const;
      },
      useRef: <T>(initial: T) => host.slot(() => ({ current: initial })),
      useMemo: memo,
      useCallback: <T>(fn: T, deps: readonly unknown[]) => memo(() => fn, deps),
      useEffect: effect,
      useLayoutEffect: effect,
      useInsertionEffect: effect,
      useContext: (context: React.Context<unknown>) => (host.contexts.has(context) ? host.contexts.get(context) : (context as unknown as { _currentValue: unknown })._currentValue),
      useSyncExternalStore: <T>(subscribe: (l: () => void) => () => void, getSnapshot: () => T) => {
        const s = host.slot<{ value: T; subscribe?: unknown; getSnapshot: () => T }>(() => ({ value: getSnapshot(), getSnapshot }));
        s.getSnapshot = getSnapshot;
        s.value = getSnapshot();
        effect(() => {
          const check = () => {
            if (!Object.is(s.value, s.getSnapshot())) host.invalidate();
          };
          const off = subscribe(check);
          check();
          return off;
        }, [subscribe]);
        return s.value;
      },
      useId: () => host.slot(() => `:r${host.slots.length}:`),
      useDebugValue: () => undefined,
      useDeferredValue: <T>(value: T) => value,
      useImperativeHandle: () => undefined,
      useTransition: () => [false, (fn: () => void) => fn()] as const,
    } as unknown as Dispatcher;
  }

  render() {
    this.dirty = false;
    this.at = 0;
    this.renders++;
    const previous = internals.H;
    internals.H = this.dispatcher();
    try {
      this.result.current = this.fn(this.props);
    } finally {
      internals.H = previous;
    }
    // Effects run after the render, clean-ups first (as React does).
    const run = this.pending.splice(0);
    for (const slot of run) {
      if (typeof slot.cleanup === "function") slot.cleanup();
      slot.cleanup = undefined;
    }
    for (const slot of run) slot.cleanup = slot.create();
  }

  rerender(props: P) {
    this.props = props;
    this.render();
  }

  /** Lets promises and re-renders caused by state changes run their course. */
  async settle() {
    for (let i = 0; i < 100; i++) {
      await Promise.resolve();
      if (this.dirty) this.render();
    }
  }

  unmount() {
    this.live = false;
    for (const s of this.slots as Partial<EffectSlot>[]) if (s && typeof s === "object" && "create" in s && typeof s.cleanup === "function") s.cleanup();
  }
}

export interface RenderedHook<P, R> {
  /** The hook's latest return value. */
  result: { current: R };
  /** How many times it rendered. */
  readonly renders: number;
  /** Renders again with new props. */
  rerender(props?: P): void;
  /** Lets pending promises and the re-renders they cause finish. */
  settle(): Promise<void>;
  /** Runs the effects' clean-ups; the hook no longer re-renders. */
  unmount(): void;
}

/** Renders `hook` once and keeps it alive: `{ contexts }` are the values `useContext` reads for given contexts. */
export function renderHook<P = void, R = unknown>(hook: (props: P) => R, options: { props?: P; contexts?: [React.Context<never>, unknown][] } = {}): RenderedHook<P, R> {
  const host = new Host(hook, options.props as P, new Map(options.contexts as [React.Context<unknown>, unknown][] | undefined));
  return {
    result: host.result,
    get renders() {
      return host.renders;
    },
    rerender: (props) => host.rerender(props === undefined ? host.props : props),
    settle: () => host.settle(),
    unmount: () => host.unmount(),
  };
}
