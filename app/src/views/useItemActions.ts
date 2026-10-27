import { useMemo, useRef } from "react";
import { useStore } from "../app/store";
import { itemLabel, labelField, nextName, type Collection, type FieldValue, type Item } from "../domain/model";
import { groupPreset, type ViewQuery } from "../domain/query";
import { isRemote } from "../domain/sources";
import { errorMessage } from "../ui/useConfirm";
import { useOpenRelated } from "../workspace/Workspace";
import type { ItemActions } from "./registry";

interface Options {
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

/** What a block can do with read-only items (a remote collection's rows): open them, sort them. */
function readOnlyActions(actions: ItemActions): ItemActions {
  const { open, sort, sortBy, groupBy } = actions;
  return { open, sort, sortBy, groupBy };
}

/**
 * What a block can do with its items. What the blocks get keeps its identity (each call goes to
 * the latest handlers), so rows that didn't change aren't rendered again; it changes only with
 * the sort, which reorders them anyway, and the grouping, which regroups them.
 */
export function useItemActions({ collection, stored, query, preset, onSort, confirm, onError }: Options): ItemActions {
  const { repo, cache, space } = useStore();
  const openRelated = useOpenRelated();
  const current: ItemActions = {
    open: (item, mode, o) => openRelated(`/collections/${collection.id}/items/${item.id}${o?.edit ? "?edit=1" : ""}`, mode),
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
      if (title) values[title.id] = nextName(String(original.values[title.id]), (stored ?? []).map((e) => itemLabel(collection, e)));
      try {
        await repo.createItem(collection, values, space.id); // the list hears the change and adds it
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
        cache.items.reload(collection.id);
      }
    },
    openNew: (mode) => openRelated(`/collections/${collection.id}/items/new`, mode),
    async create(values) {
      // Shown before the add row closes (waits for the reload the change event started, else reloads).
      const id = await repo.createItem(collection, values, space.id);
      await cache.items.settled(collection.id, id);
    },
    groupPreset: (key) => ({ ...preset, ...groupPreset(collection, query, key) }),
    groupBy: query.groupBy,
    sort: query.sort[0],
    sortBy(fieldId) {
      const sort = query.sort[0];
      const direction = sort?.fieldId === fieldId && sort.direction === "asc" ? "desc" : "asc";
      onSort([{ fieldId, direction }]);
    },
  };
  const latest = useRef(current);
  latest.current = current;
  const sort = query.sort[0];
  const groupBy = query.groupBy;
  const readOnly = isRemote(collection);
  return useMemo<ItemActions>(
    () => {
      const actions: ItemActions = {
      open: (item, mode, options) => latest.current.open(item, mode, options),
      remove: (item) => latest.current.remove?.(item),
      duplicate: (item) => latest.current.duplicate?.(item),
      setValue: (item, field, value) => latest.current.setValue!(item, field, value),
      openNew: (mode) => latest.current.openNew!(mode),
      create: (values) => latest.current.create!(values),
      groupPreset: (key) => latest.current.groupPreset!(key),
      groupBy,
      sort,
      sortBy: (fieldId) => latest.current.sortBy!(fieldId),
      };
      return readOnly ? readOnlyActions(actions) : actions;
    },
    [sort, groupBy, readOnly],
  );
}
