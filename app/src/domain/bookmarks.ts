// Bookmarks: links in the side nav to a saved view of a collection's items, to an item or to a
// dashboard's tab, toggled with the bookmark icon on that view or tab (tab strip) or item (page header).

export type BookmarkKind = "view" | "item" | "dashboard";

export interface Bookmark {
  id: string;
  kind: BookmarkKind;
  /** The view's or item's collection; null for a dashboard's tab. */
  collectionId: string | null;
  /** A dashboard tab's dashboard (only for those). */
  dashboardId?: string;
  /** The view's, item's or dashboard tab's id. */
  targetId: string;
  /** Shown in the side nav; a snapshot, refreshed whenever the bookmarked page is shown. */
  label: string;
  position: number;
  createdAt: string;
}

/** Where a bookmark leads (an in-app path). */
export function bookmarkPath(b: Pick<Bookmark, "kind" | "collectionId" | "dashboardId" | "targetId">): string {
  if (b.kind === "dashboard") return `/dashboards/${b.dashboardId}?view=${b.targetId}`;
  return b.kind === "view" ? `/collections/${b.collectionId}/items?view=${b.targetId}` : `/collections/${b.collectionId}/items/${b.targetId}`;
}
