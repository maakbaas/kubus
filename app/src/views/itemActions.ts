import type { ItemCache } from "../app/itemCache";
import type { Repository } from "../data";
import { itemPath } from "../domain/backlinks";
import { LIST_DONE, LIST_VALUE, parseEntryId, withEntryDone } from "../domain/listEntries";
import { itemLabel, labelField, nextName, type Collection, type FieldValue, type Item } from "../domain/model";
import { groupPreset, type ViewQuery } from "../domain/query";
import type { OpenMode } from "../workspace/Workspace";
import type { ItemActions } from "./registry";
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
}

export interface ItemActionsEnvironment {
  repo: Pick<Repository, "deleteItem" | "createItem" | "updateItem">;
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
export function entryActions(actions: ItemActions, list: Collection, collections: Collection[], { repo, cache }: Pick<ItemActionsEnvironment, "repo" | "cache">, onError: (message: string) => void): ItemActions {
  return {
    ...readOnlyActions(actions),
    async setValue(entry, field, value) {
      const source = list.listOf;
      const owner = collections.find((c) => c.id === source?.collectionId);
      if (!source || !owner || field.id !== LIST_DONE) return;
      const { itemId, index } = parseEntryId(entry.id);
      const item = cache.items.snapshot(owner.id).items?.find((i) => i.id === itemId);
      const next = item && withEntryDone(item.values[source.fieldId], index, String(entry.values[LIST_VALUE] ?? ""), value === true);
      if (!next) return;
      cache.items.patch(owner.id, itemId, (o) => ({ ...o, values: { ...o.values, [source.fieldId]: next } }));
      try {
        await repo.updateItem(owner, itemId, { [source.fieldId]: next });
      } catch (e) {
        onError(errorMessage(e));
        void cache.items.reload(owner.id);
      }
    },
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
export function stableItemActions(latest: { current: ItemActions }, readOnly: boolean, tickable = false): ItemActions {
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
  return tickable ? { ...readOnlyActions(actions), setValue: actions.setValue } : readOnly ? readOnlyActions(actions) : actions;
}
