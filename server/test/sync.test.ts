// @vitest-environment node
// The server's side of the sync protocol (src/sync.ts) and its schema (src/schema.ts,
// src/migrations.ts, src/wipe.ts), in-process against a real database (KUBUS_TEST_POSTGRES:
// ./postgres.ts). ./database.test.ts has the migrations' own cases; ./http.test.ts the endpoint.
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SYNC_TABLES, SYNC_VERSION, type SyncRequest, type WireRow } from "../../shared/sync.ts";
import { createPool } from "../src/db.ts";
import { applySchema } from "../src/migrations.ts";
import { loadSchema } from "../src/schema.ts";
import { currentCursor, handleSync, refusal } from "../src/sync.ts";
import { wipe } from "../src/wipe.ts";
import { ADMIN, createDatabase, dropDatabase } from "./postgres.ts";

const DB = "kubus_sync_test";
const T1 = "2026-10-01T00:00:00.000Z";
const T2 = "2026-10-02T00:00:00.000Z";
const T3 = "2026-10-03T00:00:00.000Z";
const space = (id: string, name: string, updated_at = T1, over: WireRow = {}): WireRow =>
  ({ id, name, icon: null, position: 0, created_at: T1, updated_at, deleted_at: null, ...over });

describe.skipIf(!ADMIN)("the server's side of sync", () => {
  let pool: pg.Pool;
  let schemaSql: string;

  beforeAll(async () => {
    schemaSql = await loadSchema();
    pool = createPool(await createDatabase(DB));
  });
  afterAll(async () => {
    await pool?.end();
    await dropDatabase(DB);
  });
  beforeEach(async () => {
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
    await applySchema(pool, schemaSql);
  });

  /** A sync as a current device makes it; the answer when it was a normal one. */
  const sync = async (changes: Record<string, WireRow[]>, over: Partial<SyncRequest> = {}) => {
    const result = await handleSync(pool, { since: 0, changes, version: SYNC_VERSION, compatible: SYNC_VERSION, ...over });
    if (!("cursor" in result)) throw new Error(`Not a normal answer: ${JSON.stringify(result)}`);
    return result;
  };
  const names = async () => (await pool.query("SELECT id, name FROM spaces ORDER BY id")).rows.map((r) => `${r.id}=${r.name}`);

  describe("what a request writes and gives back", () => {
    it("gives a device what it hasn't got from its cursor on, and not what it pushed", async () => {
      const first = await sync({ spaces: [space("a", "A"), space("b", "B")] });
      expect(first).toMatchObject({ wrote: true, cursor: 2, changes: {} });
      const other = await sync({}, { since: 0 });
      expect(other.wrote).toBe(false);
      expect(other.changes.spaces.map((r) => r.id)).toEqual(["a", "b"]);
      const second = await sync({ spaces: [space("c", "C")] }, { since: first.cursor });
      expect(second.changes).toEqual({}); // its own push isn't echoed
      expect((await sync({}, { since: first.cursor })).changes.spaces.map((r) => r.id)).toEqual(["c"]);
      expect((await sync({}, { since: second.cursor })).changes).toEqual({});
    });

    it("orders what it gives back by when it was written, rewritten rows last", async () => {
      await sync({ spaces: [space("a", "A"), space("b", "B")] });
      await sync({ spaces: [space("a", "A2", T2)] });
      expect((await sync({})).changes.spaces.map((r) => r.id)).toEqual(["b", "a"]);
    });

    it("starts over for a device ahead of the server (its database was reset)", async () => {
      await sync({ spaces: [space("a", "A")] });
      const answer = await sync({}, { since: 999 });
      expect(answer.cursor).toBe(1);
      expect(answer.changes.spaces).toHaveLength(1);
    });

    it("reads a missing cursor as the start, and a missing list of changes as none", async () => {
      await sync({ spaces: [space("a", "A")] });
      const answer = await handleSync(pool, { version: SYNC_VERSION, compatible: SYNC_VERSION } as unknown as SyncRequest);
      expect(answer).toMatchObject({ cursor: 1, wrote: false });
      expect("changes" in answer && answer.changes.spaces).toHaveLength(1);
    });

    it("tells the cursor of the latest write, 0 for a database nothing was written to", async () => {
      expect(await currentCursor(pool)).toBe(0);
      expect((await sync({})).cursor).toBe(0);
      await sync({ spaces: [space("a", "A")] });
      expect(await currentCursor(pool)).toBe(1);
    });

    it("carries every type through: booleans, JSON, dates, timestamps, numbers, nulls", async () => {
      const collection = { id: "c", name: "Books", plural_name: null, icon: null, description: null, item_views: '[{"id":"v"}]', space_ids: "[]", source: null, title_field: null, created_at: T1, updated_at: T1, deleted_at: null };
      const value = { item_id: "i", field_id: "f", value_text: "t", value_number: 1.5, value_date: "2026-02-03", value_datetime: "2026-02-03T04:05:06.000Z", value_bool: 1, value_ref: null, value_file: null, value_json: '{"a":[1,2]}', updated_at: T1 };
      await sync({ collections: [collection], field_values: [value, { ...value, item_id: "j", value_bool: 0, value_number: null, value_json: null, value_date: null }] });
      const got = (await sync({})).changes;
      expect(got.collections[0]).toMatchObject({ item_views: '[{"id":"v"}]', space_ids: "[]", source: null });
      const [i, j] = got.field_values;
      expect(i).toEqual(value);
      expect(j).toMatchObject({ value_bool: 0, value_number: null, value_json: null, value_date: null });
      expect(got.spaces).toBeUndefined();
    });

    it("writes more rows than one statement takes, and rows with different columns in one push", async () => {
      const many = Array.from({ length: 2500 }, (_, i) => space(`s${String(i).padStart(4, "0")}`, `Space ${i}`));
      const { icon: _icon, ...older } = space("old", "Hand-made, without its icon");
      await sync({ spaces: [...many, older] });
      expect((await pool.query("SELECT count(*)::int AS n FROM spaces")).rows).toEqual([{ n: 2501 }]);
      expect((await pool.query("SELECT icon FROM spaces WHERE id = 'old'")).rows).toEqual([{ icon: null }]);
      expect((await sync({})).changes.spaces).toHaveLength(2501);
    });

    it("takes the last of a row sent twice in one push", async () => {
      await sync({ spaces: [space("a", "first", T3), space("a", "last", T1)] });
      expect(await names()).toEqual(["a=last"]);
    });

    it("stores the item links a device derives (jsonb targets) and hands them back as the text it was sent", async () => {
      // The canonical text of the app (domain/backlinks.ts linkTargets): keys in jsonb's order, so it survives the round trip.
      const targets = '[{"item":"i1","collection":"c1"},{"item":"i2","collection":"c2"}]';
      const row = { id: "item/field", source_item_id: "item", source_field_id: "field", targets, updated_at: T2, deleted_at: null };
      await sync({ item_links: [row] });
      expect((await pool.query("SELECT targets, pg_typeof(targets)::text AS type FROM item_links")).rows).toEqual([{ targets: JSON.parse(targets), type: "jsonb" }]);
      expect((await sync({})).changes.item_links).toEqual([row]);
    });

    it("lets the newer item link win, as it does for the value it belongs to, and keeps the stored one on an equal stamp", async () => {
      const link = (targets: string, updated_at: string, deleted_at: string | null = null) => ({ id: "i/f", source_item_id: "i", source_field_id: "f", targets, updated_at, deleted_at });
      await sync({ item_links: [link('[{"item":"a","collection":"c"}]', T2)] });
      await sync({ item_links: [link('[{"item":"old","collection":"c"}]', T1)] });
      await sync({ item_links: [link('[{"item":"tie","collection":"c"}]', T2)] });
      expect((await pool.query("SELECT targets FROM item_links")).rows).toEqual([{ targets: [{ item: "a", collection: "c" }] }]);
      await sync({ item_links: [link("[]", T3, T3)] });
      expect((await pool.query("SELECT targets, deleted_at IS NOT NULL AS gone FROM item_links")).rows).toEqual([{ targets: [], gone: true }]);
    });
  });

  describe("conflicts", () => {
    it("lets the newer write win, whichever arrives last", async () => {
      await sync({ spaces: [space("a", "new", T2)] });
      const stale = await sync({ spaces: [space("a", "stale", T1)] });
      expect(stale.wrote).toBe(false);
      expect(await names()).toEqual(["a=new"]);
      const newer = await sync({ spaces: [space("a", "newest", T3)] });
      expect(newer.wrote).toBe(true);
      expect(await names()).toEqual(["a=newest"]);
    });

    it("keeps the stored row on equal timestamps (the first write stays), and doesn't tell devices of it", async () => {
      const first = await sync({ spaces: [space("a", "first", T2)] });
      const tie = await sync({ spaces: [space("a", "tie", T2)] });
      expect(tie.wrote).toBe(false);
      expect(await names()).toEqual(["a=first"]);
      expect((await sync({}, { since: first.cursor })).changes).toEqual({});
    });

    it("writes a row that had no timestamp stored", async () => {
      await pool.query("INSERT INTO spaces (id, name, position) VALUES ('a', 'bare', 0)");
      await sync({ spaces: [space("a", "stamped", T1)] });
      expect(await names()).toEqual(["a=stamped"]);
    });

    it("keeps field values apart: a device's edit of one field doesn't touch another's", async () => {
      const value = (field_id: string, value_text: string, updated_at: string) => ({ item_id: "i", field_id, value_text, updated_at });
      await sync({ field_values: [value("f1", "one", T1), value("f2", "two", T1)] });
      await sync({ field_values: [value("f1", "ONE", T2)] });
      await sync({ field_values: [value("f2", "stale", T1)] });
      const rows = (await pool.query("SELECT field_id, value_text FROM field_values ORDER BY field_id")).rows;
      expect(rows).toEqual([{ field_id: "f1", value_text: "ONE" }, { field_id: "f2", value_text: "two" }]);
    });

    it("carries a soft delete like any other newer write", async () => {
      await sync({ spaces: [space("a", "A")] });
      await sync({ spaces: [space("a", "A", T2, { deleted_at: T2 })] });
      const row = (await sync({})).changes.spaces[0];
      expect(row.deleted_at).toBe(T2);
    });

    it("never changes an immutable row (files, thumbnails): the first stays", async () => {
      const file = (mime: string) => ({ id: "f", mime, size: 1, created_at: T1 });
      await sync({ files: [file("image/png")], thumbnails: [{ file_id: "f", thumb_id: "t1", created_at: T1 }] });
      const second = await sync({ files: [file("image/jpeg")], thumbnails: [{ file_id: "f", thumb_id: "t2", created_at: T2 }] });
      expect(second.wrote).toBe(false);
      expect((await pool.query("SELECT mime FROM files")).rows).toEqual([{ mime: "image/png" }]);
      expect((await pool.query("SELECT thumb_id FROM thumbnails")).rows).toEqual([{ thumb_id: "t1" }]);
    });
  });

  describe("files", () => {
    it("lists the files pushed values use that the server has no bytes of", async () => {
      const id = "a".repeat(64);
      const answer = await sync({ field_values: [{ item_id: "i", field_id: "f", value_file: id, updated_at: T1 }] });
      expect(answer.missingFiles).toEqual([id]);
      await pool.query("INSERT INTO file_bytes (id, mime, data) VALUES ($1, 'image/png', ''::bytea)", [id]);
      expect((await sync({ field_values: [{ item_id: "i", field_id: "f2", value_file: id, updated_at: T1 }] })).missingFiles).toBeUndefined();
    });
  });

  describe("which database", () => {
    const info = async () => Object.fromEntries((await pool.query("SELECT key, value FROM server_meta")).rows.map((r) => [r.key, r.value]));

    it("gives every answer the database's id and creation time", async () => {
      const meta = await info();
      expect((await sync({})).database).toEqual({ id: meta.database_id, createdAt: meta.created_at });
      expect(meta.database_id).toMatch(/^[0-9a-f-]{36}$/);
    });

    it("lets a device of this database sync, and one of no database yet (a first sync)", async () => {
      const { database_id } = await info();
      expect(await sync({ spaces: [space("a", "A")] }, { database: database_id })).toMatchObject({ wrote: true });
      expect(await sync({}, { database: "" })).toMatchObject({ wrote: false });
    });

    it("turns away a device of another database, writing nothing, saying whether this one is empty", async () => {
      const refused = await handleSync(pool, { since: 0, changes: { spaces: [space("a", "A")] }, version: SYNC_VERSION, compatible: SYNC_VERSION, database: "someone-else" });
      expect(refused).toMatchObject({ mismatch: { empty: true, error: expect.stringMatching(/wiped or replaced/) } });
      await sync({ spaces: [space("b", "B")] });
      const again = await handleSync(pool, { since: 0, changes: { spaces: [space("a", "A")] }, version: SYNC_VERSION, compatible: SYNC_VERSION, database: "someone-else" });
      expect(again).toMatchObject({ mismatch: { empty: false, database: { id: (await info()).database_id } } });
      expect(await names()).toEqual(["b=B"]);
    });

    it("is another database after a wipe", async () => {
      const before = await info();
      await sync({ spaces: [space("a", "A")] });
      await wipe(pool, schemaSql);
      expect((await info()).database_id).not.toBe(before.database_id);
      expect(await handleSync(pool, { since: 1, changes: {}, version: SYNC_VERSION, compatible: SYNC_VERSION, database: before.database_id })).toMatchObject({ mismatch: { empty: true } });
    });
  });

  describe("versions", () => {
    const request = (over: Partial<SyncRequest> = {}): SyncRequest => ({ since: 0, changes: {}, version: SYNC_VERSION, ...over });

    it("syncs with devices of its own version only", () => {
      expect(refusal(request())).toBeNull();
      // `compatible` is only for servers from before the strict gate: this one ignores it.
      expect(refusal(request({ compatible: 0 }))).toBeNull();
      expect(refusal(request({ compatible: SYNC_VERSION + 5 }))).toBeNull();
    });

    it("tells an older device to update the app, and writes nothing", async () => {
      expect(refusal(request({ version: SYNC_VERSION - 1 }))).toMatchObject({ update: "app", version: SYNC_VERSION });
      // A device from before versions sends none.
      expect(refusal({ since: 0, changes: {} } as unknown as SyncRequest)).toMatchObject({ update: "app" });
      expect(refusal(request({ version: "abc" as unknown as number }))).toMatchObject({ update: "app" });
      expect(await handleSync(pool, request({ version: 0, compatible: 0, changes: { spaces: [space("a", "A")] } }))).toMatchObject({ outdated: { update: "app" } });
      expect(await handleSync(pool, request({ version: SYNC_VERSION - 1, changes: { spaces: [space("a", "A")] } }))).toMatchObject({ outdated: { update: "app" } });
      expect(await names()).toEqual([]);
    });

    it("tells a newer device to update the server, and writes nothing", async () => {
      expect(refusal(request({ version: SYNC_VERSION + 1 }))).toMatchObject({ update: "server", version: SYNC_VERSION });
      expect(await handleSync(pool, request({ version: SYNC_VERSION + 1, compatible: SYNC_VERSION, changes: { spaces: [space("a", "A")] } }))).toMatchObject({ outdated: { update: "server" } });
      expect(await names()).toEqual([]);
    });

    it("checks the version before the database, so a refused device isn't told its database changed", async () => {
      expect(await handleSync(pool, request({ version: 0, database: "someone-else" }))).toMatchObject({ outdated: { update: "app" } });
      expect(await handleSync(pool, request({ version: SYNC_VERSION + 1, database: "someone-else" }))).toMatchObject({ outdated: { update: "server" } });
    });

    it("answers with its version", async () => {
      expect(await sync({})).toMatchObject({ version: SYNC_VERSION });
    });
  });

  describe("failing", () => {
    it("leaves everything as it was when a request fails half way, and releases its connection", async () => {
      await sync({ spaces: [space("a", "A")] });
      const bad = [space("b", "B"), space("c", "C", "not a timestamp")];
      await expect(sync({ spaces: bad })).rejects.toThrow(/timestamp/);
      expect(await names()).toEqual(["a=A"]);
      expect(pool.idleCount).toBe(pool.totalCount); // no connection stuck in the failed transaction
      expect((await sync({ spaces: [space("b", "B")] })).wrote).toBe(true);
    });

    it("serializes concurrent requests: every write gets its own sequence number and no cursor skips one", async () => {
      const requests = Array.from({ length: 8 }, (_, i) => sync({ spaces: [space(`s${i}`, `S${i}`)] }));
      const cursors = (await Promise.all(requests)).map((r) => r.cursor).sort((a, b) => a - b);
      expect(cursors).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      expect((await sync({})).changes.spaces).toHaveLength(8);
    });
  });
});

describe.skipIf(!ADMIN)("the server's schema and migrations", () => {
  const DB2 = "kubus_schema_test";
  let pool: pg.Pool;
  let schemaSql: string;
  const columns = async (table: string) => (await pool.query("SELECT column_name AS c FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1", [table])).rows.map((r) => r.c);

  beforeAll(async () => {
    schemaSql = await loadSchema();
    pool = createPool(await createDatabase(DB2));
  });
  afterAll(async () => {
    await pool?.end();
    await dropDatabase(DB2);
  });
  beforeEach(async () => {
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
  });

  it("makes every synced table from the protocol's list, each with seq and its key", async () => {
    await applySchema(pool, schemaSql);
    for (const t of SYNC_TABLES) {
      const have = await columns(t.name);
      expect(have.sort()).toEqual([...Object.keys(t.columns), "seq"].sort());
      const key = await pool.query("SELECT a.attname AS c FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey) WHERE i.indrelid = $1::regclass AND i.indisprimary", [t.name]);
      expect(key.rows.map((r) => r.c).sort()).toEqual([...t.key].sort());
    }
    for (const own of ["server_meta", "file_bytes", "server_settings", "api_tokens", "schema_migrations"]) {
      expect((await pool.query("SELECT to_regclass($1) AS t", [own])).rows[0].t).toBe(own);
    }
  });

  it("brings a database of an older server up: the tables and columns added since, every row kept", async () => {
    await applySchema(pool, schemaSql);
    await pool.query("INSERT INTO spaces (id, name, icon, position) VALUES ('s1', 'Work', 'Star', 1)");
    await pool.query("INSERT INTO file_bytes (id, mime, data) VALUES ('f', 'text/plain', 'x')");
    await pool.query("INSERT INTO server_meta (key, value) VALUES ('keep', 'me')");
    const { rows: before } = await pool.query("SELECT value FROM server_meta WHERE key = 'database_id'");
    // As an older server left it: later tables gone, later columns missing, no migration record.
    await pool.query("DROP TABLE api_tokens, server_settings, thumbnails, bookmarks, item_links, schema_migrations");
    await pool.query("ALTER TABLE collections DROP COLUMN source, DROP COLUMN title_field");
    await pool.query("ALTER TABLE fields DROP COLUMN source_column");
    await pool.query("ALTER TABLE spaces DROP COLUMN icon");
    await applySchema(pool, schemaSql);
    await applySchema(pool, schemaSql); // and again: nothing to do
    expect(await columns("collections")).toEqual(expect.arrayContaining(["source", "title_field"]));
    expect(await columns("fields")).toContain("source_column");
    for (const table of ["api_tokens", "server_settings", "thumbnails", "bookmarks", "item_links"]) expect(await columns(table)).not.toEqual([]);
    expect((await pool.query("SELECT id, name, icon FROM spaces")).rows).toEqual([{ id: "s1", name: "Work", icon: null }]);
    expect((await pool.query("SELECT id FROM file_bytes")).rows).toEqual([{ id: "f" }]);
    expect((await pool.query("SELECT value FROM server_meta WHERE key IN ('database_id', 'keep') ORDER BY key")).rows).toEqual([{ value: before[0].value }, { value: "me" }]);
  });

  it("serializes servers starting on the same database", async () => {
    await Promise.all([applySchema(pool, schemaSql), applySchema(pool, schemaSql), applySchema(pool, schemaSql)]);
    expect((await pool.query("SELECT count(*)::int AS n FROM server_meta")).rows).toEqual([{ n: 2 }]);
  });

  it("rolls the start back and gives the connection back when the database doesn't fit", async () => {
    await applySchema(pool, schemaSql);
    await pool.query("INSERT INTO schema_migrations (version, description) VALUES (999, 'from a newer server')");
    await expect(applySchema(pool, schemaSql)).rejects.toThrow(/migration 999/);
    await pool.query("DELETE FROM schema_migrations WHERE version = 999");
    await pool.query("ALTER TABLE spaces ALTER COLUMN name TYPE varchar(20)");
    await pool.query("ALTER TABLE spaces ALTER COLUMN position TYPE bigint");
    // Both wrong columns named at once.
    await expect(applySchema(pool, schemaSql)).rejects.toThrow(/spaces\.name is character varying\(20\), not text; spaces\.position is bigint, not integer: a changed column needs a migration/);
    expect(pool.idleCount).toBe(pool.totalCount);
  });

  it("gives a column its default for rows written without it (the protocol's `defaults`)", async () => {
    const spaces = SYNC_TABLES.find((t) => t.name === "spaces")!;
    const fieldValues = SYNC_TABLES.find((t) => t.name === "field_values")!;
    const collections = SYNC_TABLES.find((t) => t.name === "collections")!;
    try {
      spaces.defaults = { icon: "it's", position: 3 };
      fieldValues.defaults = { value_bool: 1, value_text: null };
      collections.defaults = { source: '{"k":"v"}', plural_name: "O'Brien" };
      const sql = await loadSchema();
      expect(sql).toContain("DEFAULT 'it''s'::text");
      expect(sql).toContain("DEFAULT 3");
      await pool.query(sql);
      await pool.query("INSERT INTO spaces (id, name) VALUES ('s', 'S')");
      await pool.query("INSERT INTO field_values (item_id, field_id) VALUES ('i', 'f')");
      await pool.query("INSERT INTO collections (id, name) VALUES ('c', 'C')");
      expect((await pool.query("SELECT icon, position FROM spaces")).rows).toEqual([{ icon: "it's", position: 3 }]);
      expect((await pool.query("SELECT value_bool, value_text FROM field_values")).rows).toEqual([{ value_bool: true, value_text: null }]);
      expect((await pool.query("SELECT source, plural_name FROM collections")).rows).toEqual([{ source: { k: "v" }, plural_name: "O'Brien" }]);
    } finally {
      delete spaces.defaults;
      delete fieldValues.defaults;
      delete collections.defaults;
    }
  });

  describe("wiping", () => {
    it("drops every table and sequence in the schema, also those it doesn't know, and starts afresh", async () => {
      await applySchema(pool, schemaSql);
      await pool.query(`CREATE TABLE "odd ""name""" (x int); CREATE SEQUENCE stray_seq; INSERT INTO spaces (id, name) VALUES ('s', 'S')`);
      await pool.query("SELECT nextval('sync_seq')");
      await wipe(pool, schemaSql);
      expect((await pool.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT IN (SELECT t FROM unnest($1::text[]) t)", [[...SYNC_TABLES.map((t) => t.name), "server_meta", "file_bytes", "server_settings", "api_tokens", "schema_migrations"]])).rows).toEqual([]);
      expect((await pool.query("SELECT 1 FROM information_schema.sequences WHERE sequence_name = 'stray_seq'")).rowCount).toBe(0);
      expect((await pool.query("SELECT count(*)::int AS n FROM spaces")).rows).toEqual([{ n: 0 }]);
      expect(await currentCursor(pool)).toBe(0);
    });

    it("is all or nothing: a schema that fails leaves the database as it was", async () => {
      await applySchema(pool, schemaSql);
      await pool.query("INSERT INTO spaces (id, name) VALUES ('s', 'S')");
      await expect(wipe(pool, "SELECT 1 / 0")).rejects.toThrow(/division by zero/);
      expect((await pool.query("SELECT id FROM spaces")).rows).toEqual([{ id: "s" }]);
      expect(pool.idleCount).toBe(pool.totalCount);
    });

    it("works on a database nobody made the schema in", async () => {
      await wipe(pool, schemaSql);
      expect((await pool.query("SELECT count(*)::int AS n FROM server_meta")).rows).toEqual([{ n: 2 }]);
    });
  });
});
