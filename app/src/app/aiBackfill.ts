// Filling AI fields for items nobody is looking at.
//
// What shows items offers its stale AI values (useAiFill); that leaves an item untouched until it is
// shown, so a field added to a collection that already has items would stay empty (and could not be
// sorted or filtered on). The backfill looks at every item of every collection that has an AI field,
// in every space, and offers the stale values to the AiService, which generates them behind the
// shown ones and within its rate limit.
//
// It reads items straight from the repository (not through the item cache, which holds only what is
// shown) and works out prompts exactly as the views do: it uses the same code for the referenced
// items' labels (domain/refOptions.ts) and for computed values, so both reach the same prompt, and the
// same fingerprint, for the same data. (They would otherwise take turns regenerating a value.)

import type { Repository } from "../data";
import { withComputed, type Component } from "../domain/components";
import type { Collection, ItemLabel } from "../domain/model";
import { buildTargetOptions, isFullTarget, referenceTargets, refLabelOf, type RefOptions } from "../domain/refOptions";
import { inSpace, type Space } from "../domain/spaces";
import type { AiService } from "./ai";
import { scanAiValues } from "./aiScan";

export interface BackfillWorld {
  collections: Collection[];
  components: Component[];
  spaces: Space[];
}

/** After the collections, components, spaces or model changed: soon, as these come in bursts. */
export const STRUCTURE_DELAY_MS = 3000;
/** After an item changed (also by sync): later, as edits come in bursts and each look reads the collection. */
export const ITEMS_DELAY_MS = 15_000;

export class AiBackfill {
  private timer?: ReturnType<typeof setTimeout>;
  /** What to look at next: everything, or these collections. */
  private all = false;
  private ids = new Set<string>();
  private scanning = false;
  private disposed = false;

  constructor(
    private repo: Repository,
    private ai: AiService,
    private world: () => BackfillWorld,
  ) {}

  /** Looks at everything (no id) or at one collection, after `delay` (later requests join the wait). */
  request(collectionId: string | undefined, delay: number) {
    if (collectionId === undefined) this.all = true;
    else this.ids.add(collectionId);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.scan(), delay);
  }

  dispose() {
    this.disposed = true;
    clearTimeout(this.timer);
  }

  private async scan() {
    // One look at a time; what was asked for meanwhile comes right after.
    if (this.scanning) return void this.request(undefined, STRUCTURE_DELAY_MS);
    this.scanning = true;
    const all = this.all;
    const ids = this.ids;
    this.all = false;
    this.ids = new Set();
    try {
      if (!this.ai.configured) return;
      const { collections } = this.world();
      for (const collection of collections) {
        if (this.disposed) return;
        if (!all && !ids.has(collection.id)) continue;
        if (!collection.fields.some((f) => f.kind === "ai")) continue;
        await this.fill(collection);
      }
    } catch (e) {
      console.error("Looking for AI values to generate failed", e);
    } finally {
      this.scanning = false;
    }
  }

  private async fill(collection: Collection) {
    const { collections, components, spaces } = this.world();
    // Labels of referenced items, as the screens get them (domain/refOptions.ts decides how): the
    // labels of every space, and for a target that needs them (a field's choice filter) its items
    // of the space looked at.
    const targets = referenceTargets(collection).flatMap((t) => {
      const target = collections.find((c) => c.id === t.id);
      return target ? [{ ...t, target }] : [];
    });
    const labels = new Map<string, ItemLabel[]>();
    const labelsOf = async (c: Collection) => {
      let list = labels.get(c.id);
      if (!list) labels.set(c.id, (list = await this.repo.listLabels(c)));
      return list;
    };
    for (const space of spaces) {
      if (this.disposed) return;
      if (!inSpace(collection, space.id)) continue;
      const options: RefOptions = {};
      for (const t of targets) {
        const own = await labelsOf(t.target);
        const full = isFullTarget(t);
        if (full) for (const n of referenceTargets(t.target)) await labelsOf(collections.find((c) => c.id === n.id) ?? t.target);
        options[t.id] = buildTargetOptions({
          target: t.target,
          limited: t.limited,
          full,
          items: full ? await this.repo.listItems(t.target, space.id) : own,
          spaceId: space.id,
          collections,
          components,
          labelsOf: (id) => labels.get(id) ?? [],
        });
      }
      const refLabel = refLabelOf(options);
      const items = withComputed(collection, await this.repo.listItems(collection, space.id), components, refLabel);
      const scan = scanAiValues(collection, items, refLabel);
      this.ai.offerBackground(scan.generate);
      this.ai.adopt(scan.adopt);
      this.ai.offerOverrides(scan.ask, scan.settled);
      // Let the app breathe between spaces and collections.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
}
