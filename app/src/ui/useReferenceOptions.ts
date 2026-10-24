import { useCallback, useMemo, useRef, useSyncExternalStore } from "react";
import { useStore } from "../app/store";
import { fieldKinds } from "../domain/fieldKinds";
import {
  itemLabel,
  isReferenceKind,
  untitledLabel,
  type FieldDef,
  type FieldValue,
  type Item,
  type ItemLabel,
  type Collection,
} from "../domain/model";
import { filterOf } from "../domain/query";
import { hasSections, withComputed } from "../domain/components";

export interface RefOption {
  id: string;
  label: string;
  /** Reference fields (ids) whose choice filter leaves this item out. */
  excludedBy?: string[];
  /** In another space than the one shown: labelled, but not offered. */
  elsewhere?: boolean;
}

/**
 * The items a reference field offers: those of the shown space its choice filter lets through,
 * plus the ones already chosen (a value that no longer matches, or was moved to another space,
 * stays, shown as usual).
 */
export const choicesFor = (field: FieldDef, options: RefOption[], chosen: string[]): RefOption[] =>
  options.filter((o) => (!o.excludedBy?.includes(field.id) && !o.elsewhere) || chosen.includes(o.id));

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

/** Selectable items per target collection id, for every reference field of `collection`. */
export type RefOptions = Record<string, RefOption[]>;

/** A referenced collection of `collection`, and the fields whose choice filters limit what can be chosen from it. */
interface Target {
  id: string;
  limited: FieldDef[];
}

function referenceTargets(collection: Collection): Target[] {
  const ids = new Set(collection.fields.filter((f) => isReferenceKind(f.kind) && f.targetCollectionId).map((f) => f.targetCollectionId!));
  return [...ids].map((id) => ({
    id,
    limited: collection.fields.filter((f) => f.targetCollectionId === id && f.choiceFilter.length > 0),
  }));
}

/** A target's options with what they were built from, to reuse them while that is unchanged. */
interface Built {
  deps: unknown[];
  options: RefOption[];
}

const sameDeps = (a: unknown[], b: unknown[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** A collection options are built from: a target's items ("o") or its labels ("l"). */
interface Need {
  kind: "o" | "l";
  id: string;
}

/**
 * The items each reference field of `collection` can point to, from the shared cache: labels alone
 * (a light query) unless the target's items are needed: for a field's choice filter, or for
 * labels with {{ }} sections, which show rendered (as on the item's own page). Options are
 * rebuilt only for a target whose data changed, so what hangs on them (computed values, rows)
 * isn't invalidated by edits elsewhere.
 */
export function useReferenceOptions(collection: Collection): RefOptions {
  const { cache, collections, components, space } = useStore();
  const targets = referenceTargets(collection);
  const cacheOf = (kind: Need["kind"]) => (kind === "o" ? cache.items : cache.labels);
  /** Whether a target's options are built from its items rather than its labels. */
  const isFull = (t: Target) => t.limited.length > 0 || !!cache.labels.snapshot(t.id).items?.some((l) => hasSections(l.label));
  // What is watched. A target's labels tell whether they hold sections (one with a choice filter
  // needs its items anyway); rendering items shows their own references by label.
  const needs: Need[] = [];
  const add = (kind: Need["kind"], id: string) => {
    if (!needs.some((n) => n.kind === kind && n.id === id)) needs.push({ kind, id });
  };
  for (const t of targets) {
    if (t.limited.length === 0) add("l", t.id);
    if (!isFull(t)) continue;
    add("o", t.id);
    const target = collections.find((x) => x.id === t.id);
    if (target) for (const n of referenceTargets(target)) add("l", n.id);
  }
  // The subscriptions follow what is needed, not the collection's identity.
  const key = needs.map((n) => `${n.kind}${n.id}`).join(",");
  const subscribe = useCallback(
    (onChange: () => void) => {
      const unsubscribers = needs.map((n) => cacheOf(n.kind).subscribe(n.id, onChange));
      return () => unsubscribers.forEach((off) => off());
    },
    [cache, key], // `needs` is described by `key`
  );
  // The sum of the collections' change counters: changes whenever one of them does.
  const version = useSyncExternalStore(subscribe, () => needs.reduce((n, x) => n + cacheOf(x.kind).snapshot(x.id).version, 0));

  const built = useRef<{ byTarget: Record<string, Built>; options: RefOptions }>({ byTarget: {}, options: {} });
  return useMemo(() => {
    const previous = built.current;
    const byTarget: Record<string, Built> = {};
    for (const t of targets) {
      const target = collections.find((x) => x.id === t.id);
      const full = isFull(t);
      const items = target ? cacheOf(full ? "o" : "l").snapshot(t.id).items : [];
      if (!items) continue; // still loading
      // The labels of what the target's items refer to (shown in their rendered labels).
      const nested = full && target ? referenceTargets(target).map((n) => cache.labels.snapshot(n.id).items) : [];
      // Labels need the collection only for the name of an unlabelled item; filters need its fields.
      const deps = full ? [items, target, components, ...t.limited.map((f) => f.choiceFilter), ...nested] : [items, target?.name, space.id];
      const old = previous.byTarget[t.id];
      if (old && sameDeps(old.deps, deps)) {
        byTarget[t.id] = old;
        continue;
      }
      let options: RefOption[] = [];
      if (target && full) {
        // Rendered labels, and for fields limiting their choices which items each filter leaves
        // out (computed values included; the target's own references read by their stored labels).
        const nestedLabels = new Map<string, Map<string, string>>();
        const refLabel = (f: FieldDef, id: string) => {
          const collectionId = f.targetCollectionId ?? "";
          let labels = nestedLabels.get(collectionId);
          if (!labels) {
            const nestedType = collections.find((x) => x.id === collectionId);
            const items = cache.labels.snapshot(collectionId).items ?? [];
            labels = new Map(items.map((l) => [l.id, l.label ?? (nestedType ? untitledLabel(nestedType) : "")]));
            nestedLabels.set(collectionId, labels);
          }
          return labels.get(id) ?? "";
        };
        const ctx = { refLabel };
        const computed = withComputed(target, items as Item[], components, ctx.refLabel);
        const passes = t.limited.map((f) => filterOf(target, f.choiceFilter, ctx));
        options = computed.map((e) => {
          const excludedBy = t.limited.filter((_, i) => !passes[i](e)).map((f) => f.id);
          return { id: e.id, label: itemLabel(target, e), ...(excludedBy.length ? { excludedBy } : {}) };
        });
      } else if (target) {
        options = (items as ItemLabel[]).map((l) => ({
          id: l.id,
          label: l.label ?? untitledLabel(target),
          ...(l.spaceId !== space.id ? { elsewhere: true } : {}),
        }));
      }
      byTarget[t.id] = { deps, options };
    }
    // Nothing rebuilt: the same options object, so nothing downstream sees a change.
    const ids = Object.keys(byTarget);
    if (ids.length === Object.keys(previous.byTarget).length && ids.every((id) => byTarget[id] === previous.byTarget[id])) return previous.options;
    const options = Object.fromEntries(ids.map((id) => [id, byTarget[id].options]));
    built.current = { byTarget, options };
    return options;
    // `version` stands for the collections' contents; `targets` is described by `key`.
  }, [cache, collections, components, space.id, key, version]);
}

/** Plain-text rendering of any field value, resolving references to item labels. */
export function formatValue(field: FieldDef, value: FieldValue | undefined, refs: RefOptions): string {
  if (!isReferenceKind(field.kind)) return fieldKinds[field.kind].format(value ?? null);
  const options = refs[field.targetCollectionId ?? ""];
  if (!options) return ""; // still loading
  const label = (id: string) => labelOf(options, id) ?? "(deleted)";
  if (typeof value === "string") return label(value);
  if (Array.isArray(value)) return value.map(label).join(", ");
  return "";
}
