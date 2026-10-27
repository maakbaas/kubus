import type { FieldDef, FieldValue, Item, ItemLabel, Collection, CollectionDraft } from "../domain/model";
import type { Bookmark, BookmarkKind } from "../domain/bookmarks";
import type { ItemView } from "../domain/fieldLayout";
import type { Component } from "../domain/components";
import type { Space } from "../domain/spaces";
import type { CollectionView } from "../domain/views";

/**
 * What changed after a write, so every open view of that data can refresh (another pane, a
 * reference label). A future sync layer reports incoming changes the same way.
 */
export type DataChange =
  | { scope: "spaces" }
  | { scope: "collections" }
  | { scope: "items"; collectionId: string; itemId?: string }
  | { scope: "views"; collectionId: string }
  | { scope: "components" }
  | { scope: "bookmarks" };

/** Where and whether this device syncs (stored per device; see data/sync/SyncEngine.ts). */
export interface SyncConfig {
  /** The Kubus server, e.g. https://notes.example.com */
  url: string;
  token: string;
  enabled: boolean;
  /**
   * Which file bytes this device downloads after a sync: every file ("always"), or only
   * thumbnails ("opened": an original is fetched, and then kept, when it is first shown).
   */
  originals: "always" | "opened";
}
export interface SyncStatus {
  state: "off" | "idle" | "syncing" | "error";
  /** ISO time of the last successful sync. */
  lastSync: string | null;
  error: string | null;
  /**
   * The server's database is another one than this device synced with (wiped or replaced since):
   * sync is paused until the user connects again (`reconnect`) or disconnects. When the new one was
   * made, and whether it holds anything (connecting again then uploads this device's data, else
   * replaces it with the server's).
   */
  replaced: { createdAt: string; empty: boolean } | null;
}
export interface SyncControl {
  readonly config: SyncConfig;
  /** A new object whenever it changes (for useSyncExternalStore). */
  readonly status: SyncStatus;
  subscribe(listener: () => void): () => void;
  /** Saves the settings and syncs right away when enabled. */
  configure(config: SyncConfig): Promise<void>;
  syncNow(): Promise<void>;
  /**
   * Forgets the server: clears the settings and what sync remembered about it. The device keeps its
   * data; connecting again later counts as a first connection (the server's data replaces it).
   */
  disconnect(): Promise<void>;
  /**
   * Stops syncing, keeping the server's address and token. Switching it on again counts as a first
   * connection (the server's data replaces this device's).
   */
  pause(): Promise<void>;
  /** After `status.replaced`: syncs again, as a first connection to the server's new database. */
  reconnect(): Promise<void>;
  /**
   * Deletes everything on the saved server (all devices' data; also when its tables don't fit the
   * schema), then pauses sync here: switching it on again uploads this device's data.
   */
  wipeServer(): Promise<void>;
  /** True when connecting to `url` would replace this device's data with the server's (first time). */
  isNewServer(url: string): boolean;
}

/**
 * The only door from the UI to persistence. Today it is backed by local SQLite;
 * a future sync-aware implementation (local replica + Postgres) plugs in here
 * without touching the UI.
 */
export interface Repository {
  /** persistent=false means an in-memory fallback: data is lost on reload. */
  readonly storage: { persistent: boolean };
  /**
   * Drops all data on this device, after pausing sync (see `SyncControl.pause`): a new, empty
   * database. Whatever shows data must start over: the app reloads after it.
   */
  wipeLocal(): Promise<void>;
  /** Syncing with the Kubus server. */
  readonly sync: SyncControl;

  /** Notified after every successful write; returns an unsubscribe function. */
  subscribe(listener: (change: DataChange) => void): () => void;

  /** All spaces, the default one included, in their order. */
  listSpaces(): Promise<Space[]>;
  /** Creates (at the end) or renames / re-icons a space. */
  saveSpace(space: Pick<Space, "id" | "name" | "icon">): Promise<void>;
  /** Deletes a space with its items, views and bookmarks. The default space can't be deleted. */
  deleteSpace(spaceId: string): Promise<void>;

  listCollections(): Promise<Collection[]>;
  /**
   * Creates or updates a collection, including adding/renaming/removing fields. A new one gets
   * an "All" view in `spaceId` (views belong to a space).
   */
  saveCollection(draft: CollectionDraft, spaceId: string): Promise<void>;
  deleteCollection(collectionId: string): Promise<void>;
  /** Item counts per collection, of one space, or of all when null. */
  countItemsByCollection(spaceId: string | null): Promise<Record<string, number>>;

  /** A collection's items in one space, most recently changed first (or one page of them). */
  listItems(collection: Collection, spaceId: string, page?: { limit: number; offset: number }): Promise<Item[]>;
  /** One item, whichever space it is in. */
  getItem(collection: Collection, itemId: string): Promise<Item | null>;
  /** These items of a collection, whichever space they are in (deleted ones left out). */
  getItems(collection: Collection, itemIds: string[]): Promise<Item[]>;
  /** The collection of each of these items (also of deleted ones), by item id. */
  collectionsOfItems(itemIds: string[]): Promise<Map<string, string>>;
  /**
   * Just the labels (`labelField`: the first non-empty string value, as stored) of a collection's
   * items in every space, or of the given ones: what pickers and links need, without loading every value.
   */
  listLabels(collection: Collection, itemIds?: string[]): Promise<ItemLabel[]>;
  /** Returns the id of the created item. */
  createItem(collection: Collection, values: Record<string, FieldValue>, spaceId: string): Promise<string>;
  /**
   * Creates many items (of any collections) in one change set, e.g. an import; they may refer to
   * each other. Returns their ids, in order.
   */
  createItems(entries: NewItem[]): Promise<string[]>;
  updateItem(collection: Collection, itemId: string, values: Record<string, FieldValue>): Promise<void>;
  /**
   * Stores what a model generated for an AI field, with the fingerprint of the prompt it answers
   * (domain/ai.ts). Leaves the item itself (its updatedAt) alone; ignored for an item that is gone.
   */
  setGenerated(collection: Collection, itemId: string, field: FieldDef, value: string | number | null, inputHash: string): Promise<void>;
  /**
   * Records that a value the user typed over an AI field's stands for the item as its prompt reads
   * now (`inputHash`): it is then current, and asked about only when that changes again.
   */
  acceptEdit(collection: Collection, itemId: string, field: FieldDef, inputHash: string): Promise<void>;
  /** Moves an item to another space (its references and files stay as they are). */
  moveItem(itemId: string, spaceId: string): Promise<void>;
  deleteItem(itemId: string): Promise<void>;
  /**
   * Items in `spaceId` of any of `collections` (the caller's current list of all collections) whose text
   * (string, markdown, list of strings) contains `query`. Most recent first.
   */
  search(query: string, collections: Collection[], spaceId: string, limit?: number): Promise<Item[]>;

  /** Saved views of a collection's items in one space, in their display order. */
  listViews(collectionId: string, spaceId: string): Promise<CollectionView[]>;
  /** Every view, of every collection and space (what the Components page lists local components from). */
  listAllViews(): Promise<CollectionView[]>;
  /** Creates or updates a view (by id). */
  saveView(view: CollectionView): Promise<void>;
  deleteView(viewId: string): Promise<void>;
  /** Stars a view as the collection's default in a space (unstarring any other there), or clears it with null. */
  setDefaultView(collectionId: string, spaceId: string, viewId: string | null): Promise<void>;

  /** Replaces a collection's item page layouts. */
  saveItemViews(collectionId: string, views: ItemView[]): Promise<void>;
  /** Pins an item to one of its collection's item views, or back to the collection's default with null. */
  pinItemView(itemId: string, viewId: string | null): Promise<void>;

  /** A space's side-nav bookmarks, in their order. */
  listBookmarks(spaceId: string): Promise<Bookmark[]>;
  /** Bookmarks the view or item in a space (at the end of its list). */
  addBookmark(kind: BookmarkKind, collectionId: string, targetId: string, label: string, spaceId: string): Promise<void>;
  /** Removes the space's bookmark of this view or item, if any. */
  removeBookmark(targetId: string, spaceId: string): Promise<void>;
  /** Updates the label snapshot of a bookmarked view or item (no-op when unchanged). */
  relabelBookmark(targetId: string, label: string): Promise<void>;

  /** All components, by name. */
  listComponents(): Promise<Component[]>;
  /** Creates or updates a component (by id). */
  saveComponent(component: Component): Promise<void>;
  /**
   * Fails while a field still uses the component, unless `withFields`: then those fields are
   * removed too (in the same transaction). Their values are computed, so no data is lost.
   */
  deleteComponent(componentId: string, options?: { withFields?: boolean }): Promise<void>;

  /** Stores binary content (deduplicated by hash) and returns its file id. */
  putFile(data: Uint8Array, mime: string): Promise<string>;
  /**
   * A file's bytes (fetched from the server when this device doesn't have them yet; null when
   * that fails). `small`: its thumbnail when it has one (then `small` is true in the answer).
   */
  getFile(fileId: string, options?: { small?: boolean }): Promise<{ data: Uint8Array; mime: string; small?: boolean } | null>;
  /** Stores a small version of an image file (made by the UI: ui/thumbnails.ts), used where it is shown small. */
  putThumbnail(fileId: string, data: Uint8Array, mime: string): Promise<void>;
  /** Deletes these files unless a live item still uses them. Safe to call liberally. */
  releaseFiles(fileIds: string[]): Promise<void>;
}

/** An item to create: its values by field id, its space, and its id when the caller has one (else a new one). */
export interface NewItem {
  collection: Collection;
  values: Record<string, FieldValue>;
  spaceId: string;
  id?: string;
}
