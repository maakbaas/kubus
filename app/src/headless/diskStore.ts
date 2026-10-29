// Where the headless device keeps its database between server starts (KUBUS_HEADLESS_DIR): one
// directory holding `headless.db`, a SQLite file, and `headless.lock`, which keeps a second server
// process off it. sqlite-wasm under Node has no file system, so the database lives in memory and
// is saved as a whole: a snapshot (`DirectSqlClient.export`) written to a temporary file, flushed,
// and renamed over the old one. The file is therefore always one complete database, never half of
// a write; and because the sync cursor, the server's database id and the data are all rows of that
// one database, a snapshot is consistent by construction: after a crash the device resumes from the
// cursor of its last snapshot and fetches what came after (a sync is idempotent).

import { mkdir, open, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";

const DB_FILE = "headless.db";
const LOCK_FILE = "headless.lock";
/** The lock holder touches its file this often; one untouched for STALE_MS is a dead holder's. */
const BEAT_MS = 5_000;
const STALE_MS = 20_000;
/** Snapshots are at least this far apart, and 10 times as far as the last one took to write. */
const MIN_GAP_MS = 1_000;

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
  /** The database file's bytes as found at start, undefined when there is none yet. */
  loaded: Uint8Array | undefined;
  private export: (() => Uint8Array) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private beat: ReturnType<typeof setInterval> | null = null;
  private writing: Promise<void> = Promise.resolve();
  private lastCost = 0;
  private dirty = false;
  private closed = false;

  private constructor(
    readonly dir: string,
    private lock: string,
  ) {}

  /** Takes the directory (it is made if needed) and reads its database; throws when another server process uses it. */
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
    try {
      store.loaded = await readFile(join(dir, DB_FILE)).then((b) => new Uint8Array(b.buffer, b.byteOffset, b.length), (e: NodeJS.ErrnoException) => {
        if (e.code === "ENOENT") return undefined;
        throw e;
      });
    } catch (e) {
      await store.close();
      throw e;
    }
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

  /** The database could not be opened (damaged file): keeps it aside, so the device starts over. */
  async setAside(): Promise<string> {
    const aside = join(this.dir, `${DB_FILE}.damaged-${Date.now()}`);
    await rename(join(this.dir, DB_FILE), aside);
    this.loaded = undefined;
    return aside;
  }

  /** The database to save: `changed` (to give it) saves a snapshot soon after a write. */
  attach(exportDb: () => Uint8Array) {
    this.export = exportDb;
  }

  readonly changed = () => {
    this.dirty = true;
    if (this.timer || this.closed) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, Math.max(MIN_GAP_MS, this.lastCost * 10));
    this.timer.unref();
  };

  /** Writes a snapshot now if anything changed since the last one. */
  flush(): Promise<void> {
    this.writing = this.writing.then(async () => {
      if (!this.dirty || !this.export) return;
      this.dirty = false;
      const started = Date.now();
      const tmp = join(this.dir, `${DB_FILE}.tmp`);
      try {
        const file = await open(tmp, "w");
        try {
          await file.writeFile(this.export());
          await file.sync();
        } finally {
          await file.close();
        }
        await rename(tmp, join(this.dir, DB_FILE));
        this.lastCost = Date.now() - started;
      } catch (e) {
        this.dirty = true; // the next write tries again
        console.warn(`Saving the headless device's database failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    });
    return this.writing;
  }

  /** Saves the last changes and lets go of the directory. */
  async close(): Promise<void> {
    if (this.closed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.flush();
    this.closed = true;
    if (this.beat) clearInterval(this.beat);
    held.delete(this.dir);
    await rm(this.lock, { force: true });
  }
}
