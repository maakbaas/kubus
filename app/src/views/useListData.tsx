import { useMemo, type ReactNode } from "react";
import { useStore } from "../app/store";
import { useItems } from "../app/useItems";
import { entryItems, type EntryMemo } from "../domain/listEntries";
import type { Collection, Item } from "../domain/model";
import type { QueryContext } from "../domain/query";
import { refLabelOf, useReferenceOptions } from "../ui/useReferenceOptions";
import { useCollectionData, type CollectionData } from "./useCollectionData";

// A block of a list field's entries (domain/listEntries.ts): its rows made from the items in the shared cache (a list of
// items: with its items' values as shown, component fields computed), current with them. Rows that didn't change keep
// their identity.

const NO_TARGETS = null;

/** The rows from the items of the list's collection (and a list of items' entries), the references' labels loaded. */
function useEntries(list: Collection, owner: Collection, targets: Item[] | null, targetsError?: string): CollectionData {
  const { items, error } = useItems(owner);
  const refs = useReferenceOptions(list);
  const refsLoading = list.fields.some((f) => f.targetCollectionId && !refs[f.targetCollectionId]);
  const ctx: QueryContext = useMemo(() => ({ refLabel: refLabelOf(refs, "(deleted)") }), [refs]);
  const memo = useMemo<EntryMemo>(() => new WeakMap(), [list]);
  const byId = useMemo(() => (targets ? new Map(targets.map((t) => [t.id, t])) : null), [targets]);
  const waiting = !items || refsLoading || (list.listOf?.kind === "item_list" && !byId);
  const rows = useMemo(() => (waiting ? null : entryItems(list, items!, byId, memo)), [waiting, list, items, byId, memo]);
  return { items: rows, stored: rows, refs, ctx, error: error ?? targetsError };
}

function Entries({ list, owner, children }: { list: Collection; owner: Collection; children(data: CollectionData): ReactNode }) {
  return <>{children(useEntries(list, owner, NO_TARGETS))}</>;
}

function LinkedEntries({ list, owner, target, children }: { list: Collection; owner: Collection; target: Collection; children(data: CollectionData): ReactNode }) {
  // The entries' items as every block shows them (component fields computed).
  const targetData = useCollectionData(target);
  return <>{children(useEntries(list, owner, targetData.items, targetData.error))}</>;
}

/** Gives a list field's entries (a block of `list`) to `children`; nothing while the field's collection is gone. */
export function ListData({ list, children }: { list: Collection; children(data: CollectionData): ReactNode }) {
  const { collections } = useStore();
  const source = list.listOf;
  const owner = collections.find((c) => c.id === source?.collectionId);
  const target = source?.targetCollectionId ? collections.find((c) => c.id === source.targetCollectionId) : undefined;
  if (!owner) return null;
  // Keyed by what the rows are made from: the hooks are not the same for a list of items.
  return target ? (
    <LinkedEntries key={`${owner.id}>${target.id}`} list={list} owner={owner} target={target}>
      {children}
    </LinkedEntries>
  ) : (
    <Entries key={owner.id} list={list} owner={owner}>
      {children}
    </Entries>
  );
}
