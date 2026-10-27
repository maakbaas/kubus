// A Kubus server in memory for tests: the sync protocol (last writer wins, a cursor), the file
// endpoints and the token, behind a `fetch` to stub globally. Devices made with `device()` sync
// through it as through the real one (server/src).
import { createHash } from "node:crypto";
import { vi } from "vitest";
import type { ServerAi } from "../../../shared/api";
import { SYNC_TABLES, type SyncMismatch, type SyncRequest, type SyncResponse, type WireRow } from "../../../shared/sync";
import { DirectSqlClient } from "../data/sqlite/direct";
import { SqliteRepository } from "../data/sqlite/SqliteRepository";
import { memoryEnvironment } from "../data/sync/environment";

export const SERVER_URL = "https://kubus.test";
export const TOKEN = "secret";

export class FakeServer {
  database = { id: "db-1", createdAt: "2026-10-01T00:00:00.000Z" };
  /** Rows by table, then by key, with the sequence number of their last write. */
  tables = new Map<string, Map<string, { row: WireRow; seq: number }>>();
  files = new Map<string, { mime: string; data: Uint8Array }>();
  seq = 0;
  /** Every request, as "METHOD /path". */
  log: string[] = [];
  /** Answers for file requests to fail on purpose: "PUT <id>" → status. */
  failures = new Map<string, number>();
  /** The language model it offers (GET /api/ai); null: none set up. Requests to it, by body. */
  ai: ServerAi | null = null;
  aiRequests: { model: string; authorization: string | null }[] = [];
  /** Answers a sync gives on top of the protocol's (tests of later additions). */
  extra: (request: SyncRequest) => Partial<SyncResponse> = () => ({});

  /** As a wipe does: everything gone, a new database id. */
  wipe() {
    this.tables.clear();
    this.files.clear();
    this.seq = 0;
    this.database = { id: `db-${Math.random()}`, createdAt: new Date().toISOString() };
  }

  rows(table: string): WireRow[] {
    return [...(this.tables.get(table)?.values() ?? [])].map((r) => r.row);
  }

  sync(request: SyncRequest): SyncResponse | SyncMismatch {
    if (request.database && request.database !== this.database.id) {
      return { error: "The server's database was wiped or replaced", database: this.database, empty: this.seq === 0 };
    }
    // The rows this request writes come after `before`; they aren't sent back.
    const before = this.seq;
    for (const t of SYNC_TABLES) {
      const table = this.tables.get(t.name) ?? new Map();
      this.tables.set(t.name, table);
      for (const row of request.changes[t.name] ?? []) {
        const key = t.key.map((k) => row[k]).join("|");
        const old = table.get(key);
        if (old && (!t.version || String(old.row[t.version]) >= String(row[t.version]))) continue;
        table.set(key, { row, seq: ++this.seq });
      }
    }
    const since = request.since > this.seq ? 0 : request.since;
    const changes: Record<string, WireRow[]> = {};
    for (const [name, table] of this.tables) {
      const rows = [...table.values()].filter((r) => r.seq > since && r.seq <= before).sort((a, b) => a.seq - b.seq).map((r) => r.row);
      if (rows.length > 0) changes[name] = rows;
    }
    return { cursor: this.seq, changes, database: this.database, ...this.extra(request) };
  }

  fetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const method = init.method ?? "GET";
    const path = url.slice(SERVER_URL.length);
    this.log.push(`${method} ${path}`);
    const headers = new Headers(init.headers);
    if (headers.get("Authorization") !== `Bearer ${TOKEN}`) return Response.json({ error: "Wrong token" }, { status: 401 });
    if (path === "/api/events") return new Response(new ReadableStream({ start() {} }));
    if (path === "/api/ai") return Response.json(this.ai ?? { available: false, fieldModel: "", codeModel: "" });
    if (path === "/api/ai/chat/completions") {
      this.aiRequests.push({ model: (JSON.parse(String(init.body)) as { model: string }).model, authorization: headers.get("Authorization") });
      return Response.json({ choices: [{ message: { content: "42" } }] });
    }
    if (path === "/api/sync") {
      const answer = this.sync(JSON.parse(String(init.body)) as SyncRequest);
      return Response.json(answer, { status: "error" in answer ? 409 : 200 });
    }
    const file = /^\/api\/files\/(\w+)$/.exec(path);
    if (file) {
      const id = file[1];
      const failure = this.failures.get(`${method} ${id}`);
      if (failure) return Response.json({ error: "failed" }, { status: failure });
      if (method === "PUT") {
        const data = new Uint8Array(init.body as Uint8Array);
        if (createHash("sha256").update(data).digest("hex") !== id) return Response.json({ error: "mismatch" }, { status: 400 });
        this.files.set(id, { mime: headers.get("Content-Type") ?? "", data });
        return Response.json({ ok: true });
      }
      const stored = this.files.get(id);
      if (!stored) return new Response(null, { status: 404 });
      return method === "HEAD" ? new Response(null) : new Response(stored.data as Uint8Array<ArrayBuffer>, { headers: { "Content-Type": stored.mime } });
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  };

  /** Makes this server what `fetch` reaches. */
  install(): this {
    vi.stubGlobal("fetch", this.fetch);
    return this;
  }
}

/** A device (in-memory database, settings in memory) syncing with SERVER_URL, connected and synced once. */
export async function device(options: { keepFiles?: boolean; originals?: "always" | "opened"; connect?: boolean } = {}) {
  const repo = await SqliteRepository.open(await DirectSqlClient.open(), memoryEnvironment({ keepFiles: options.keepFiles }));
  if (options.connect !== false) {
    await repo.sync.configure({ url: SERVER_URL, token: TOKEN, enabled: true, originals: options.originals ?? "always" });
    await settled(repo);
  }
  return repo;
}

/** Waits for the sync in flight and the downloads it started. */
export async function settled(repo: SqliteRepository) {
  for (let i = 0; i < 5; i++) {
    await repo.sync.syncNow();
    await repo.sync.idle();
  }
}

/** Bytes that make a small, distinct file. */
export const bytes = (text: string) => new TextEncoder().encode(text);
