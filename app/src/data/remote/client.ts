import type {
  SourceDescription,
  SourceInfo,
  SourceQuery,
  SourceResult,
  SourceRow,
  SourceRowRequest,
  SourceTable,
  SourceTarget,
} from "../../../../shared/sources";
import type { Item } from "../../domain/model";
import type { SyncConfig } from "../repository";

// The server's remote sources (shared/sources.ts), asked for over HTTP with the sync token: the
// server this device syncs with reads them for it (server/src/sources.ts). Nothing is stored or
// kept offline: a remote collection reads its rows whenever it is shown.

const TIMEOUT_MS = 60_000;
/** Rows remembered as last shown, so an item page opened from a list shows at once (and reads its row again). */
const REMEMBERED = 1000;

export class SourcesClient {
  /** Bumped by `refresh`: what shows remote rows reads them again. */
  private listeners = new Set<(collectionId: string | null) => void>();
  private shown = new Map<string, Item>();

  constructor(private config: () => SyncConfig) {}

  private async call<T>(path: string, body?: unknown): Promise<T> {
    const { url, token } = this.config();
    if (!url || !token) throw new Error("Remote collections are read through a Kubus server: set one up in Settings → Sync.");
    let response: Response;
    try {
      response = await fetch(`${url}/api/sources${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { Authorization: `Bearer ${token}`, ...(body !== undefined && { "Content-Type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new Error("The Kubus server can't be reached (remote collections need it online).");
    }
    const answer = (await response.json().catch(() => null)) as { error?: string } | null;
    if (!response.ok) throw new Error(answer?.error ?? `The server answered ${response.status}`);
    return answer as T;
  }

  list(): Promise<SourceInfo[]> {
    return this.call("");
  }
  tables(source: string): Promise<SourceTable[]> {
    return this.call(`/${encodeURIComponent(source)}/tables`);
  }
  describe(source: string, target: SourceTarget): Promise<SourceDescription> {
    return this.call(`/${encodeURIComponent(source)}/describe`, { target });
  }
  query(source: string, query: SourceQuery): Promise<SourceResult> {
    return this.call(`/${encodeURIComponent(source)}/query`, query);
  }
  async row(source: string, request: SourceRowRequest): Promise<SourceRow | null> {
    return (await this.call<{ row: SourceRow | null }>(`/${encodeURIComponent(source)}/row`, request)).row;
  }

  /** Remembers rows as shown (as items), for `shownItem`. */
  remember(items: Item[]) {
    for (const item of items) {
      const key = `${item.collectionId}/${item.id}`;
      this.shown.delete(key);
      this.shown.set(key, item);
    }
    for (const key of this.shown.keys()) {
      if (this.shown.size <= REMEMBERED) break;
      this.shown.delete(key);
    }
  }
  /** A row as it was last shown in a list, if it was. */
  shownItem(collectionId: string, itemId: string): Item | undefined {
    return this.shown.get(`${collectionId}/${itemId}`);
  }

  /** Read again: one remote collection's rows (null: every one's). */
  refresh(collectionId: string | null) {
    for (const listener of this.listeners) listener(collectionId);
  }
  onRefresh(listener: (collectionId: string | null) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
