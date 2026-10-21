import {
  SYNC_TABLES,
  type ColumnType,
  type SyncRequest,
  type SyncResponse,
  type SyncTable,
  type WireChanges,
  type WireRow,
  type WireValue,
} from "../../../../shared/sync";
import { observeStamp } from "../../domain/model";
import type { DataChange, SyncConfig, SyncControl, SyncStatus } from "../repository";
import type { SqlClient } from "../sqlite/client";
import type { Statement } from "../sqlite/protocol";

// Keeps this device's database in step with the Kubus server (server/src/sync.ts).
//
//  * Local changes: triggers (schema.sql) queue the key of every changed row in `sync_outbox`.
//  * A sync sends the queued rows and receives every row the server changed after `sync_cursor`
//    (the server's sequence number), in one request. Applying what came back, clearing the
//    sent part of the outbox and storing the cursor is one local transaction.
//  * Merging: a row replaces the local one only when its updated_at is newer. Values are rows of
//    their own, so two devices editing different fields of an object never conflict.
//  * First connection to a server (or a different one): the server is the source of truth, so what
//    it holds replaces this device's data. Only an empty server takes this device's data instead
//    (everything local is queued for upload).
//  * When: shortly after a local change, every 30 s, when coming online or back to the app, and
//    when the server signals a change (server-sent events).

const STORAGE_KEY = "kubus.sync";
const SERVER_KEY = "kubus.syncServer";
const POLL_MS = 30_000;
const DEBOUNCE_MS = 2_000;

/** The server serving this very page is the natural default (the installed home-screen app). */
function defaultUrl(): string {
  const web = location.protocol.startsWith("http") && !location.hostname.endsWith("tauri.localhost") && !import.meta.env.DEV;
  return web ? location.origin : "";
}

function loadConfig(): SyncConfig {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as Partial<SyncConfig> | null;
    if (saved) return { url: saved.url ?? defaultUrl(), token: saved.token ?? "", enabled: !!saved.enabled };
  } catch {
    // unreadable settings: start over
  }
  return { url: defaultUrl(), token: "", enabled: false };
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const fromBase64 = (text: string): Uint8Array => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

const toWire = (t: SyncTable, row: Record<string, unknown>): WireRow =>
  Object.fromEntries(
    Object.keys(t.columns).map((c) => {
      const v = row[c];
      return [c, v instanceof Uint8Array ? toBase64(v) : ((v ?? null) as WireValue)];
    }),
  );

const fromWire = (type: ColumnType, v: WireValue): string | number | Uint8Array | null =>
  v !== null && type === "bytes" ? fromBase64(String(v)) : v;

/** SQL that inserts a row from the server, replacing the local one only if it is newer. */
export function applyStatement(t: SyncTable, row: WireRow): Statement {
  const cols = Object.keys(t.columns);
  let sql = `INSERT INTO ${t.name} (${cols.join(", ")}) VALUES (${cols.map((_, i) => `?${i + 1}`).join(", ")}) `;
  if (t.version) {
    const set = cols.filter((c) => !t.key.includes(c)).map((c) => `${c} = excluded.${c}`);
    sql += `ON CONFLICT (${t.key.join(", ")}) DO UPDATE SET ${set.join(", ")} WHERE excluded.${t.version} > ${t.name}.${t.version}`;
  } else {
    sql += "ON CONFLICT DO NOTHING";
  }
  return { sql, bind: cols.map((c) => fromWire(t.columns[c], row[c] ?? null)) };
}

export const keyOf = (t: SyncTable) => (t.key.length > 1 ? `json_array(${t.key.join(", ")})` : t.key[0]);

export class SyncEngine implements SyncControl {
  config = loadConfig();
  status: SyncStatus = { state: "off", lastSync: null, error: null };

  private listeners = new Set<() => void>();
  private running: Promise<void> | null = null;
  private again = false;
  private applying = false;
  private debounce: ReturnType<typeof setTimeout> | undefined;
  private events: AbortController | undefined;

  constructor(
    private db: SqlClient,
    private emit: (...changes: DataChange[]) => void,
  ) {
    setInterval(() => void this.syncNow(), POLL_MS);
    addEventListener("online", () => void this.syncNow());
    document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && void this.syncNow());
    this.listenForChanges();
    void this.syncNow();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private setStatus(patch: Partial<SyncStatus>) {
    this.status = { ...this.status, ...patch };
    this.listeners.forEach((l) => l());
  }

  private get active() {
    return this.config.enabled && this.config.url !== "" && this.config.token !== "";
  }

  async configure(config: SyncConfig): Promise<void> {
    this.config = { ...config, url: config.url.trim().replace(/\/+$/, "") };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.config));
    } catch {
      // storage blocked: the settings last until the page closes
    }
    this.listenForChanges();
    await this.syncNow();
  }

  /** The repository calls this after every local write. */
  localChange() {
    if (this.applying || !this.active) return;
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => void this.syncNow(), DEBOUNCE_MS);
  }

  /** Syncs now; a request while one is running makes it run once more afterwards. */
  syncNow(): Promise<void> {
    if (!this.active) {
      this.setStatus({ state: "off", error: null });
      return Promise.resolve();
    }
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.again = false;
        this.setStatus({ state: "syncing" });
        try {
          await this.syncOnce();
          this.setStatus({ state: "idle", lastSync: new Date().toISOString(), error: null });
        } catch (e) {
          this.setStatus({ state: "error", error: e instanceof Error ? e.message : String(e) });
          break;
        }
      } while (this.again);
    })().finally(() => (this.running = null));
    return this.running;
  }

  /** One request to the server: sends rows, receives the ones changed since the cursor. */
  private async post(request: SyncRequest): Promise<SyncResponse> {
    const { url, token } = this.config;
    let response: Response;
    try {
      response = await fetch(`${url}/api/sync`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(request),
      });
    } catch {
      throw new Error(`Cannot reach ${url}`);
    }
    if (response.status === 401) throw new Error("The server did not accept the token");
    if (!response.ok) throw new Error(`Server error ${response.status}`);
    return (await response.json()) as SyncResponse;
  }

  private async syncOnce() {
    if (await this.connectToNewServer(this.config.url)) return;

    const meta = await this.db.select<{ value: string }>("SELECT value FROM meta WHERE key = 'sync_cursor'");
    const since = Number(meta[0]?.value ?? 0);
    const upTo = (await this.db.select<{ n: number | null }>("SELECT max(id) AS n FROM sync_outbox"))[0]?.n ?? 0;
    const request: SyncRequest = { since, changes: await this.readOutbox(upTo) };

    const { cursor, changes } = await this.post(request);

    const statements: Statement[] = [
      { sql: "INSERT OR REPLACE INTO meta (key, value) VALUES ('sync_applying', '1')" },
      { sql: "PRAGMA defer_foreign_keys = ON" },
    ];
    for (const t of SYNC_TABLES) for (const row of changes[t.name] ?? []) statements.push(applyStatement(t, row));
    statements.push(
      { sql: "DELETE FROM sync_outbox WHERE id <= ?1", bind: [upTo] },
      { sql: "INSERT OR REPLACE INTO meta (key, value) VALUES ('sync_cursor', ?1)", bind: [String(cursor)] },
      { sql: "DELETE FROM meta WHERE key = 'sync_applying'" },
    );
    await this.db.write(statements);

    await this.announce(changes);
  }

  /** True when this device has not synced with `url` yet: connecting replaces its data (see below). */
  isNewServer(url: string): boolean {
    try {
      return localStorage.getItem(SERVER_KEY) !== url.trim().replace(/\/+$/, "");
    } catch {
      return true;
    }
  }

  /**
   * First connection to this server (or a different one). The server is the source of truth: if it
   * holds data, that replaces everything on this device (one local transaction, nothing is sent).
   * An empty server has nothing to respect, so this device's data is queued for upload instead,
   * which the sync that follows sends. Returns true when the local data was replaced.
   */
  private async connectToNewServer(url: string): Promise<boolean> {
    const known = await this.db.select<{ value: string }>("SELECT value FROM meta WHERE key = 'sync_server'");
    if (known[0]?.value === url) return false;

    const remote = await this.post({ since: 0, changes: {} });
    const remember = [{ sql: "INSERT OR REPLACE INTO meta (key, value) VALUES ('sync_server', ?1)", bind: [url] }];
    let replaced = false;
    if (SYNC_TABLES.some((t) => (remote.changes[t.name] ?? []).length > 0)) {
      const oldTypes = (await this.db.select<{ id: string }>("SELECT id FROM object_types")).map((r) => r.id);
      const statements: Statement[] = [
        { sql: "INSERT OR REPLACE INTO meta (key, value) VALUES ('sync_applying', '1')" },
        { sql: "PRAGMA defer_foreign_keys = ON" },
        { sql: "DELETE FROM sync_outbox" },
        // Children first: foreign keys point from field values and files' users to what they reference.
        ...[...SYNC_TABLES].reverse().map((t) => ({ sql: `DELETE FROM ${t.name}` })),
      ];
      for (const t of SYNC_TABLES) for (const row of remote.changes[t.name] ?? []) statements.push(applyStatement(t, row));
      statements.push(
        { sql: "INSERT OR REPLACE INTO meta (key, value) VALUES ('sync_cursor', ?1)", bind: [String(remote.cursor)] },
        ...remember,
        { sql: "DELETE FROM meta WHERE key = 'sync_applying'" },
      );
      await this.db.write(statements);
      replaced = true;
      await this.announce(remote.changes, oldTypes);
    } else {
      await this.db.write([
        { sql: "DELETE FROM sync_outbox" },
        ...SYNC_TABLES.map((t) => ({ sql: `INSERT INTO sync_outbox (tbl, pk) SELECT '${t.name}', ${keyOf(t)} FROM ${t.name}` })),
        { sql: "INSERT OR REPLACE INTO meta (key, value) VALUES ('sync_cursor', '0')" },
        ...remember,
      ]);
    }
    try {
      localStorage.setItem(SERVER_KEY, url);
    } catch {
      // storage blocked: the page just asks again next time
    }
    return replaced;
  }

  private async readOutbox(upTo: number): Promise<WireChanges> {
    const queued = await this.db.select<{ tbl: string; pk: string }>(
      "SELECT DISTINCT tbl, pk FROM sync_outbox WHERE id <= ?1",
      [upTo],
    );
    const changes: WireChanges = {};
    for (const t of SYNC_TABLES) {
      const keys = queued.filter((q) => q.tbl === t.name).map((q) => (t.key.length > 1 ? JSON.parse(q.pk) : q.pk));
      if (keys.length === 0) continue;
      const where =
        t.key.length === 1
          ? `${t.key[0]} IN (SELECT value FROM json_each(?1))`
          : `(${t.key.join(", ")}) IN (SELECT ${t.key.map((_, i) => `json_extract(value, '$[${i}]')`).join(", ")} FROM json_each(?1))`;
      const rows = await this.db.select<Record<string, unknown>>(
        `SELECT ${Object.keys(t.columns).join(", ")} FROM ${t.name} WHERE ${where}`,
        [JSON.stringify(keys)],
      );
      if (rows.length > 0) changes[t.name] = rows.map((r) => toWire(t, r));
    }
    return changes;
  }

  /** Tells the UI what the server changed, the way a local write would. */
  private async announce(changes: WireChanges, replacedTypes: string[] = []) {
    const out: DataChange[] = [];
    const objects = new Map<string, string>(); // object id -> type id
    for (const r of changes.objects ?? []) objects.set(String(r.id), String(r.type_id));
    const valueOf = (changes.field_values ?? []).map((r) => String(r.object_id)).filter((id) => !objects.has(id));
    if (valueOf.length > 0) {
      const rows = await this.db.select<{ id: string; type_id: string }>(
        "SELECT id, type_id FROM objects WHERE id IN (SELECT value FROM json_each(?1))",
        [JSON.stringify([...new Set(valueOf)])],
      );
      for (const r of rows) objects.set(r.id, r.type_id);
    }
    if (changes.object_types?.length || changes.fields?.length) out.push({ scope: "types" });
    if (changes.templates?.length) out.push({ scope: "templates" });
    if (changes.bookmarks?.length) out.push({ scope: "bookmarks" });
    // Everything was replaced: whatever the old data showed is gone or different now.
    if (replacedTypes.length > 0) {
      out.push({ scope: "types" }, { scope: "templates" }, { scope: "bookmarks" });
      for (const typeId of replacedTypes) out.push({ scope: "objects", typeId }, { scope: "views", typeId });
    }
    for (const typeId of new Set((changes.views ?? []).map((r) => String(r.type_id)))) out.push({ scope: "views", typeId });
    for (const [objectId, typeId] of objects) out.push({ scope: "objects", typeId, objectId });

    for (const t of SYNC_TABLES) for (const r of changes[t.name] ?? []) if (typeof r.updated_at === "string") observeStamp(r.updated_at);
    this.applying = true;
    try {
      this.emit(...out);
    } finally {
      this.applying = false;
    }
  }

  /** Holds a connection to the server's change signal open while syncing is on. */
  private listenForChanges() {
    this.events?.abort();
    this.events = undefined;
    if (!this.active) return;
    const controller = new AbortController();
    this.events = controller;
    const { url, token } = this.config;
    void (async () => {
      for (let delay = 1000; !controller.signal.aborted; delay = Math.min(delay * 2, 30_000)) {
        try {
          const response = await fetch(`${url}/api/events`, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal });
          if (!response.ok || !response.body) throw new Error(String(response.status));
          const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
          delay = 500;
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value.includes("data:")) void this.syncNow();
          }
        } catch {
          // offline, or a proxy dropped the stream: try again below (polling covers the gap)
        }
        if (!controller.signal.aborted) await new Promise((resolve) => setTimeout(resolve, delay));
      }
    })();
  }
}
