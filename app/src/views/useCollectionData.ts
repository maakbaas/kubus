import { useMemo } from "react";
import { useStore } from "../app/store";
import { useItems } from "../app/useItems";
import { withComputed } from "../domain/components";
import { isReferenceKind, type Collection, type Item } from "../domain/model";
import type { QueryContext } from "../domain/query";
import { refLabelOf, useReferenceOptions, type RefOptions } from "../ui/useReferenceOptions";

export interface CollectionData {
  /**
   * The items (of the shown space) with their component fields computed, so blocks, filters,
   * sorting and grouping see the results; null until loaded, and until the referenced items'
   * labels are in (a reference would read as "(deleted)" in groups, sorting and filters).
   */
  items: Item[] | null;
  /** As stored: what a duplicate copies (not computed values). */
  stored: Item[] | null;
  refs: RefOptions;
  ctx: QueryContext;
  error?: string;
}

/** A collection's items for its blocks: shared with every pane showing them, current from the change feed. */
export function useCollectionData(collection: Collection): CollectionData {
  const { components } = useStore();
  const refs = useReferenceOptions(collection);
  const { items, error } = useItems(collection);
  const refsLoading = collection.fields.some((f) => isReferenceKind(f.kind) && f.targetCollectionId && !refs[f.targetCollectionId]);
  const ctx: QueryContext = useMemo(() => ({ refLabel: refLabelOf(refs, "(deleted)") }), [refs]);
  // Each item is computed once: only items that changed are computed again.
  const memo = useMemo(() => new WeakMap<Item, Item>(), [collection, components, ctx]);
  const computed = useMemo(
    () => (items && !refsLoading ? withComputed(collection, items, components, ctx.refLabel, memo) : null),
    [collection, items, refsLoading, components, ctx, memo],
  );
  return { items: computed, stored: items, refs, ctx, error };
}
