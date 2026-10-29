// Where the headless device keeps its database between server starts (KUBUS_HEADLESS_DIR): one
// directory holding `headless.db`, a real SQLite file the device opens directly (NodeSqlClient,
// node:sqlite, WAL mode: every commit is on disk when it returns, a crash leaves a consistent
// database), and `headless.lock`, which keeps a second server process off it. This class only
// takes the directory (the lock) and puts a damaged file aside; the database itself is the client's.
// Because the sync cursor, the server's database id and the data are rows of that one database,
// committed together, after a crash the device resumes from the cursor of its last commit and
// fetches what came after (a sync is idempotent).

import { mkdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";

const DB_FILE = "headless.db";
const LOCK_FILE = "headless.lock";
/** The lock holder touches its file this often; one untouched for STALE_MS is a dead holder's. */
const BEAT_MS = 5_000;
const STALE_MS = 20_000;

/** Directories this process holds (a second device in the same process must not take over its own). */
const held = new Set<string>();

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

export class DiskStore {
  /** The database file (it may not exist yet). */
  readonly dbPath: string;
  private beat: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  private constructor(
    readonly dir: string,
    private lock: string,
  ) {
    this.dbPath = join(dir, DB_FILE);
  }

  /** Takes the directory (it is made if needed); throws when another server process uses it. */
  static async open(dir: string): Promise<DiskStore> {
    await mkdir(dir, { recursive: true });
    const lock = join(dir, LOCK_FILE);
    const mine = JSON.stringify({ pid: process.pid, host: hostname() });
    if (held.has(dir)) throw DiskStore.inUse(dir, `this process (pid ${process.pid})`);
    for (let attempt = 0; ; attempt++) {
      try {
        await writeFile(lock, mine, { flag: "wx" });
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        const holder = await DiskStore.holder(lock);
        if (holder || attempt >= 3) throw DiskStore.inUse(dir, holder ?? "unknown");
        await rm(lock, { force: true }); // a dead holder's
      }
    }
    held.add(dir);
    const store = new DiskStore(dir, lock);
    store.beat = setInterval(() => void utimes(lock, new Date(), new Date()).catch(() => {}), BEAT_MS);
    store.beat.unref();
    return store;
  }

  private static inUse(dir: string, holder: string) {
    return new Error(`${dir} is in use by another Kubus server process (${holder}): only one may use KUBUS_HEADLESS_DIR`);
  }

  /** Who holds the lock, or null when nobody does any more (its process is gone, or it stopped touching the file). */
  private static async holder(lock: string): Promise<string | null> {
    try {
      const { pid, host } = JSON.parse(await readFile(lock, "utf8")) as { pid: number; host: string };
      const fresh = Date.now() - (await stat(lock)).mtimeMs < STALE_MS;
      // On this machine (or container) a pid says it all; another machine's holder is told by the file being touched.
      if (host === hostname()) return pid !== process.pid && alive(pid) ? `pid ${pid}` : null;
      return fresh ? `pid ${pid} on ${host}` : null;
    } catch {
      return null; // unreadable or gone
    }
  }

  /** The database could not be opened (damaged file): keeps it aside (with its write-ahead log), so the device starts over. */
  async setAside(): Promise<string> {
    const aside = join(this.dir, `${DB_FILE}.damaged-${Date.now()}`);
    await rename(this.dbPath, aside);
    for (const suffix of ["-wal", "-shm"]) await rm(`${this.dbPath}${suffix}`, { force: true });
    return aside;
  }

  /** Lets go of the directory (the database is closed by then). */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.beat) clearInterval(this.beat);
    held.delete(this.dir);
    await rm(this.lock, { force: true });
  }
}
