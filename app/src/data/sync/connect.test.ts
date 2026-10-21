// @vitest-environment node
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import schema from "../schema.sql?raw";
import type { SyncRequest, SyncResponse } from "../../../../shared/sync";

const store = new Map<string, string>();
vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) });
vi.stubGlobal("document", { addEventListener() {}, visibilityState: "visible" });
vi.stubGlobal("addEventListener", () => {});
vi.stubGlobal("location", { protocol: "http:", hostname: "localhost", origin: "http://localhost" });
const { SyncEngine } = await import("./SyncEngine");

/** The SqlClient the engine uses, over an in-memory database. */
class FakeClient {
  db = new DatabaseSync(":memory:");
  constructor() {
    this.db.exec(schema);
    this.db.exec("PRAGMA foreign_keys = ON");
  }
  async select(sql: string, bind: unknown[] = []) {
    return this.db.prepare(sql).all(...(bind as never[]));
  }
  async write(statements: { sql: string; bind?: unknown[] }[]) {
    this.db.exec("BEGIN");
    try {
      for (const s of statements) this.db.prepare(s.sql).run(...((s.bind ?? []) as never[]));
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
const config = { url: "https://notes.example.com", token: "t", enabled: true };

const type = (id: string) => ({ id, name: id, plural_name: id, icon: null, description: "", object_views: null, created_at: T, updated_at: T, deleted_at: null });
const field = (id: string, typeId: string) => ({
  id, type_id: typeId, name: "Title", kind: "string", target_type_id: null, template_id: null, template_args: null,
  choice_filter: null, toggle_icon: null, position: 0, created_at: T, updated_at: T, deleted_at: null,
});
const object = (id: string, typeId: string) => ({ id, type_id: typeId, object_view_id: null, created_at: T, updated_at: T, deleted_at: null });
const value = (objectId: string, fieldId: string, text: string) => ({
  object_id: objectId, field_id: fieldId, value_text: text, value_number: null, value_date: null, value_datetime: null,
  value_bool: null, value_ref: null, value_file: null, value_json: null, updated_at: T,
});

let requests: SyncRequest[];
/** Makes fetch answer like a server: `respond` gets each request. */
function server(respond: (request: SyncRequest) => SyncResponse) {
  requests = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: { body: string }) => {
      const request = JSON.parse(init.body) as SyncRequest;
      requests.push(request);
      return { ok: true, status: 200, json: async () => respond(request) };
    }),
  );
}

async function localDevice() {
  const db = new FakeClient();
  await db.write([
    { sql: `INSERT INTO object_types (id, name, plural_name, created_at, updated_at) VALUES ('mine', 'Mine', 'Mine', '${T}', '${T}')` },
    { sql: `INSERT INTO fields (id, type_id, name, kind, created_at, updated_at) VALUES ('mf', 'mine', 'Title', 'string', '${T}', '${T}')` },
    { sql: `INSERT INTO objects (id, type_id, created_at, updated_at) VALUES ('mo', 'mine', '${T}', '${T}')` },
    { sql: `INSERT INTO field_values (object_id, field_id, value_text, updated_at) VALUES ('mo', 'mf', 'local', '${T}')` },
  ]);
  return db;
}

beforeEach(() => store.clear());

describe("first connection to a server", () => {
  it("replaces the local data with the server's when the server has data", async () => {
    server(() => ({
      cursor: 7,
      changes: { object_types: [type("t1")], fields: [field("f1", "t1")], objects: [object("o1", "t1")], field_values: [value("o1", "f1", "remote")] },
    }));
    const db = await localDevice();
    const emitted: unknown[] = [];
    const engine = new SyncEngine(db as never, (...c) => void emitted.push(...c));
    expect(engine.isNewServer(config.url)).toBe(true);

    await engine.configure(config);

    expect(engine.status.error).toBeNull();
    expect(db.names("object_types")).toEqual(["t1"]); // "mine" is gone
    expect(db.names("objects")).toEqual(["o1"]);
    expect(db.db.prepare("SELECT value_text FROM field_values").all()).toEqual([{ value_text: "remote" }]);
    expect(db.db.prepare("SELECT count(*) AS n FROM sync_outbox").get()).toEqual({ n: 0 }); // nothing sent back
    expect(db.db.prepare("SELECT value FROM meta WHERE key = 'sync_cursor'").get()).toEqual({ value: "7" });
    expect(requests).toHaveLength(1); // only the pull; no local rows were sent
    expect(requests[0]).toEqual({ since: 0, changes: {} });
    expect(emitted).toContainEqual({ scope: "types" });
    expect(emitted).toContainEqual({ scope: "objects", typeId: "mine" }); // the old type's views reload
    expect(engine.isNewServer(config.url)).toBe(false);
  });

  it("uploads the local data when the server is empty", async () => {
    server((request) => ({ cursor: Object.keys(request.changes).length > 0 ? 4 : 0, changes: {} }));
    const db = await localDevice();
    const engine = new SyncEngine(db as never, () => {});

    await engine.configure(config);

    expect(engine.status.error).toBeNull();
    expect(db.names("object_types")).toEqual(["mine"]); // untouched
    expect(db.db.prepare("SELECT value_text FROM field_values").all()).toEqual([{ value_text: "local" }]);
    expect(requests).toHaveLength(2); // the empty probe, then the upload
    expect(Object.keys(requests[1].changes).sort()).toEqual(["field_values", "fields", "object_types", "objects"]);
    expect(db.db.prepare("SELECT count(*) AS n FROM sync_outbox").get()).toEqual({ n: 0 });
  });

  it("does not ask again for the same server", async () => {
    server(() => ({ cursor: 1, changes: { object_types: [type("t1")] } }));
    const db = await localDevice();
    const engine = new SyncEngine(db as never, () => {});
    await engine.configure(config);
    await engine.syncNow();
    // later syncs are ordinary: they send what changed since the cursor
    expect(requests.at(-1)?.since).toBe(1);
  });

  it("forgets the server on disconnect, keeping the local data", async () => {
    server(() => ({ cursor: 1, changes: { object_types: [type("t1")] } }));
    const db = await localDevice();
    const engine = new SyncEngine(db as never, () => {});
    await engine.configure(config);
    expect(engine.isNewServer(config.url)).toBe(false);

    await engine.disconnect();

    expect(engine.status.state).toBe("off");
    expect(engine.config).toMatchObject({ token: "", enabled: false });
    expect(engine.isNewServer(config.url)).toBe(true); // connecting again is a first connection
    expect(db.names("object_types")).toEqual(["t1"]); // the data stays
    expect(db.db.prepare("SELECT count(*) AS n FROM meta WHERE key IN ('sync_server', 'sync_cursor')").get()).toEqual({ n: 0 });
    const calls = requests.length;
    await engine.syncNow(); // off: no request
    expect(requests).toHaveLength(calls);
  });
});
