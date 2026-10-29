// @vitest-environment node
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fileIds, schema } from "../schema";
import { SYNC_COMPATIBLE, SYNC_VERSION, type SyncRequest, type SyncResponse } from "../../../../shared/sync";
import { SyncEngine } from "./SyncEngine";
import { memoryEnvironment } from "./environment";

let env = memoryEnvironment();

/** node:sqlite binds numbered parameters (?1, ?2) only by name. */
const params = (bind: unknown[]) => [Object.fromEntries(bind.map((v, i) => [`?${i + 1}`, v]))] as never[];

/** The SqlClient the engine uses, over an in-memory database. */
class FakeClient {
  db = new DatabaseSync(":memory:");
  constructor() {
    this.db.function("file_ids", { deterministic: true }, fileIds as (...args: unknown[]) => string);
    this.db.exec(schema);
    this.db.exec("PRAGMA foreign_keys = ON");
  }
  async select(sql: string, bind: unknown[] = []) {
    return this.db.prepare(sql).all(...params(bind));
  }
  async write(statements: { sql: string; bind?: unknown[] }[]) {
    this.db.exec("BEGIN");
    try {
      for (const s of statements) this.db.prepare(s.sql).run(...params(s.bind ?? []));
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  names(table: string) {
    return (this.db.prepare(`SELECT id FROM ${table} ORDER BY id`).all() as { id: string }[]).map((r) => r.id);
  }
}

const T = "2026-10-21T10:00:00.000Z";
const config = { url: "https://notes.example.com", token: "t", enabled: true, originals: "always" as const };

const collection = (id: string) => ({ id, name: id, plural_name: id, icon: null, description: "", item_views: null, created_at: T, updated_at: T, deleted_at: null });
const field = (id: string, collectionId: string) => ({
  id, collection_id: collectionId, name: "Title", kind: "string", target_collection_id: null, component_id: null, code: null, output: null, frame_ratio: null,
  choice_filter: null, toggle_icon: null, strike_through: null, position: 0, created_at: T, updated_at: T, deleted_at: null,
});
const item = (id: string, collectionId: string) => ({ id, collection_id: collectionId, space_id: "default", item_view_id: null, created_at: T, updated_at: T, deleted_at: null });
const value = (itemId: string, fieldId: string, text: string) => ({
  item_id: itemId, field_id: fieldId, value_text: text, value_number: null, value_date: null, value_datetime: null,
  value_bool: null, value_ref: null, value_file: null, value_json: null, updated_at: T,
});

let requests: SyncRequest[];
/** Makes fetch answer like a server: `respond` gets each request. */
function server(respond: (request: SyncRequest) => Omit<SyncResponse, "database"> & Partial<SyncResponse>) {
  requests = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: { body: string }) => {
      const request = JSON.parse(init.body) as SyncRequest;
      requests.push(request);
      return { ok: true, status: 200, json: async () => ({ database: { id: "db-1", createdAt: T }, ...respond(request) }) };
    }),
  );
}

async function localDevice() {
  const db = new FakeClient();
  await db.write([
    { sql: `INSERT INTO collections (id, name, plural_name, created_at, updated_at) VALUES ('mine', 'Mine', 'Mine', '${T}', '${T}')` },
    { sql: `INSERT INTO fields (id, collection_id, name, kind, created_at, updated_at) VALUES ('mf', 'mine', 'Title', 'string', '${T}', '${T}')` },
    { sql: `INSERT INTO items (id, collection_id, space_id, created_at, updated_at) VALUES ('mo', 'mine', 'default', '${T}', '${T}')` },
    { sql: `INSERT INTO field_values (item_id, field_id, value_text, updated_at) VALUES ('mo', 'mf', 'local', '${T}')` },
  ]);
  return db;
}

beforeEach(() => void (env = memoryEnvironment()));

describe("first connection to a server", () => {
  it("replaces the local data with the server's when the server has data", async () => {
    server(() => ({
      cursor: 7,
      changes: { collections: [collection("t1")], fields: [field("f1", "t1")], items: [item("o1", "t1")], field_values: [value("o1", "f1", "remote")] },
    }));
    const db = await localDevice();
    const emitted: unknown[] = [];
    const engine = new SyncEngine(db as never, (...c) => void emitted.push(...c), env);
    expect(engine.isNewServer(config.url)).toBe(true);

    await engine.configure(config);

    expect(engine.status.error).toBeNull();
    expect(db.names("collections")).toEqual(["t1"]); // "mine" is gone
    expect(db.names("items")).toEqual(["o1"]);
    expect(db.db.prepare("SELECT value_text FROM field_values").all()).toEqual([{ value_text: "remote" }]);
    expect(db.db.prepare("SELECT count(*) AS n FROM sync_outbox").get()).toEqual({ n: 0 }); // nothing sent back
    expect(db.db.prepare("SELECT value FROM meta WHERE key = 'sync_cursor'").get()).toEqual({ value: "7" });
    expect(requests).toHaveLength(1); // only the pull; no local rows were sent
    expect(requests[0]).toEqual({ since: 0, changes: {}, version: SYNC_VERSION, compatible: SYNC_COMPATIBLE });
    expect(emitted).toContainEqual({ scope: "collections" });
    expect(emitted).toContainEqual({ scope: "items", collectionId: "mine" }); // the old collection's views reload
    expect(engine.isNewServer(config.url)).toBe(false);
  });

  it("uploads the local data when the server is empty", async () => {
    server((request) => ({ cursor: Object.keys(request.changes).length > 0 ? 4 : 0, changes: {} }));
    const db = await localDevice();
    const engine = new SyncEngine(db as never, () => {}, env);

    await engine.configure(config);

    expect(engine.status.error).toBeNull();
    expect(db.names("collections")).toEqual(["mine"]); // untouched
    expect(db.db.prepare("SELECT value_text FROM field_values").all()).toEqual([{ value_text: "local" }]);
    expect(requests).toHaveLength(2); // the empty probe, then the upload
    expect(Object.keys(requests[1].changes).sort()).toEqual(["collections", "field_values", "fields", "items"]);
    expect(db.db.prepare("SELECT count(*) AS n FROM sync_outbox").get()).toEqual({ n: 0 });
  });

  it("does not ask again for the same server", async () => {
    server(() => ({ cursor: 1, changes: { collections: [collection("t1")] } }));
    const db = await localDevice();
    const engine = new SyncEngine(db as never, () => {}, env);
    await engine.configure(config);
    await engine.syncNow();
    // later syncs are ordinary: they send what changed since the cursor
    expect(requests.at(-1)?.since).toBe(1);
  });

  it("forgets the server on disconnect, keeping the local data", async () => {
    server(() => ({ cursor: 1, changes: { collections: [collection("t1")] } }));
    const db = await localDevice();
    const engine = new SyncEngine(db as never, () => {}, env);
    await engine.configure(config);
    expect(engine.isNewServer(config.url)).toBe(false);

    await engine.disconnect();

    expect(engine.status.state).toBe("off");
    expect(engine.config).toMatchObject({ token: "", enabled: false });
    expect(engine.isNewServer(config.url)).toBe(true); // connecting again is a first connection
    expect(db.names("collections")).toEqual(["t1"]); // the data stays
    expect(db.db.prepare("SELECT count(*) AS n FROM meta WHERE key IN ('sync_server', 'sync_cursor')").get()).toEqual({ n: 0 });
    const calls = requests.length;
    await engine.syncNow(); // off: no request
    expect(requests).toHaveLength(calls);
  });
});

describe("the server's database id", () => {
  const A = { id: "db-a", createdAt: T };
  const B = { id: "db-b", createdAt: "2026-10-26T14:03:00.000Z" };
  /** A server holding `database` (with rows, unless `empty`); a request for another one gets the 409 answer. */
  function holding(database: { id: string; createdAt: string }, { empty = false } = {}) {
    requests = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: string }) => {
        const request = JSON.parse(init.body) as SyncRequest;
        requests.push(request);
        if (request.database && request.database !== database.id) {
          return { ok: false, status: 409, json: async () => ({ error: "The server's database was wiped or replaced", database, empty }) };
        }
        const changes = empty && request.since === 0 && Object.keys(request.changes).length === 0 ? {} : { collections: [collection("t1")] };
        return { ok: true, status: 200, json: async () => ({ cursor: 3, changes, database }) };
      }),
    );
  }
  const stored = (db: FakeClient) => (db.db.prepare("SELECT value FROM meta WHERE key = 'sync_database'").get() as { value: string } | undefined)?.value;

  it("is remembered on the first connection and sent with every sync", async () => {
    holding(A);
    const db = await localDevice();
    const engine = new SyncEngine(db as never, () => {}, env);
    await engine.configure(config);
    expect(stored(db)).toBe("db-a");
    await engine.syncNow();
    expect(requests.at(-1)?.database).toBe("db-a");
    expect(engine.status.replaced).toBeNull();
  });

  it("changed: pauses without writing, keeps the local data, and asks", async () => {
    holding(A);
    const db = await localDevice();
    const engine = new SyncEngine(db as never, () => {}, env);
    await engine.configure(config);
    await db.write([{ sql: `UPDATE field_values SET value_text = 'edited', updated_at = '2026-10-22T00:00:00.000Z'` }]);

    holding(B, { empty: true }); // wiped
    await engine.syncNow();

    expect(requests).toHaveLength(1); // the refused one; nothing after it
    expect(engine.status.replaced).toEqual({ createdAt: B.createdAt, empty: true });
    expect(engine.status.state).toBe("off");
    expect(engine.config).toMatchObject({ enabled: false, token: "t", url: config.url }); // paused, not forgotten
    expect(db.names("collections")).toEqual(["t1"]);
    expect(stored(db)).toBeUndefined(); // the next connection is a first one
    await engine.syncNow();
    expect(requests).toHaveLength(1); // stays paused

    // A new engine (the app reloaded) still shows it.
    expect(new SyncEngine(db as never, () => {}, env).status.replaced).toEqual({ createdAt: B.createdAt, empty: true });
  });

  it("connecting again to an empty new database uploads everything", async () => {
    holding(A);
    const db = await localDevice();
    const engine = new SyncEngine(db as never, () => {}, env);
    await engine.configure(config);
    holding(B, { empty: true });
    await engine.syncNow();

    await engine.reconnect();

    expect(engine.status.replaced).toBeNull();
    expect(requests[1]).toEqual({ since: 0, changes: {}, version: SYNC_VERSION, compatible: SYNC_COMPATIBLE }); // the probe, without an id
    // everything on the device (since the first connection: what the old database held)
    expect(requests[2].changes.collections.map((r) => r.id)).toEqual(["t1"]);
    expect(requests[2].database).toBe("db-b");
    expect(stored(db)).toBe("db-b");
  });

  it("connecting again to a new database with data replaces the local data", async () => {
    holding(A);
    const db = await localDevice();
    const engine = new SyncEngine(db as never, () => {}, env);
    await engine.configure(config);
    await db.write([{ sql: `INSERT INTO collections (id, name, plural_name, created_at, updated_at) VALUES ('extra', 'Extra', 'Extra', '${T}', '${T}')` }]);
    holding(B);
    await engine.syncNow();
    expect(engine.status.replaced).toEqual({ createdAt: B.createdAt, empty: false });

    await engine.reconnect();

    expect(db.names("collections")).toEqual(["t1"]); // "extra" never reached the server, and is gone
    expect(stored(db)).toBe("db-b");
  });
});

describe("testing a server", () => {
  /** A server at notes.example.com whose token is "t"; nothing answers anywhere else. */
  const answer = (url: string, init?: { headers?: Record<string, string> }) => {
    if (!url.startsWith("https://notes.example.com/")) throw new TypeError("fetch failed");
    if (url.endsWith("/api/health")) return { ok: true, status: 200, json: async () => ({ ok: true }) };
    const accepted = init?.headers?.Authorization === "Bearer t";
    return { ok: accepted, status: accepted ? 200 : 401, json: async () => ({}) };
  };
  beforeEach(() => vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => answer(url, init))));
  const engine = () => new SyncEngine(new FakeClient() as never, () => {}, env);

  it("passes for a server that takes the token, saving nothing", async () => {
    const e = engine();
    await expect(e.testServer("https://notes.example.com/", "t")).resolves.toBeUndefined();
    expect(e.config.token).toBe("");
  });
  it("says when the token is refused", async () => {
    await expect(engine().testServer("https://notes.example.com", "wrong")).rejects.toThrow("did not accept the token");
  });
  it("says when nothing answers", async () => {
    await expect(engine().testServer("https://elsewhere.example.com", "t")).rejects.toThrow("Cannot reach https://elsewhere.example.com");
  });
});

describe("switching sync off", () => {
  it("while a sync is running leaves it off, not up to date", async () => {
    server(() => ({ cursor: 1, changes: { collections: [collection("t1")] } }));
    const engine = new SyncEngine((await localDevice()) as never, () => {}, env);
    await engine.configure(config);
    expect(engine.status.state).toBe("idle");

    // The next request waits; sync is switched off meanwhile.
    const answer = globalThis.fetch;
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    vi.stubGlobal("fetch", vi.fn(async (...args: Parameters<typeof fetch>) => (await held, answer(...args))));
    const running = engine.syncNow();
    await engine.configure({ ...config, enabled: false });
    release();
    await running;
    await engine.idle();

    expect(engine.status.state).toBe("off");
    expect(engine.status.error).toBeNull();
  });
});
