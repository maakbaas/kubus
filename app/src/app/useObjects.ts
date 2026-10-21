import { useCallback, useSyncExternalStore } from "react";
import type { ObjectInstance, ObjectType } from "../domain/model";
import type { Snapshot } from "./objectCache";
import { useStore } from "./store";

/**
 * The type's objects, shared with every other pane showing them and kept current from the
 * change feed. `items` is null until loaded. Objects that didn't change keep their identity.
 */
export function useObjects(type: ObjectType): Snapshot<ObjectInstance> {
  const { cache } = useStore();
  const typeId = type.id;
  const subscribe = useCallback((onChange: () => void) => cache.objects.subscribe(typeId, onChange), [cache, typeId]);
  return useSyncExternalStore(subscribe, () => cache.objects.snapshot(typeId));
}
