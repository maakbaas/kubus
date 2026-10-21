// One loaded copy of each type's objects (and of their labels), shared by every pane and page.
//
// Pages used to load a type's objects themselves, so the same objects could be in memory several
// times and every pane re-read them on its own. Here a collection is loaded once while anything
// shows it, kept up to date from the repository's change feed (one changed object is re-read, not
// the whole type), and dropped shortly after the last viewer leaves. Objects that didn't change
// keep their identity, so what is derived from them (computed values, memoized rows) stays valid.

import type { DataChange, Repository } from "../data/repository";
import type { ObjectInstance, ObjectLabel, ObjectType } from "../domain/model";

/** What a viewer sees of a collection; replaced (never changed) whenever the collection changes. */
export interface Snapshot<T> {
  /** null until loaded. */
  items: T[] | null;
  error?: string;
  /** Counts the changes, for viewers that combine several collections. */
  version: number;
}

const EMPTY: Snapshot<never> = { items: null, version: 0 };

/** How long a collection stays (and stays current) after its last viewer left, e.g. switching tabs back. */
const GRACE_MS = 10_000;

interface Source<T> {
  list(type: ObjectType): Promise<T[]>;
  one(type: ObjectType, id: string): Promise<T | null>;
}

interface Entry<T> {
  snapshot: Snapshot<T>;
  listeners: Set<() => void>;
  /** The type's field ids in order: when they change, what was loaded may no longer fit. */
  fieldKey: string;
  /** Single-object reloads in progress, by id. */
  reloading: Map<string, Promise<void>>;
  /** Counts full loads, so a slow older one can't overwrite a newer one. */
  generation: number;
  dropTimer?: ReturnType<typeof setTimeout>;
}

const fieldKeyOf = (type: ObjectType | undefined) => (type ? type.fields.map((f) => f.id).join(",") : "");
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The loaded items of each type, by type id. */
export class Collection<T extends { id: string }> {
  private entries = new Map<string, Entry<T>>();

  constructor(
    private source: Source<T>,
    private typeOf: (typeId: string) => ObjectType | undefined,
  ) {}

  /** What is loaded for a type now (an empty snapshot when nothing shows it). */
  snapshot(typeId: string): Snapshot<T> {
    return this.entries.get(typeId)?.snapshot ?? (EMPTY as Snapshot<T>);
  }

  /** Starts keeping the type's items loaded and current for `listener`; returns the unsubscribe. */
  subscribe(typeId: string, listener: () => void): () => void {
    let entry = this.entries.get(typeId);
    if (!entry) {
      const type = this.typeOf(typeId);
      entry = {
        snapshot: { items: type ? null : [], version: 0 },
        listeners: new Set(),
        fieldKey: fieldKeyOf(type),
        reloading: new Map(),
        generation: 0,
      };
      this.entries.set(typeId, entry);
      if (type) void this.reload(typeId);
    }
    clearTimeout(entry.dropTimer);
    const own = entry;
    own.listeners.add(listener);
    return () => {
      own.listeners.delete(listener);
      if (own.listeners.size > 0) return;
      own.dropTimer = setTimeout(() => {
        if (own.listeners.size === 0 && this.entries.get(typeId) === own) this.entries.delete(typeId);
      }, GRACE_MS);
    };
  }

  /** Loads the whole type again. */
  async reload(typeId: string): Promise<void> {
    const entry = this.entries.get(typeId);
    const type = this.typeOf(typeId);
    if (!entry || !type) return;
    const generation = ++entry.generation;
    try {
      const items = await this.source.list(type);
      if (entry.generation === generation) this.set(entry, items);
    } catch (e) {
      if (entry.generation === generation) this.set(entry, entry.snapshot.items, messageOf(e));
    }
  }

  /** Reads one item again: replaced when known, added when new, dropped when gone. */
  refresh(typeId: string, id: string): Promise<void> {
    const entry = this.entries.get(typeId);
    const type = this.typeOf(typeId);
    if (!entry || !type) return Promise.resolve();
    if (!entry.snapshot.items) {
      // A full load is under way, perhaps started before this change: it must start again.
      return this.reload(typeId);
    }
    const job: Promise<void> = this.source
      .one(type, id)
      .then((item) => {
        const list = entry.snapshot.items;
        if (!list) return;
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
  settled(typeId: string, id: string): Promise<void> {
    return this.entries.get(typeId)?.reloading.get(id) ?? this.refresh(typeId, id);
  }

  /** Changes one item right away (an edit shown before it is saved); the saved result replaces it. */
  patch(typeId: string, id: string, update: (item: T) => T) {
    const entry = this.entries.get(typeId);
    const list = entry?.snapshot.items;
    if (entry && list) this.set(entry, list.map((x) => (x.id === id ? update(x) : x)));
  }

  /** Applies a committed change. */
  handle(change: DataChange) {
    if (change.scope !== "objects") return;
    if (change.objectId) void this.refresh(change.typeId, change.objectId);
    else void this.reload(change.typeId);
  }

  /** The types were reloaded: collections whose type got other fields are loaded again. */
  typesChanged() {
    for (const [typeId, entry] of this.entries) {
      const key = fieldKeyOf(this.typeOf(typeId));
      if (key === entry.fieldKey) continue;
      entry.fieldKey = key;
      void this.reload(typeId);
    }
  }

  private set(entry: Entry<T>, items: T[] | null, error?: string) {
    entry.snapshot = { items, error, version: entry.snapshot.version + 1 };
    for (const listener of entry.listeners) listener();
  }
}

/** The shared collections: objects, and their labels alone (what references and pickers need). */
export class ObjectCache {
  readonly objects: Collection<ObjectInstance>;
  readonly labels: Collection<ObjectLabel>;
  private unsubscribe: () => void;

  constructor(repo: Repository, typeOf: (typeId: string) => ObjectType | undefined) {
    this.objects = new Collection({ list: (t) => repo.listObjects(t), one: (t, id) => repo.getObject(t, id) }, typeOf);
    this.labels = new Collection(
      { list: (t) => repo.listLabels(t), one: async (t, id) => (await repo.listLabels(t, [id]))[0] ?? null },
      typeOf,
    );
    this.unsubscribe = repo.subscribe((change) => {
      this.objects.handle(change);
      this.labels.handle(change);
    });
  }

  typesChanged() {
    this.objects.typesChanged();
    this.labels.typesChanged();
  }

  dispose() {
    this.unsubscribe();
  }
}
