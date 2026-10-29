// Webhooks: every sync of the headless device that brought changes (from any device, or from the
// API itself) becomes one POST to each configured URL, with the changed items as the API shows
// them. In order and one at a time per URL, a few retries, then dropped (best effort: nothing is
// kept across a restart). Documented on the Help page (help/api.md).

import { createHmac } from "node:crypto";
import type { WireChanges } from "../../../shared/sync";
import type { Repository } from "../data/repository";
import type { SqliteRepository } from "../data/sqlite/SqliteRepository";
import type { Pulled } from "../data/sync/SyncEngine";
import type { Collection, Item, ItemLabel } from "../domain/model";
import { computeItems, loadWorld } from "../domain/world";
import { itemOut, type ApiItem } from "./values";
import { errorMessage } from "../domain/errors";

export type WebhookEvent =
  | { type: "item.created" | "item.updated"; id: string; collection: string; collectionId: string; spaceId: string; item: ApiItem }
  | { type: "item.deleted"; id: string; collection: string; collectionId: string; spaceId: string }
  | { type: "collection.changed" | "space.changed" | "component.changed" | "bookmark.changed"; id: string }
  | { type: "view.changed"; id: string; collectionId: string };

export interface WebhookPayload {
  database: string | undefined;
  cursor: number;
  events: WebhookEvent[];
}

/** Waits before each retry; after the last one a delivery is dropped. */
const RETRY_MS = [1000, 5000, 30_000];

const ids = (changes: WireChanges, table: string, column = "id") => [...new Set((changes[table] ?? []).map((r) => String(r[column])))];

/** The rows of two change sets together (a sync's pulled and pushed rows). */
const merged = (a: WireChanges, b: WireChanges): WireChanges =>
  Object.fromEntries([...new Set([...Object.keys(a), ...Object.keys(b)])].map((t) => [t, [...(a[t] ?? []), ...(b[t] ?? [])]]));

/**
 * The events of one sync. An item is created when the hook first sees it (`known` holds the ids
 * it has seen), deleted when it carries a deletion, otherwise updated (also when only its values
 * changed, an AI value for example). Items are read and computed per collection and space, not
 * one by one.
 */
export async function buildEvents(repo: Repository, changes: WireChanges, known: Set<string>): Promise<WebhookEvent[]> {
  const events: WebhookEvent[] = [];
  const world = await loadWorld(repo);
  for (const id of new Set([...ids(changes, "collections"), ...ids(changes, "fields", "collection_id")])) events.push({ type: "collection.changed", id });
  for (const r of changes.views ?? []) events.push({ type: "view.changed", id: String(r.id), collectionId: String(r.collection_id) });
  for (const id of ids(changes, "spaces")) events.push({ type: "space.changed", id });
  for (const id of ids(changes, "components")) events.push({ type: "component.changed", id });
  for (const id of ids(changes, "bookmarks")) events.push({ type: "bookmark.changed", id });

  const rows = new Map((changes.items ?? []).map((r) => [String(r.id), r]));
  for (const id of ids(changes, "field_values", "item_id")) if (!rows.has(id)) rows.set(id, { id });
  const collectionOf = await repo.collectionsOfItems([...rows.keys()].filter((id) => !rows.get(id)!.collection_id));
  const byCollection = new Map<string, string[]>();
  for (const [id, row] of rows) {
    const collectionId = row.collection_id ? String(row.collection_id) : collectionOf.get(id);
    if (collectionId) byCollection.set(collectionId, [...(byCollection.get(collectionId) ?? []), id]);
  }

  const shown = new Map<string, { collection: Collection; item: Item }>();
  const labels = new Map<string, ItemLabel[]>();
  for (const [collectionId, itemIds] of byCollection) {
    const collection = world.collections.find((c) => c.id === collectionId);
    if (!collection) continue; // its collection is gone too
    const items = await repo.getItems(collection, itemIds);
    for (const spaceId of new Set(items.map((i) => i.spaceId))) {
      const computed = await computeItems(repo, world, collection, items.filter((i) => i.spaceId === spaceId), spaceId, labels);
      for (const item of computed) shown.set(item.id, { collection, item });
    }
  }

  for (const [id, row] of rows) {
    const isNew = !known.has(id);
    known.add(id);
    const found = shown.get(id);
    if (found) {
      const { collection, item } = found;
      events.push({ type: isNew ? "item.created" : "item.updated", id, collection: collection.name, collectionId: collection.id, spaceId: item.spaceId, item: itemOut(collection, item) });
      continue;
    }
    const collection = world.collections.find((c) => c.id === (row.collection_id ? String(row.collection_id) : collectionOf.get(id)));
    if (collection && row.deleted_at) events.push({ type: "item.deleted", id, collection: collection.name, collectionId: collection.id, spaceId: String(row.space_id ?? "") });
  }
  return events;
}

/** `X-Kubus-Signature` of a body: sha256=<HMAC-SHA256 of it with the secret, in hex>. */
export const signature = (body: string, secret: string) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

export class Webhooks {
  private known = new Set<string>();
  /** Per URL: the delivery in progress and those after it. */
  private queues = new Map<string, Promise<void>>();
  private building: Promise<void> = Promise.resolve();

  constructor(
    private repo: SqliteRepository,
    private config: { urls: string[]; secret: string | null },
    private log: (message: string) => void,
    private wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  ) {}

  /** Follows the device's syncs (call once, before its first sync). */
  attach() {
    if (this.config.urls.length === 0) return;
    this.repo.sync.onPulled((pulled) => void this.handle(pulled));
  }

  private handle(pulled: Pulled) {
    // In order: each sync's events are built after the previous one's.
    this.building = this.building.then(async () => {
      if (pulled.initial) {
        // Everything the server holds, not changes: only remembered (also after a wipe).
        this.known = new Set(ids(pulled.changes, "items"));
        return;
      }
      try {
        // What other devices changed and what this one (the API) did.
        const events = await buildEvents(this.repo, merged(pulled.changes, pulled.pushed), this.known);
        if (events.length > 0) this.send({ database: pulled.database, cursor: pulled.cursor, events });
      } catch (e) {
        this.log(`Webhook events failed: ${errorMessage(e)}`);
      }
    });
  }

  /** Delivers to every URL, each in order. */
  send(payload: WebhookPayload) {
    const body = JSON.stringify(payload);
    for (const url of this.config.urls) {
      const previous = this.queues.get(url) ?? Promise.resolve();
      this.queues.set(url, previous.then(() => this.deliver(url, body)));
    }
  }

  /** Settles once everything queued so far is delivered or dropped (tests). */
  async idle() {
    await this.building;
    await Promise.all(this.queues.values());
  }

  private async deliver(url: string, body: string) {
    const headers: Record<string, string> = { "Content-Type": "application/json", "User-Agent": "Kubus" };
    if (this.config.secret) headers["X-Kubus-Signature"] = signature(body, this.config.secret);
    for (let attempt = 0; ; attempt++) {
      let problem: string;
      try {
        const response = await fetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(10_000) });
        if (response.ok) return;
        problem = `HTTP ${response.status}`;
      } catch (e) {
        problem = errorMessage(e);
      }
      if (attempt >= RETRY_MS.length) {
        this.log(`Webhook to ${url} dropped after ${attempt + 1} tries: ${problem}`);
        return;
      }
      await this.wait(RETRY_MS[attempt]);
    }
  }
}
