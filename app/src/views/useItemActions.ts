import { useMemo, useRef } from "react";
import { useStore } from "../app/store";
import { isReadOnly } from "../domain/sources";
import { useOpenRelated } from "../workspace/Workspace";
import { buildItemActions, stableItemActions, type ItemActionsOptions } from "./itemActions";
import type { ItemActions } from "./registry";

/**
 * What a block can do with its items. What the blocks get keeps its identity (each call goes to
 * the latest handlers, `sort` and `groupBy` read the latest query), so rows that didn't change
 * aren't rendered again, also when they are sorted or regrouped: a sorted 1,000-row table rendered
 * every row again. Whatever shows the sort renders with the rows it reorders.
 */
export function useItemActions(options: ItemActionsOptions): ItemActions {
  const { repo, cache, space } = useStore();
  const openRelated = useOpenRelated();
  const latest = useRef<ItemActions>(null as unknown as ItemActions);
  latest.current = buildItemActions(options, { repo, cache, spaceId: space.id, openRelated });
  const readOnly = isReadOnly(options.collection);
  return useMemo(() => stableItemActions(latest, readOnly), [readOnly]);
}
