import { useCallback, useRef } from "react";
import { linkTargetOf, searchLinkTargets, type LinkSearchOptions, type LinkTarget, type LinkTargetData } from "../domain/linkTargets";
import type { ItemLabel } from "../domain/model";
import type { CollectionView } from "../domain/views";
import { dashboardViewsIn, type DashboardView } from "../domain/dashboards";
import { useStore } from "./store";

/**
 * The pages a link can point at (domain/linkTargets.ts) for the shown space, found by what was typed.
 * Views and the labels of items are read when first needed and kept until `reset` (the picker closing,
 * a new search), so typing more letters filters what is held and asks the database nothing.
 */
export function useLinkTargets() {
  const { repo, space, spaceCollections, spaceDashboards } = useStore();
  const held = useRef<{ views?: Promise<CollectionView[]>; tabs?: Promise<DashboardView[]>; labels: Map<string, Promise<ItemLabel[]>> }>({ labels: new Map() });
  const reset = useCallback(() => {
    held.current = { labels: new Map() };
  }, []);
  /** What the options are made of, read once and held until `reset`. */
  const dataOf = useCallback(async (): Promise<LinkTargetData> => {
    const mine = held.current;
    // A page of the shown space only; a view of another space isn't offered.
    mine.views ??= repo.listAllViews().then((all) => all.filter((v) => v.spaceId === space.id));
    // The tabs the space's dashboards show here: its own, or copies of another space's.
    mine.tabs ??= repo.listAllDashboardViews().then((all) => spaceDashboards.flatMap((d) => dashboardViewsIn(all, d.id, space.id)));
    return {
      collections: spaceCollections,
      spaceId: space.id,
      views: await mine.views,
      dashboards: spaceDashboards,
      tabs: await mine.tabs,
      labels: (c, ids) => {
        if (ids) return repo.listLabels(c, ids);
        let labels = mine.labels.get(c.id);
        if (!labels) mine.labels.set(c.id, (labels = repo.listLabels(c)));
        return labels;
      },
    };
  }, [repo, space.id, spaceCollections, spaceDashboards]);
  const search = useCallback(
    async (query: string, opts: LinkSearchOptions): Promise<LinkTarget[]> => searchLinkTargets(query, await dataOf(), opts),
    [dataOf],
  );
  /** The page a link typed or pasted names in the shown space (by id or by name); null when none. */
  const targetOf = useCallback(async (link: string) => linkTargetOf(link, await dataOf()), [dataOf]);
  return { search, targetOf, reset };
}
