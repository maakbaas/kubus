import {
  SYNC_TABLES,
  type SyncMismatch,
  type SyncRequest,
  type SyncResponse,
  type SyncTable,
  type WireChanges,
  type WireRow,
  type WireValue,
} from "../../../../shared/sync";
import { filesUsedBy } from "../../domain/files";
import { observeStamp } from "../../domain/model";
import type { DataChange, SyncConfig, SyncControl, SyncStatus } from "../repository";
import type { SqlClient, Statement } from "../sqlite/protocol";
import type { SyncEnvironment } from "./environment";

// Keeps this device's database in step with the Kubus server (server/src/sync.ts).
//
//  * Local changes: triggers (schema.sql) queue the key of every changed row in `sync_outbox`.
//  * A sync sends the queued rows and receives every row the server changed after `sync_cursor`
//    (the server's sequence number), in one request. Applying what came back, clearing the
//    sent part of the outbox and storing the cursor is one local transaction.
//  * Merging: a row replaces the local one only when its updated_at is newer. Values are rows of
//    their own, so two devices editing different fields of an item never conflict.
//  * First connection to a server (or a different one): the server is the source of truth, so what
//    it holds replaces this device's data. Only an empty server takes this device's data instead
//    (everything local is queued for upload).
//  * The server's database has an id (server_meta). Every sync sends the one this device synced
//    with; when the server holds another one (wiped or replaced since), it writes nothing and
//    answers 409, and this device pauses until the user connects again (a first connection to the
//    new database) or disconnects: its outbox only holds what changed since the last sync, which
//    would land on the new database as fragments.
//  * When: shortly after a local change, every 30 s, when coming online or back to the app, and
//    when the server signals a change (server-sent events) this device doesn't have yet (the
//    signal carries the server's cursor: a device's own push is not fetched again).
//  * File bytes don't travel in /api/sync. Before a sync sends a queued `files` row, the engine
//    uploads its bytes (PUT /api/files/<id>), so the server never lists a file it can't serve; a
//    sync uploads up to UPLOAD_BYTES / UPLOAD_MS, the rest waits in the outbox for the next one
//    (other rows don't wait: nothing refers to a file by foreign key). Rows from the server come
//    without bytes (files.data NULL); after each sync they are downloaded in the background, all
//    of them or, with `originals: "opened"`, only thumbnails (an original then when it is shown).
//  * Files a sync stops using (another device replaced an image, deleted an item, …) are released
//    as a local edit would, so every device cleans up the same files. The server deletes unused
//    files itself, a week later (server/src/files.ts); if a pushed row uses one it no longer has,
//    it says so (`missingFiles`) and a device that has the bytes uploads them again.

const STORAGE_KEY = "kubus.sync";
const SERVER_KEY = "kubus.syncServer";
/** `SyncStatus.replaced`, kept across reloads (sync stays paused until the user acts). */
const REPLACED_KEY = "kubus.syncReplaced";
const POLL_MS = 30_000;
const DEBOUNCE_MS = 2_000;
/** How much one sync uploads at most (it goes on with the next file while under both). */
const UPLOAD_BYTES = 50 * 1024 * 1024;
const UPLOAD_MS = 30_000;
/** Files downloaded at the same time. */
const DOWNLOADS = 3;

function loadConfig(env: SyncEnvironment): SyncConfig {
  try {
    const saved = JSON.parse(env.storage.get(STORAGE_KEY) ?? "null") as Partial<SyncConfig> | null;
    if (saved) {
      const originals = saved.originals === "opened" ? "opened" : "always";
      return { url: saved.url ?? env.defaultUrl(), token: saved.token ?? "", enabled: !!saved.enabled, originals };
    }
  } catch {
    // unreadable settings: start over
  }
  return { url: env.defaultUrl(), token: "", enabled: false, originals: "always" };
}

function loadReplaced(env: SyncEnvironment): SyncStatus["replaced"] {
  try {
    const saved = JSON.parse(env.storage.get(REPLACED_KEY) ?? "null") as SyncStatus["replaced"];
    return saved && typeof saved.createdAt === "string" ? { createdAt: saved.createdAt, empty: !!saved.empty } : null;
  } catch {
    return null;
  }
}

/** The server holds another database than this device synced with (its 409 answer). */
class DatabaseReplaced extends Error {
  constructor(readonly mismatch: SyncMismatch) {
    super(mismatch.error);
  }
}

const toWire = (t: SyncTable, row: Record<string, unknown>): WireRow =>
  Object.fromEntries(Object.keys(t.columns).map((c) => [c, (row[c] ?? null) as WireValue]));

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
  return { sql, bind: cols.map((c) => row[c] ?? null) };
}

/** Stores the id of the server's database this device syncs with (an older server sends none). */
const rememberDatabase = (id: string | undefined): Statement[] =>
  id ? [{ sql: "INSERT OR REPLACE INTO meta (key, value) VALUES ('sync_database', ?1)", bind: [id] }] : [];

/** Queues files (with their thumbnails) for upload again: the server lost them, this device has their bytes. */
const requeueFiles = (ids: string[]): Statement[] =>
  ids.length === 0
    ? []
    : [
        {
          sql: `INSERT INTO sync_outbox (tbl, pk)
                  SELECT 'files', id FROM files WHERE data IS NOT NULL
                     AND (id IN (SELECT value FROM json_each(?1)) OR id IN (SELECT thumb_id FROM thumbnails WHERE file_id IN (SELECT value FROM json_each(?1))))`,
          bind: [JSON.stringify(ids)],
        },
        { sql: "INSERT INTO sync_outbox (tbl, pk) SELECT 'thumbnails', file_id FROM thumbnails WHERE file_id IN (SELECT value FROM json_each(?1))", bind: [JSON.stringify(ids)] },
      ];

export const keyOf = (t: SyncTable) => (t.key.length > 1 ? `json_array(${t.key.join(", ")})` : t.key[0]);

/** Rows a sync brought, after they were applied, and the rows it sent (the headless device's webhooks). */
export interface Pulled {
  changes: WireChanges;
  /** This device's own changes the sync sent (the server doesn't send them back). */
  pushed: WireChanges;
  /** The server's sequence number they bring this device to. */
  cursor: number;
  /** The server database's id. */
  database: string | undefined;
  /** The first download from a server (everything it holds), not changes. */
  initial: boolean;
}

export class SyncEngine implements SyncControl {
  config: SyncConfig;
  status: SyncStatus;

  private listeners = new Set<() => void>();
  private running: Promise<void> | null = null;
  private again = false;
  private applying = false;
  private debounce: ReturnType<typeof setTimeout> | undefined;
  private events: AbortController | undefined;
  private downloading: Promise<void> | null = null;
  private downloadAgain = false;
  private pulledListeners = new Set<(pulled: Pulled) => void>();
  private fetching = new Map<string, Promise<{ data: Uint8Array; mime: string } | null>>();
  /** The server's sequence number this device has everything up to (-1: not known yet). */
  private cursor = -1;

  constructor(
    private db: SqlClient,
    private emit: (...changes: DataChange[]) => void,
    private env: SyncEnvironment,
    /** Deletes those of these files no live item uses (Repository.releaseFiles). */
    private releaseFiles: (fileIds: string[]) => Promise<void> = async () => {},
  ) {
    this.config = loadConfig(env);
    this.status = { state: "off", lastSync: null, error: null, replaced: loadReplaced(env) };
    setInterval(() => void this.syncNow(), POLL_MS);
    env.watch(() => void this.syncNow());
    this.listenForChanges();
    void this.syncNow();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Calls `listener` with the rows of every sync that brought some, once they are applied. */
  onPulled(listener: (pulled: Pulled) => void): () => void {
    this.pulledListeners.add(listener);
    return () => this.pulledListeners.delete(listener);
  }

  private pulled(pulled: Pulled) {
    if (!SYNC_TABLES.some((t) => (pulled.changes[t.name] ?? []).length + (pulled.pushed[t.name] ?? []).length > 0)) return;
    for (const listener of this.pulledListeners) listener(pulled);
  }

  private setStatus(patch: Partial<SyncStatus>) {
    this.status = { ...this.status, ...patch };
    this.listeners.forEach((l) => l());
  }

  private get active() {
    return this.config.enabled && this.config.url !== "" && this.config.token !== "";
  }

  async configure(config: SyncConfig): Promise<void> {
    this.config = { ...config, url: config.url.trim().replace(/\/+$/, ""), originals: config.originals === "opened" ? "opened" : "always" };
    if (config.enabled) this.setReplaced(null); // switched on again: that is the answer
    this.env.storage.set(STORAGE_KEY, JSON.stringify(this.config));
    this.listenForChanges();
    await this.syncNow();
  }

  async disconnect(): Promise<void> {
    this.stop({ url: this.env.defaultUrl(), token: "", enabled: false, originals: this.config.originals });
    await this.running; // a sync in flight finishes first
    await this.forgetServer([{ sql: "DELETE FROM sync_outbox" }]);
    this.setReplaced(null);
    this.setStatus({ state: "off", lastSync: null, error: null });
  }

  async pause(): Promise<void> {
    this.stop({ ...this.config, enabled: false });
    await this.running; // a sync in flight finishes first
    await this.forgetServer();
    this.setStatus({ state: "off", error: null });
  }

  async reconnect(): Promise<void> {
    await this.configure({ ...this.config, enabled: true });
  }

  /** Stops syncing (saving `config`, which is switched off): no pending sync, no change signal, the server not known any more. */
  private stop(config: SyncConfig) {
    this.config = config;
    clearTimeout(this.debounce);
    this.listenForChanges(); // closes the change signal
    this.env.storage.set(STORAGE_KEY, JSON.stringify(this.config));
    this.env.storage.remove(SERVER_KEY);
  }

  /** What sync remembered about the server's database (with `also`, in the same transaction): the next connection is a first one. */
  private forgetServer(also: Statement[] = []) {
    this.cursor = -1;
    return this.db.write([...also, { sql: "DELETE FROM meta WHERE key IN ('sync_server', 'sync_cursor', 'sync_database')" }]);
  }

  private setReplaced(replaced: SyncStatus["replaced"]) {
    if (replaced) this.env.storage.set(REPLACED_KEY, JSON.stringify(replaced));
    else this.env.storage.remove(REPLACED_KEY);
    if (replaced !== this.status.replaced) this.setStatus({ replaced });
  }

  /** The server holds another database: stop (keeping URL and token) until the user answers. Runs inside a sync. */
  private async stopForReplaced({ database, empty }: SyncMismatch) {
    this.stop({ ...this.config, enabled: false });
    await this.forgetServer();
    this.setReplaced({ createdAt: database.createdAt, empty });
    this.setStatus({ state: "off", error: null });
  }

  /** A request to the server with the token; network failures and a refused token throw. */
  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const { url, token } = this.config;
    let response: Response;
    try {
      response = await fetch(`${url}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, ...init.headers } });
    } catch {
      throw new Error(`Cannot reach ${url}`);
    }
    if (response.status === 401) throw new Error("The server did not accept the token");
    return response;
  }

  async wipeServer(): Promise<void> {
    const response = await this.request("/api/wipe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: "wipe" }),
    });
    if (!response.ok) throw new Error(`Server error ${response.status}`);
    await this.pause();
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
        // This sync sends every change made so far: a pending debounced one would find nothing.
        clearTimeout(this.debounce);
        this.setStatus({ state: "syncing" });
        try {
          await this.syncOnce();
          this.setStatus({ state: "idle", lastSync: new Date().toISOString(), error: null });
          void this.downloadFiles();
        } catch (e) {
          if (e instanceof DatabaseReplaced) await this.stopForReplaced(e.mismatch);
          else this.setStatus({ state: "error", error: e instanceof Error ? e.message : String(e) });
          break;
        }
      } while (this.again);
    })().finally(() => (this.running = null));
    return this.running;
  }

  /**
   * Syncs unless this device already has everything up to `serverCursor`, the server's latest
   * write (the server's headless device knows it; 0: none since a wipe, so always sync).
   */
  async catchUp(serverCursor: number): Promise<void> {
    await this.running;
    if (serverCursor > 0 && this.cursor >= serverCursor && this.status.state === "idle") return;
    await this.syncNow();
  }

  /** The server signalled a write up to `cursor` (0: a wipe): syncs unless this device has it (its own, mostly). */
  private async heard(cursor: number) {
    await this.running;
    if (cursor > 0 && cursor <= this.cursor) return;
    await this.syncNow();
  }

  /** Resolves once the sync in flight and the downloads after it are done. */
  async idle(): Promise<void> {
    await this.running;
    await this.downloading;
  }

  /** One request to the server: sends rows, receives the ones changed since the cursor. */
  private async post(request: SyncRequest): Promise<SyncResponse> {
    const response = await this.request("/api/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
    if (response.status === 409) throw new DatabaseReplaced((await response.json()) as SyncMismatch);
    if (!response.ok) throw new Error(`Server error ${response.status}`);
    return (await response.json()) as SyncResponse;
  }

  private async syncOnce() {
    if (await this.connectToNewServer(this.config.url)) return;

    const meta = await this.db.select<{ key: string; value: string }>("SELECT key, value FROM meta WHERE key IN ('sync_cursor', 'sync_database')");
    const since = Number(meta.find((m) => m.key === "sync_cursor")?.value ?? 0);
    // The database synced with (none yet: a device from before ids, or an older server).
    const database = meta.find((m) => m.key === "sync_database")?.value;
    const upTo = (await this.db.select<{ n: number | null }>("SELECT max(id) AS n FROM sync_outbox"))[0]?.n ?? 0;
    const { waiting, unsendable, uploaded } = await this.uploadFiles(upTo);
    const outgoing = await this.readOutbox(upTo);
    const held = new Set([...waiting, ...unsendable]);
    if (outgoing.files) outgoing.files = outgoing.files.filter((r) => !held.has(String(r.id)));
    const request: SyncRequest = { since, changes: outgoing, ...(database && { database }) };

    const { cursor, changes, database: current, missingFiles = [] } = await this.post(request);
    const freed = await this.filesUsedBefore(changes);

    const statements: Statement[] = [
      { sql: "INSERT OR REPLACE INTO meta (key, value) VALUES ('sync_applying', '1')" },
      { sql: "PRAGMA defer_foreign_keys = ON" },
    ];
    for (const t of SYNC_TABLES) for (const row of changes[t.name] ?? []) statements.push(applyStatement(t, row));
    statements.push(
      // Files whose bytes aren't uploaded yet stay queued for the next sync.
      { sql: "DELETE FROM sync_outbox WHERE id <= ?1 AND NOT (tbl = 'files' AND pk IN (SELECT value FROM json_each(?2)))", bind: [upTo, JSON.stringify(waiting)] },
      { sql: "INSERT OR REPLACE INTO meta (key, value) VALUES ('sync_cursor', ?1)", bind: [String(cursor)] },
      { sql: "DELETE FROM meta WHERE key = 'sync_applying'" },
      ...rememberDatabase(current?.id),
      ...requeueFiles(missingFiles),
    );
    await this.db.write(statements);
    this.cursor = cursor;
    if (freed.length > 0) await this.releaseFiles(freed);
    this.pulled({ changes, pushed: outgoing, cursor, database: current?.id ?? database, initial: false });

    await this.announce(changes);
    // More to upload, and uploading works (or files to upload again): go on right away.
    if ((waiting.length > 0 && uploaded > 0) || missingFiles.length > 0) this.again = true;
  }

  /**
   * The files this device's rows use that incoming rows may stop using: the values they replace,
   * and the values of the items and fields they delete. Read before they are applied.
   */
  private async filesUsedBefore(changes: WireChanges): Promise<string[]> {
    const values = (changes.field_values ?? []).map((r) => [r.item_id, r.field_id]);
    const items = (changes.items ?? []).filter((r) => r.deleted_at !== null).map((r) => r.id);
    const fields = (changes.fields ?? []).filter((r) => r.deleted_at !== null).map((r) => r.id);
    if (values.length + items.length + fields.length === 0) return [];
    const rows = await this.db.select<{ value_file: string | null; value_text: string | null }>(
      `SELECT value_file, value_text FROM field_values
        WHERE (value_file IS NOT NULL OR value_text LIKE '%files/%')
          AND ((item_id, field_id) IN (SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?1))
               OR item_id IN (SELECT value FROM json_each(?2)) OR field_id IN (SELECT value FROM json_each(?3)))`,
      [JSON.stringify(values), JSON.stringify(items), JSON.stringify(fields)],
    );
    return filesUsedBy(rows);
  }

  /**
   * Uploads the bytes of the queued files the server doesn't have yet, within this sync's budget.
   * Returns the files to hold back from this sync: `waiting` (not uploaded yet, they stay queued)
   * and `unsendable` (no bytes anywhere, or refused by the server: their rows are never sent).
   */
  private async uploadFiles(upTo: number): Promise<{ waiting: string[]; unsendable: string[]; uploaded: number }> {
    const queued = await this.db.select<{ id: string; local: number }>(
      `SELECT id, data IS NOT NULL AS local FROM files
        WHERE id IN (SELECT pk FROM sync_outbox WHERE tbl = 'files' AND id <= ?1) ORDER BY created_at`,
      [upTo],
    );
    const waiting: string[] = [];
    const unsendable: string[] = [];
    const deadline = Date.now() + UPLOAD_MS;
    let uploaded = 0;
    for (const { id, local } of queued) {
      if (waiting.length > 0 || uploaded > UPLOAD_BYTES || Date.now() > deadline) {
        waiting.push(id);
        continue;
      }
      if ((await this.request(`/api/files/${id}`, { method: "HEAD" })).ok) {
        await this.dropBytes(id);
        continue;
      }
      const file = local ? (await this.db.select<{ mime: string; data: Uint8Array }>("SELECT mime, data FROM files WHERE id = ?1", [id]))[0] : undefined;
      if (!file?.data) {
        unsendable.push(id); // known only from a server that no longer has it: nobody can serve it
        continue;
      }
      const response = await this.request(`/api/files/${id}`, {
        method: "PUT",
        headers: { "Content-Type": file.mime },
        body: file.data as Uint8Array<ArrayBuffer>,
      });
      if (response.ok) {
        uploaded += file.data.byteLength;
        await this.dropBytes(id);
      } else if (response.status === 400 || response.status === 413) {
        console.warn(`The server refused file ${id} (${response.status})`);
        unsendable.push(id);
      } else {
        waiting.push(id); // the server failed: try again next sync
      }
    }
    return { waiting, unsendable, uploaded };
  }

  /** A device that keeps no file bytes (the headless device) lets go of them once the server has them. */
  private async dropBytes(id: string) {
    if (!this.env.keepFiles) await this.db.write([{ sql: "UPDATE files SET data = NULL WHERE id = ?1", bind: [id] }]);
  }

  /**
   * A file from the server (null when it hasn't got it or can't be reached), kept on this device
   * unless it keeps no bytes. Also a file this device no longer lists (released when an edit
   * removed its last use, which an undo or a paste then put back): the server keeps unused files
   * for a week.
   */
  fetchFile(id: string): Promise<{ data: Uint8Array; mime: string } | null> {
    if (!this.active) return Promise.resolve(null);
    // One request per file at a time (a download and an image being shown may both ask).
    let pending = this.fetching.get(id);
    if (!pending) {
      pending = this.download(id).finally(() => this.fetching.delete(id));
      this.fetching.set(id, pending);
    }
    return pending;
  }

  private async download(id: string): Promise<{ data: Uint8Array; mime: string } | null> {
    let response: Response;
    let data: Uint8Array;
    try {
      // Not through the browser's HTTP cache: the bytes are kept in the database (and a cache
      // that can't take a large file fails the whole response).
      response = await this.request(`/api/files/${id}`, { cache: "no-store" });
      // Deleted on the server as unused: gone here too, unless something here still uses it.
      if (response.status === 404) await this.releaseFiles([id]);
      if (!response.ok) return null;
      data = new Uint8Array(await response.arrayBuffer());
    } catch {
      return null; // offline, or the connection broke off
    }
    const mime = response.headers.get("Content-Type") ?? "application/octet-stream";
    if (this.env.keepFiles) {
      await this.db.write([
        {
          sql: `INSERT INTO files (id, mime, size, data, created_at) VALUES (?1, ?2, ?3, ?4, ?5)
                ON CONFLICT (id) DO UPDATE SET data = excluded.data WHERE files.data IS NULL`,
          bind: [id, mime, data.byteLength, data, new Date().toISOString()],
        },
      ]);
    }
    return { data, mime };
  }

  /** Downloads the bytes this device lacks (see the top of this file), a few at a time. */
  private downloadFiles(): Promise<void> {
    if (!this.env.keepFiles) return Promise.resolve();
    if (this.downloading) {
      this.downloadAgain = true;
      return this.downloading;
    }
    this.downloading = (async () => {
      do {
        this.downloadAgain = false;
        const missing = (await this.db.select<{ id: string }>(
          // Thumbnails first (they are what lists and cards show); only them with "opened".
          `SELECT id FROM files WHERE data IS NULL ${this.config.originals === "opened" ? "AND id IN (SELECT thumb_id FROM thumbnails)" : ""}
            ORDER BY id IN (SELECT thumb_id FROM thumbnails) DESC, created_at DESC`,
        )).map((r) => r.id);
        let failed = false;
        const next = async (): Promise<void> => {
          const id = missing.shift();
          if (!id || failed || !this.active) return;
          if (!(await this.fetchFile(id))) failed = true; // offline or refused: the next sync tries again
          return next();
        };
        await Promise.all(Array.from({ length: DOWNLOADS }, next));
      } while (this.downloadAgain);
    })().finally(() => (this.downloading = null));
    return this.downloading;
  }

  /** True when this device has not synced with `url` yet: connecting replaces its data (see below). */
  isNewServer(url: string): boolean {
    return this.env.storage.get(SERVER_KEY) !== url.trim().replace(/\/+$/, "");
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
    const remember = [{ sql: "INSERT OR REPLACE INTO meta (key, value) VALUES ('sync_server', ?1)", bind: [url] }, ...rememberDatabase(remote.database?.id)];
    let replaced = false;
    if (SYNC_TABLES.some((t) => (remote.changes[t.name] ?? []).length > 0)) {
      const oldCollections = (await this.db.select<{ id: string }>("SELECT id FROM collections")).map((r) => r.id);
      const statements: Statement[] = [
        { sql: "INSERT OR REPLACE INTO meta (key, value) VALUES ('sync_applying', '1')" },
        { sql: "PRAGMA defer_foreign_keys = ON" },
        { sql: "DELETE FROM sync_outbox" },
        // Children first: foreign keys point from field values to what they reference. Files the
        // server lists too keep their bytes (content-addressed: the same id is the same file).
        ...[...SYNC_TABLES].reverse().map((t) =>
          t.name === "files"
            ? { sql: "DELETE FROM files WHERE id NOT IN (SELECT value FROM json_each(?1))", bind: [JSON.stringify((remote.changes.files ?? []).map((r) => r.id))] }
            : { sql: `DELETE FROM ${t.name}` },
        ),
      ];
      for (const t of SYNC_TABLES) for (const row of remote.changes[t.name] ?? []) statements.push(applyStatement(t, row));
      statements.push(
        { sql: "INSERT OR REPLACE INTO meta (key, value) VALUES ('sync_cursor', ?1)", bind: [String(remote.cursor)] },
        ...remember,
        { sql: "DELETE FROM meta WHERE key = 'sync_applying'" },
      );
      await this.db.write(statements);
      this.cursor = remote.cursor;
      replaced = true;
      this.pulled({ changes: remote.changes, pushed: {}, cursor: remote.cursor, database: remote.database?.id, initial: true });
      await this.announce(remote.changes, oldCollections);
    } else {
      await this.db.write([
        { sql: "DELETE FROM sync_outbox" },
        ...SYNC_TABLES.map((t) => ({ sql: `INSERT INTO sync_outbox (tbl, pk) SELECT '${t.name}', ${keyOf(t)} FROM ${t.name}` })),
        { sql: "INSERT OR REPLACE INTO meta (key, value) VALUES ('sync_cursor', '0')" },
        ...remember,
      ]);
    }
    this.env.storage.set(SERVER_KEY, url);
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
  private async announce(changes: WireChanges, replacedCollections: string[] = []) {
    const out: DataChange[] = [];
    const items = new Map<string, string>(); // item id -> collection id
    for (const r of changes.items ?? []) items.set(String(r.id), String(r.collection_id));
    const valueOf = (changes.field_values ?? []).map((r) => String(r.item_id)).filter((id) => !items.has(id));
    if (valueOf.length > 0) {
      const rows = await this.db.select<{ id: string; collection_id: string }>(
        "SELECT id, collection_id FROM items WHERE id IN (SELECT value FROM json_each(?1))",
        [JSON.stringify([...new Set(valueOf)])],
      );
      for (const r of rows) items.set(r.id, r.collection_id);
    }
    if (changes.spaces?.length) out.push({ scope: "spaces" });
    if (changes.collections?.length || changes.fields?.length) out.push({ scope: "collections" });
    if (changes.components?.length) out.push({ scope: "components" });
    if (changes.bookmarks?.length) out.push({ scope: "bookmarks" });
    // Everything was replaced: whatever the old data showed is gone or different now.
    if (replacedCollections.length > 0) {
      out.push({ scope: "spaces" }, { scope: "collections" }, { scope: "components" }, { scope: "bookmarks" });
      for (const collectionId of replacedCollections) out.push({ scope: "items", collectionId }, { scope: "views", collectionId });
    }
    for (const collectionId of new Set((changes.views ?? []).map((r) => String(r.collection_id)))) out.push({ scope: "views", collectionId });
    for (const [itemId, collectionId] of items) out.push({ scope: "items", collectionId, itemId });

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
          let rest = "";
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            // Each event is a line `data: <cursor>` (server/src/events.ts); a read may end mid-line.
            const lines = (rest + value).split("\n");
            rest = lines.pop() ?? "";
            for (const line of lines) {
              if (!line.startsWith("data:")) continue;
              const cursor = Number(line.slice(5).trim());
              void this.heard(Number.isFinite(cursor) ? cursor : 0);
            }
          }
        } catch {
          // offline, or a proxy dropped the stream: try again below (polling covers the gap)
        }
        if (!controller.signal.aborted) await new Promise((resolve) => setTimeout(resolve, delay));
      }
    })();
  }
}
