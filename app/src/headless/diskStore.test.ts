// @vitest-environment node
// The headless device with a data directory (KUBUS_HEADLESS_DIR): its database is a real file
// (node:sqlite, WAL), a restart resumes from it, a replaced server database starts it over, and one
// directory belongs to one process.
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HeadlessOptions } from "../../../shared/api";
import { SYNC_COMPATIBLE, SYNC_VERSION, type SyncRequest } from "../../../shared/sync";
import { FakeServer, SERVER_URL, TOKEN } from "../test/fakeServer";
import { startHeadless } from "./index";

vi.setConfig({ testTimeout: 30_000 });

let server: FakeServer;
let logged: string[];
let dir: string;
/** The `since` of every sync request the devices sent. */
let sinces: number[];

const options = (over: Partial<HeadlessOptions> = {}): HeadlessOptions => ({
  serverUrl: SERVER_URL, token: TOKEN, cursor: () => server.seq, webhooks: { urls: [], secret: null }, log: (m) => void logged.push(m), dataDir: dir, ...over,
});

beforeEach(() => {
  server = new FakeServer().install();
  const real = server.fetch;
  sinces = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    if (url.endsWith("/api/sync")) sinces.push((JSON.parse(String(init.body)) as SyncRequest).since);
    return real(url, init);
  });
  logged = [];
  dir = join(mkdtempSync(join(tmpdir(), "kubus-headless-dir-")), "data"); // not there yet: the device makes it
});
afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(join(dir, ".."), { recursive: true, force: true });
});

type Api = Awaited<ReturnType<typeof startHeadless>>;
const get = (api: Api, path: string, method = "GET", body?: unknown) => {
  const url = new URL(`http://localhost/api/v1${path}`);
  const data = new TextEncoder().encode(body === undefined ? "" : JSON.stringify(body));
  return api.handle({ method, path: url.pathname, query: url.searchParams, headers: {}, body: async () => data });
};
const spaces = async (api: Api) => ((await get(api, "/spaces")).json as { name: string }[]).map((s) => s.name);
const row = (id: string, name: string) => ({ id, name, icon: null, position: 1, created_at: "2026-10-28T10:00:00.000Z", updated_at: "2026-10-28T10:00:00.000Z", deleted_at: null });
const elsewhere = (...rows: ReturnType<typeof row>[]) => server.sync({ since: 0, changes: { spaces: rows }, version: SYNC_VERSION, compatible: SYNC_COMPATIBLE });

describe("a restart with a data directory", () => {
  it("starts empty the first time, downloading everything", async () => {
    elsewhere(row("a", "Elsewhere"));
    const api = await startHeadless(options());
    expect(logged).toEqual([expect.stringContaining("the first sync downloads everything")]);
    expect(sinces[0]).toBe(0);
    expect(await spaces(api)).toContain("Elsewhere");
    await api.close();
  });

  it("resumes from the saved cursor: no full download, the data there at once", async () => {
    elsewhere(row("a", "Elsewhere"));
    const first = await startHeadless(options());
    await get(first, "/spaces", "POST", { name: "Made here" });
    await first.close();

    sinces = [];
    logged = [];
    const second = await startHeadless(options());
    expect(logged).toEqual([expect.stringContaining(`holds the server's data up to write ${server.seq}`)]);
    expect(sinces).toEqual([server.seq]); // one sync, from the cursor: no request for everything
    expect(await spaces(second)).toEqual(expect.arrayContaining(["Elsewhere", "Made here"]));
    await second.close();
  });

  it("fetches only what the server got while it was down", async () => {
    const first = await startHeadless(options());
    await first.close();
    const saved = server.seq;
    elsewhere(row("b", "While down"));
    sinces = [];
    const second = await startHeadless(options());
    expect(sinces).toEqual([saved]);
    expect(await spaces(second)).toContain("While down");
    await second.close();
  });

  it("has every write in the file at once, not only on close: a second connection sees it", async () => {
    const api = await startHeadless(options());
    await get(api, "/spaces", "POST", { name: "Committed" });
    const other = new DatabaseSync(join(dir, "headless.db"), { readOnly: true });
    expect(other.prepare("SELECT name FROM spaces WHERE name = 'Committed'").all()).toEqual([{ name: "Committed" }]);
    expect(other.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    other.close();
    await api.close();
  });

  it("leaves one file when it closes: the write-ahead log is folded into the database", async () => {
    const api = await startHeadless(options());
    await get(api, "/spaces", "POST", { name: "Folded in" });
    await api.close();
    expect(readdirSync(dir)).toEqual(["headless.db"]);
  });

  it("is consistent after a crash: a log left behind is replayed, the cursor and the data agree", async () => {
    const first = await startHeadless(options());
    await get(first, "/spaces", "POST", { name: "Before the crash" });
    // A crash: the process is gone without closing the database, so its log and lock stay behind.
    // (The copy is what a disk holds at that moment; the lock is a dead process's.)
    const crashed = join(dir, "..", "crashed");
    mkdirSync(crashed);
    for (const f of readdirSync(dir)) if (f !== "headless.lock") copyFileSync(join(dir, f), join(crashed, f));
    expect(readdirSync(crashed)).toContain("headless.db-wal");
    await first.close();

    sinces = [];
    const second = await startHeadless(options({ dataDir: crashed }));
    expect(sinces).toEqual([server.seq]); // resumed from the cursor the log held
    expect(await spaces(second)).toContain("Before the crash");
    await second.close();
    const check = new DatabaseSync(join(crashed, "headless.db"), { readOnly: true });
    expect(check.prepare("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
    check.close();
  });

  it("starts over when the server's database was wiped while it was down", async () => {
    const first = await startHeadless(options());
    for (const name of ["A", "B", "C"]) await get(first, "/spaces", "POST", { name });
    await first.close();
    server.wipe();
    elsewhere(row("n", "New"));
    logged = [];
    const second = await startHeadless(options());
    expect(logged).toContain("The server's database was replaced: the headless device starts over");
    const names = await spaces(second);
    expect(names).toContain("New");
    expect(names).not.toContain("A");
    await second.close();
  });

  it("starts over with a database from a different server", async () => {
    elsewhere(row("a", "Old server's"));
    const first = await startHeadless(options());
    await first.close();
    server.wipe(); // another server: another database id
    elsewhere(row("x", "Other server's"));
    logged = [];
    const second = await startHeadless(options());
    expect(logged).toContain("The server's database was replaced: the headless device starts over");
    expect(await spaces(second)).toEqual(expect.arrayContaining(["Other server's"]));
    expect(await spaces(second)).not.toContain("Old server's");
    await second.close();
    // And what it holds now is the new server's: the next start resumes.
    sinces = [];
    const third = await startHeadless(options());
    expect(sinces).toEqual([server.seq]);
    await third.close();
  });

  it("puts a file that isn't a database aside and starts over", async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "headless.db"), "this is not a database, not even a long one".repeat(50));
    elsewhere(row("a", "Elsewhere"));
    const api = await startHeadless(options());
    expect(logged.some((m) => m.includes("can't be opened") && m.includes("headless.db.damaged-"))).toBe(true);
    expect(readdirSync(dir).some((f) => f.startsWith("headless.db.damaged-"))).toBe(true);
    expect(await spaces(api)).toContain("Elsewhere");
    await api.close();
  });

  it("leaves a database of a newer version alone and doesn't start", async () => {
    const first = await startHeadless(options());
    await first.close();
    const file = new DatabaseSync(join(dir, "headless.db"));
    file.exec("PRAGMA user_version = 9999");
    file.close();
    await expect(startHeadless(options())).rejects.toThrow(/newer version of Kubus/);
    expect(readdirSync(dir).sort()).toEqual(["headless.db"]); // not set aside, and the lock given up
    const again = new DatabaseSync(join(dir, "headless.db"));
    expect(again.prepare("PRAGMA user_version").get()).toEqual({ user_version: 9999 });
    again.close();
  });
});

describe("the data directory's lock", () => {
  it("refuses a second device in the directory, and gives it up on close", async () => {
    const first = await startHeadless(options());
    await expect(startHeadless(options())).rejects.toThrow(/is in use by another Kubus server process/);
    await first.close();
    await (await startHeadless(options())).close();
  });

  it("refuses a directory a live process on this machine holds", async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "headless.lock"), JSON.stringify({ pid: process.ppid, host: hostname() }));
    await expect(startHeadless(options())).rejects.toThrow(new RegExp(`pid ${process.ppid}\\b.*only one may use KUBUS_HEADLESS_DIR`));
  });

  it("refuses a directory another machine touched a moment ago", async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "headless.lock"), JSON.stringify({ pid: 1, host: "some-other-host" }));
    await expect(startHeadless(options())).rejects.toThrow(/pid 1 on some-other-host/);
  });

  it("takes over the lock of a process that is gone, or of an old one on another machine", async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "headless.lock"), JSON.stringify({ pid: 2 ** 22 + 12345, host: hostname() }));
    await (await startHeadless(options())).close();
    writeFileSync(join(dir, "headless.lock"), JSON.stringify({ pid: 1, host: "some-other-host" }));
    const old = new Date(Date.now() - 60_000);
    
    utimesSync(join(dir, "headless.lock"), old, old);
    await (await startHeadless(options())).close();
  });

  it("gives the lock up when the device can't start, so the next try can", async () => {
    server.compatible = 99;
    await expect(startHeadless(options())).rejects.toMatchObject({ status: 503 });
    server.compatible = SYNC_COMPATIBLE;
    expect(readdirSync(dir)).not.toContain("headless.lock");
    await (await startHeadless(options())).close();
  });
});
