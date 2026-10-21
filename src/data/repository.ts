import type { FieldValue, ObjectInstance, ObjectLabel, ObjectType, ObjectTypeDraft } from "../domain/model";
import type { Bookmark, BookmarkKind } from "../domain/bookmarks";
import type { ObjectView } from "../domain/fieldLayout";
import type { Template } from "../domain/templates";
import type { SavedView } from "../domain/views";

/**
 * What changed after a write, so every open view of that data can refresh (another pane, a
 * reference label). A future sync layer reports incoming changes the same way.
 */
export type DataChange =
  | { scope: "types" }
  | { scope: "objects"; typeId: string; objectId?: string }
  | { scope: "views"; typeId: string }
  | { scope: "templates" }
  | { scope: "bookmarks" };

/**
 * The only door from the UI to persistence. Today it is backed by local SQLite;
 * a future sync-aware implementation (local replica + Postgres) plugs in here
 * without touching the UI.
 */
export interface Repository {
  /** persistent=false means an in-memory fallback: data is lost on reload. */
  readonly storage: { persistent: boolean };

  /** Notified after every successful write; returns an unsubscribe function. */
  subscribe(listener: (change: DataChange) => void): () => void;

  listTypes(): Promise<ObjectType[]>;
  /** Creates or updates a type, including adding/renaming/removing fields. */
  saveType(draft: ObjectTypeDraft): Promise<void>;
  deleteType(typeId: string): Promise<void>;
  countObjectsByType(): Promise<Record<string, number>>;

  listObjects(type: ObjectType): Promise<ObjectInstance[]>;
  getObject(type: ObjectType, objectId: string): Promise<ObjectInstance | null>;
  /**
   * Just the labels (`labelField`: the first non-empty string value, as stored) of a type's
   * objects, or of the given ones: what pickers and links need, without loading every value.
   */
  listLabels(type: ObjectType, objectIds?: string[]): Promise<ObjectLabel[]>;
  /** Returns the id of the created object. */
  createObject(type: ObjectType, values: Record<string, FieldValue>): Promise<string>;
  updateObject(type: ObjectType, objectId: string, values: Record<string, FieldValue>): Promise<void>;
  deleteObject(objectId: string): Promise<void>;
  /**
   * Objects of any of `types` (the caller's current list of all types) whose text (string, markdown,
   * list of strings) contains `query`. Most recent first.
   */
  search(query: string, types: ObjectType[], limit?: number): Promise<ObjectInstance[]>;

  /** Saved views of a type's objects, in their display order. */
  listViews(typeId: string): Promise<SavedView[]>;
  /** Creates or updates a view (by id). */
  saveView(view: SavedView): Promise<void>;
  deleteView(viewId: string): Promise<void>;
  /** Stars a view as the type's default (unstarring any other), or clears it with null. */
  setDefaultView(typeId: string, viewId: string | null): Promise<void>;

  /** Replaces a type's object page layouts. */
  saveObjectViews(typeId: string, views: ObjectView[]): Promise<void>;
  /** Pins an object to one of its type's object views, or back to the type's default with null. */
  pinObjectView(objectId: string, viewId: string | null): Promise<void>;

  /** Side-nav bookmarks, in their order. */
  listBookmarks(): Promise<Bookmark[]>;
  /** Bookmarks the view or object (at the end of the list). */
  addBookmark(kind: BookmarkKind, typeId: string, targetId: string, label: string): Promise<void>;
  /** Removes the bookmark of this view or object, if any. */
  removeBookmark(targetId: string): Promise<void>;
  /** Updates the label snapshot of a bookmarked view or object (no-op when unchanged). */
  relabelBookmark(targetId: string, label: string): Promise<void>;

  /** All templates, by name. */
  listTemplates(): Promise<Template[]>;
  /** Creates or updates a template (by id). */
  saveTemplate(template: Template): Promise<void>;
  /**
   * Fails while a field still uses the template, unless `withFields`: then those fields are
   * removed too (in the same transaction). Their values are computed, so no data is lost.
   */
  deleteTemplate(templateId: string, options?: { withFields?: boolean }): Promise<void>;

  /** Stores binary content (deduplicated by hash) and returns its file id. */
  putFile(data: Uint8Array, mime: string): Promise<string>;
  getFile(fileId: string): Promise<{ data: Uint8Array; mime: string } | null>;
  /** Deletes these files unless a live object still uses them. Safe to call liberally. */
  releaseFiles(fileIds: string[]): Promise<void>;
}
