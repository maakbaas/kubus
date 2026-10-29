import { useEffect } from "react";
import { IconButton } from "@carbon/react";
import { Bookmark, BookmarkFilled } from "@carbon/icons-react";
import { useStore } from "../app/store";
import type { BookmarkKind } from "../domain/bookmarks";

/**
 * Bookmark toggle for a view, an item or a dashboard's tab: outlined = not bookmarked, filled = in the side nav.
 * While shown it also keeps the bookmark's label in step with the current name.
 */
export function BookmarkButton({
  kind,
  ownerId,
  targetId,
  label,
  prepare,
  onError,
}: {
  kind: BookmarkKind;
  /** The view's or item's collection, or the tab's dashboard. */
  ownerId: string;
  targetId: string;
  label: string;
  /** Makes the target real before it is bookmarked (a virtual view or tab is stored); returns its id. */
  prepare?(): Promise<string | undefined>;
  onError(e: unknown): void;
}) {
  const { repo, bookmarks, space } = useStore();
  const marked = bookmarks.some((b) => b.targetId === targetId);
  useEffect(() => {
    if (marked) repo.relabelBookmark(targetId, label).catch(onError);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo, marked, targetId, label]);
  return (
    <IconButton autoAlign
      kind="ghost"
      size="sm"
      align="bottom"
      label={marked ? "Remove bookmark" : "Bookmark"}
      aria-pressed={marked}
      onClick={() =>
        (marked
          ? repo.removeBookmark(targetId, space.id)
          : (prepare?.() ?? Promise.resolve(undefined)).then((id) => repo.addBookmark(kind, ownerId, id ?? targetId, label, space.id))
        ).catch(onError)
      }
    >
      {marked ? <BookmarkFilled /> : <Bookmark />}
    </IconButton>
  );
}
