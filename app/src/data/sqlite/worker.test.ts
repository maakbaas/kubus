// @vitest-environment node
// The worker's message handling (worker.ts) with `self` replaced: opening in memory where there is no
// OPFS, and the persistent path with the SAH-pool VFS faked. The invariant that matters: the pool is
// installed only once the lock is held and its files are free.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "./protocol";

// Each test builds devices and a database: on a busy machine that outlasts the default 5 s.
vi.setConfig({ testTimeout: 30_000 });

const installPool = vi.fn();
const acquire = vi.fn();
const waitForFiles = vi.fn();

vi.mock("@sqlite.org/sqlite-wasm", async (importOriginal) => {
  const real = (await importOriginal()) as { default: () => Promise<Record<string, unknown> & { oo1: { DB: new (file: string, flags: string) => unknown } }> };
  return { default: async () => ({ ...(await real.default()), installOpfsSAHPoolVfs: installPool }) };
});
vi.mock("./dbLock", async (importOriginal) => ({
  ...((await importOriginal()) as object),
  acquireDbLock: acquire,
  waitForPoolFiles: waitForFiles,
}));

let posted: Response[];
let send: (req: Request) => Promise<Response>;

/** A fresh worker module: its own `engine`, answering through the faked `self`. */
async function startWorker(navigatorStub: object) {
  vi.resetModules();
  posted = [];
  const scope = { onmessage: null as ((e: { data: Request }) => Promise<void>) | null, postMessage: (r: Response) => void posted.push(r) };
  vi.stubGlobal("self", scope);
  vi.stubGlobal("navigator", navigatorStub);
  await import("./worker");
  send = async (req) => {
    await scope.onmessage!({ data: req });
    return posted[posted.length - 1];
  };
}

beforeEach(() => {
  installPool.mockReset();
  acquire.mockReset().mockResolvedValue(undefined);
  waitForFiles.mockReset().mockResolvedValue(true);
});
afterEach(() => vi.unstubAllGlobals());

describe("the worker without OPFS", () => {
  beforeEach(() => startWorker({}));

  it("refuses any request before the database is open", async () => {
    expect(await send({ id: 1, op: "select", sql: "SELECT 1" })).toEqual({ id: 1, ok: false, error: "Database not open" });
    expect(await send({ id: 2, op: "write", statements: [] })).toMatchObject({ ok: false, error: "Database not open" });
    expect(await send({ id: 3, op: "wipe" })).toMatchObject({ ok: false });
  });

  it("opens an in-memory database, not persistent, and answers its reads and writes", async () => {
    const opened = await send({ id: 1, op: "open" });
    expect(opened).toMatchObject({ id: 1, ok: true, result: { persistent: false } });
    expect(installPool).not.toHaveBeenCalled();
    expect(acquire).not.toHaveBeenCalled();
    await send({ id: 2, op: "write", statements: [{ sql: "INSERT INTO meta (key, value) VALUES (?1, ?2)", bind: ["k", "v"] }] });
    expect(await send({ id: 3, op: "select", sql: "SELECT value FROM meta WHERE key = ?1", bind: ["k"] })).toEqual({ id: 3, ok: true, result: [{ value: "v" }] });
  });

  it("opens only once: a second open answers null and keeps the data", async () => {
    await send({ id: 1, op: "open" });
    await send({ id: 2, op: "write", statements: [{ sql: "INSERT INTO meta (key, value) VALUES ('k', 'v')" }] });
    expect(await send({ id: 3, op: "open" })).toEqual({ id: 3, ok: true, result: null });
    expect((await send({ id: 4, op: "select", sql: "SELECT count(*) AS n FROM meta WHERE key = 'k'" })) as { result: unknown }).toMatchObject({ result: [{ n: 1 }] });
  });

  it("wipes to an empty database", async () => {
    await send({ id: 1, op: "open" });
    await send({ id: 2, op: "write", statements: [{ sql: "INSERT INTO meta (key, value) VALUES ('k', 'v')" }] });
    expect(await send({ id: 3, op: "wipe" })).toEqual({ id: 3, ok: true, result: null });
    expect(await send({ id: 4, op: "select", sql: "SELECT * FROM meta WHERE key = 'k'" })).toEqual({ id: 4, ok: true, result: [] });
  });

  it("reports a failing statement as an error answer, and stays usable", async () => {
    await send({ id: 1, op: "open" });
    const failed = await send({ id: 2, op: "write", statements: [{ sql: "INSERT INTO nowhere VALUES (1)" }] });
    expect(failed).toMatchObject({ id: 2, ok: false, error: expect.stringMatching(/nowhere/) });
    expect(await send({ id: 3, op: "select", sql: "SELECT 1 AS one" })).toEqual({ id: 3, ok: true, result: [{ one: 1 }] });
  });
});

/** navigator with OPFS: `storage.getDirectory` exists. */
const opfs = { storage: { getDirectory: async () => ({}) } };

describe("the worker with OPFS", () => {
  it("installs the pool only after the lock is held and its files are free, then persists", async () => {
    const order: string[] = [];
    acquire.mockImplementation(async () => void order.push("lock"));
    waitForFiles.mockImplementation(async () => (order.push("free"), true));
    installPool.mockImplementation(async (options: { name: string }) => {
      order.push(`install ${options.name}`);
      const { default: init } = await vi.importActual<{ default: () => Promise<{ oo1: { DB: new (file: string, flags: string) => unknown } }> }>("@sqlite.org/sqlite-wasm");
      const sqlite3 = await init();
      // `new pool.OpfsSAHPoolDb(file)` is an ordinary database here (the file is not opened).
      const OpfsSAHPoolDb = function (this: unknown, _file: string) {
        return new sqlite3.oo1.DB(":memory:", "c");
      };
      return { OpfsSAHPoolDb };
    });
    await startWorker(opfs);
    expect(await send({ id: 1, op: "open" })).toMatchObject({ ok: true, result: { persistent: true } });
    expect(order).toEqual(["lock", "free", "install kubus-sahpool"]);
  });

  it("never installs the pool while another window still holds a file (that would delete the database)", async () => {
    waitForFiles.mockResolvedValue(false);
    await startWorker(opfs);
    expect(await send({ id: 1, op: "open" })).toEqual({ id: 1, ok: false, error: "The database is still in use by another Kubus window. Close it and reload." });
    expect(installPool).not.toHaveBeenCalled();
    expect(await send({ id: 2, op: "select", sql: "SELECT 1" })).toMatchObject({ ok: false, error: "Database not open" });
  });

  it("never installs the pool when the lock is refused, and says why", async () => {
    acquire.mockRejectedValue(new Error("Kubus is open in another tab or window. Close it there and reload."));
    await startWorker(opfs);
    expect(await send({ id: 1, op: "open" })).toMatchObject({ ok: false, error: expect.stringMatching(/another tab/) });
    expect(waitForFiles).not.toHaveBeenCalled();
    expect(installPool).not.toHaveBeenCalled();
  });

  it("answers a thrown non-error as its text", async () => {
    acquire.mockRejectedValue("plain text");
    await startWorker(opfs);
    expect(await send({ id: 1, op: "open" })).toEqual({ id: 1, ok: false, error: "plain text" });
  });
});
