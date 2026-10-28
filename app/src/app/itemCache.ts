// One loaded copy of each collection's items in the current space (and of their labels, in every
// space), shared by every pane and page.
//
// A collection's list is loaded once while
// anything shows it, kept up to date from the repository's change feed (one changed item is
// re-read, not the whole list), and dropped shortly after the last viewer leaves. Items that didn't
// change keep their identity, so what is derived from them (computed values, memoized rows) stays
// valid. Switching spaces loads every shown list again.

import type { DataChange, Repository } from "../data/repository";
import type { Item, ItemLabel, Collection } from "../domain/model";

/** What a viewer sees of a collection's list; replaced (never changed) whenever the list changes. */
export interface Snapshot<T> {
  /** null until loaded. */
  items: T[] | null;
  error?: string;
  /** Counts the changes, for viewers that combine several lists. */
  version: number;
}

const EMPTY: Snapshot<never> = { items: null, version: 0 };

/** How long a list stays (and stays current) after its last viewer left, e.g. switching tabs back. */
const GRACE_MS = 10_000;

interface Source<T> {
  list(collection: Collection): Promise<T[]>;
  one(collection: Collection, id: string): Promise<T | null>;
  /** Whether a reloaded entry is the one held (then the list keeps its identity, and nothing hears of it). */
  same?(a: T, b: T): boolean;
}

interface Entry<T> {
  snapshot: Snapshot<T>;
  listeners: Set<() => void>;
  /** The collection's field ids in order: when they change, what was loaded may no longer fit. */
  fieldKey: string;
  /** Single-item reloads in progress, by id. */
  reloading: Map<string, Promise<void>>;
  /** Counts full loads, so a slow older one can't overwrite a newer one. */
  generation: number;
  dropTimer?: ReturnType<typeof setTimeout>;
}

const fieldKeyOf = (collection: Collection | undefined) => (collection ? collection.fields.map((f) => f.id).join(",") : "");
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The loaded items of each collection, by collection id. */
export class SharedCache<T extends { id: string }> {
  private entries = new Map<string, Entry<T>>();

  constructor(
    private source: Source<T>,
    private collectionOf: (collectionId: string) => Collection | undefined,
  ) {}

  /** What is loaded for a collection now (an empty snapshot when nothing shows it). */
  snapshot(collectionId: string): Snapshot<T> {
    return this.entries.get(collectionId)?.snapshot ?? (EMPTY as Snapshot<T>);
  }

  /** Starts keeping the collection's items loaded and current for `listener`; returns the unsubscribe. */
  subscribe(collectionId: string, listener: () => void): () => void {
    let entry = this.entries.get(collectionId);
    if (!entry) {
      const collection = this.collectionOf(collectionId);
      entry = {
        snapshot: { items: collection ? null : [], version: 0 },
        listeners: new Set(),
        fieldKey: fieldKeyOf(collection),
        reloading: new Map(),
        generation: 0,
      };
      this.entries.set(collectionId, entry);
      if (collection) void this.reload(collectionId);
    }
    clearTimeout(entry.dropTimer);
    const own = entry;
    own.listeners.add(listener);
    return () => {
      own.listeners.delete(listener);
      if (own.listeners.size > 0) return;
      own.dropTimer = setTimeout(() => {
        if (own.listeners.size === 0 && this.entries.get(collectionId) === own) this.entries.delete(collectionId);
      }, GRACE_MS);
    };
  }

  /** Loads the whole collection again. */
  async reload(collectionId: string): Promise<void> {
    const entry = this.entries.get(collectionId);
    const collection = this.collectionOf(collectionId);
    if (!entry || !collection) return;
    const generation = ++entry.generation;
    try {
      const items = await this.source.list(collection);
      if (entry.generation !== generation) return;
      const held = entry.snapshot.items;
      const same = this.source.same;
      if (same && held && !entry.snapshot.error && held.length === items.length && held.every((x, i) => same(x, items[i]))) return;
      this.set(entry, items);
    } catch (e) {
      if (entry.generation === generation) this.set(entry, entry.snapshot.items, messageOf(e));
    }
  }

  /** Reads one item again: replaced when known, added when new, dropped when gone. */
  refresh(collectionId: string, id: string): Promise<void> {
    const entry = this.entries.get(collectionId);
    const collection = this.collectionOf(collectionId);
    if (!entry || !collection) return Promise.resolve();
    if (!entry.snapshot.items) {
      // A full load is under way, perhaps started before this change: it must start again.
      return this.reload(collectionId);
    }
    const job: Promise<void> = this.source
      .one(collection, id)
      .then((item) => {
        const list = entry.snapshot.items;
        if (!list) return;
        if (item && this.source.same) {
          const held = list.find((x) => x.id === id);
          if (held && this.source.same(held, item)) return;
        }
        const rest = list.filter((x) => x.id !== id);
        if (!item) return this.set(entry, rest);
        this.set(entry, rest.length === list.length ? [item, ...rest] : list.map((x) => (x.id === id ? item : x)));
      })
      .catch((e) => this.set(entry, entry.snapshot.items, messageOf(e)))
      .finally(() => {
        if (entry.reloading.get(id) === job) entry.reloading.delete(id);
      });
    entry.reloading.set(id, job);
    return job;
  }

  /** The reload of an item already under way (begun by its change), else a new one. */
  settled(collectionId: string, id: string): Promise<void> {
    return this.entries.get(collectionId)?.reloading.get(id) ?? this.refresh(collectionId, id);
  }

  /** Changes one item right away (an edit shown before it is saved); the saved result replaces it. */
  patch(collectionId: string, id: string, update: (item: T) => T) {
    const entry = this.entries.get(collectionId);
    const list = entry?.snapshot.items;
    if (entry && list) this.set(entry, list.map((x) => (x.id === id ? update(x) : x)));
  }

  /** Applies a committed change. */
  handle(change: DataChange) {
    if (change.scope !== "items") return;
    if (change.itemId) void this.refresh(change.collectionId, change.itemId);
    else void this.reload(change.collectionId);
  }

  /** Everything shown is loaded again, from scratch (another space); what nothing shows is dropped. */
  reloadAll() {
    for (const [collectionId, entry] of this.entries) {
      if (entry.listeners.size === 0) {
        this.entries.delete(collectionId);
        continue;
      }
      this.set(entry, null);
      void this.reload(collectionId);
    }
  }

  /** The collections were reloaded: the lists of those with other fields are loaded again. */
  collectionsChanged() {
    for (const [collectionId, entry] of this.entries) {
      const key = fieldKeyOf(this.collectionOf(collectionId));
      if (key === entry.fieldKey) continue;
      entry.fieldKey = key;
      void this.reload(collectionId);
    }
  }

  private set(entry: Entry<T>, items: T[] | null, error?: string) {
    entry.snapshot = { items, error, version: entry.snapshot.version + 1 };
    for (const listener of entry.listeners) listener();
  }
}

/** The shared lists: items of the current space, and labels alone (what references and pickers need). */
export class ItemCache {
  readonly items: SharedCache<Item>;
  readonly labels: SharedCache<ItemLabel>;
  private unsubscribe: () => void;

  constructor(repo: Repository, collectionOf: (collectionId: string) => Collection | undefined, space: () => string) {
    this.items = new SharedCache(
      {
        list: (c) => repo.listItems(c, space()),
        // An item of another space (e.g. just moved there) isn't in this space's list.
        one: async (c, id) => {
          const item = await repo.getItem(c, id);
          return item && item.spaceId === space() ? item : null;
        },
      },
      collectionOf,
    );
    this.labels = new SharedCache(
      {
        list: (t) => repo.listLabels(t),
        one: async (t, id) => (await repo.listLabels(t, [id]))[0] ?? null,
        // An edit that leaves the label as it was (most do) changes nothing that shows labels:
        // references, and the rows and cards of every collection referring to this one.
        same: (a, b) => a.label === b.label && a.spaceId === b.spaceId,
      },
      collectionOf,
    );
    this.unsubscribe = repo.subscribe((change) => {
      this.items.handle(change);
      this.labels.handle(change);
    });
  }

  collectionsChanged() {
    this.items.collectionsChanged();
    this.labels.collectionsChanged();
  }

  /** The shown space changed: items are another space's now (labels cover every space). */
  spaceChanged() {
    this.items.reloadAll();
  }

  dispose() {
    this.unsubscribe();
  }
}
