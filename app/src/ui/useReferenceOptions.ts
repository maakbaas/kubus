import { useCallback, useMemo, useRef, useSyncExternalStore } from "react";
import { useStore } from "../app/store";
import { fieldKinds } from "../domain/fieldKinds";
import { isReferenceKind, type FieldDef, type FieldValue, type Collection } from "../domain/model";
import { buildTargetOptions, isFullTarget, labelOf, referenceTargets, type RefOption, type RefOptions, type Target } from "../domain/refOptions";

// Where these were first; the domain module owns them now.
export { labelOf, refLabelOf } from "../domain/refOptions";
export type { RefOption, RefOptions } from "../domain/refOptions";

/**
 * The items a reference field offers: those of the shown space its choice filter lets through,
 * plus the ones already chosen (a value that no longer matches, or was moved to another space,
 * stays, shown as usual).
 */
export const choicesFor = (field: FieldDef, options: RefOption[], chosen: string[]): RefOption[] =>
  options.filter((o) => (!o.excludedBy?.includes(field.id) && !o.elsewhere) || chosen.includes(o.id));

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
  const isFull = (t: Target) => isFullTarget(t, cache.labels.snapshot(t.id).items);
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
      const options: RefOption[] = target
        ? buildTargetOptions({ target, limited: t.limited, full, items, spaceId: space.id, collections, components, labelsOf: (id) => cache.labels.snapshot(id).items ?? [] })
        : [];
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
