// @vitest-environment node
// NodeSqlClient (node.ts): the engine on node:sqlite, where it must behave as on sqlite-wasm (the rest of
// the storage contract runs on both: vitest project `nodesqlite`). Here what is its own: how values are
// bound and read, the file it keeps (WAL, reopening, a damaged one) and the version it refuses.
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { DirectSqlClient } from "./direct";
import { NodeSqlClient } from "./node";

const dir = mkdtempSync(join(tmpdir(), "kubus-node-sqlite-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const file = () => join(dir, `${++n}.db`);

/** Both engines, asked the same: values go in and come back alike. */
const engines = [
  ["node:sqlite", () => NodeSqlClient.open()],
  ["sqlite-wasm", () => DirectSqlClient.open()],
] as const;

describe.each(engines)("values on %s", (_name, open) => {
  const roundTrip = async (...bind: (string | number | Uint8Array | null)[]) => {
    const client = await open();
    const [row] = await client.select<Record<string, unknown>>(`SELECT ${bind.map((_, i) => `?${i + 1} AS v${i}, typeof(?${i + 1}) AS t${i}`).join(", ")}`, bind);
    return row;
  };

  it("binds whole numbers as INTEGER, fractions as REAL, text as TEXT, null as NULL", async () => {
    expect(await roundTrip(1, 1.5, "x", null, -7, 0)).toEqual({ v0: 1, t0: "integer", v1: 1.5, t1: "real", v2: "x", t2: "text", v3: null, t3: "null", v4: -7, t4: "integer", v5: 0, t5: "integer" });
  });

  it("makes json_array of a whole number a whole number", async () => {
    const client = await open();
    expect(await client.select("SELECT json_array(?1, ?2) AS j", [3, 2.5])).toEqual([{ j: "[3,2.5]" }]);
  });

  it("keeps blobs as bytes", async () => {
    const row = await roundTrip(new Uint8Array([0, 1, 255]));
    expect(row.t0).toBe("blob");
    expect(Array.from(row.v0 as Uint8Array)).toEqual([0, 1, 255]);
  });

  it("numbers one parameter once however often it is used, and in any order", async () => {
    const client = await open();
    expect(await client.select("SELECT ?2 AS a, ?1 AS b, ?1 AS c", ["x", "y"])).toEqual([{ a: "y", b: "x", c: "x" }]);
  });

  it("returns integers as numbers while safe, a BigInt beyond", async () => {
    const client = await open();
    expect(await client.select("SELECT 9007199254740991 AS safe, 9007199254740993 AS big, -9007199254740993 AS small")).toEqual([
      { safe: 9007199254740991, big: 9007199254740993n, small: -9007199254740993n },
    ]);
  });

  it("answers rows as plain objects, in column order", async () => {
    const client = await open();
    const [row] = await client.select("SELECT 1 AS b, 2 AS a");
    expect(Object.keys(row as object)).toEqual(["b", "a"]);
  });

  it("registers file_ids() with the schema: a value's files are found by the file_uses triggers", async () => {
    const client = await open();
    expect(await client.select("SELECT file_ids(NULL, 'x') AS ids")).toEqual([{ ids: "[]" }]);
  });
});

describe("a database file", () => {
  it("is persistent, in WAL mode, and a new one is made from the schema", async () => {
    const path = file();
    const client = await NodeSqlClient.open(path);
    expect(client.info).toEqual({ persistent: true, sqliteVersion: expect.stringMatching(/^3\.\d+/) });
    expect(await client.select("PRAGMA journal_mode")).toEqual([{ journal_mode: "wal" }]);
    expect(await client.select("PRAGMA foreign_keys")).toEqual([{ foreign_keys: 1 }]);
    expect(await client.select("PRAGMA busy_timeout")).toEqual([{ timeout: 5000 }]);
    expect((await client.select<{ n: number }>("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'"))[0].n).toBeGreaterThan(10);
    await client.close();
  });

  it("keeps what was written across a close and an open, with its log folded into the one file", async () => {
    const path = file();
    const first = await NodeSqlClient.open(path);
    await first.write([{ sql: "INSERT INTO meta (key, value) VALUES (?1, ?2)", bind: ["k", "v"] }]);
    await first.close();
    expect(readdirSync(dir).filter((f) => f.startsWith(`${n}.db`))).toEqual([`${n}.db`]);
    const second = await NodeSqlClient.open(path);
    expect(await second.select("SELECT key, value FROM meta WHERE key = 'k'")).toEqual([{ key: "k", value: "v" }]);
    await second.close();
    await second.close(); // twice is fine
  });

  it("has a commit in the file before the connection closes: another connection reads it", async () => {
    const path = file();
    const client = await NodeSqlClient.open(path);
    await client.write([{ sql: "INSERT INTO meta (key, value) VALUES ('seen', '1')" }]);
    const other = new DatabaseSync(path, { readOnly: true });
    expect(other.prepare("SELECT value FROM meta WHERE key = 'seen'").all()).toEqual([{ value: "1" }]);
    other.close();
    await client.close();
  });

  it("rolls a failed change set back whole, and works on afterwards", async () => {
    const client = await NodeSqlClient.open(file());
    await expect(
      client.write([
        { sql: "INSERT INTO meta (key, value) VALUES ('a', '1')" },
        { sql: "INSERT INTO meta (key, value) VALUES ('a', '2')" },
      ]),
    ).rejects.toThrow(/UNIQUE/);
    expect(await client.select("SELECT * FROM meta WHERE key = 'a'")).toEqual([]);
    await client.write([{ sql: "INSERT INTO meta (key, value) VALUES ('a', '3')" }]);
    expect(await client.select("SELECT value FROM meta WHERE key = 'a'")).toEqual([{ value: "3" }]);
    await client.close();
  });

  it("waits for another process's write lock instead of failing at once", async () => {
    const path = file();
    const client = await NodeSqlClient.open(path);
    // A process of its own (this one would block while it waits): holds the write lock for 300 ms.
    const holder = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "-e", `
      const db = new (require("node:sqlite").DatabaseSync)(process.argv[1]);
      db.exec("PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE");
      console.log("locked");
      setTimeout(() => { db.exec("COMMIT"); db.close(); }, 300);
    `, path], { stdio: ["ignore", "pipe", "inherit"] });
    await new Promise((resolve) => holder.stdout.once("data", resolve));
    const started = Date.now();
    await client.write([{ sql: "INSERT INTO meta (key, value) VALUES ('late', '1')" }]);
    expect(Date.now() - started).toBeGreaterThan(100);
    expect(await client.select("SELECT value FROM meta WHERE key = 'late'")).toEqual([{ value: "1" }]);
    await client.close();
  });

  it("wipes in place: the file stays, empty, with its schema", async () => {
    const path = file();
    const client = await NodeSqlClient.open(path);
    await client.write([{ sql: "INSERT INTO meta (key, value) VALUES ('a', '1')" }]);
    await client.wipe();
    expect(await client.select("SELECT * FROM meta")).toEqual([]);
    await client.write([{ sql: "INSERT INTO meta (key, value) VALUES ('b', '1')" }]);
    await client.close();
    const again = await NodeSqlClient.open(path);
    expect(await again.select("SELECT key FROM meta")).toEqual([{ key: "b" }]);
    await again.close();
  });

  it("refuses a file that isn't a database, and leaves it as it is", async () => {
    const path = file();
    writeFileSync(path, "this is not a database, not even a long one".repeat(50));
    await expect(NodeSqlClient.open(path)).rejects.toThrow(/not a database/);
    expect(readdirSync(dir)).not.toContain(`${n}.db-wal`);
  });

  it("refuses the database of a newer version and lets go of the file", async () => {
    const path = file();
    await (await NodeSqlClient.open(path)).close();
    const raw = new DatabaseSync(path);
    raw.exec("PRAGMA user_version = 4242");
    raw.close();
    await expect(NodeSqlClient.open(path)).rejects.toThrow(/newer version of Kubus/);
    const again = new DatabaseSync(path);
    expect(again.prepare("PRAGMA user_version").get()).toEqual({ user_version: 4242 });
    again.close();
  });
});

describe("rows on node:sqlite", () => {
  it("are plain objects", async () => {
    const [row] = await (await NodeSqlClient.open()).select("SELECT 1 AS b");
    expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
  });
});

describe("in memory", () => {
  it("is not persistent, and each is its own database", async () => {
    const a = await NodeSqlClient.open();
    const b = await NodeSqlClient.open(":memory:");
    expect(a.info.persistent).toBe(false);
    await a.write([{ sql: "INSERT INTO meta (key, value) VALUES ('a', '1')" }]);
    expect(await b.select("SELECT * FROM meta")).toEqual([]);
  });
});
