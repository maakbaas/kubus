import { useCallback, useRef } from "react";
import { searchLinkTargets, type LinkTarget, type LinkTargetData } from "../domain/linkTargets";
import type { ItemLabel } from "../domain/model";
import type { CollectionView } from "../domain/views";
import { useStore } from "./store";

/**
 * The pages a link can point at (domain/linkTargets.ts) for the shown space, found by what was typed.
 * Views and the labels of items are read when first needed and kept until `reset` (the picker closing,
 * a new search), so typing more letters filters what is held and asks the database nothing.
 */
export function useLinkTargets() {
  const { repo, space, spaceCollections } = useStore();
  const held = useRef<{ views?: Promise<CollectionView[]>; labels: Map<string, Promise<ItemLabel[]>> }>({ labels: new Map() });
  const reset = useCallback(() => {
    held.current = { labels: new Map() };
  }, []);
  const search = useCallback(
    async (query: string, opts: { items: boolean; limit?: number }): Promise<LinkTarget[]> => {
      const mine = held.current;
      // A page of the shown space only; a view of another space isn't offered.
      mine.views ??= repo.listAllViews().then((all) => all.filter((v) => v.spaceId === space.id));
      const data: LinkTargetData = {
        collections: spaceCollections,
        spaceId: space.id,
        views: await mine.views,
        labels: (c, ids) => {
          if (ids) return repo.listLabels(c, ids);
          let labels = mine.labels.get(c.id);
          if (!labels) mine.labels.set(c.id, (labels = repo.listLabels(c)));
          return labels;
        },
      };
      return searchLinkTargets(query, data, opts);
    },
    [repo, space.id, spaceCollections],
  );
  return { search, reset };
}
