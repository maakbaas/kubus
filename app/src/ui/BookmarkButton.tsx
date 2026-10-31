import { useEffect } from "react";
import { IconButton } from "@carbon/react";
import { Bookmark, BookmarkFilled } from "@carbon/icons-react";
import { useStore } from "../app/store";

/**
 * Bookmark toggle for the page shown (a collection view, an item under an item view, a dashboard view): outlined = not
 * bookmarked, filled = in the side nav. While shown it also keeps the bookmark's label in step with the current name.
 */
export function BookmarkButton({
  link,
  label,
  prepare,
  onError,
}: {
  /** The page's stored link (domain/bookmarks.ts: collectionViewLink, itemLink, dashboardViewLink). */
  link: string;
  label: string;
  /** Makes the page real before it is bookmarked (a virtual view is stored); returns its link then. */
  prepare?(): Promise<string | undefined>;
  onError(e: unknown): void;
}) {
  const { repo, bookmarks, space } = useStore();
  const marked = bookmarks.some((b) => b.link === link);
  useEffect(() => {
    if (marked) repo.relabelBookmark(link, label).catch(onError);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo, marked, link, label]);
  return (
    <IconButton autoAlign
      kind="ghost"
      size="sm"
      align="bottom"
      label={marked ? "Remove bookmark" : "Bookmark"}
      aria-pressed={marked}
      onClick={() =>
        (marked
          ? repo.removeBookmark(link, space.id)
          : (prepare?.() ?? Promise.resolve(undefined)).then((stored) => repo.addBookmark(stored ?? link, label, space.id))
        ).catch(onError)
      }
    >
      {marked ? <BookmarkFilled /> : <Bookmark />}
    </IconButton>
  );
}
