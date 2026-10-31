import { fieldKinds } from "../../domain/fieldKinds";
import {
  canBeTitle,
  newId,
  NO_TITLE,
  titleFields,
  titleText,
  now,
  type FieldDef,
  type FieldKind,
  type FieldValue,
  type Item,
  type ItemLabel,
  type Collection,
  type CollectionDraft,
  type CollectionSource,
  type FieldDraft,
  valuesEqual,
} from "../../domain/model";
import type { FilterRule } from "../../domain/query";
import { bookmarkCondition, type Bookmark, type BookmarkOwner } from "../../domain/bookmarks";
import { parseItemViews, withDefaultItemView, type ItemView } from "../../domain/fieldLayout";
import { isComponentOutput, type Component } from "../../domain/components";
import { DEFAULT_SPACE_ID, withDefaultSpace, type Space } from "../../domain/spaces";
import { defaultViewState, NOTHING_COLLAPSED, parseViewConfig, type CollectionView } from "../../domain/views";
import { dashboardViewsIn, FIRST_TAB_NAME, isVirtualTab, type Dashboard, type DashboardView } from "../../domain/dashboards";
import type { DataChange, NewItem, Repository } from "../repository";
import { SyncEngine } from "../sync/SyncEngine";
import type { SyncEnvironment } from "../sync/environment";
import { acceptedStatement, editedStatement, generatedStatement } from "./generated";
import { decodeAiInput } from "../../domain/ai";
import { draftProblem } from "../../domain/collectionDraft";
import { firstShownFields, isRemote, sourcePeriod } from "../../domain/sources";
import type { SqlClient, Statement } from "./protocol";
import type { Backlink } from "../../domain/backlinks";
import { healLinks } from "../schema";

interface CollectionRow {
  id: string;
  name: string;
  plural_name: string;
  icon: string | null;
  description: string;
  item_views: string | null;
  space_ids: string | null;
  source: string | null;
  title_field: string | null;
  hidden_in_nav: number | null;
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
  choice_filter: string | null;
  toggle_icon: string | null;
  strike_through: number | null;
  code: string | null;
  output: string | null;
  frame_ratio: string | null;
  source_column: string | null;
  position: number;
}
interface ComponentRow {
  id: string;
  name: string;
  description: string;
  code: string;
  output: string;
  frame_ratio: string | null;
  ai: number;
  created_at: string;
  updated_at: string;
}
interface ViewRow {
  id: string;
  collection_id: string;
  space_id: string;
  name: string;
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
  updated_at: string;
}

const toField = (r: FieldRow): FieldDef => ({
  id: r.id,
  collectionId: r.collection_id,
  name: r.name,
  kind: r.kind,
  targetCollectionId: r.target_collection_id,
  componentId: r.component_id,
  code: r.code,
  output: isComponentOutput(r.output) ? r.output : null,
  frameRatio: r.frame_ratio,
  choiceFilter: parseJson<FilterRule[]>(r.choice_filter, []),
  toggleIcon: r.toggle_icon,
  strikeThrough: r.strike_through === 1,
  position: r.position,
  column: r.source_column,
});

/** A stored view as a CollectionView (its config parsed and normalized). */
function toView(r: ViewRow): CollectionView {
  const { filters, blocks, editable, collapsed, filterBar, fullWidth } = parseViewConfig(r.config);
  return {
    id: r.id,
    collectionId: r.collection_id,
    spaceId: r.space_id,
    name: r.name,
    filters,
    blocks,
    editable,
    collapsed,
    ...(filterBar && { filterBar }),
    ...(fullWidth !== undefined && { fullWidth }),
    position: r.position,
    isDefault: r.is_default === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

interface DashboardRow {
  id: string;
  name: string;
  icon: string | null;
  description: string;
  space_ids: string | null;
  position: number;
  created_at: string;
  updated_at: string;
}
interface DashboardViewRow {
  id: string;
  dashboard_id: string;
  space_id: string;
  name: string;
  config: string;
  position: number;
  is_default: number;
  created_at: string;
  updated_at: string;
}

/** A stored dashboard tab (its config parsed as a collection view's; its blocks may be none). */
function toDashboardView(r: DashboardViewRow): DashboardView {
  const { filters, blocks, editable, collapsed, filterBar, fullWidth } = parseViewConfig(r.config);
  return {
    id: r.id,
    dashboardId: r.dashboard_id,
    spaceId: r.space_id,
    name: r.name,
    filters,
    blocks,
    editable,
    collapsed,
    ...(filterBar && { filterBar }),
    ...(fullWidth !== undefined && { fullWidth }),
    position: r.position,
    isDefault: r.is_default === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** A view's or dashboard tab's config as stored (JSON). */
const viewConfig = (view: Pick<CollectionView, "filters" | "blocks" | "editable" | "collapsed" | "filterBar" | "fullWidth">) =>
  JSON.stringify({ filters: view.filters, blocks: view.blocks, editable: view.editable, collapsed: view.collapsed, filterBar: view.filterBar, fullWidth: view.fullWidth });

/** Stored space_ids: null (every space) or a list of space ids. */
const spaceIdsOf = (json: string | null): string[] | null => {
  const ids = parseJson<unknown>(json, null);
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : null;
};
const spaceIdsJson = (ids: string[] | null) => (ids === null ? null : JSON.stringify(ids));
/** The title field as stored: one of its fields that can be one (canBeTitle), NO_TITLE, else null (the first text field with a value). */
const titleFieldOf = (draft: CollectionDraft) =>
  draft.titleField === NO_TITLE || draft.fields.some((f) => f.id === draft.titleField && canBeTitle(f)) ? draft.titleField! : null;
/** Stored hidden_in_nav: 1 when left out of the side nav, else null (shown, as a collection made before it). */
const hiddenInNavOf = (draft: CollectionDraft) => (draft.hiddenInNav ? 1 : null);
/** Whether a label field (lf) is one its collection's titles come from (titleFields). */
const IS_TITLE_FIELD = "coalesce((SELECT tc.title_field FROM collections tc WHERE tc.id = lf.collection_id), lf.id) = lf.id";
/** A remote collection's source, as stored (null: a native collection). */
const sourceJson = (draft: CollectionDraft) => (draft.source ? JSON.stringify(draft.source) : null);
/** The column a field shows: only in a remote collection. */
const columnOf = (draft: CollectionDraft, f: FieldDraft) => (draft.source ? (f.column ?? null) : null);
/** Remote collections are read-only: their items are the source's. */
function writable(collection: Collection) {
  if (isRemote(collection)) throw new Error(`${collection.pluralName} are read from ${collection.source!.name}: they can't be changed here.`);
}

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
  private constructor(
    private db: SqlClient,
    env: SyncEnvironment,
  ) {
    this.sync = new SyncEngine(db, (...changes) => this.emit(...changes), env, {
      release: (fileIds) => this.releaseFiles(fileIds),
      sweep: () => this.sweepFiles(),
    });
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

  async collectionsOfItems(itemIds: string[]): Promise<Map<string, string>> {
    const rows = await this.db.select<{ id: string; collection_id: string }>(
      "SELECT id, collection_id FROM items WHERE id IN (SELECT value FROM json_each(?1))",
      [JSON.stringify(itemIds)],
    );
    return new Map(rows.map((r) => [r.id, r.collection_id]));
  }

  private async collectionOfItem(itemId: string): Promise<string | undefined> {
    return (await this.collectionsOfItems([itemId])).get(itemId);
  }

  /** The repository over an open database, syncing from `env` (the browser, or the headless device). */
  static async open(db: SqlClient, env: SyncEnvironment): Promise<SqliteRepository> {
    // Stable identity of this replica, needed once sync exists.
    await db.write([{ sql: "INSERT OR IGNORE INTO meta (key, value) VALUES ('replica_id', ?1)", bind: [newId()] }]);
    const repo = new SqliteRepository(db, env);
    void repo.sweepFiles().catch((e) => console.warn("File clean-up failed", e)); // also on devices that don't sync
    return repo;
  }

  get storage() {
    return { persistent: this.db.info.persistent };
  }

  async wipeLocal(): Promise<void> {
    await this.sync.pause();
    await this.db.wipe();
  }

  exportBackup(): Promise<Uint8Array> {
    return this.db.exportDatabase();
  }

  checkBackup(bytes: Uint8Array): Promise<void> {
    return this.db.importDatabase(bytes, true);
  }

  async restoreBackup(bytes: Uint8Array): Promise<void> {
    await this.checkBackup(bytes); // a refused file changes nothing, not even sync
    await this.sync.pause();
    await this.db.importDatabase(bytes);
  }

  async listSpaces(): Promise<Space[]> {
    const rows = await this.db.select<Space>(
      "SELECT id, name, icon, position FROM spaces WHERE deleted_at IS NULL ORDER BY position, created_at",
    );
    const defaultDeleted = (await this.db.select("SELECT 1 FROM spaces WHERE id = ?1 AND deleted_at IS NOT NULL", [DEFAULT_SPACE_ID])).length > 0;
    return withDefaultSpace(rows, defaultDeleted);
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
    if ((await this.listSpaces()).length < 2) throw new Error("The only space can't be deleted.");
    const ts = now();
    const collections = await this.db.select<{ collection_id: string }>(
      `SELECT collection_id FROM items WHERE space_id = ?1 AND deleted_at IS NULL
        UNION SELECT collection_id FROM views WHERE space_id = ?1 AND deleted_at IS NULL`,
      [spaceId],
    );
    const dashboards = await this.db.select<{ dashboard_id: string }>(
      "SELECT DISTINCT dashboard_id FROM dashboard_views WHERE space_id = ?1 AND deleted_at IS NULL",
      [spaceId],
    );
    // Read before the items are deleted; the release statements run after that, in the same transaction.
    const released = [
      ...(await this.releaseFilesWhere("item_id IN (SELECT id FROM items WHERE space_id = ?1 AND deleted_at IS NULL)", [spaceId])),
      ...(await this.releaseBlockFiles("SELECT id FROM views WHERE space_id = ?1 AND deleted_at IS NULL", [spaceId])),
      ...(await this.releaseBlockFiles("SELECT id FROM dashboard_views WHERE space_id = ?1 AND deleted_at IS NULL", [spaceId])),
    ];
    await this.db.write([
      { sql: "UPDATE items SET deleted_at = ?1, updated_at = ?1 WHERE space_id = ?2 AND deleted_at IS NULL", bind: [ts, spaceId] },
      { sql: "UPDATE bookmarks SET deleted_at = ?1, updated_at = ?1 WHERE space_id = ?2 AND deleted_at IS NULL", bind: [ts, spaceId] },
      { sql: "UPDATE views SET deleted_at = ?1, updated_at = ?1 WHERE space_id = ?2 AND deleted_at IS NULL", bind: [ts, spaceId] },
      { sql: "UPDATE dashboard_views SET deleted_at = ?1, updated_at = ?1 WHERE space_id = ?2 AND deleted_at IS NULL", bind: [ts, spaceId] },
      // The default space has no row until renamed: its tombstone is made here.
      {
        sql: `INSERT INTO spaces (id, name, icon, position, created_at, updated_at, deleted_at) VALUES (?2, 'Space', NULL, -1, ?1, ?1, ?1)
              ON CONFLICT (id) DO UPDATE SET deleted_at = excluded.deleted_at, updated_at = excluded.updated_at`,
        bind: [ts, spaceId],
      },
      ...released,
    ]);
    this.emit({ scope: "spaces" }, { scope: "bookmarks" }, ...collections.flatMap((c) => [
      { scope: "items", collectionId: c.collection_id } as const,
      { scope: "views", collectionId: c.collection_id } as const,
    ]), ...dashboards.map((d) => ({ scope: "dashboardViews", dashboardId: d.dashboard_id }) as const));
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
      source: parseJson<CollectionSource | null>(t.source, null),
      titleField: t.title_field,
      ...(t.hidden_in_nav ? { hiddenInNav: true } : {}),
      createdAt: t.created_at,
      updatedAt: t.updated_at,
    }));
  }

  async saveCollection(draft: CollectionDraft, spaceId: string): Promise<void> {
    const problem = draftProblem(draft, await this.listComponents());
    if (problem) throw new Error(problem);
    const ts = now();
    const writes: Statement[] = [];
    const existing = await this.db.select<{ id: string }>("SELECT id FROM collections WHERE id = ?1", [draft.id]);
    if (existing.length === 0) {
      writes.push({
        sql: "INSERT INTO collections (id, name, plural_name, icon, description, space_ids, source, title_field, hidden_in_nav, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?7, ?8, ?9, ?10, ?6, ?6)",
        bind: [draft.id, draft.name, draft.pluralName, draft.icon, draft.description, ts, spaceIdsJson(draft.spaceIds), sourceJson(draft), titleFieldOf(draft), hiddenInNavOf(draft)],
      });
      // Every collection starts with an ordinary (renamable, deletable) "All" view in the space it
      // was made in: a table of all items sorted by title; its options are filled in by the block
      // type's normalizeOptions. Other spaces show that unsaved table until a view is saved there.
      writes.push({
        sql: `INSERT INTO views (id, collection_id, space_id, name, config, position, is_default, created_at, updated_at)
              VALUES (?1, ?2, ?5, 'All', ?3, 0, 0, ?4, ?4)`,
        bind: [newId(), draft.id, JSON.stringify(defaultViewState(null, firstShownFields(draft), !draft.source, sourcePeriod(draft))), ts, spaceId],
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
          sql: "INSERT INTO fields (id, collection_id, name, kind, target_collection_id, component_id, code, output, frame_ratio, choice_filter, toggle_icon, strike_through, source_column, position, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?15, ?13, ?14, ?14)",
          bind: [f.id, draft.id, f.name, f.kind, f.targetCollectionId, componentOf(f), ...local(f, null), choices(f), f.toggleIcon, strike(f), position, ts, columnOf(draft, f)],
        });
      } else {
        // Kind, target and an AI field's output are immutable once created (values would need
        // conversion); a component field's component may change (its values are computed, not
        // stored), and so may an AI field's prompt (its values turn stale, see domain/ai.ts). A
        // remote collection stores no values: its column fields follow their column (text shown
        // as Markdown, a column whose type changed: domain/sources.ts).
        const [code, output, frameRatio] = local(f, old);
        const kind = draft.source && old.source_column && f.column === old.source_column ? f.kind : old.kind;
        if (
          old.kind !== kind ||
          old.name !== f.name ||
          old.position !== position ||
          old.component_id !== componentOf(f) ||
          old.code !== code ||
          old.output !== output ||
          old.frame_ratio !== frameRatio ||
          (old.choice_filter ?? null) !== choices(f) ||
          old.toggle_icon !== f.toggleIcon ||
          (old.strike_through ?? 0) !== strike(f)
        ) {
          writes.push({
            sql: "UPDATE fields SET name = ?1, position = ?2, component_id = ?3, code = ?4, output = ?5, frame_ratio = ?6, choice_filter = ?7, toggle_icon = ?8, strike_through = ?9, updated_at = ?10, kind = ?12 WHERE id = ?11",
            bind: [f.name, position, componentOf(f), code, output, frameRatio, choices(f), f.toggleIcon, strike(f), ts, f.id, kind],
          });
        }
      }
    }
    const removed = stored.filter((old) => !keep.has(old.id));
    for (const old of removed) {
      writes.push({ sql: "UPDATE fields SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2", bind: [ts, old.id] });
    }
    // Links to a removed field (`book/dune#author`) lose their bookmarks.
    writes.push(...bookmarksOf(removed.map((old) => ({ field: old.id })), ts));

    writes.push({
      sql: "UPDATE collections SET name = ?1, plural_name = ?2, icon = ?3, description = ?4, space_ids = ?7, source = ?8, title_field = ?9, hidden_in_nav = ?10, updated_at = ?5 WHERE id = ?6",
      bind: [draft.name, draft.pluralName, draft.icon, draft.description, ts, draft.id, spaceIdsJson(draft.spaceIds), sourceJson(draft), titleFieldOf(draft), hiddenInNavOf(draft)],
    });
    for (const old of removed) {
      writes.push(...(await this.releaseFilesWhere("field_id = ?1", [old.id])));
    }
    await this.db.write(writes);
    this.emit({ scope: "collections" }, ...(removed.length > 0 ? [{ scope: "bookmarks" } as const] : []));
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
      ...bookmarksOf([{ collection: collectionId }], ts),
      ...(await this.releaseFilesWhere("item_id IN (SELECT id FROM items WHERE collection_id = ?1)", [collectionId])),
      ...(await this.releaseBlockFiles("SELECT id FROM views WHERE collection_id = ?1 UNION SELECT ?1", [collectionId])),
    ]);
    this.emit({ scope: "collections" }, { scope: "items", collectionId }, { scope: "views", collectionId }, { scope: "bookmarks" });
  }

  async countItemsByCollection(spaceId: string | null): Promise<Record<string, number>> {
    const rows = await this.db.select<{ collection_id: string; n: number }>(
      "SELECT collection_id, COUNT(*) AS n FROM items WHERE deleted_at IS NULL AND (?1 IS NULL OR space_id = ?1) GROUP BY collection_id",
      [spaceId],
    );
    return Object.fromEntries(rows.map((r) => [r.collection_id, r.n]));
  }

  async listItems(collection: Collection, spaceId: string, page?: { limit: number; offset: number }): Promise<Item[]> {
    const items = await this.db.select<ItemRow>(
      `SELECT * FROM items WHERE collection_id = ?1 AND space_id = ?2 AND deleted_at IS NULL
        ORDER BY updated_at DESC, id ${page ? "LIMIT ?3 OFFSET ?4" : ""}`,
      page ? [collection.id, spaceId, page.limit, page.offset] : [collection.id, spaceId],
    );
    const values = page
      ? await this.valuesOf(items.map((o) => o.id))
      : await this.db.select<ValueRow>(
          `SELECT fv.* FROM field_values fv
             JOIN items o ON o.id = fv.item_id
            WHERE o.collection_id = ?1 AND o.space_id = ?2 AND o.deleted_at IS NULL`,
          [collection.id, spaceId],
        );
    return this.assemble(collection, items, values);
  }

  async getItems(collection: Collection, itemIds: string[]): Promise<Item[]> {
    const items = await this.db.select<ItemRow>(
      "SELECT * FROM items WHERE id IN (SELECT value FROM json_each(?1)) AND collection_id = ?2 AND deleted_at IS NULL",
      [JSON.stringify(itemIds), collection.id],
    );
    return items.length === 0 ? [] : this.assemble(collection, items, await this.valuesOf(items.map((o) => o.id)));
  }

  async getItem(collection: Collection, itemId: string): Promise<Item | null> {
    return (await this.getItems(collection, [itemId]))[0] ?? null;
  }

  /** The stored values of these items. */
  private valuesOf(itemIds: string[]): Promise<ValueRow[]> {
    return this.db.select<ValueRow>("SELECT * FROM field_values WHERE item_id IN (SELECT value FROM json_each(?1))", [JSON.stringify(itemIds)]);
  }

  async listLabels(collection: Collection, itemIds?: string[]): Promise<ItemLabel[]> {
    // Same rule as labelField: the first of its title fields (in the collection's field order) whose
    // value isn't blank. A chosen title field that is a number or a date is read as it is shown (titleText).
    const chosen = titleFields(collection);
    const field = chosen.length === 1 && chosen[0].kind !== "string" ? chosen[0] : null;
    if (field) {
      const rows = await this.db.select<{ id: string; spaceId: string; number: number | null; text: string | null }>(
        `SELECT o.id AS id, o.space_id AS spaceId, fv.value_number AS number, coalesce(fv.value_date, fv.value_datetime) AS text
           FROM items o LEFT JOIN field_values fv ON fv.item_id = o.id AND fv.field_id = ?3
          WHERE o.collection_id = ?1 AND o.deleted_at IS NULL
            AND (?2 IS NULL OR o.id IN (SELECT value FROM json_each(?2)))`,
        [collection.id, itemIds ? JSON.stringify(itemIds) : null, field.id],
      );
      return rows.map((r) => ({ id: r.id, spaceId: r.spaceId, label: titleText(field, field.kind === "number" ? r.number : r.text) || null }));
    }
    return this.db.select<ItemLabel>(
      `SELECT o.id AS id, o.space_id AS spaceId,
              (SELECT fv.value_text FROM field_values fv JOIN fields lf ON lf.id = fv.field_id
                WHERE fv.item_id = o.id AND lf.kind = 'string' AND lf.deleted_at IS NULL AND ${IS_TITLE_FIELD}
                  AND trim(fv.value_text, ' ' || char(9, 10, 13)) <> ''
                ORDER BY lf.position, lf.created_at LIMIT 1) AS label
         FROM items o
        WHERE o.collection_id = ?1 AND o.deleted_at IS NULL
          AND (?2 IS NULL OR o.id IN (SELECT value FROM json_each(?2)))`,
      [collection.id, itemIds ? JSON.stringify(itemIds) : null],
    );
  }

  async listBacklinks(collectionId: string, itemId: string, spaceId: string): Promise<Backlink[]> {
    // The index row holds the targets as JSON; instr() narrows to the rows that mention the item at all.
    const rows = await this.db.select<{ collection_id: string; item_id: string; field_id: string; created_at: string; updated_at: string }>(
      `SELECT o.collection_id, o.id AS item_id, l.source_field_id AS field_id, o.created_at, o.updated_at
         FROM item_links l
         JOIN items o ON o.id = l.source_item_id AND o.deleted_at IS NULL AND o.space_id = ?3
         JOIN collections c ON c.id = o.collection_id AND c.deleted_at IS NULL
         JOIN fields f ON f.id = l.source_field_id AND f.deleted_at IS NULL
        WHERE l.deleted_at IS NULL AND o.id <> ?2 AND instr(l.targets, ?2) > 0
          AND EXISTS (SELECT 1 FROM json_each(l.targets) t WHERE json_extract(t.value, '$.item') = ?2 AND json_extract(t.value, '$.collection') = ?1)
        ORDER BY o.updated_at DESC, o.id, f.position`,
      [collectionId, itemId, spaceId],
    );
    return rows.map((r) => ({ sourceCollectionId: r.collection_id, sourceItemId: r.item_id, fieldId: r.field_id, itemCreatedAt: r.created_at, itemUpdatedAt: r.updated_at }));
  }

  async rebuildLinks(): Promise<void> {
    await this.db.write([healLinks(true)]);
  }

  async createItem(collection: Collection, values: Record<string, FieldValue>, spaceId: string): Promise<string> {
    const [id] = await this.createItems([{ collection, values, spaceId }]);
    return id;
  }

  async createItems(entries: NewItem[]): Promise<string[]> {
    for (const e of entries) writable(e.collection);
    const ids = entries.map((e) => e.id ?? newId());
    // Each its own time, in order (as if created one by one).
    const stamps = entries.map(() => now());
    // Every item before any value, so a reference to another new item finds it.
    const writes: Statement[] = entries.map((e, i) => ({
      sql: "INSERT INTO items (id, collection_id, space_id, created_at, updated_at) VALUES (?1, ?2, ?4, ?3, ?3)",
      bind: [ids[i], e.collection.id, stamps[i], e.spaceId],
    }));
    // Only actual values: an empty field has no row, component fields are computed, never stored,
    // and AI fields are generated (setGenerated), never entered.
    entries.forEach((e, i) => {
      for (const field of e.collection.fields) {
        const value = e.values[field.id];
        if (value != null && field.kind !== "component" && field.kind !== "ai") writes.push(valueStatement(ids[i], field, value, stamps[i]));
      }
    });
    await this.db.write(writes);
    // One item: that item changed; more: each collection's list is read again once.
    if (entries.length === 1) this.emit({ scope: "items", collectionId: entries[0].collection.id, itemId: ids[0] });
    else this.emit(...[...new Set(entries.map((e) => e.collection.id))].map((collectionId) => ({ scope: "items", collectionId }) as const));
    return ids;
  }

  async updateItem(collection: Collection, itemId: string, values: Record<string, FieldValue>): Promise<void> {
    writable(collection);
    const current = await this.getItem(collection, itemId);
    if (!current) throw new Error("Item not found");
    const ts = now();
    const writes: Statement[] = [];
    const changed: string[] = [];
    // Only touch changed fields: keeps per-field updated_at meaningful for merges.
    for (const field of collection.fields) {
      if (!(field.id in values)) continue;
      const next = values[field.id] ?? null;
      const prev = current.values[field.id];
      if (valuesEqual(next, prev)) continue;
      changed.push(field.id);
      if (field.kind === "ai") {
        // Typed over a generated value: kept, and never replaced by itself (the user is asked).
        writes.push(editedStatement(itemId, field.id, field.output === "number" ? "number" : "text", next as string | number | null, ts));
        continue;
      }
      writes.push(valueStatement(itemId, field, next, ts));
    }
    if (writes.length === 0) return;
    writes.push({ sql: "UPDATE items SET updated_at = ?1 WHERE id = ?2", bind: [ts, itemId] });
    // The files the changed values used: deleted unless the new values (or anything else) still use them.
    writes.push(...(await this.releaseFilesWhere("item_id = ?1 AND field_id IN (SELECT value FROM json_each(?2))", [itemId, JSON.stringify(changed)])));
    await this.db.write(writes);
    this.emit({ scope: "items", collectionId: collection.id, itemId });
  }

  async setGenerated(collection: Collection, itemId: string, field: FieldDef, value: string | number | null, inputHash: string): Promise<void> {
    writable(collection);
    // Not through updateItem: the item itself doesn't change (its updatedAt stays, so a prompt
    // reading it isn't stale because of this write). Nothing is written for an item gone meanwhile.
    await this.db.write([generatedStatement(itemId, field.id, field.output === "number" ? "number" : "text", value, inputHash, now())]);
    this.emit({ scope: "items", collectionId: collection.id, itemId });
  }

  async acceptEdit(collection: Collection, itemId: string, field: FieldDef, inputHash: string): Promise<void> {
    await this.db.write([acceptedStatement(itemId, field.id, inputHash, now())]);
    this.emit({ scope: "items", collectionId: collection.id, itemId });
  }

  async moveItem(itemId: string, spaceId: string): Promise<void> {
    await this.db.write([
      { sql: "UPDATE items SET space_id = ?1, updated_at = ?2 WHERE id = ?3 AND space_id <> ?1", bind: [spaceId, now(), itemId] },
      // Its bookmarks stay behind in the old space's list: they would lead nowhere there.
      {
        sql: `UPDATE bookmarks SET deleted_at = ?1, updated_at = ?1 WHERE ${bookmarkCondition({ item: itemId }, 2).sql} AND space_id <> ?3 AND deleted_at IS NULL`,
        bind: [now(), itemId, spaceId],
      },
    ]);
    const collectionId = await this.collectionOfItem(itemId);
    if (collectionId) this.emit({ scope: "items", collectionId, itemId }, { scope: "bookmarks" });
  }

  async listViews(collectionId: string, spaceId: string): Promise<CollectionView[]> {
    const rows = await this.db.select<ViewRow>(
      "SELECT * FROM views WHERE collection_id = ?1 AND space_id = ?2 AND deleted_at IS NULL ORDER BY position, created_at",
      [collectionId, spaceId],
    );
    return rows.map(toView);
  }

  async listAllViews(): Promise<CollectionView[]> {
    const rows = await this.db.select<ViewRow>("SELECT * FROM views WHERE deleted_at IS NULL ORDER BY collection_id, space_id, position, created_at");
    return rows.map(toView);
  }

  async saveView(view: CollectionView): Promise<void> {
    const ts = now();
    const config = viewConfig(view);
    // Links to a block taken out of it (`books/reading-list#table`) lose their bookmarks.
    const before = (await this.db.select<{ config: string }>("SELECT config FROM views WHERE id = ?1", [view.id]))[0]?.config;
    const removedBlocks = gone(blockIds(before), view.blocks.map((b) => b.id));
    await this.db.write([
      {
        sql: `INSERT INTO views (id, collection_id, space_id, name, config, position, created_at, updated_at)
              VALUES (?1, ?2, ?7, ?3, ?4, ?5, ?6, ?6)
              ON CONFLICT (id) DO UPDATE SET
                name = excluded.name, config = excluded.config,
                position = excluded.position, updated_at = excluded.updated_at`,
        bind: [view.id, view.collectionId, view.name, config, view.position, ts, view.spaceId],
      },
      ...bookmarksOf(removedBlocks.map((block) => ({ block })), ts),
      ...(await this.releaseBlockFiles("SELECT ?1", [view.id])),
    ]);
    this.emit({ scope: "views", collectionId: view.collectionId }, ...(removedBlocks.length > 0 ? [{ scope: "bookmarks" } as const] : []));
  }

  async orderViews(collectionId: string, spaceId: string, ids: string[]): Promise<void> {
    const ts = now();
    await this.db.write(
      ids.map((id, position) => ({
        sql: "UPDATE views SET position = ?1, updated_at = ?2 WHERE id = ?3 AND collection_id = ?4 AND space_id = ?5 AND position IS NOT ?1",
        bind: [position, ts, id, collectionId, spaceId],
      })),
    );
    this.emit({ scope: "views", collectionId });
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
    const ts = now();
    // Links to an item view or a block taken away (`book/dune/compact`, `book/dune#notes`) lose their bookmarks.
    const json = JSON.stringify(views);
    const before = itemViewParts((await this.db.select<{ item_views: string | null }>("SELECT item_views FROM collections WHERE id = ?1", [collectionId]))[0]?.item_views);
    const after = itemViewParts(json);
    const owners: BookmarkOwner[] = [...gone(before.views, after.views).map((view) => ({ view })), ...gone(before.blocks, after.blocks).map((block) => ({ block }))];
    await this.db.write([
      { sql: "UPDATE collections SET item_views = ?1, updated_at = ?2 WHERE id = ?3", bind: [json, ts, collectionId] },
      ...bookmarksOf(owners, ts),
      ...(await this.releaseBlockFiles("SELECT ?1", [collectionId])),
    ]);
    this.emit({ scope: "collections" }, ...(owners.length > 0 ? [{ scope: "bookmarks" } as const] : []));
  }

  async pinItemView(itemId: string, viewId: string | null): Promise<void> {
    await this.db.write([
      { sql: "UPDATE items SET item_view_id = ?1, updated_at = ?2 WHERE id = ?3", bind: [viewId, now(), itemId] },
    ]);
    const collectionId = await this.collectionOfItem(itemId);
    if (collectionId) this.emit({ scope: "items", collectionId, itemId });
  }

  async listDashboards(): Promise<Dashboard[]> {
    const rows = await this.db.select<DashboardRow>("SELECT * FROM dashboards WHERE deleted_at IS NULL ORDER BY position, created_at");
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      icon: r.icon,
      description: r.description,
      spaceIds: spaceIdsOf(r.space_ids),
      position: r.position,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  async saveDashboard(d: Pick<Dashboard, "id" | "name" | "icon" | "description" | "spaceIds">, spaceId: string): Promise<void> {
    const ts = now();
    const isNew = (await this.db.select("SELECT 1 FROM dashboards WHERE id = ?1", [d.id])).length === 0;
    const first = { filters: [], blocks: [], editable: true, collapsed: NOTHING_COLLAPSED };
    await this.db.write([
      {
        sql: `INSERT INTO dashboards (id, name, icon, description, space_ids, position, created_at, updated_at)
              SELECT ?1, ?2, ?3, ?4, ?5, COALESCE(MAX(position), -1) + 1, ?6, ?6 FROM dashboards WHERE deleted_at IS NULL
              ON CONFLICT (id) DO UPDATE SET name = excluded.name, icon = excluded.icon, description = excluded.description,
                space_ids = excluded.space_ids, updated_at = excluded.updated_at`,
        bind: [d.id, d.name, d.icon, d.description, spaceIdsJson(d.spaceIds), ts],
      },
      // A new one's first tab, in the space it is made in.
      ...(isNew
        ? [{
            sql: "INSERT INTO dashboard_views (id, dashboard_id, space_id, name, config, position, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, ?6)",
            bind: [newId(), d.id, spaceId, FIRST_TAB_NAME, viewConfig(first), ts],
          }]
        : []),
    ]);
    this.emit({ scope: "dashboards" }, ...(isNew ? [{ scope: "dashboardViews", dashboardId: d.id } as const] : []));
  }

  async deleteDashboard(dashboardId: string): Promise<void> {
    const ts = now();
    await this.db.write([
      ...bookmarksOf([{ dashboard: dashboardId }], ts),
      { sql: "UPDATE dashboard_views SET deleted_at = ?1, updated_at = ?1 WHERE dashboard_id = ?2 AND deleted_at IS NULL", bind: [ts, dashboardId] },
      { sql: "UPDATE dashboards SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2", bind: [ts, dashboardId] },
      ...(await this.releaseBlockFiles("SELECT id FROM dashboard_views WHERE dashboard_id = ?1", [dashboardId])),
    ]);
    this.emit({ scope: "dashboards" }, { scope: "dashboardViews", dashboardId }, { scope: "bookmarks" });
  }

  async listDashboardViews(dashboardId: string, spaceId: string): Promise<DashboardView[]> {
    // All its spaces' tabs: a space without its own shows another's.
    const rows = await this.db.select<DashboardViewRow>("SELECT * FROM dashboard_views WHERE dashboard_id = ?1 AND deleted_at IS NULL", [dashboardId]);
    return dashboardViewsIn(rows.map(toDashboardView), dashboardId, spaceId);
  }

  async listAllDashboardViews(): Promise<DashboardView[]> {
    const rows = await this.db.select<DashboardViewRow>(
      "SELECT * FROM dashboard_views WHERE deleted_at IS NULL ORDER BY dashboard_id, space_id, position, created_at",
    );
    return rows.map(toDashboardView);
  }

  async storeDashboardViews(dashboardId: string, spaceId: string): Promise<Map<string, string>> {
    const shown = await this.listDashboardViews(dashboardId, spaceId);
    const ids = new Map(shown.filter((v) => v.virtual).map((v) => [v.id, newId()]));
    if (ids.size === 0) return ids;
    const ts = now();
    await this.db.write(
      shown.map((v) => ({
        sql: `INSERT INTO dashboard_views (id, dashboard_id, space_id, name, config, position, is_default, created_at, updated_at)
              VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)`,
        bind: [ids.get(v.id)!, dashboardId, spaceId, v.name, viewConfig(v), v.position, v.isDefault ? 1 : 0, ts],
      })),
    );
    this.emit({ scope: "dashboardViews", dashboardId });
    return ids;
  }

  async saveDashboardView(view: DashboardView): Promise<void> {
    if (view.virtual || isVirtualTab(view.id)) throw new Error("A dashboard view copied from another space is stored in this space first.");
    const ts = now();
    const before = (await this.db.select<{ config: string }>("SELECT config FROM dashboard_views WHERE id = ?1", [view.id]))[0]?.config;
    const removedBlocks = gone(blockIds(before), view.blocks.map((b) => b.id));
    await this.db.write([
      {
        sql: `INSERT INTO dashboard_views (id, dashboard_id, space_id, name, config, position, created_at, updated_at)
              VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
              ON CONFLICT (id) DO UPDATE SET
                name = excluded.name, config = excluded.config,
                position = excluded.position, updated_at = excluded.updated_at`,
        bind: [view.id, view.dashboardId, view.spaceId, view.name, viewConfig(view), view.position, ts],
      },
      ...bookmarksOf(removedBlocks.map((block) => ({ block })), ts),
      ...(await this.releaseBlockFiles("SELECT ?1", [view.id])),
    ]);
    this.emit({ scope: "dashboardViews", dashboardId: view.dashboardId }, ...(removedBlocks.length > 0 ? [{ scope: "bookmarks" } as const] : []));
  }

  async deleteDashboardView(viewId: string): Promise<void> {
    const dashboardId = (await this.db.select<{ dashboard_id: string }>("SELECT dashboard_id FROM dashboard_views WHERE id = ?1", [viewId]))[0]?.dashboard_id;
    const ts = now();
    await this.db.write([
      { sql: "UPDATE dashboard_views SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2", bind: [ts, viewId] },
      ...bookmarksOf([{ view: viewId }], ts),
      ...(await this.releaseBlockFiles("SELECT ?1", [viewId])),
    ]);
    if (dashboardId) this.emit({ scope: "dashboardViews", dashboardId }, { scope: "bookmarks" });
  }

  async orderDashboardViews(dashboardId: string, spaceId: string, ids: string[]): Promise<void> {
    const ts = now();
    await this.db.write(
      ids.map((id, position) => ({
        sql: "UPDATE dashboard_views SET position = ?1, updated_at = ?2 WHERE id = ?3 AND dashboard_id = ?4 AND space_id = ?5 AND position IS NOT ?1",
        bind: [position, ts, id, dashboardId, spaceId],
      })),
    );
    this.emit({ scope: "dashboardViews", dashboardId });
  }

  async setDefaultDashboardView(dashboardId: string, spaceId: string, viewId: string | null): Promise<void> {
    await this.db.write([
      {
        sql: `UPDATE dashboard_views SET is_default = (id IS ?2), updated_at = ?3
               WHERE dashboard_id = ?1 AND space_id = ?4 AND deleted_at IS NULL AND is_default IS NOT (id IS ?2)`,
        bind: [dashboardId, viewId, now(), spaceId],
      },
    ]);
    this.emit({ scope: "dashboardViews", dashboardId });
  }

  async listBookmarks(spaceId: string): Promise<Bookmark[]> {
    const rows = await this.db.select<{ id: string; link: string; label: string; position: number; created_at: string }>(
      // What a bookmark names is never gone: its bookmarks are deleted with it (bookmarksOf).
      "SELECT id, link, label, position, created_at FROM bookmarks WHERE deleted_at IS NULL AND space_id = ?1 ORDER BY position, created_at",
      [spaceId],
    );
    return rows.map((r) => ({ id: r.id, link: r.link, label: r.label, position: r.position, createdAt: r.created_at }));
  }

  async getSettings(): Promise<Record<string, unknown>> {
    const rows = await this.db.select<{ key: string; value: string }>("SELECT key, value FROM settings WHERE deleted_at IS NULL");
    const out: Record<string, unknown> = {};
    for (const r of rows) {
      try {
        out[r.key] = JSON.parse(r.value);
      } catch {
        // Not JSON (written by hand): left out, as if never set.
      }
    }
    return out;
  }

  async setSetting(key: string, value: unknown): Promise<void> {
    const ts = now();
    await this.db.write([
      {
        sql: `INSERT INTO settings (key, value, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)
              ON CONFLICT (key) DO UPDATE SET value = ?2, updated_at = ?3, deleted_at = NULL`,
        bind: [key, JSON.stringify(value), ts],
      },
    ]);
    this.emit({ scope: "settings" });
  }

  async addBookmark(link: string, label: string, spaceId: string): Promise<void> {
    const ts = now();
    await this.db.write([
      {
        sql: `INSERT INTO bookmarks (id, space_id, link, label, position, created_at, updated_at)
              SELECT ?1, ?2, ?3, ?4, COALESCE(MAX(position), -1) + 1, ?5, ?5 FROM bookmarks WHERE deleted_at IS NULL AND space_id = ?2`,
        bind: [newId(), spaceId, link, label, ts],
      },
    ]);
    this.emit({ scope: "bookmarks" });
  }

  async removeBookmark(link: string, spaceId: string): Promise<void> {
    await this.db.write([
      {
        sql: "UPDATE bookmarks SET deleted_at = ?1, updated_at = ?1 WHERE link = ?2 AND space_id = ?3 AND deleted_at IS NULL",
        bind: [now(), link, spaceId],
      },
    ]);
    this.emit({ scope: "bookmarks" });
  }

  async relabelBookmark(link: string, label: string): Promise<void> {
    const changed = await this.db.select<{ id: string }>(
      "SELECT id FROM bookmarks WHERE link = ?1 AND deleted_at IS NULL AND label <> ?2",
      [link, label],
    );
    if (changed.length === 0) return;
    await this.db.write([
      { sql: "UPDATE bookmarks SET label = ?1, updated_at = ?2 WHERE link = ?3 AND deleted_at IS NULL", bind: [label, now(), link] },
    ]);
    this.emit({ scope: "bookmarks" });
  }

  async listComponents(): Promise<Component[]> {
    const rows = await this.db.select<ComponentRow>("SELECT * FROM components WHERE deleted_at IS NULL ORDER BY name COLLATE NOCASE");
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      code: r.code,
      output: isComponentOutput(r.output) ? r.output : "markdown",
      frameRatio: r.frame_ratio,
      ai: r.ai === 1,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  async saveComponent(x: Component): Promise<void> {
    await this.db.write([
      {
        sql: `INSERT INTO components (id, name, description, code, output, frame_ratio, ai, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
              ON CONFLICT (id) DO UPDATE SET name = excluded.name, description = excluded.description, code = excluded.code,
                output = excluded.output, frame_ratio = excluded.frame_ratio, ai = excluded.ai, updated_at = excluded.updated_at`,
        bind: [x.id, x.name, x.description, x.code, x.output, x.frameRatio, x.ai ? 1 : 0, now()],
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
      ...bookmarksOf(users.map((u) => ({ field: u.id })), ts),
      { sql: "UPDATE components SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2", bind: [ts, componentId] },
    ]);
    this.emit({ scope: "components" }, ...(users.length > 0 ? [{ scope: "collections" } as const, { scope: "bookmarks" } as const] : []));
  }

  async deleteView(viewId: string): Promise<void> {
    const collectionId = (await this.db.select<{ collection_id: string }>("SELECT collection_id FROM views WHERE id = ?1", [viewId]))[0]?.collection_id;
    const ts = now();
    await this.db.write([
      { sql: "UPDATE views SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2", bind: [ts, viewId] },
      ...bookmarksOf([{ view: viewId }], ts),
      ...(await this.releaseBlockFiles("SELECT ?1", [viewId])),
    ]);
    if (collectionId) this.emit({ scope: "views", collectionId }, { scope: "bookmarks" });
  }

  async deleteItem(itemId: string): Promise<void> {
    const collectionId = await this.collectionOfItem(itemId);
    const ts = now();
    await this.db.write([
      { sql: "UPDATE items SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2", bind: [ts, itemId] },
      ...bookmarksOf([{ item: itemId }], ts),
      ...(await this.releaseFilesWhere("item_id = ?1", [itemId])),
    ]);
    if (collectionId) this.emit({ scope: "items", collectionId, itemId }, { scope: "bookmarks" });
  }

  async search(query: string, collections: Collection[], spaceId: string, limit = 50): Promise<Item[]> {
    const q = query.trim();
    if (!q) return [];
    // Case-insensitive for ASCII only (SQLite's lower()); fine until there is an FTS index.
    // Markdown is matched without its backslash escapes: the editor stores a typed "[[" as
    // "\[\[" (and "*" as "\*", …), which a search for what was typed must still find. Item and
    // list-of-items fields match on the labels of the items they point to (as listLabels).
    const label = (ref: string) =>
      `(SELECT lv.value_text FROM field_values lv JOIN fields lf ON lf.id = lv.field_id
         WHERE lv.item_id = ${ref} AND lf.kind = 'string' AND lf.deleted_at IS NULL AND ${IS_TITLE_FIELD}
           AND trim(lv.value_text, ' ' || char(9, 10, 13)) <> ''
         ORDER BY lf.position, lf.created_at LIMIT 1)`;
    const hits = await this.db.select<{ id: string }>(
      `SELECT o.id FROM field_values fv
         JOIN items o ON o.id = fv.item_id
         JOIN fields f ON f.id = fv.field_id
        WHERE o.deleted_at IS NULL AND o.space_id = ?3 AND f.deleted_at IS NULL
          AND CASE
            WHEN f.kind IN ('string', 'markdown', 'html', 'string_list', 'number_list', 'checklist', 'ai')
              THEN instr(lower(CASE WHEN f.kind = 'markdown' THEN replace(fv.value_text, '\\', '') ELSE coalesce(fv.value_text, fv.value_json) END), lower(?1)) > 0
            WHEN f.kind = 'item' THEN instr(lower(${label("fv.value_ref")}), lower(?1)) > 0
            WHEN f.kind = 'item_list' THEN EXISTS (SELECT 1 FROM json_each(fv.value_json) j WHERE instr(lower(${label("j.value")}), lower(?1)) > 0)
            ELSE 0
          END
        GROUP BY o.id
        ORDER BY max(o.updated_at) DESC
        LIMIT ?2`,
      [q, limit, spaceId],
    );
    if (hits.length === 0) return [];
    const items = await this.db.select<ItemRow>("SELECT * FROM items WHERE id IN (SELECT value FROM json_each(?1))", [
      JSON.stringify(hits.map((h) => h.id)),
    ]);
    const values = await this.valuesOf(hits.map((h) => h.id));
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

  /** Those of these files no live item uses (a thumbnail: whose original none uses), by the rule of releaseFile. */
  async unusedFiles(fileIds: string[]): Promise<string[]> {
    if (fileIds.length === 0) return [];
    const rows = await this.db.select<{ id: string }>(`SELECT value AS id FROM json_each(?1) WHERE NOT ${fileInUse("value")}`, [
      JSON.stringify([...new Set(fileIds)]),
    ]);
    return rows.map((r) => r.id);
  }

  /**
   * Deletes the files no live item has used for FILE_GRACE_MS (`before`: marked before then), with
   * their thumbnails, and the server's copies (SyncEngine.deleteFromServer); a marked one used
   * again only loses its mark. Runs when the app opens and after each sync.
   */
  async sweepFiles(before = new Date(Date.now() - FILE_GRACE_MS).toISOString()): Promise<void> {
    await this.db.write([{ sql: `UPDATE files SET unused_since = NULL WHERE unused_since < ?1 AND ${fileInUse("files.id")}`, bind: [before] }]);
    const expired = (await this.db.select<{ id: string }>("SELECT id FROM files WHERE unused_since < ?1", [before])).map((r) => r.id);
    if (expired.length === 0) return;
    const gone = JSON.stringify(await this.sync.deleteFromServer(expired));
    await this.db.write([
      { sql: `DELETE FROM thumbnails WHERE file_id IN (SELECT value FROM json_each(?1)) AND NOT ${fileInUse("file_id")}`, bind: [gone] },
      { sql: `DELETE FROM files WHERE id IN (SELECT value FROM json_each(?1)) AND NOT ${fileInUse("files.id")}`, bind: [gone] },
    ]);
  }

  /** Release statements for every file the uses matching `where` (on item_id, field_id) name: run after the writes that end them. */
  private async releaseFilesWhere(where: string, bind: string[]): Promise<Statement[]> {
    const rows = await this.db.select<{ file_id: string }>(`SELECT DISTINCT file_id FROM file_uses WHERE ${where}`, bind);
    return rows.flatMap((r) => releaseFile(r.file_id));
  }

  /**
   * Release statements for every file the blocks of these owners (`owners`: a SELECT of view ids or collection
   * ids or dashboard tab ids, block_file_uses) name: read before the write that changes or deletes them, run after it.
   */
  private async releaseBlockFiles(owners: string, bind: string[]): Promise<Statement[]> {
    const rows = await this.db.select<{ file_id: string }>(`SELECT DISTINCT file_id FROM block_file_uses WHERE owner_id IN (${owners})`, bind);
    return rows.flatMap((r) => releaseFile(r.file_id));
  }

  async putFile(data: Uint8Array, mime: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", data as Uint8Array<ArrayBuffer>);
    const id = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    await this.db.write([
      {
        // Known from a sync but not downloaded yet: now this device has the bytes.
        sql: `INSERT INTO files (id, mime, size, data, created_at) VALUES (?1, ?2, ?3, ?4, ?5)
              ON CONFLICT (id) DO UPDATE SET data = excluded.data WHERE files.data IS NULL`,
        bind: [id, mime, data.byteLength, data, now()],
      },
    ]);
    return id;
  }

  async getFile(fileId: string, options: { small?: boolean } = {}): Promise<{ data: Uint8Array; mime: string; small?: boolean } | null> {
    if (options.small) {
      const thumb = (await this.db.select<{ thumb_id: string }>("SELECT thumb_id FROM thumbnails WHERE file_id = ?1", [fileId]))[0];
      const file = thumb && (await this.getFile(thumb.thumb_id));
      if (file) return { ...file, small: true };
    }
    const rows = await this.db.select<{ data: Uint8Array | null; mime: string }>("SELECT mime, data FROM files WHERE id = ?1", [
      fileId,
    ]);
    const file = rows[0];
    if (file?.data) return { data: file.data, mime: file.mime };
    // Known from a sync but not downloaded yet, or released here: from the server (null offline).
    const fetched = await this.sync.fetchFile(fileId);
    return fetched && { data: fetched.data, mime: file?.mime ?? fetched.mime };
  }

  async putThumbnail(fileId: string, data: Uint8Array, mime: string): Promise<void> {
    const thumbId = await this.putFile(data, mime);
    await this.db.write([
      { sql: "INSERT OR IGNORE INTO thumbnails (file_id, thumb_id, created_at) VALUES (?1, ?2, ?3)", bind: [fileId, thumbId, now()] },
    ]);
  }

  private assemble(collection: Collection, items: ItemRow[], values: ValueRow[]): Item[] {
    const fieldsById = new Map(collection.fields.map((f) => [f.id, f]));
    const byItem = new Map<string, Record<string, FieldValue>>();
    const inputsByItem = new Map<string, Record<string, string>>();
    const generatedByItem = new Map<string, Record<string, string>>();
    const editedByItem = new Map<string, Record<string, true>>();
    for (const v of values) {
      const field = fieldsById.get(v.field_id);
      if (!field) continue; // value of a removed field
      const spec = fieldKinds[field.kind];
      const record = byItem.get(v.item_id) ?? {};
      if (field.kind === "ai") {
        // A number is in value_number, text and Markdown in value_text; the prompt it came from in value_json.
        record[field.id] = field.output === "number" ? v.value_number : v.value_text;
        const input = decodeAiInput(v.value_json);
        if (input) inputsByItem.set(v.item_id, { ...inputsByItem.get(v.item_id), [field.id]: input.hash });
        if (input?.edited) editedByItem.set(v.item_id, { ...editedByItem.get(v.item_id), [field.id]: true });
        if (v.value_text != null || v.value_number != null) generatedByItem.set(v.item_id, { ...generatedByItem.get(v.item_id), [field.id]: v.updated_at });
        byItem.set(v.item_id, record);
        continue;
      }
      record[field.id] = spec.fromDb(v[spec.column]);
      byItem.set(v.item_id, record);
    }
    return items.map((o) => ({
      id: o.id,
      collectionId: o.collection_id,
      spaceId: o.space_id,
      values: byItem.get(o.id) ?? {},
      ...(inputsByItem.has(o.id) && { aiInputs: inputsByItem.get(o.id) }),
      ...(generatedByItem.has(o.id) && { aiGeneratedAt: generatedByItem.get(o.id) }),
      ...(editedByItem.has(o.id) && { aiEdited: editedByItem.get(o.id) }),
      itemViewId: o.item_view_id,
      createdAt: o.created_at,
      updatedAt: o.updated_at,
    }));
  }
}

/**
 * Whether the file `id` (an SQL expression) is in use: a live item uses it through a live field
 * (file_uses) or a live view's, collection's or dashboard tab's blocks do (block_file_uses), or it is the thumbnail
 * of such a file.
 */
const fileInUse = (id: string) => {
  const used = (file: string) => `(EXISTS (SELECT 1 FROM file_uses u
      JOIN items o ON o.id = u.item_id AND o.deleted_at IS NULL
      JOIN fields f ON f.id = u.field_id AND f.deleted_at IS NULL
     WHERE u.file_id = ${file}) OR EXISTS (SELECT 1 FROM block_file_uses b WHERE b.file_id = ${file}))`;
  return `(${used(id)} OR EXISTS (SELECT 1 FROM thumbnails t WHERE t.thumb_id = ${id} AND ${used("t.file_id")}))`;
};

/** How long a file no live item uses is kept: an undo or a paste may bring it back, other devices sync late. */
const FILE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Marks a file (with its thumbnail) unused once no live item uses it; sweepFiles deletes it after
 * FILE_GRACE_MS. Runs after the statements that drop the use, in the same transaction.
 */
/** Deletes the bookmarks of what is being deleted (domain/bookmarks.ts: those whose link names it), in the same write. */
function bookmarksOf(owners: BookmarkOwner[], ts: string): Statement[] {
  return owners.map((o) => {
    const c = bookmarkCondition(o, 2);
    return { sql: `UPDATE bookmarks SET deleted_at = ?1, updated_at = ?1 WHERE deleted_at IS NULL AND ${c.sql}`, bind: [ts, c.id] };
  });
}

/** The ids of a view config's blocks (a collection view's or a dashboard view's config JSON). */
function blockIds(config: string | null | undefined): string[] {
  const blocks = parseJson<{ blocks?: { id?: unknown }[] }>(config ?? null, {}).blocks;
  return Array.isArray(blocks) ? blocks.flatMap((b) => (typeof b?.id === "string" ? [b.id] : [])) : [];
}

/** The item views of a collection's `item_views` JSON and the blocks of their layouts. */
function itemViewParts(json: string | null | undefined): { views: string[]; blocks: string[] } {
  const views = parseJson<{ id?: unknown; layout?: { blocks?: { id?: unknown }[] } }[]>(json ?? null, []);
  if (!Array.isArray(views)) return { views: [], blocks: [] };
  return {
    views: views.flatMap((v) => (typeof v?.id === "string" ? [v.id] : [])),
    blocks: views.flatMap((v) => (Array.isArray(v?.layout?.blocks) ? v.layout.blocks.flatMap((b) => (typeof b?.id === "string" ? [b.id] : [])) : [])),
  };
}

/** What was in `before` and is no longer in `after`. */
const gone = (before: string[], after: string[]) => before.filter((id) => !after.includes(id));

function releaseFile(fileId: string): Statement[] {
  return [
    {
      sql: `UPDATE files SET unused_since = ?2
             WHERE (id = ?1 OR id IN (SELECT thumb_id FROM thumbnails WHERE file_id = ?1)) AND NOT ${fileInUse("files.id")}`,
      bind: [fileId, now()],
    },
  ];
}

/** A reference field's choice filters as stored (JSON), or null for other fields / none. */
const choices = (f: CollectionDraft["fields"][number]) =>
  (f.kind === "item" || f.kind === "item_list") && f.choiceFilter.length > 0 ? JSON.stringify(f.choiceFilter) : null;

const strike = (f: CollectionDraft["fields"][number]) => (f.strikeThrough && (f.kind === "checkbox" || f.kind === "checklist") ? 1 : 0);
const usesComponent = (kind: FieldKind) => kind === "component" || kind === "ai";
/** The shared component a component or AI field picks (null: its own, or another kind). */
const componentOf = (f: CollectionDraft["fields"][number]) => (usesComponent(f.kind) && f.code === null ? f.componentId : null);
/**
 * A component or AI field's own component as stored: code, output, frame ratio (nulls for other
 * fields). An AI field's output is fixed once saved (`old`), and it always has one.
 */
function local(f: CollectionDraft["fields"][number], old: FieldRow | null): [string | null, string | null, string | null] {
  const kind = old?.kind ?? f.kind;
  if (!usesComponent(kind)) return [null, null, null];
  const output = kind === "ai" ? (old?.output ?? f.output ?? "string") : f.code !== null ? (f.output ?? "markdown") : null;
  return [f.code, output, f.code !== null && output === "html" ? f.frameRatio : null];
}

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
