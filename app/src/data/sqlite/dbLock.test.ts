// @vitest-environment node
// The rules that protect the database's files (dbLock.ts): the SAH-pool VFS deletes the database when
// it can't open a file another worker holds, so a worker only goes on once it holds the lock and every
// file is free. The browser's locks and storage are replaced by fakes; tabs talk over Node's real
// BroadcastChannel.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireDbLock, holderAnswers, OTHER_TAB, poolFilesFree, waitForPoolFiles } from "./dbLock";

// Each test builds devices and a database: on a busy machine that outlasts the default 5 s.
vi.setConfig({ testTimeout: 30_000 });

// A holder answers pings for as long as its worker lives; here the channels are closed after each test.
const channels: BroadcastChannel[] = [];
beforeEach(() => {
  vi.stubGlobal("BroadcastChannel", class extends BroadcastChannel {
    constructor(name: string) {
      super(name);
      channels.push(this);
    }
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const channel of channels.splice(0)) channel.close();
});

/** navigator.locks for one origin: exclusive, `ifAvailable`, and a waiting request that can be aborted. */
class FakeLocks {
  private held = false;
  private queue: (() => void)[] = [];

  request(name: string, a: unknown, b?: unknown): Promise<unknown> {
    const options = (typeof a === "function" ? {} : a) as { ifAvailable?: boolean; signal?: AbortSignal };
    const callback = (typeof a === "function" ? a : b) as (lock: object | null) => unknown;
    const run = async () => {
      this.held = true;
      try {
        return await callback({ name });
      } finally {
        this.held = false;
        this.queue.shift()?.();
      }
    };
    if (!this.held) return run();
    if (options.ifAvailable) return Promise.resolve(callback(null));
    return new Promise((resolve, reject) => {
      const start = () => run().then(resolve, reject);
      this.queue.push(start);
      options.signal?.addEventListener("abort", () => {
        this.queue = this.queue.filter((q) => q !== start);
        reject(new DOMException("aborted", "AbortError"));
      });
    });
  }

  /** Holds the lock the way a worker that is going away does: without answering pings, until `release`. */
  hold(): { release(): void } {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    void this.request("kubus-db", () => gate);
    return { release };
  }
}

const withLocks = () => {
  const locks = new FakeLocks();
  vi.stubGlobal("navigator", { locks });
  return locks;
};

describe("acquireDbLock", () => {
  it("goes on at once where there are no locks", async () => {
    vi.stubGlobal("navigator", {});
    await expect(acquireDbLock()).resolves.toBeUndefined();
  });

  it("takes a free lock, and answers other tabs' pings while it is held", async () => {
    withLocks();
    await acquireDbLock();
    expect(await holderAnswers(30_000)).toBe(true);
  });

  it("tells a second tab at once that Kubus is open elsewhere", async () => {
    withLocks();
    await acquireDbLock();
    const started = Date.now();
    await expect(acquireDbLock(60_000)).rejects.toThrow(OTHER_TAB);
    expect(Date.now() - started).toBeLessThan(30_000); // the holder answered: no waiting for the timeout
  });

  it("waits for a reloading page's worker, which no longer answers, and then takes the lock", async () => {
    const locks = withLocks();
    const old = locks.hold();
    const acquired = acquireDbLock(30_000);
    setTimeout(() => old.release(), 600); // after the ping went unanswered
    await expect(acquired).resolves.toBeUndefined();
    expect(await holderAnswers(30_000)).toBe(true); // and now it holds it
  });

  it("gives up after its timeout when the holder never lets go, without answering", async () => {
    const locks = withLocks();
    locks.hold();
    await expect(acquireDbLock(100)).rejects.toThrow(OTHER_TAB);
  });

  it("waits without pings where BroadcastChannel is missing", async () => {
    const locks = withLocks();
    vi.stubGlobal("BroadcastChannel", undefined);
    expect(await holderAnswers()).toBe(false);
    const old = locks.hold();
    const acquired = acquireDbLock(30_000);
    setTimeout(() => old.release(), 50);
    await expect(acquired).resolves.toBeUndefined();
  });
});

describe("holderAnswers", () => {
  it("is false when nobody answers within the time", async () => {
    expect(await holderAnswers(50)).toBe(false);
  });
});

/** An OPFS directory with these entries: a file is `true` (free) or `false` (another worker holds it), a directory an object. */
type Tree = { [name: string]: boolean | Tree };
function directory(tree: Tree, closed: string[] = [], path = ""): unknown {
  return {
    kind: "directory",
    async *values() {
      for (const [name, entry] of Object.entries(tree)) {
        yield typeof entry === "object"
          ? { name, ...(directory(entry, closed, `${path}${name}/`) as object) }
          : {
              kind: "file",
              name,
              async createSyncAccessHandle() {
                if (!entry) throw new DOMException("held", "NoModificationAllowedError");
                return { close: () => void closed.push(`${path}${name}`) };
              },
            };
      }
    },
  };
}
const storage = (pool: unknown) =>
  vi.stubGlobal("navigator", {
    storage: {
      getDirectory: async () => ({
        async getDirectoryHandle(name: string) {
          if (name !== ".kubus-sahpool" || !pool) throw new DOMException("none", "NotFoundError");
          return pool;
        },
      }),
    },
  });

describe("poolFilesFree", () => {
  it("is true before any pool exists", async () => {
    storage(null);
    expect(await poolFilesFree()).toBe(true);
  });

  it("is true when every file opens, and lets each go again", async () => {
    const closed: string[] = [];
    storage(directory({ "a.sqlite3": true, "b.sqlite3": true }, closed));
    expect(await poolFilesFree()).toBe(true);
    expect(closed).toEqual(["a.sqlite3", "b.sqlite3"]);
  });

  it("is false when one file is held by another worker", async () => {
    storage(directory({ "a.sqlite3": true, "b.sqlite3": false }));
    expect(await poolFilesFree()).toBe(false);
  });

  it("looks into subdirectories too", async () => {
    storage(directory({ sub: { deeper: { "c.sqlite3": false } }, "a.sqlite3": true }));
    expect(await poolFilesFree()).toBe(false);
    storage(directory({ sub: { "c.sqlite3": true } }));
    expect(await poolFilesFree()).toBe(true);
  });
});

describe("waitForPoolFiles", () => {
  it("tries again, pausing between tries, until the files are free", async () => {
    const answers = [false, false, true];
    const pauses: number[] = [];
    const free = vi.fn(async () => answers.shift()!);
    expect(await waitForPoolFiles(50, 100, free, async (ms) => void pauses.push(ms))).toBe(true);
    expect(free).toHaveBeenCalledTimes(3);
    expect(pauses).toEqual([100, 100]);
  });

  it("gives up after the given number of tries", async () => {
    const free = vi.fn(async () => false);
    expect(await waitForPoolFiles(5, 1, free, async () => {})).toBe(false);
    expect(free).toHaveBeenCalledTimes(5);
  });

  it("asks the real pool by default", async () => {
    storage(null);
    expect(await waitForPoolFiles()).toBe(true);
  });
});
