import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { tagColor, type TagColor, type TagIndex } from "../domain/tags";
import { useDataChanges } from "./useDataChanges";
import { useStore } from "./store";

/** The tags in use and their colours (TagIndexProvider). */
export interface Tags {
  /** Each tag's place in `used` (domain/tags.ts): its colour. */
  index: TagIndex;
  /** The tags in items now (lower case, with `#`), A to Z: what typing `#` offers, its colours cycling down the list. */
  used: { tag: string; count: number }[];
}

const TagsContext = createContext<Tags>({ index: {}, used: [] });

/** The tags in use and their places. Outside the provider (no database): none, every tag grey. */
export const useTags = () => useContext(TagsContext);

/** A tag's colour (domain/tags.ts tagColor), by its place among the tags in use. */
export function useTagColor(tag: string): TagColor {
  return tagColor(useTags().index, tag);
}

/** How long after an item changes the tags are read again (typing changes an item on every few keys). */
const RESCAN_MS = 1500;

/**
 * The tags in items (`Repository.listTags`), read at start and again a moment after items change, A to Z: a tag's colour
 * is its place in that list cycling through TAG_COLORS, so the list (the `#` dropdown) cycles neatly. A tag added or
 * gone before another in the alphabet moves that one's colour on: the same on every device with the same items.
 */
export function TagIndexProvider({ children }: { children: ReactNode }) {
  const { repo } = useStore();
  const [used, setUsed] = useState<{ tag: string; count: number }[]>([]);
  const [scans, setScans] = useState(0);
  useEffect(() => {
    let current = true;
    repo.listTags().then((tags) => current && setUsed(tags), () => {});
    return () => {
      current = false;
    };
  }, [repo, scans]);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useDataChanges((change) => {
    if (change.scope !== "items") return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setScans((n) => n + 1), RESCAN_MS);
  });
  useEffect(() => () => clearTimeout(timer.current), []);

  const value = useMemo<Tags>(() => {
    const sorted = [...used].sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
    return { used: sorted, index: Object.fromEntries(sorted.map((t, i) => [t.tag, i])) };
  }, [used]);
  return <TagsContext.Provider value={value}>{children}</TagsContext.Provider>;
}
