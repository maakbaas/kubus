// The rules that keep two workers from opening the database's files at once. Kept apart from the
// worker (worker.ts, which only wires them to the messages) so they can be tested with the browser's
// locks and storage replaced. The SAH-pool VFS must never be installed while another worker may
// hold its files: its error handling deletes the pool directory, i.e. the database.

export const POOL_NAME = "kubus-sahpool";
const POOL_DIR = `.${POOL_NAME}`; // the SAH pool's default directory for this name

export const OTHER_TAB = "Kubus is open in another tab or window. Close it there and reload.";

/**
 * Whether another live Kubus worker holds the lock: the holder answers a ping. A reloading page's
 * previous worker is gone by then and doesn't answer, so that case keeps waiting for the lock.
 */
export function holderAnswers(timeoutMs = 400): Promise<boolean> {
  if (typeof BroadcastChannel === "undefined") return Promise.resolve(false);
  return new Promise((resolve) => {
    const channel = new BroadcastChannel("kubus-db");
    const done = (answered: boolean) => {
      clearTimeout(timer);
      channel.close();
      resolve(answered);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    channel.onmessage = (e) => e.data === "pong" && done(true);
    channel.postMessage("ping");
  });
}

/**
 * Exclusive lock on the database for this worker's whole lifetime. A reloading
 * page's previous worker may still hold it for a moment; we wait for it. A
 * second tab is told at once (the holder answers); should it not answer, it waits up to
 * `timeoutMs`, then gives up without touching the files.
 */
export function acquireDbLock(timeoutMs = 10_000): Promise<void> {
  if (!("locks" in navigator)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const held = () => {
      clearTimeout(timer);
      resolve();
      // Answer other tabs' pings for as long as the lock is held.
      if (typeof BroadcastChannel !== "undefined") {
        const channel = new BroadcastChannel("kubus-db");
        channel.onmessage = (e) => e.data === "ping" && channel.postMessage("pong");
      }
      return new Promise<void>(() => {}); // held until the worker terminates
    };
    navigator.locks
      .request("kubus-db", { ifAvailable: true }, (lock) => {
        if (lock) return held();
        // Taken: by another tab (say so now) or by a page that is reloading (wait for it).
        return holderAnswers().then((answered) => {
          if (answered) throw new Error(OTHER_TAB);
          timer = setTimeout(() => controller.abort(), timeoutMs);
          return navigator.locks.request("kubus-db", { signal: controller.signal }, held);
        });
      })
      .catch((e) => reject(e instanceof Error && e.message === OTHER_TAB ? e : new Error(OTHER_TAB)));
  });
}

/** True when every file of the SAH pool can be opened, i.e. no other worker still holds one. */
export async function poolFilesFree(): Promise<boolean> {
  let dir: FileSystemDirectoryHandle;
  try {
    dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(POOL_DIR);
  } catch {
    return true; // no pool yet
  }
  const probe = async (d: FileSystemDirectoryHandle): Promise<boolean> => {
    for await (const handle of (d as unknown as { values(): AsyncIterable<FileSystemHandle> }).values()) {
      if (handle.kind === "directory") {
        if (!(await probe(handle as FileSystemDirectoryHandle))) return false;
        continue;
      }
      try {
        const access = await (handle as FileSystemFileHandle).createSyncAccessHandle();
        access.close();
      } catch {
        return false;
      }
    }
    return true;
  };
  return probe(dir);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits (up to `attempts` x `pauseMs`) until every file of the pool is free; false when it never is. */
export async function waitForPoolFiles(attempts = 50, pauseMs = 100, free: () => Promise<boolean> = poolFilesFree, pause: (ms: number) => Promise<unknown> = sleep): Promise<boolean> {
  let ok = false;
  for (let attempt = 0; attempt < attempts && !ok; attempt++) {
    ok = await free();
    if (!ok) await pause(pauseMs);
  }
  return ok;
}
