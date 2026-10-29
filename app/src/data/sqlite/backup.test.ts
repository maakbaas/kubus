// @vitest-environment node
// Backups: the database exported as a SQLite file and restored (engine.ts exportDatabase /
// importDatabase, Repository.exportBackup / checkBackup / restoreBackup): every row survives, a first-release
// database is migrated, a file that isn't a Kubus backup (or is a newer one's) is refused with the database
// untouched, and the sync state of the file is not carried over.
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { newId, type FieldDef } from "../../domain/model";
import { bytes, device, FakeServer, SERVER_URL, settled, TOKEN } from "../../test/fakeServer";
import firstRelease from "../schema-v1.sql?raw";
import firstReleaseData from "../fixture-v1.sql?raw";
import { fileIds } from "../schema";
import type { Db } from "../migrations";
import { DirectSqlClient } from "./direct";
import { BackupRefused, SqliteEngine, type SchemaPlan } from "./engine";
import { SqliteRepository } from "./SqliteRepository";
import { memoryEnvironment } from "../sync/environment";

vi.setConfig({ testTimeout: 30_000 });

let sqlite3: Db;
beforeAll(async () => {
  sqlite3 = await sqlite3InitModule();
});

const field = (name: string, kind: FieldDef["kind"] = "string"): FieldDef => ({
  id: newId(), collectionId: "", name, kind, targetCollectionId: null, componentId: null, code: null, output: null,
  frameRatio: null, choiceFilter: [], toggleIcon: null, strikeThrough: false, position: 0,
});

/** Every row of every table (not the outbox: that is queued sync work), as JSON, in a stable order. */
async function content(client: DirectSqlClient, skip: string[] = ["sync_outbox"]) {
  const tables = (await client.select<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"))
    .map((t) => t.name)
    .filter((t) => !skip.includes(t));
  const out: Record<string, string[]> = {};
  for (const t of tables) {
    const rows = await client.select<Record<string, unknown>>(`SELECT * FROM "${t}"`);
    out[t] = rows.map((r) => JSON.stringify(r, (_, v) => (v instanceof Uint8Array ? `bytes:${Buffer.from(v).toString("hex")}` : v))).sort();
  }
  return out;
}
const schemaOf = (client: DirectSqlClient) => client.select<{ type: string; name: string; sql: string }>("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name");
const version = async (client: DirectSqlClient) => (await client.select<{ user_version: number }>("PRAGMA user_version"))[0].user_version;

/** A client opened on a first-release database with the fixture's rows (the engine migrates it). */
const firstReleaseClient = () =>
  DirectSqlClient.open((db) => {
    db.createFunction("file_ids", (_ctx: number, file: unknown, text: unknown) => fileIds(file, text), { arity: 2, deterministic: true });
    db.exec(firstRelease);
    db.exec(firstReleaseData);
    db.exec("PRAGMA user_version = 1");
  });

describe("exporting and restoring the database", () => {
  it("round trips every row, the schema and the files' bytes, of a first-release database too", async () => {
    const source = await firstReleaseClient();
    const file = await source.exportDatabase();
    expect(new TextDecoder().decode(file.subarray(0, 16))).toBe("SQLite format 3\0");
    const target = await DirectSqlClient.open();
    // The target holds something else first: it is replaced, not merged.
    await target.write([{ sql: "INSERT INTO collections (id, name, plural_name, created_at, updated_at) VALUES ('other', 'Other', 'Others', 'x', 'x')" }]);
    await target.importDatabase(file);
    const copy = await content(target);
    const original = await content(source);
    expect(Object.keys(original.field_values).length).toBeGreaterThan(10);
    expect(Object.values(original).some((rows) => rows.some((r) => r.includes("bytes:")))).toBe(true); // the image's bytes
    expect(copy).toEqual(original);
    expect(await schemaOf(target)).toEqual(await schemaOf(source));
    expect(await version(target)).toBe(await version(source));
    // The restored database works as the app uses it: triggers (file uses, outbox) are there and fire.
    const repo = await SqliteRepository.open(target, memoryEnvironment());
    expect((await repo.listCollections()).map((c) => c.id)).toContain("collection-book");
    expect((await repo.listCollections()).map((c) => c.id)).not.toContain("other");
    expect(await repo.getFile("e06cc5dc61902f1ec01216ae3298216b218ad494ca253a85557ed4e44a23994b")).toEqual({ data: new TextEncoder().encode("cover bytes"), mime: "image/png" });
    const before = (await target.select<{ n: number }>("SELECT count(*) AS n FROM sync_outbox"))[0].n;
    await repo.saveSpace({ id: "later", name: "Later", icon: null });
    expect((await target.select<{ n: number }>("SELECT count(*) AS n FROM sync_outbox"))[0].n).toBeGreaterThan(before);
  });

  it("exports a consistent file while the database is in use and leaves it unchanged", async () => {
    const client = await firstReleaseClient();
    const before = await content(client, []);
    await client.exportDatabase();
    expect(await content(client, [])).toEqual(before);
  });

  it("migrates an older backup after importing it, like any older database", async () => {
    // A small schema in two versions; the backup is a version-1 file with rows.
    const v1 = "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE sync_outbox (id INTEGER PRIMARY KEY, tbl TEXT, pk TEXT);";
    const tables = "CREATE TABLE collections (id TEXT); CREATE TABLE fields (id TEXT); CREATE TABLE items (id TEXT); CREATE TABLE views (id TEXT); CREATE TABLE components (id TEXT); CREATE TABLE spaces (id TEXT);";
    const plan: SchemaPlan = {
      schema: `${v1}${tables} CREATE TABLE notes (id TEXT PRIMARY KEY, name TEXT NOT NULL, tags TEXT);`,
      triggers: "SELECT 1;",
      migrations: [{ version: 2, description: "title becomes name", up: "ALTER TABLE notes RENAME COLUMN title TO name; ALTER TABLE notes ADD COLUMN tags TEXT" }],
    };
    const old = new sqlite3.oo1.DB(":memory:", "c");
    old.exec(`${v1}${tables} CREATE TABLE notes (id TEXT PRIMARY KEY, title TEXT NOT NULL); INSERT INTO notes VALUES ('n1', 'Milk'), ('n2', 'Eggs');
      INSERT INTO meta VALUES ('sync_cursor', '7'), ('keep', 'me'); INSERT INTO sync_outbox (tbl, pk) VALUES ('notes', 'n1'); PRAGMA user_version = 1;`);
    const file: Uint8Array = sqlite3.capi.sqlite3_js_db_export(old.pointer);
    const live = new sqlite3.oo1.DB(":memory:", "c");
    const engine = new SqliteEngine(sqlite3, live);
    engine.importDatabase(file, false, plan);
    expect(engine.select("SELECT id, name, tags FROM notes ORDER BY id")).toEqual([
      { id: "n1", name: "Milk", tags: null },
      { id: "n2", name: "Eggs", tags: null },
    ]);
    expect(engine.select("SELECT key, value FROM meta ORDER BY key")).toEqual([{ key: "keep", value: "me" }]);
    expect(engine.select("SELECT count(*) AS n FROM sync_outbox")).toEqual([{ n: 0 }]);
    expect(live.selectValue("PRAGMA user_version")).toBe(2);
  });

  describe("refuses", () => {
    let target: DirectSqlClient;
    let before: Awaited<ReturnType<typeof content>>;
    beforeEach(async () => {
      target = await firstReleaseClient();
      before = await content(target, []);
    });
    /** The message the file is refused with; the database is checked, and untouched. */
    async function refused(file: Uint8Array): Promise<string> {
      const error = await target.importDatabase(file).then(
        () => null,
        (e) => e as Error,
      );
      expect(error).toBeInstanceOf(BackupRefused);
      await expect(target.importDatabase(file, true)).rejects.toThrow(error!.message); // the check alone says the same
      expect(await content(target, [])).toEqual(before);
      return error!.message;
    }
    const sqliteFile = (sql: string): Uint8Array => {
      const db = new sqlite3.oo1.DB(":memory:", "c");
      db.exec(sql);
      const file: Uint8Array = sqlite3.capi.sqlite3_js_db_export(db.pointer);
      db.close();
      return file;
    };

    it("a file that is not SQLite, empty or too short to be", async () => {
      expect(await refused(new TextEncoder().encode("hello, this is a text file ".repeat(10)))).toMatch(/not a SQLite database/);
      expect(await refused(new Uint8Array(0))).toMatch(/not a SQLite database/);
      expect(await refused(new TextEncoder().encode("SQLite format 3\0"))).toMatch(/not a SQLite database/);
    });

    it("a SQLite database that is not Kubus's", async () => {
      expect(await refused(sqliteFile("CREATE TABLE recipes (id INTEGER); INSERT INTO recipes VALUES (1); PRAGMA user_version = 1;"))).toMatch(/not a Kubus backup/);
    });

    it("a damaged file: the header of a database followed by nothing it can read", async () => {
      const file = await target.exportDatabase();
      const damaged = file.slice();
      damaged.fill(0xab, 100, damaged.length); // keeps the header, ruins every page
      expect(await refused(damaged)).toMatch(/damaged/);
    });

    it("a backup of a newer version of the app, saying to update", async () => {
      const copy = new sqlite3.oo1.DB(":memory:", "c");
      copy.exec(firstRelease);
      copy.exec("PRAGMA user_version = 99");
      const file: Uint8Array = sqlite3.capi.sqlite3_js_db_export(copy.pointer);
      const message = await refused(file);
      expect(message).toMatch(/newer version of Kubus/);
      expect(message).toMatch(/schema 99/);
      expect(message).toMatch(/Update the app/);
    });

    it("a database from before schema versions were counted (a hash in user_version)", async () => {
      const copy = new sqlite3.oo1.DB(":memory:", "c");
      copy.exec(firstRelease);
      copy.exec("PRAGMA user_version = 123456789");
      expect(await refused(sqlite3.capi.sqlite3_js_db_export(copy.pointer))).toMatch(/before Kubus counted/);
    });
  });

  it("does not carry the file's sync state over, and keeps this device's own identity", async () => {
    const source = await firstReleaseClient();
    await source.write([
      { sql: "INSERT OR REPLACE INTO meta (key, value) VALUES ('sync_server', 'https://old.example'), ('sync_cursor', '41'), ('sync_database', 'db-x'), ('replica_id', 'their-replica')" },
    ]);
    expect((await source.select<{ n: number }>("SELECT count(*) AS n FROM sync_outbox"))[0].n).toBeGreaterThan(0);
    const target = await DirectSqlClient.open();
    await target.write([{ sql: "INSERT INTO meta (key, value) VALUES ('replica_id', 'mine')" }]);
    await target.importDatabase(await source.exportDatabase());
    expect(await target.select("SELECT key, value FROM meta ORDER BY key")).toEqual([{ key: "replica_id", value: "mine" }]);
    expect(await target.select("SELECT count(*) AS n FROM sync_outbox")).toEqual([{ n: 0 }]);
  });
});

describe("restoring through the repository", () => {
  let server: FakeServer;
  const repos: SqliteRepository[] = [];
  const keep = (r: SqliteRepository) => (repos.push(r), r);
  beforeEach(() => {
    server = new FakeServer().install();
  });
  afterEach(async () => {
    await Promise.all(repos.splice(0).map((r) => r.sync.pause().catch(() => {})));
    vi.unstubAllGlobals();
  });

  async function withBook(repo: SqliteRepository, title: string) {
    const id = newId();
    await repo.saveCollection({ id, name: "Book", pluralName: "Books", icon: null, description: "", spaceIds: null, fields: [field("Title")] }, "default");
    const book = (await repo.listCollections()).find((c) => c.id === id)!;
    await repo.createItem(book, { [book.fields[0].id]: title }, "default");
    return book;
  }

  it("replaces the data, notifies nothing it must not, and pauses sync so the server is met as for a first time", async () => {
    const backupSource = keep(await device({ connect: false }));
    const book = await withBook(backupSource, "Dune");
    const file = await backupSource.exportBackup();

    // This device syncs with a server that holds other data.
    const a = keep(await device());
    await withBook(a, "Emma");
    await settled(a);
    expect(a.sync.status.state).toBe("idle");
    const serverRows = server.rows("items").length;

    await a.restoreBackup(file);
    expect(a.sync.config).toMatchObject({ url: SERVER_URL, token: TOKEN, enabled: false }); // paused, address and token kept
    expect(a.sync.isNewServer(SERVER_URL)).toBe(true);
    expect(a.sync.status.state).toBe("off");
    const restored = (await a.listCollections()).find((c) => c.id === book.id)!;
    expect((await a.listItems(restored, "default")).map((i) => i.values[restored.fields[0].id])).toEqual(["Dune"]);
    expect(await a.exportBackup()).toBeInstanceOf(Uint8Array);
    // Nothing was sent to the server by the restore, nor does a sync run while paused.
    await a.sync.syncNow();
    expect(server.rows("items")).toHaveLength(serverRows);
    // Switching sync on again is a first connection: the server holds data, so it replaces the restored data.
    await a.sync.configure({ url: SERVER_URL, token: TOKEN, enabled: true, originals: "always" });
    await settled(a);
    const titles = async () => {
      const collections = await a.listCollections();
      return (await Promise.all(collections.map(async (c) => (await a.listItems(c, "default")).map((i) => i.values[c.fields[0].id])))).flat();
    };
    expect(await titles()).toEqual(["Emma"]);
  });

  it("uploads the restored data when the server is empty (a first connection to an empty server)", async () => {
    const source = keep(await device({ connect: false }));
    await withBook(source, "Dune");
    const file = await source.exportBackup();
    const b = keep(await device({ connect: false }));
    await b.restoreBackup(file);
    expect(server.rows("items")).toHaveLength(0);
    await b.sync.configure({ url: SERVER_URL, token: TOKEN, enabled: true, originals: "always" });
    await settled(b);
    expect(server.rows("items")).toHaveLength(1);
    expect(server.rows("collections")).toHaveLength(1);
  });

  it("refuses a file that is no backup before touching anything, sync included", async () => {
    const a = keep(await device());
    await withBook(a, "Emma");
    await settled(a);
    await expect(a.restoreBackup(bytes("not a database"))).rejects.toThrow(/not a SQLite database/);
    await expect(a.checkBackup(bytes("not a database"))).rejects.toBeInstanceOf(BackupRefused);
    expect(a.sync.config.enabled).toBe(true);
    expect((await a.listCollections()).map((c) => c.name)).toEqual(["Book"]);
  });
});
