// The items a reference field can point to, with their labels: one place that decides it, so that
// everything which needs the label of a referenced item (pickers, links, components, and the
// prompts of AI fields) gets the same text. The screens call it through useReferenceOptions (ui/),
// the background fill of AI fields (app/aiBackfill.ts) directly.
//
// Labels come in two forms. Plain: each item's first filled string field, as stored (a light query).
// Full: the items themselves, computed, needed when a field's choice filter must test the target's
// items. Which one a target gets depends on its fields (`isFullTarget`), never on what is on screen.

import { withComputed, type Component } from "./components";
import { isReferenceKind, itemLabel, untitledLabel, type Collection, type FieldDef, type Item, type ItemLabel } from "./model";
import { filterOf } from "./query";

export interface RefOption {
  id: string;
  label: string;
  /** Reference fields (ids) whose choice filter leaves this item out. */
  excludedBy?: string[];
  /** In another space than the one shown: labelled, but not offered. */
  elsewhere?: boolean;
}

/** Selectable items per target collection id, for every reference field of a collection. */
export type RefOptions = Record<string, RefOption[]>;

/** Labels by item id, per options list (built once; lists are replaced, never changed). */
const labelMaps = new WeakMap<RefOption[], Map<string, string>>();

/** The label of item `id` among `options` (undefined: not loaded, or deleted). */
export function labelOf(options: RefOption[] | undefined, id: string): string | undefined {
  if (!options) return undefined;
  let labels = labelMaps.get(options);
  if (!labels) {
    labels = new Map(options.map((o) => [o.id, o.label]));
    labelMaps.set(options, labels);
  }
  return labels.get(id);
}

/** Labels of referenced items for queries and components; `missing` for a deleted one. */
export const refLabelOf =
  (refs: RefOptions, missing = "") =>
  (field: FieldDef, id: string): string =>
    labelOf(refs[field.targetCollectionId ?? ""], id) ?? missing;

/** A referenced collection of `collection`, and the fields whose choice filters limit what can be chosen from it. */
export interface Target {
  id: string;
  limited: FieldDef[];
}

export function referenceTargets(collection: Collection): Target[] {
  const ids = new Set(collection.fields.filter((f) => isReferenceKind(f.kind) && f.targetCollectionId).map((f) => f.targetCollectionId!));
  return [...ids].map((id) => ({
    id,
    limited: collection.fields.filter((f) => f.targetCollectionId === id && f.choiceFilter.length > 0),
  }));
}

/** Whether a target's options are built from its items rather than its labels: for a field's choice filter. */
export const isFullTarget = (t: Target): boolean => t.limited.length > 0;

/**
 * The options of one target. `items` are its items of the shown space when `full`, else its labels
 * (of every space). `labelsOf` gives the labels of other collections: what the target's own items
 * refer to, shown in their rendered labels.
 */
export function buildTargetOptions(args: {
  target: Collection;
  limited: FieldDef[];
  full: boolean;
  items: Item[] | ItemLabel[];
  spaceId: string;
  collections: Collection[];
  components: Component[];
  labelsOf(collectionId: string): ItemLabel[];
}): RefOption[] {
  const { target, limited, full, items, spaceId, collections, components, labelsOf } = args;
  if (!full) {
    return (items as ItemLabel[]).map((l) => ({
      id: l.id,
      label: l.label ?? untitledLabel(target),
      ...(l.spaceId !== spaceId ? { elsewhere: true } : {}),
    }));
  }
  // For fields limiting their choices: which items each filter leaves out (computed values
  // included; the target's own references read by their stored labels).
  const nestedLabels = new Map<string, Map<string, string>>();
  const refLabel = (f: FieldDef, id: string) => {
    const collectionId = f.targetCollectionId ?? "";
    let labels = nestedLabels.get(collectionId);
    if (!labels) {
      const nestedType = collections.find((x) => x.id === collectionId);
      labels = new Map(labelsOf(collectionId).map((l) => [l.id, l.label ?? (nestedType ? untitledLabel(nestedType) : "")]));
      nestedLabels.set(collectionId, labels);
    }
    return labels.get(id) ?? "";
  };
  const ctx = { refLabel };
  const computed = withComputed(target, items as Item[], components, ctx.refLabel);
  const passes = limited.map((f) => filterOf(target, f.choiceFilter, ctx));
  return computed.map((e) => {
    const excludedBy = limited.filter((_, i) => !passes[i](e)).map((f) => f.id);
    return { id: e.id, label: itemLabel(target, e), ...(excludedBy.length ? { excludedBy } : {}) };
  });
}

/** What `refLabelForSpace` reads: the repository's item and label lists. */
export interface RefSource {
  listLabels(collection: Collection): Promise<ItemLabel[]>;
  listItems(collection: Collection, spaceId: string): Promise<Item[]>;
}

/**
 * The labels of the items `collection`'s reference fields point to, as the screens show them in
 * `spaceId`: what works out values without the UI (the background fill of AI fields, the API's
 * computed values) uses this, so it reaches the same text. `labels` caches each collection's
 * labels between calls (they don't depend on the space).
 */
export async function refLabelForSpace(
  source: RefSource,
  collection: Collection,
  spaceId: string,
  world: { collections: Collection[]; components: Component[] },
  labels = new Map<string, ItemLabel[]>(),
): Promise<(field: FieldDef, id: string) => string> {
  const { collections, components } = world;
  const targets = referenceTargets(collection).flatMap((t) => {
    const target = collections.find((c) => c.id === t.id);
    return target ? [{ ...t, target }] : [];
  });
  const labelsOf = async (c: Collection) => {
    let list = labels.get(c.id);
    if (!list) labels.set(c.id, (list = await source.listLabels(c)));
    return list;
  };
  const options: RefOptions = {};
  for (const t of targets) {
    const own = await labelsOf(t.target);
    const full = isFullTarget(t);
    if (full) for (const n of referenceTargets(t.target)) await labelsOf(collections.find((c) => c.id === n.id) ?? t.target);
    options[t.id] = buildTargetOptions({
      target: t.target,
      limited: t.limited,
      full,
      items: full ? await source.listItems(t.target, spaceId) : own,
      spaceId,
      collections,
      components,
      labelsOf: (id) => labels.get(id) ?? [],
    });
  }
  return refLabelOf(options);
}
