import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { parseTagIndex, TAG_INDEX_SETTING, tagColor, withTags, type TagColor, type TagIndex } from "../domain/tags";
import { useDataChanges } from "./useDataChanges";
import { useStore } from "./store";

/** The tags in use and their colours (TagIndexProvider). */
export interface Tags {
  /** The tag index (domain/tags.ts): its numbers give the colours. */
  index: TagIndex;
  /** The tags in items now (lower case, with `#`), the most used first: what typing `#` offers. */
  used: { tag: string; count: number }[];
}

const TagsContext = createContext<Tags>({ index: {}, used: [] });

/** The tags in use and the tag index. Outside the provider (no database): none, every tag the first colour. */
export const useTags = () => useContext(TagsContext);

/** A tag's colour (domain/tags.ts tagColor), by the tag index. */
export function useTagColor(tag: string): TagColor {
  return tagColor(useTags().index, tag);
}

/** How long after an item changes the tags are read again (typing changes an item on every few keys). */
const RESCAN_MS = 1500;

/**
 * Keeps the tag index (a synced setting, domain/tags.ts): read at start and on every settings change (a synced one
 * too); the tags in items read at start and again a moment after items change (`Repository.listTags`), the new ones
 * added to the index in the order they were first used and stored. Numbers already given never change.
 */
export function TagIndexProvider({ children }: { children: ReactNode }) {
  const { repo } = useStore();
  const [index, setIndex] = useState<TagIndex | null>(null);
  const [used, setUsed] = useState<{ tag: string; count: number }[] | null>(null);
  const [scans, setScans] = useState(0);

  useEffect(() => {
    let current = true;
    const load = () => repo.getSettings().then((s) => current && setIndex(parseTagIndex(s[TAG_INDEX_SETTING])), () => current && setIndex((i) => i ?? {}));
    load();
    const off = repo.subscribe((change) => change.scope === "settings" && load());
    return () => {
      current = false;
      off();
    };
  }, [repo]);

  useEffect(() => {
    let current = true;
    repo.listTags().then((tags) => current && setUsed(tags), () => current && setUsed((u) => u ?? []));
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

  // New tags get the next numbers (stored; the settings change then reads the index back).
  useEffect(() => {
    if (!index || !used) return;
    const next = withTags(index, used.map((t) => t.tag));
    if (next === index) return;
    setIndex(next);
    repo.setSetting(TAG_INDEX_SETTING, next).catch(() => {});
  }, [index, used, repo]);

  const value = useMemo<Tags>(() => ({ index: index ?? {}, used: [...(used ?? [])].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag)) }), [index, used]);
  return <TagsContext.Provider value={value}>{children}</TagsContext.Provider>;
}
