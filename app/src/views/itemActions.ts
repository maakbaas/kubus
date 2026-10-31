import type { ItemCache } from "../app/itemCache";
import type { Repository } from "../data";
import { itemPath } from "../domain/backlinks";
import { LIST_DONE, LIST_VALUE, parseEntryId, withEntryAdded, withEntryChanged, withEntryRemoved } from "../domain/listEntries";
import { itemLabel, labelField, nextName, type Collection, type FieldValue, type Item } from "../domain/model";
import { groupPreset, type ViewQuery } from "../domain/query";
import type { OpenMode } from "../workspace/Workspace";
import type { ItemActions, PageItem } from "./registry";
import { errorMessage } from "../domain/errors";

// What a block can do with its items (useItemActions wires these to the app): the handlers worked out
// from the collection and the block's query, and the stable object blocks get, which delegates to the
// latest handlers. Plain functions over the repository and the shared cache, so they run without React.

export interface ItemActionsOptions {
  collection: Collection;
  /** The collection's items as stored (a duplicate copies these, not computed values). */
  stored: Item[] | null;
  /** The block's query (its sort and grouping; a new item lands in its group). */
  query: ViewQuery;
  /** Values every new item starts with (e.g. to pass the block's filter). */
  preset: Record<string, FieldValue>;
  /** Clicking a column header: sort by that field (ascending, then descending). */
  onSort(sort: ViewQuery["sort"]): void;
  confirm(options: { title: string; body: string }): Promise<boolean>;
  onError(message: string): void;
  /** A block of a list field's entries on an item page whose fields are editable: its entries are edited, added (to this item) and deleted. */
  entriesOn?: PageItem | null;
}

export interface ItemActionsEnvironment {
  repo: Pick<Repository, "deleteItem" | "createItem" | "updateItem" | "getItem">;
  cache: Pick<ItemCache, "items">;
  /** The space new items land in. */
  spaceId: string;
  openRelated(path: string, mode?: OpenMode): void;
}


/** What a block can do with read-only items (a remote collection's rows): open them, sort them. */
export function readOnlyActions(actions: ItemActions): ItemActions {
  return {
    open: actions.open,
    sortBy: actions.sortBy,
    get sort() {
      return actions.sort;
    },
    get groupBy() {
      return actions.groupBy;
    },
  };
}

/**
 * What a block can do with a checklist's entries (domain/listEntries.ts): open and sort them, and tick one (Done), which
 * writes the entry back into its item's checklist; nothing else of them is edited here.
 */
export function entryActions(
  actions: ItemActions,
  list: Collection,
  collections: Collection[],
  { repo, cache }: Pick<ItemActionsEnvironment, "repo" | "cache">,
  { onError, confirm, entriesOn }: Pick<ItemActionsOptions, "onError" | "confirm" | "entriesOn">,
): ItemActions {
  const source = list.listOf;
  const owner = collections.find((c) => c.id === source?.collectionId);
  if (!source || !owner) return readOnlyActions(actions);
  /**
   * The owner item's list value made into `change` of it (null: nothing to do), shown at once and stored. Read from the
   * database, not the cache: a reload of the cache after an earlier edit may still show the list before it, and the
   * whole list is written back.
   */
  const write = async (itemId: string, change: (value: FieldValue | undefined) => FieldValue | null) => {
    const item = await repo.getItem(owner, itemId).catch(() => null);
    const next = item && change(item.values[source.fieldId]);
    if (!next) return;
    cache.items.patch(owner.id, itemId, (o) => ({ ...o, values: { ...o.values, [source.fieldId]: next } }));
    try {
      await repo.updateItem(owner, itemId, { [source.fieldId]: next });
    } catch (e) {
      onError(errorMessage(e));
      void cache.items.reload(owner.id);
    }
  };
  // A checklist's Done is ticked wherever its entries are listed; the rest only on an item page (`entriesOn`), whose item a
  // new entry goes to.
  const page = entriesOn && entriesOn.item.collectionId === owner.id ? entriesOn : null;
  return {
    ...readOnlyActions(actions),
    async setValue(entry, field, value) {
      const { itemId, index } = parseEntryId(entry.id);
      const shown = entry.values[LIST_VALUE];
      if (field.id === LIST_DONE && source.kind === "checklist") await write(itemId, (v) => withEntryChanged(source.kind, v, index, shown, { done: value === true }));
      else if (field.id === LIST_VALUE && page) await write(itemId, (v) => withEntryChanged(source.kind, v, index, shown, { text: value }));
    },
    ...(page && {
      groupPreset: actions.groupPreset,
      async create(values) {
        await write(page.item.id, (v) => withEntryAdded(source.kind, v, values[LIST_VALUE], values[LIST_DONE] === true));
      },
      async remove(entry) {
        const { itemId, index } = parseEntryId(entry.id);
        const shown = entry.values[LIST_VALUE];
        if (!(await confirm({ title: `Delete “${String(shown ?? "")}”?`, body: `It is removed from ${owner.name}'s ${list.name.split(" / ").pop()}.` }))) return;
        await write(itemId, (v) => withEntryRemoved(source.kind, v, index, shown));
      },
    }),
  };
}

/** The handlers for the collection and query as they are now. */
export function buildItemActions({ collection, stored, query, preset, onSort, confirm, onError }: ItemActionsOptions, { repo, cache, spaceId, openRelated }: ItemActionsEnvironment): ItemActions {
  return {
    open: (item, mode, o) => {
      const path = itemPath(collection, item);
      openRelated(`${path}${o?.edit ? `${path.includes("?") ? "&" : "?"}edit=1` : ""}`, mode);
    },
    async remove(item) {
      if (!(await confirm({ title: `Delete ${collection.name}?`, body: `This ${collection.name} will be removed.` }))) return;
      try {
        await repo.deleteItem(item.id); // the list hears the change and drops it
      } catch (e) {
        onError(errorMessage(e));
      }
    },
    /**
     * A copy with the item's stored values (not computed ones: component fields, rendered {{ }}
     * sections keep their source; AI fields are generated for the copy); its title numbered. Images are shared (files are immutable).
     */
    async duplicate(item) {
      const original = stored?.find((e) => e.id === item.id) ?? item;
      const values: Record<string, FieldValue> = {};
      for (const f of collection.fields) {
        const v = original.values[f.id];
        if (f.kind !== "component" && f.kind !== "ai" && v != null) values[f.id] = v;
      }
      const title = labelField(collection, original);
      // A text title gets "(2)"; a number or date stays as it is.
      if (title?.kind === "string") values[title.id] = nextName(String(original.values[title.id]), (stored ?? []).map((e) => itemLabel(collection, e)));
      try {
        await repo.createItem(collection, values, spaceId); // the list hears the change and adds it
      } catch (e) {
        onError(errorMessage(e));
      }
    },
    /** Optimistic update, then save (reload on failure). */
    async setValue(item, field, value: FieldValue) {
      cache.items.patch(collection.id, item.id, (o) => ({ ...o, values: { ...o.values, [field.id]: value } }));
      try {
        await repo.updateItem(collection, item.id, { [field.id]: value });
      } catch (e) {
        onError(errorMessage(e));
        void cache.items.reload(collection.id);
      }
    },
    openNew: (mode) => openRelated(`/collections/${collection.id}/items/new`, mode),
    async create(values) {
      // Shown before the add row closes (waits for the reload the change event started, else reloads).
      const id = await repo.createItem(collection, values, spaceId);
      await cache.items.settled(collection.id, id);
    },
    groupPreset: (key) => ({ ...preset, ...groupPreset(collection, query, key) }),
    groupBy: query.groupBy,
    sort: query.sort[0],
    // A column's header: that field first (its direction turned when it already was), the other levels after it.
    sortBy(fieldId) {
      const sort = query.sort[0];
      const direction = sort?.fieldId === fieldId && sort.direction === "asc" ? "desc" : "asc";
      onSort([{ fieldId, direction }, ...query.sort.filter((s) => s.fieldId !== fieldId)]);
    },
  };
}

/**
 * The object blocks get: each call goes to the latest handlers, `sort` and `groupBy` read the latest
 * query, so it never changes (except between editable and read-only). A read-only one (a remote
 * collection) can only open and sort.
 */
export function stableItemActions(latest: { current: ItemActions }, readOnly: boolean, tickable = false, entries = false): ItemActions {
  const actions: ItemActions = {
    open: (item, mode, options) => latest.current.open(item, mode, options),
    remove: (item) => latest.current.remove?.(item),
    duplicate: (item) => latest.current.duplicate?.(item),
    setValue: (item, field, value) => latest.current.setValue!(item, field, value),
    openNew: (mode) => latest.current.openNew!(mode),
    create: (values) => latest.current.create!(values),
    groupPreset: (key) => latest.current.groupPreset!(key),
    get groupBy() {
      return latest.current.groupBy;
    },
    get sort() {
      return latest.current.sort;
    },
    sortBy: (fieldId) => latest.current.sortBy!(fieldId),
  };
  // A list field's entries: ticked (a checklist's Done), and on an item page edited, added and deleted (entryActions).
  if (entries) return { ...readOnlyActions(actions), setValue: actions.setValue, create: actions.create, remove: actions.remove, groupPreset: actions.groupPreset };
  return tickable ? { ...readOnlyActions(actions), setValue: actions.setValue } : readOnly ? readOnlyActions(actions) : actions;
}
