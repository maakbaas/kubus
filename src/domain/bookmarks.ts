// Bookmarks: links in the side nav to a saved view of a type's objects or to an object,
// toggled with the bookmark icon on that view (tab strip) or object (page header).

export type BookmarkKind = "view" | "object";

export interface Bookmark {
  id: string;
  kind: BookmarkKind;
  typeId: string;
  /** The view's or object's id. */
  targetId: string;
  /** Shown in the side nav; a snapshot, refreshed whenever the bookmarked page is shown. */
  label: string;
  position: number;
  createdAt: string;
}

/** Where a bookmark leads (an in-app path). */
export function bookmarkPath(b: Pick<Bookmark, "kind" | "typeId" | "targetId">): string {
  return b.kind === "view" ? `/types/${b.typeId}/objects?view=${b.targetId}` : `/types/${b.typeId}/objects/${b.targetId}`;
}
