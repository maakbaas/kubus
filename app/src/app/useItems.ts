import { useCallback, useSyncExternalStore } from "react";
import type { Item, Collection } from "../domain/model";
import type { Snapshot } from "./itemCache";
import { useStore } from "./store";

/**
 * The collection's items, shared with every other pane showing them and kept current from the
 * change feed. `items` is null until loaded. Items that didn't change keep their identity.
 */
export function useItems(collection: Collection): Snapshot<Item> {
  const { cache } = useStore();
  const collectionId = collection.id;
  const subscribe = useCallback((onChange: () => void) => cache.items.subscribe(collectionId, onChange), [cache, collectionId]);
  return useSyncExternalStore(subscribe, () => cache.items.snapshot(collectionId));
}
