import { fieldKinds } from "../../domain/fieldKinds";
import { fileIdsIn } from "../../domain/files";
import {
  newId,
  now,
  type FieldDef,
  type FieldKind,
  type FieldValue,
  type Item,
  type ItemLabel,
  type Collection,
  type CollectionDraft,
  valuesEqual,
  parseComponentArgs,
} from "../../domain/model";
import { defaultQuery, type FilterRule } from "../../domain/query";
import type { Bookmark, BookmarkKind } from "../../domain/bookmarks";
import { parseItemViews, withDefaultItemView, type ItemView } from "../../domain/fieldLayout";
import { hasSections, isComponentOutput, type Component } from "../../domain/components";
import { DEFAULT_SPACE_ID, withDefaultSpace, type Space } from "../../domain/spaces";
import type { CollectionView } from "../../domain/views";
import type { DataChange, Repository } from "../repository";
import { SyncEngine } from "../sync/SyncEngine";
import { SqlClient } from "./client";
import type { Statement } from "./protocol";

interface CollectionRow {
  id: string;
  name: string;
  plural_name: string;
  icon: string | null;
  description: string;
  item_views: string | null;
  space_ids: string | null;
  created_at: string;
  updated_at: string;
}
interface FieldRow {
  id: string;
  collection_id: string;
  name: string;
  kind: FieldKind;
  target_collection_id: string | null;
  component_id: string | null;
  component_args: string | null;
  choice_filter: string | null;
  toggle_icon: string | null;
  position: number;
}
interface ComponentRow {
  id: string;
  name: string;
  params: string;
  code: string;
  output: string;
  frame_ratio: string | null;
  created_at: string;
  updated_at: string;
}
interface ViewRow {
  id: string;
  collection_id: string;
  space_id: string;
  name: string;
  kind: string;
  config: string;
  position: number;
  is_default: number;
  created_at: string;
  updated_at: string;
}
interface ItemRow {
  id: string;
  collection_id: string;
  space_id: string;
  item_view_id: string | null;
  created_at: string;
  updated_at: string;
}
interface ValueRow {
  item_id: string;
  field_id: string;
  value_text: string | null;
  value_number: number | null;
  value_date: string | null;
  value_datetime: string | null;
  value_bool: number | null;
  value_ref: string | null;
  value_file: string | null;
  value_json: string | null;
}

const toField = (r: FieldRow): FieldDef => ({
  id: r.id,
  collectionId: r.collection_id,
  name: r.name,
  kind: r.kind,
  targetCollectionId: r.target_collection_id,
  componentId: r.component_id,
  componentArgs: parseComponentArgs(r.component_args),
  choiceFilter: parseJson<FilterRule[]>(r.choice_filter, []),
  toggleIcon: r.toggle_icon,
  position: r.position,
});

/** Stored space_ids: null (every space) or a list of space ids. */
const spaceIdsOf = (json: string | null): string[] | null => {
  const ids = parseJson<unknown>(json, null);
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : null;
};
const spaceIdsJson = (ids: string[] | null) => (ids === null ? null : JSON.stringify(ids));

function parseJson<T>(text: string | null, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/**
 * Reads go straight to the worker; each mutating method collects its
 * statements and commits them as one transaction (one change set — the unit a
 * future sync outbox would record).
 */
export class SqliteRepository implements Repository {
  private constructor(private db: SqlClient) {
    this.sync = new SyncEngine(db, (...changes) => this.emit(...changes));
    this.subscribe(() => this.sync.localChange());
  }

  readonly sync: SyncEngine;

  private listeners = new Set<(change: DataChange) => void>();

  subscribe(listener: (change: DataChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Announces a committed change to every subscriber (other panes, reference labels, …). */
  private emit(...changes: DataChange[]) {
    for (const change of changes) for (const listener of this.listeners) listener(change);
  }

  private async collectionOfItem(itemId: string): Promise<string | undefined> {
    return (await this.db.select<{ collection_id: string }>("SELECT collection_id FROM items WHERE id = ?1", [itemId]))[0]?.collection_id;
  }

  static async open(): Promise<SqliteRepository> {
    const db = await SqlClient.open();
    // Stable identity of this replica, needed once sync exists.
    await db.write([{ sql: "INSERT OR IGNORE INTO meta (key, value) VALUES ('replica_id', ?1)", bind: [newId()] }]);
    return new SqliteRepository(db);
  }

  get storage() {
    return { persistent: this.db.info.persistent };
  }

  async listSpaces(): Promise<Space[]> {
    const rows = await this.db.select<Space>(
      "SELECT id, name, icon, position FROM spaces WHERE deleted_at IS NULL ORDER BY position, created_at",
    );
    return withDefaultSpace(rows);
  }

  async saveSpace(space: Pick<Space, "id" | "name" | "icon">): Promise<void> {
    const ts = now();
    await this.db.write([
      {
        // A new space goes last; the default one (no row yet) stays first.
        sql: `INSERT INTO spaces (id, name, icon, position, created_at, updated_at)
              SELECT ?1, ?2, ?3, CASE WHEN ?1 = ?5 THEN -1 ELSE COALESCE(MAX(position), -1) + 1 END, ?4, ?4 FROM spaces WHERE deleted_at IS NULL
              ON CONFLICT (id) DO UPDATE SET name = excluded.name, icon = excluded.icon, updated_at = excluded.updated_at`,
        bind: [space.id, space.name, space.icon, ts, DEFAULT_SPACE_ID],
      },
    ]);
    this.emit({ scope: "spaces" });
  }

  async deleteSpace(spaceId: string): Promise<void> {
    if (spaceId === DEFAULT_SPACE_ID) throw new Error("The first space can't be deleted.");
    const ts = now();
    const collections = await this.db.select<{ collection_id: string }>(
      `SELECT collection_id FROM items WHERE space_id = ?1 AND deleted_at IS NULL
        UNION SELECT collection_id FROM views WHERE space_id = ?1 AND deleted_at IS NULL`,
      [spaceId],
    );
    await this.db.write([
      ...(await this.releaseFilesWhere("item_id IN (SELECT id FROM items WHERE space_id = ?1 AND deleted_at IS NULL)", [spaceId])),
      { sql: "UPDATE items SET deleted_at = ?1, updated_at = ?1 WHERE space_id = ?2 AND deleted_at IS NULL", bind: [ts, spaceId] },
      { sql: "UPDATE bookmarks SET deleted_at = ?1, updated_at = ?1 WHERE space_id = ?2 AND deleted_at IS NULL", bind: [ts, spaceId] },
      { sql: "UPDATE views SET deleted_at = ?1, updated_at = ?1 WHERE space_id = ?2 AND deleted_at IS NULL", bind: [ts, spaceId] },
      { sql: "UPDATE spaces SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2", bind: [ts, spaceId] },
    ]);
    this.emit({ scope: "spaces" }, { scope: "bookmarks" }, ...collections.flatMap((c) => [
      { scope: "items", collectionId: c.collection_id } as const,
      { scope: "views", collectionId: c.collection_id } as const,
    ]));
  }

  async listCollections(): Promise<Collection[]> {
    const collections = await this.db.select<CollectionRow>(
      "SELECT * FROM collections WHERE deleted_at IS NULL ORDER BY plural_name COLLATE NOCASE",
    );
    const fields = await this.db.select<FieldRow>(
      "SELECT * FROM fields WHERE deleted_at IS NULL ORDER BY position, created_at",
    );
    return collections.map((t) => ({
      id: t.id,
      name: t.name,
      pluralName: t.plural_name,
      icon: t.icon,
      description: t.description,
      fields: fields.filter((f) => f.collection_id === t.id).map(toField),
      itemViews: withDefaultItemView(parseItemViews(t.item_views)),
      spaceIds: spaceIdsOf(t.space_ids),
      createdAt: t.created_at,
      updatedAt: t.updated_at,
    }));
  }

  async saveCollection(draft: CollectionDraft, spaceId: string): Promise<void> {
    const ts = now();
    const writes: Statement[] = [];
    const existing = await this.db.select<{ id: string }>("SELECT id FROM collections WHERE id = ?1", [draft.id]);
    if (existing.length === 0) {
      writes.push({
        sql: "INSERT INTO collections (id, name, plural_name, icon, description, space_ids, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?7, ?6, ?6)",
        bind: [draft.id, draft.name, draft.pluralName, draft.icon, draft.description, ts, spaceIdsJson(draft.spaceIds)],
      });
      // Every collection starts with an ordinary (renamable, deletable) "All" view in the space it
      // was made in: a table of all items sorted by title; its options are filled in by the view
      // type's normalizeOptions. Other spaces show that unsaved table until a view is saved there.
      writes.push({
        sql: `INSERT INTO views (id, collection_id, space_id, name, kind, config, position, is_default, created_at, updated_at)
              VALUES (?1, ?2, ?5, 'All', 'table', ?3, 0, 0, ?4, ?4)`,
        bind: [newId(), draft.id, JSON.stringify({ query: defaultQuery(), options: null }), ts, spaceId],
      });
    }

    const stored = await this.db.select<FieldRow>("SELECT * FROM fields WHERE collection_id = ?1 AND deleted_at IS NULL", [
      draft.id,
    ]);
    const storedById = new Map(stored.map((f) => [f.id, f]));
    const keep = new Set(draft.fields.map((f) => f.id));

    for (const [position, f] of draft.fields.entries()) {
      const old = storedById.get(f.id);
      if (!old) {
        writes.push({
          sql: "INSERT INTO fields (id, collection_id, name, kind, target_collection_id, component_id, component_args, choice_filter, toggle_icon, position, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?10, ?11, ?8, ?9, ?9)",
          bind: [f.id, draft.id, f.name, f.kind, f.targetCollectionId, f.componentId, args(f), position, ts, choices(f), f.toggleIcon],
        });
      } else if (
        old.name !== f.name ||
        old.position !== position ||
        old.component_id !== f.componentId ||
        (old.component_args ?? null) !== args(f) ||
        (old.choice_filter ?? null) !== choices(f) ||
        old.toggle_icon !== f.toggleIcon
      ) {
        // Kind and target are immutable once created (values would need conversion); an
        // component field's component may change (its values are computed, not stored).
        writes.push({
          sql: "UPDATE fields SET name = ?1, position = ?2, component_id = ?3, component_args = ?4, updated_at = ?5, choice_filter = ?7, toggle_icon = ?8 WHERE id = ?6",
          bind: [
            f.name,
            position,
            old.kind === "component" ? f.componentId : old.component_id,
            old.kind === "component" ? args(f) : old.component_args,
            ts,
            f.id,
            choices(f),
            f.toggleIcon,
          ],
        });
      }
    }
    const removed = stored.filter((old) => !keep.has(old.id));
    for (const old of removed) {
      writes.push({ sql: "UPDATE fields SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2", bind: [ts, old.id] });
    }

    writes.push({
      sql: "UPDATE collections SET name = ?1, plural_name = ?2, icon = ?3, description = ?4, space_ids = ?7, updated_at = ?5 WHERE id = ?6",
      bind: [draft.name, draft.pluralName, draft.icon, draft.description, ts, draft.id, spaceIdsJson(draft.spaceIds)],
    });
    for (const old of removed) {
      writes.push(...(await this.releaseFilesWhere("field_id = ?1", [old.id])));
    }
    await this.db.write(writes);
    this.emit({ scope: "collections" });
  }

  async deleteCollection(collectionId: string): Promise<void> {
    const referencing = await this.db.select<{ field: string; collection: string }>(
      `SELECT f.name AS field, t.name AS collection FROM fields f JOIN collections t ON t.id = f.collection_id
        WHERE f.target_collection_id = ?1 AND f.collection_id <> ?1 AND f.deleted_at IS NULL AND t.deleted_at IS NULL`,
      [collectionId],
    );
    if (referencing.length > 0) {
      const where = referencing.map((r) => `“${r.field}” of ${r.collection}`).join(", ");
      throw new Error(`Still referenced by ${where}. Remove those fields first.`);
    }
    const ts = now();
    await this.db.write([
      {
        sql: "UPDATE items SET deleted_at = ?1, updated_at = ?1 WHERE collection_id = ?2 AND deleted_at IS NULL",
        bind: [ts, collectionId],
      },
      {
        sql: "UPDATE fields SET deleted_at = ?1, updated_at = ?1 WHERE collection_id = ?2 AND deleted_at IS NULL",
        bind: [ts, collectionId],
      },
      {
        sql: "UPDATE views SET deleted_at = ?1, updated_at = ?1 WHERE collection_id = ?2 AND deleted_at IS NULL",
        bind: [ts, collectionId],
      },
      { sql: "UPDATE collections SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2", bind: [ts, collectionId] },
      ...(await this.releaseFilesWhere("item_id IN (SELECT id FROM items WHERE collection_id = ?1)", [collectionId])),
    ]);
    this.emit({ scope: "collections" }, { scope: "items", collectionId }, { scope: "views", collectionId });
  }

  async countItemsByCollection(spaceId: string | null): Promise<Record<string, number>> {
    const rows = await this.db.select<{ collection_id: string; n: number }>(
      "SELECT collection_id, COUNT(*) AS n FROM items WHERE deleted_at IS NULL AND (?1 IS NULL OR space_id = ?1) GROUP BY collection_id",
      [spaceId],
    );
    return Object.fromEntries(rows.map((r) => [r.collection_id, r.n]));
  }

  async listItems(collection: Collection, spaceId: string): Promise<Item[]> {
    const items = await this.db.select<ItemRow>(
      "SELECT * FROM items WHERE collection_id = ?1 AND space_id = ?2 AND deleted_at IS NULL ORDER BY updated_at DESC",
      [collection.id, spaceId],
    );
    const values = await this.db.select<ValueRow>(
      `SELECT fv.* FROM field_values fv
         JOIN items o ON o.id = fv.item_id
        WHERE o.collection_id = ?1 AND o.space_id = ?2 AND o.deleted_at IS NULL`,
      [collection.id, spaceId],
    );
    return this.assemble(collection, items, values);
  }

  async getItem(collection: Collection, itemId: string): Promise<Item | null> {
    const items = await this.db.select<ItemRow>(
      "SELECT * FROM items WHERE id = ?1 AND collection_id = ?2 AND deleted_at IS NULL",
      [itemId, collection.id],
    );
    if (items.length === 0) return null;
    const values = await this.db.select<ValueRow>("SELECT * FROM field_values WHERE item_id = ?1", [itemId]);
    return this.assemble(collection, items, values)[0];
  }

  async listLabels(collection: Collection, itemIds?: string[]): Promise<ItemLabel[]> {
    // Same rule as labelField: the first string field (in the collection's field order) whose value
    // isn't blank.
    return this.db.select<ItemLabel>(
      `SELECT o.id AS id, o.space_id AS spaceId,
              (SELECT fv.value_text FROM field_values fv JOIN fields f ON f.id = fv.field_id
                WHERE fv.item_id = o.id AND f.kind = 'string' AND f.deleted_at IS NULL
                  AND trim(fv.value_text, ' ' || char(9, 10, 13)) <> ''
                ORDER BY f.position, f.created_at LIMIT 1) AS label
         FROM items o
        WHERE o.collection_id = ?1 AND o.deleted_at IS NULL
          AND (?2 IS NULL OR o.id IN (SELECT value FROM json_each(?2)))`,
      [collection.id, itemIds ? JSON.stringify(itemIds) : null],
    );
  }

  async createItem(collection: Collection, values: Record<string, FieldValue>, spaceId: string): Promise<string> {
    const id = newId();
    const ts = now();
    const writes: Statement[] = [
      {
        sql: "INSERT INTO items (id, collection_id, space_id, created_at, updated_at) VALUES (?1, ?2, ?4, ?3, ?3)",
        bind: [id, collection.id, ts, spaceId],
      },
    ];
    // Only actual values: an empty field has no row, and component fields are computed, never stored.
    for (const field of collection.fields) {
      const value = values[field.id];
      if (value != null && field.kind !== "component") writes.push(valueStatement(id, field, value, ts));
    }
    await this.db.write(writes);
    this.emit({ scope: "items", collectionId: collection.id, itemId: id });
    return id;
  }

  async updateItem(collection: Collection, itemId: string, values: Record<string, FieldValue>): Promise<void> {
    const current = await this.getItem(collection, itemId);
    if (!current) throw new Error("Item not found");
    const ts = now();
    const writes: Statement[] = [];
    const replacedFiles: string[] = [];
    // Only touch changed fields: keeps per-field updated_at meaningful for merges.
    for (const field of collection.fields) {
      if (!(field.id in values)) continue;
      const next = values[field.id] ?? null;
      const prev = current.values[field.id];
      if (valuesEqual(next, prev)) continue;
      writes.push(valueStatement(itemId, field, next, ts));
      if (field.kind === "image" && typeof prev === "string") replacedFiles.push(prev);
      if ((field.kind === "markdown" || field.kind === "html") && typeof prev === "string") {
        const kept = new Set(typeof next === "string" ? fileIdsIn(next) : []);
        replacedFiles.push(...fileIdsIn(prev).filter((id) => !kept.has(id)));
      }
    }
    if (writes.length === 0) return;
    writes.push({ sql: "UPDATE items SET updated_at = ?1 WHERE id = ?2", bind: [ts, itemId] });
    writes.push(...replacedFiles.flatMap(releaseFile));
    await this.db.write(writes);
    this.emit({ scope: "items", collectionId: collection.id, itemId });
  }

  async moveItem(itemId: string, spaceId: string): Promise<void> {
    await this.db.write([
      { sql: "UPDATE items SET space_id = ?1, updated_at = ?2 WHERE id = ?3 AND space_id <> ?1", bind: [spaceId, now(), itemId] },
      // Its bookmarks stay behind in the old space's list: they would lead nowhere there.
      { sql: "UPDATE bookmarks SET deleted_at = ?1, updated_at = ?1 WHERE target_id = ?2 AND space_id <> ?3 AND deleted_at IS NULL", bind: [now(), itemId, spaceId] },
    ]);
    const collectionId = await this.collectionOfItem(itemId);
    if (collectionId) this.emit({ scope: "items", collectionId, itemId }, { scope: "bookmarks" });
  }

  async listViews(collectionId: string, spaceId: string): Promise<CollectionView[]> {
    const rows = await this.db.select<ViewRow>(
      "SELECT * FROM views WHERE collection_id = ?1 AND space_id = ?2 AND deleted_at IS NULL ORDER BY position, created_at",
      [collectionId, spaceId],
    );
    return rows.map((r) => {
      const config = JSON.parse(r.config) as Pick<CollectionView, "query" | "options">;
      return {
        id: r.id,
        collectionId: r.collection_id,
        spaceId: r.space_id,
        name: r.name,
        kind: r.kind,
        query: config.query,
        options: config.options,
        position: r.position,
        isDefault: r.is_default === 1,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      };
    });
  }

  async saveView(view: CollectionView): Promise<void> {
    const ts = now();
    const config = JSON.stringify({ query: view.query, options: view.options });
    await this.db.write([
      {
        sql: `INSERT INTO views (id, collection_id, space_id, name, kind, config, position, created_at, updated_at)
              VALUES (?1, ?2, ?8, ?3, ?4, ?5, ?6, ?7, ?7)
              ON CONFLICT (id) DO UPDATE SET
                name = excluded.name, kind = excluded.kind, config = excluded.config,
                position = excluded.position, updated_at = excluded.updated_at`,
        bind: [view.id, view.collectionId, view.name, view.kind, config, view.position, ts, view.spaceId],
      },
    ]);
    this.emit({ scope: "views", collectionId: view.collectionId });
  }

  async setDefaultView(collectionId: string, spaceId: string, viewId: string | null): Promise<void> {
    await this.db.write([
      {
        sql: `UPDATE views SET is_default = (id IS ?2), updated_at = ?3
               WHERE collection_id = ?1 AND space_id = ?4 AND deleted_at IS NULL AND is_default IS NOT (id IS ?2)`,
        bind: [collectionId, viewId, now(), spaceId],
      },
    ]);
    this.emit({ scope: "views", collectionId });
  }

  async saveItemViews(collectionId: string, views: ItemView[]): Promise<void> {
    await this.db.write([
      { sql: "UPDATE collections SET item_views = ?1, updated_at = ?2 WHERE id = ?3", bind: [JSON.stringify(views), now(), collectionId] },
    ]);
    this.emit({ scope: "collections" });
  }

  async pinItemView(itemId: string, viewId: string | null): Promise<void> {
    await this.db.write([
      { sql: "UPDATE items SET item_view_id = ?1, updated_at = ?2 WHERE id = ?3", bind: [viewId, now(), itemId] },
    ]);
    const collectionId = await this.collectionOfItem(itemId);
    if (collectionId) this.emit({ scope: "items", collectionId, itemId });
  }

  async listBookmarks(spaceId: string): Promise<Bookmark[]> {
    const rows = await this.db.select<{
      id: string;
      kind: BookmarkKind;
      collection_id: string;
      target_id: string;
      label: string;
      position: number;
      created_at: string;
    }>(
      // Bookmarks of deleted views and items aren't shown.
      `SELECT b.* FROM bookmarks b JOIN collections t ON t.id = b.collection_id AND t.deleted_at IS NULL
        WHERE b.deleted_at IS NULL AND b.space_id = ?1
          AND (b.kind <> 'view' OR EXISTS (SELECT 1 FROM views v WHERE v.id = b.target_id AND v.deleted_at IS NULL))
          AND (b.kind <> 'item' OR EXISTS (SELECT 1 FROM items o WHERE o.id = b.target_id AND o.deleted_at IS NULL))
        ORDER BY b.position, b.created_at`,
      [spaceId],
    );
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      collectionId: r.collection_id,
      targetId: r.target_id,
      label: r.label,
      position: r.position,
      createdAt: r.created_at,
    }));
  }

  async addBookmark(kind: BookmarkKind, collectionId: string, targetId: string, label: string, spaceId: string): Promise<void> {
    const ts = now();
    await this.db.write([
      {
        sql: `INSERT INTO bookmarks (id, kind, collection_id, space_id, target_id, label, position, created_at, updated_at)
              SELECT ?1, ?2, ?3, ?7, ?4, ?5, COALESCE(MAX(position), -1) + 1, ?6, ?6 FROM bookmarks WHERE deleted_at IS NULL AND space_id = ?7`,
        bind: [newId(), kind, collectionId, targetId, label, ts, spaceId],
      },
    ]);
    this.emit({ scope: "bookmarks" });
  }

  async removeBookmark(targetId: string, spaceId: string): Promise<void> {
    await this.db.write([
      {
        sql: "UPDATE bookmarks SET deleted_at = ?1, updated_at = ?1 WHERE target_id = ?2 AND space_id = ?3 AND deleted_at IS NULL",
        bind: [now(), targetId, spaceId],
      },
    ]);
    this.emit({ scope: "bookmarks" });
  }

  async relabelBookmark(targetId: string, label: string): Promise<void> {
    const changed = await this.db.select<{ id: string }>(
      "SELECT id FROM bookmarks WHERE target_id = ?1 AND deleted_at IS NULL AND label <> ?2",
      [targetId, label],
    );
    if (changed.length === 0) return;
    await this.db.write([
      { sql: "UPDATE bookmarks SET label = ?1, updated_at = ?2 WHERE target_id = ?3 AND deleted_at IS NULL", bind: [label, now(), targetId] },
    ]);
    this.emit({ scope: "bookmarks" });
  }

  async listComponents(): Promise<Component[]> {
    const rows = await this.db.select<ComponentRow>("SELECT * FROM components WHERE deleted_at IS NULL ORDER BY name COLLATE NOCASE");
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      params: parseJson<string[]>(r.params, []),
      code: r.code,
      output: isComponentOutput(r.output) ? r.output : "markdown",
      frameRatio: r.frame_ratio,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  async saveComponent(x: Component): Promise<void> {
    await this.db.write([
      {
        sql: `INSERT INTO components (id, name, params, code, output, frame_ratio, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?6, ?7, ?5, ?5)
              ON CONFLICT (id) DO UPDATE SET name = excluded.name, params = excluded.params, code = excluded.code,
                output = excluded.output, frame_ratio = excluded.frame_ratio, updated_at = excluded.updated_at`,
        bind: [x.id, x.name, JSON.stringify(x.params), x.code, now(), x.output, x.frameRatio],
      },
    ]);
    this.emit({ scope: "components" });
  }

  async deleteComponent(componentId: string, options: { withFields?: boolean } = {}): Promise<void> {
    const users = await this.db.select<{ id: string; field: string; collection: string }>(
      `SELECT f.id, f.name AS field, t.name AS collection FROM fields f JOIN collections t ON t.id = f.collection_id
        WHERE f.component_id = ?1 AND f.deleted_at IS NULL AND t.deleted_at IS NULL`,
      [componentId],
    );
    if (users.length > 0 && !options.withFields) {
      throw new Error(`Still used by ${users.map((u) => `“${u.field}” of ${u.collection}`).join(", ")}. Remove those fields first.`);
    }
    // A collection always keeps a field: one whose only fields use this component can't lose them.
    const emptied = await this.db.select<{ collection: string }>(
      `SELECT t.name AS collection FROM collections t
        WHERE t.deleted_at IS NULL
          AND EXISTS (SELECT 1 FROM fields f WHERE f.collection_id = t.id AND f.deleted_at IS NULL AND f.component_id = ?1)
          AND NOT EXISTS (SELECT 1 FROM fields f WHERE f.collection_id = t.id AND f.deleted_at IS NULL AND f.component_id IS NOT ?1)`,
      [componentId],
    );
    if (emptied.length > 0) {
      throw new Error(`${emptied.map((e) => e.collection).join(", ")} would be left without fields. Add another field there first.`);
    }
    const ts = now();
    await this.db.write([
      // Its fields go first (soft delete, like removing them in the collection editor).
      ...users.map((u) => ({ sql: "UPDATE fields SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2", bind: [ts, u.id] })),
      { sql: "UPDATE components SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2", bind: [ts, componentId] },
    ]);
    this.emit({ scope: "components" }, ...(users.length > 0 ? [{ scope: "collections" } as const] : []));
  }

  async deleteView(viewId: string): Promise<void> {
    const collectionId = (await this.db.select<{ collection_id: string }>("SELECT collection_id FROM views WHERE id = ?1", [viewId]))[0]?.collection_id;
    await this.db.write([{ sql: "UPDATE views SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2", bind: [now(), viewId] }]);
    if (collectionId) this.emit({ scope: "views", collectionId });
  }

  async deleteItem(itemId: string): Promise<void> {
    const collectionId = await this.collectionOfItem(itemId);
    await this.db.write([
      { sql: "UPDATE items SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2", bind: [now(), itemId] },
      ...(await this.releaseFilesWhere("item_id = ?1", [itemId])),
    ]);
    if (collectionId) this.emit({ scope: "items", collectionId, itemId });
  }

  async search(query: string, collections: Collection[], spaceId: string, limit = 50): Promise<Item[]> {
    const q = query.trim();
    if (!q) return [];
    // Case-insensitive for ASCII only (SQLite's lower()); fine until there is an FTS index.
    // Markdown is matched without its backslash escapes: the editor stores a typed "[[" as
    // "\[\[" (and "*" as "\*", …), which a search for what was typed must still find.
    const hits = await this.db.select<{ id: string }>(
      `SELECT o.id FROM field_values fv
         JOIN items o ON o.id = fv.item_id
         JOIN fields f ON f.id = fv.field_id
        WHERE o.deleted_at IS NULL AND o.space_id = ?3 AND f.deleted_at IS NULL
          AND f.kind IN ('string', 'markdown', 'html', 'string_list', 'checklist')
          AND instr(lower(CASE WHEN f.kind = 'markdown' THEN replace(fv.value_text, '\\', '') ELSE coalesce(fv.value_text, fv.value_json) END), lower(?1)) > 0
        GROUP BY o.id
        ORDER BY max(o.updated_at) DESC
        LIMIT ?2`,
      [q, limit, spaceId],
    );
    if (hits.length === 0) return [];
    const ids = JSON.stringify(hits.map((h) => h.id));
    const items = await this.db.select<ItemRow>("SELECT * FROM items WHERE id IN (SELECT value FROM json_each(?1))", [
      ids,
    ]);
    const values = await this.db.select<ValueRow>(
      "SELECT * FROM field_values WHERE item_id IN (SELECT value FROM json_each(?1))",
      [ids],
    );
    const byId = new Map<string, Item>();
    for (const collection of collections) {
      const own = items.filter((o) => o.collection_id === collection.id);
      if (own.length > 0) this.assemble(collection, own, values).forEach((e) => byId.set(e.id, e));
    }
    return hits.map((h) => byId.get(h.id)).filter((e): e is Item => !!e);
  }

  async releaseFiles(fileIds: string[]): Promise<void> {
    await this.db.write([...new Set(fileIds)].flatMap(releaseFile));
  }

  /** Release statements for every file referenced by the field_values matching `where`. */
  private async releaseFilesWhere(where: string, bind: string[]): Promise<Statement[]> {
    const rows = await this.db.select<{ value_file: string | null; markdown: string | null }>(
      `SELECT fv.value_file, CASE WHEN f.kind IN ('markdown', 'html') THEN fv.value_text END AS markdown
         FROM field_values fv JOIN fields f ON f.id = fv.field_id
        WHERE (fv.value_file IS NOT NULL OR f.kind IN ('markdown', 'html')) AND ${where}`,
      bind,
    );
    const ids = new Set<string>();
    for (const r of rows) {
      if (r.value_file) ids.add(r.value_file);
      if (r.markdown) fileIdsIn(r.markdown).forEach((id) => ids.add(id));
    }
    return [...ids].flatMap(releaseFile);
  }

  async putFile(data: Uint8Array, mime: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", data as Uint8Array<ArrayBuffer>);
    const id = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    await this.db.write([
      {
        sql: "INSERT OR IGNORE INTO files (id, mime, size, data, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        bind: [id, mime, data.byteLength, data, now()],
      },
    ]);
    return id;
  }

  async getFile(fileId: string): Promise<{ data: Uint8Array; mime: string } | null> {
    const rows = await this.db.select<{ data: Uint8Array; mime: string }>("SELECT mime, data FROM files WHERE id = ?1", [
      fileId,
    ]);
    return rows[0] ?? null;
  }

  private assemble(collection: Collection, items: ItemRow[], values: ValueRow[]): Item[] {
    const fieldsById = new Map(collection.fields.map((f) => [f.id, f]));
    const byItem = new Map<string, Record<string, FieldValue>>();
    for (const v of values) {
      const field = fieldsById.get(v.field_id);
      if (!field) continue; // value of a removed field
      const spec = fieldKinds[field.kind];
      const record = byItem.get(v.item_id) ?? {};
      // A number with {{ }} sections is stored as its text (see valueStatement).
      record[field.id] = field.kind === "number" && v.value_number == null && v.value_text != null ? v.value_text : spec.fromDb(v[spec.column]);
      byItem.set(v.item_id, record);
    }
    return items.map((o) => ({
      id: o.id,
      collectionId: o.collection_id,
      spaceId: o.space_id,
      values: byItem.get(o.id) ?? {},
      itemViewId: o.item_view_id,
      createdAt: o.created_at,
      updatedAt: o.updated_at,
    }));
  }
}

/**
 * Deletes a file once no live item uses it. Runs after the statements that drop
 * the reference, in the same transaction. Rows of soft-deleted items/fields
 * still point at their files (and the FK forbids dangling ones), so those links
 * are cleared first — only when no live reference remains.
 */
function releaseFile(fileId: string): Statement[] {
  // A live use is an image field value, or a markdown or HTML value mentioning `files/<id>`.
  const liveUse = `EXISTS (
      SELECT 1 FROM field_values fv
        JOIN items o ON o.id = fv.item_id
        JOIN fields f ON f.id = fv.field_id
       WHERE o.deleted_at IS NULL AND f.deleted_at IS NULL
         AND (fv.value_file = ?1 OR (f.kind IN ('markdown', 'html') AND instr(fv.value_text, 'files/' || ?1) > 0)))`;
  return [
    {
      sql: `UPDATE field_values SET value_file = NULL WHERE value_file = ?1 AND NOT ${liveUse}`,
      bind: [fileId],
    },
    {
      sql: `DELETE FROM files WHERE id = ?1
              AND NOT EXISTS (SELECT 1 FROM field_values WHERE value_file = ?1)
              AND NOT ${liveUse}`,
      bind: [fileId],
    },
  ];
}

/** A reference field's choice filters as stored (JSON), or null for other fields / none. */
const choices = (f: CollectionDraft["fields"][number]) =>
  (f.kind === "item" || f.kind === "item_list") && f.choiceFilter.length > 0 ? JSON.stringify(f.choiceFilter) : null;

/** A component field's variable mapping as stored (JSON), or null for other fields / none. */
const args = (f: CollectionDraft["fields"][number]) =>
  f.kind === "component" && Object.keys(f.componentArgs).length > 0 ? JSON.stringify(f.componentArgs) : null;

function valueStatement(itemId: string, field: FieldDef, value: FieldValue, ts: string): Statement {
  const spec = fieldKinds[field.kind];
  const cols: Record<string, string | number | null> = {
    value_text: null,
    value_number: null,
    value_date: null,
    value_datetime: null,
    value_bool: null,
    value_ref: null,
    value_file: null,
    value_json: null,
  };
  cols[spec.column] = spec.toDb(value);
  // A number field's {{ }} sections (computed when shown) are text: kept in value_text.
  if (field.kind === "number" && hasSections(value)) cols.value_text = value;
  return {
    sql: `INSERT INTO field_values (item_id, field_id, value_text, value_number, value_date, value_datetime,
                                      value_bool, value_ref, value_file, value_json, updated_at)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
          ON CONFLICT (item_id, field_id) DO UPDATE SET
            value_text = excluded.value_text,
            value_number = excluded.value_number,
            value_date = excluded.value_date,
            value_datetime = excluded.value_datetime,
            value_bool = excluded.value_bool,
            value_ref = excluded.value_ref,
            value_file = excluded.value_file,
            value_json = excluded.value_json,
            updated_at = excluded.updated_at`,
    bind: [
      itemId,
      field.id,
      cols.value_text,
      cols.value_number,
      cols.value_date,
      cols.value_datetime,
      cols.value_bool,
      cols.value_ref,
      cols.value_file,
      cols.value_json,
      ts,
    ],
  };
}
