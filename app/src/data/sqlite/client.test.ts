// @vitest-environment node
// The main thread's side of the worker protocol (client.ts), against a fake Worker.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "./protocol";
import { terminateWorkers, WorkerSqlClient } from "./client";

const defaultAnswer = (req: Request): Response => ({ id: req.id, ok: true, result: req.op === "open" ? { persistent: true, sqliteVersion: "3.x" } : req.op === "select" ? [{ n: 1 }] : null });

class FakeWorker {
  static all: FakeWorker[] = [];
  onmessage: ((e: { data: Response }) => void) | null = null;
  sent: Request[] = [];
  terminated = false;
  /** How the "worker" answers a request (default: ok with `null`, or the open result). */
  static answer: (req: Request) => Response | null = defaultAnswer;
  constructor(readonly url: URL, readonly options: object) {
    FakeWorker.all.push(this);
  }
  postMessage(req: Request) {
    this.sent.push(req);
    const res = FakeWorker.answer(req);
    if (res) queueMicrotask(() => this.onmessage?.({ data: res }));
  }
  terminate() {
    this.terminated = true;
  }
}

beforeEach(() => {
  FakeWorker.all = [];
  FakeWorker.answer = defaultAnswer;
  vi.stubGlobal("Worker", FakeWorker);
});
afterEach(() => {
  terminateWorkers();
  vi.unstubAllGlobals();
});

describe("WorkerSqlClient", () => {
  it("starts a module worker and opens the database through it", async () => {
    const client = await WorkerSqlClient.open();
    expect(client.info).toEqual({ persistent: true, sqliteVersion: "3.x" });
    expect(FakeWorker.all).toHaveLength(1);
    expect(FakeWorker.all[0].options).toEqual({ type: "module" });
    expect(FakeWorker.all[0].url.pathname).toMatch(/worker\.ts$/);
    expect(FakeWorker.all[0].sent).toEqual([{ op: "open", id: 1 }]);
  });

  it("sends reads and writes with increasing ids, and resolves each by its id", async () => {
    const client = await WorkerSqlClient.open();
    expect(await client.select("SELECT ?1", ["a"])).toEqual([{ n: 1 }]);
    await client.write([{ sql: "DELETE FROM meta" }]);
    await client.wipe();
    expect(FakeWorker.all[0].sent.slice(1)).toEqual([
      { op: "select", sql: "SELECT ?1", bind: ["a"], id: 2 },
      { op: "write", statements: [{ sql: "DELETE FROM meta" }], id: 3 },
      { op: "wipe", id: 4 },
    ]);
  });

  it("sends nothing for an empty change set", async () => {
    const client = await WorkerSqlClient.open();
    await client.write([]);
    expect(FakeWorker.all[0].sent).toHaveLength(1); // only "open"
  });

  it("answers concurrent requests each with its own result", async () => {
    const client = await WorkerSqlClient.open();
    const late: Response[] = [];
    FakeWorker.answer = (req) => (req.op === "select" && req.sql === "slow" ? (late.push({ id: req.id, ok: true, result: ["slow"] }), null) : { id: req.id, ok: true, result: ["fast"] });
    const slow = client.select("slow");
    const fast = client.select("fast");
    expect(await fast).toEqual(["fast"]);
    FakeWorker.all[0].onmessage!({ data: late[0] });
    expect(await slow).toEqual(["slow"]);
  });

  it("rejects with the worker's error message", async () => {
    const client = await WorkerSqlClient.open();
    FakeWorker.answer = (req) => ({ id: req.id, ok: false, error: "no such table: nowhere" });
    await expect(client.select("SELECT * FROM nowhere")).rejects.toThrow("no such table: nowhere");
    await expect(client.write([{ sql: "x" }])).rejects.toThrow("no such table");
  });

  it("fails to open when the worker refuses (another window holds the database)", async () => {
    FakeWorker.answer = (req) => ({ id: req.id, ok: false, error: "Kubus is open in another tab or window." });
    await expect(WorkerSqlClient.open()).rejects.toThrow("another tab");
  });

  it("ignores an answer nobody waits for", async () => {
    await WorkerSqlClient.open();
    expect(() => FakeWorker.all[0].onmessage!({ data: { id: 99, ok: true, result: null } })).not.toThrow();
  });
});

describe("terminateWorkers", () => {
  it("shuts down every worker this module started, once", async () => {
    await WorkerSqlClient.open();
    await WorkerSqlClient.open();
    terminateWorkers();
    expect(FakeWorker.all.map((w) => w.terminated)).toEqual([true, true]);
    FakeWorker.all.forEach((w) => (w.terminated = false));
    terminateWorkers(); // forgotten: nothing terminated twice
    expect(FakeWorker.all.map((w) => w.terminated)).toEqual([false, false]);
  });
});
