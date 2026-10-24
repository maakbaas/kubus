import { useEffect } from "react";
import { IconButton } from "@carbon/react";
import { Bookmark, BookmarkFilled } from "@carbon/icons-react";
import { useStore } from "../app/store";
import type { BookmarkKind } from "../domain/bookmarks";

/**
 * Bookmark toggle for a view or an item: outlined = not bookmarked, filled = in the side nav.
 * While shown it also keeps the bookmark's label in step with the current name.
 */
export function BookmarkButton({
  kind,
  collectionId,
  targetId,
  label,
  onError,
}: {
  kind: BookmarkKind;
  collectionId: string;
  targetId: string;
  label: string;
  onError(e: unknown): void;
}) {
  const { repo, bookmarks } = useStore();
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
      onClick={() => (marked ? repo.removeBookmark(targetId) : repo.addBookmark(kind, collectionId, targetId, label)).catch(onError)}
    >
      {marked ? <BookmarkFilled /> : <Bookmark />}
    </IconButton>
  );
}
