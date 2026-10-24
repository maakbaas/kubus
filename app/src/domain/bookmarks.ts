// Bookmarks: links in the side nav to a saved view of a collection's items or to an item,
// toggled with the bookmark icon on that view (tab strip) or item (page header).

export type BookmarkKind = "view" | "item";

export interface Bookmark {
  id: string;
  kind: BookmarkKind;
  collectionId: string;
  /** The view's or item's id. */
  targetId: string;
  /** Shown in the side nav; a snapshot, refreshed whenever the bookmarked page is shown. */
  label: string;
  position: number;
  createdAt: string;
}

/** Where a bookmark leads (an in-app path). */
export function bookmarkPath(b: Pick<Bookmark, "kind" | "collectionId" | "targetId">): string {
  return b.kind === "view" ? `/collections/${b.collectionId}/items?view=${b.targetId}` : `/collections/${b.collectionId}/items/${b.targetId}`;
}
