import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { RefLabel } from "../domain/components";
import type { Collection, Item } from "../domain/model";
import type { AiConfig, AiProgress } from "./ai";
import { scanAiValues, type RequestCache } from "./aiScan";
import { useStore } from "./store";

/** The language model settings of this device (address, key, models), current. */
export function useAiSettings(): AiConfig {
  const { ai } = useStore();
  return useSyncExternalStore(ai.subscribe, () => ai.settings);
}

/** How many AI values wait, work or failed. */
export function useAiProgress(): AiProgress {
  const { ai } = useStore();
  return useSyncExternalStore(ai.subscribe, ai.getProgress);
}

/** What one AI value is doing (see AiService.cellState). */
export function useAiCellState(itemId: string, fieldId: string): string {
  const { ai } = useStore();
  return useSyncExternalStore(ai.subscribe, () => ai.cellState(itemId, fieldId));
}

/**
 * Offers the AI values of shown items that need something (see AiService, aiScan.ts): stale ones to
 * generate, typed ones to record or to ask about. `items` are the
 * computed items (null while loading); `ready` is false while what a prompt reads (the labels of
 * referenced items) is still loading, so a half-rendered prompt is never sent.
 */
export function useAiFill(collection: Collection, items: Item[] | null, refLabel: RefLabel, ready = true) {
  const { ai, components } = useStore();
  // Rendered prompts are kept per item while the collection, the labels and the components stay.
  const requests = useMemo<RequestCache>(() => new WeakMap(), [collection, refLabel, components]);
  useEffect(() => {
    if (!items || !ready || !collection.fields.some((f) => f.kind === "ai")) return;
    const scan = scanAiValues(collection, items, refLabel, components, requests);
    ai.setProblems(scan.problems);
    ai.offer(scan.generate);
    ai.adopt(scan.adopt);
    ai.offerOverrides(scan.ask, scan.settled);
  }, [ai, collection, items, ready, refLabel, components, requests]);
}
