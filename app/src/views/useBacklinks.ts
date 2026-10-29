import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../app/store";
import { useDataChanges } from "../app/useDataChanges";
import { backlinkItems } from "../domain/backlinks";
import type { Item } from "../domain/model";
import type { QueryContext } from "../domain/query";
import { errorMessage } from "../ui/useConfirm";
import { refLabelOf } from "../ui/useReferenceOptions";
import type { CollectionData } from "./useCollectionData";
import type { PageItem } from "./registry";

const NO_REFS = {};

/**
 * The Backlinks collection's data for an item page's block: the items linking to the page's item (one row per link,
 * read from item_links), with their labels, current from the change feed (any item changing may add or drop a link).
 * Rows that didn't change keep their identity, as items do in the shared cache.
 */
export function useBacklinkData(page: PageItem): CollectionData {
  const { repo, collections, space } = useStore();
  const [items, setItems] = useState<Item[] | null>(null);
  const [error, setError] = useState<string>();
  const known = useRef(new Map<string, { json: string; item: Item }>());
  const reads = useRef(0);
  const pageCollection = page.collection.id;
  const pageItem = page.item.id;
  const collectionsRef = useRef(collections);
  collectionsRef.current = collections;

  const load = useCallback(() => {
    const n = ++reads.current;
    void (async () => {
      const links = await repo.listBacklinks(pageCollection, pageItem, space.id);
      // The linking items' labels, a collection at a time.
      const labels = new Map<string, string | null>();
      for (const c of collectionsRef.current) {
        const ids = links.filter((l) => l.sourceCollectionId === c.id).map((l) => l.sourceItemId);
        if (ids.length > 0) for (const l of await repo.listLabels(c, [...new Set(ids)])) labels.set(l.id, l.label);
      }
      return backlinkItems(links, collectionsRef.current, labels);
    })().then(
      (made) => {
        if (reads.current !== n) return;
        const next = new Map<string, { json: string; item: Item }>();
        const shown = made.map((item) => {
          const json = JSON.stringify(item);
          const before = known.current.get(item.id);
          const entry = before && before.json === json ? before : { json, item };
          next.set(item.id, entry);
          return entry.item;
        });
        known.current = next;
        setError(undefined);
        setItems(shown);
      },
      (e) => reads.current === n && setError(errorMessage(e)),
    );
  }, [repo, pageCollection, pageItem, space.id]);

  // Also when the collections change: their names and fields are in the rows.
  useEffect(load, [load, collections]);
  useDataChanges((change) => {
    if (change.scope === "items" || change.scope === "collections") load();
  });

  const ctx: QueryContext = useMemo(() => ({ refLabel: refLabelOf(NO_REFS, "(deleted)") }), []);
  return { items, stored: items, refs: NO_REFS, ctx, error };
}
