// Working out what the AI values of items need: shared by what shows items (useAiFill) and the
// backfill (aiBackfill.ts), so they judge a value the same way.

import { aiRequest, aiStaleness, type AiRequest } from "../domain/ai";
import type { Component, RefLabel } from "../domain/components";
import { itemLabel, type Collection, type Item } from "../domain/model";
import type { AiJob } from "./ai";

export interface AiScan {
  /** Missing, or made from another prompt: to generate. */
  generate: AiJob[];
  /** Typed by the user just now: to record as right for the item as it is. */
  adopt: AiJob[];
  /** Typed by the user, and the prompt has changed since: to ask about, never to replace by itself. */
  ask: AiJob[];
  /** Values that need nothing (or nothing to ask about): an earlier question about them is moot. */
  settled: [itemId: string, fieldId: string][];
  /** Why a value has no prompt to send (null: it has one). */
  problems: [itemId: string, fieldId: string, problem: string | null][];
}

/** Per item and field: the prompt as it reads, rendered once (items that didn't change keep their identity). */
export type RequestCache = WeakMap<Item, Map<string, AiRequest | { problem: string }>>;

/** Sorts the AI values of `items` (computed items) by what they need. */
export function scanAiValues(collection: Collection, items: Item[], refLabel: RefLabel, components: Component[], cache: RequestCache = new WeakMap()): AiScan {
  const scan: AiScan = { generate: [], adopt: [], ask: [], settled: [], problems: [] };
  const aiFields = collection.fields.filter((f) => f.kind === "ai");
  for (const item of items) {
    let own = cache.get(item);
    if (!own) cache.set(item, (own = new Map()));
    for (const field of aiFields) {
      let request = own.get(field.id);
      if (!request) own.set(field.id, (request = aiRequest(collection, field, item, refLabel, components)));
      // A prompt that can't be made is reported where the value would be, never skipped silently.
      scan.problems.push([item.id, field.id, "problem" in request ? request.problem : null]);
      if ("problem" in request) continue;
      const job: AiJob = { collection, field, itemId: item.id, request, label: itemLabel(collection, item) };
      const need = aiStaleness(item, field, request.hash);
      if (need === "generate") scan.generate.push(job);
      else if (need === "adopt") scan.adopt.push(job);
      else if (need === "ask") scan.ask.push(job);
      else scan.settled.push([item.id, field.id]);
    }
  }
  return scan;
}
