import { useEffect, useMemo, useRef } from "react";
import { AiBackfill, ITEMS_DELAY_MS, STRUCTURE_DELAY_MS } from "./aiBackfill";
import { useStore } from "./store";
import { useAiSettings } from "./useAi";

/**
 * Keeps AI fields filled for items nobody is looking at (see aiBackfill.ts): looks at everything
 * soon after the app starts and whenever the collections, components, spaces or model change, and
 * at a collection when its items change (not for a value the app generated itself).
 */
export function AiBackfillRunner() {
  const { repo, ai, collections, components, spaces } = useStore();
  const { baseUrl, fieldModel } = useAiSettings();
  const world = useRef({ collections, components, spaces });
  world.current = { collections, components, spaces };
  const backfill = useMemo(() => new AiBackfill(repo, ai, () => world.current), [repo, ai]);

  useEffect(() => {
    const unsubscribe = repo.subscribe((change) => {
      if (change.scope === "items") {
        if (!change.itemId || !ai.isRecent(change.itemId)) backfill.request(change.collectionId, ITEMS_DELAY_MS);
      }
    });
    return () => {
      unsubscribe();
      backfill.dispose();
    };
  }, [repo, ai, backfill]);

  useEffect(() => {
    backfill.request(undefined, STRUCTURE_DELAY_MS);
  }, [backfill, collections, components, spaces, baseUrl, fieldModel]);

  return null;
}
