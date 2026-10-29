import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { MAX_SOURCE_PAGE } from "../../../shared/sources";
import { useStore } from "../app/store";
import { hasRemotePart, resolveBlend, type BlendProblem } from "../domain/blend";
import { blendQueryResult, BlendCursor, nativeItems, nativeStream, remoteStream, type BlendGroup, type BlendRow, type PartStream } from "../domain/blendMerge";
import type { Collection, Item } from "../domain/model";
import { isGroupable, sortComparator, type QueryContext, type ViewQuery } from "../domain/query";
import { deviceTimeZone, isRemote } from "../domain/sources";
import { refLabelOf } from "../ui/useReferenceOptions";
import { EMPTY, LOADING_SHOWN_MS, useSettled, useThrottled, type RemoteResult } from "./useRemoteResult";

// A block of a blend: its query asked of every part (a native part answered from the items in memory, a remote one
// by its source) and the answers merged a page at a time (domain/blendMerge.ts). What it gives the block type is the
// same as useRemoteResult's, so every block type shows a blend's rows as it shows a remote collection's.

/** Rows per page ("Show more" asks for the next). */
const PAGE = 100;
/** Typing in the search box asks the remote parts again once it pauses this long. */
const SEARCH_DELAY_MS = 300;

export interface BlendResult extends RemoteResult {
  /** What is wrong with the blend (a part deleted, a mapped field removed): the block says so, the rest is shown. */
  problems: BlendProblem[];
}

const NO_REFS: QueryContext = { refLabel: refLabelOf({}, "(deleted)") };

interface Loaded {
  key: string;
  rows: BlendRow[];
  total: number;
  groups: BlendGroup[];
  more: boolean;
  error?: string;
}

/** A short fingerprint of a text (FNV-1a), to tell when what a request is made from changed. */
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16);
}

/** The items of several collections in the shared cache (the current space), each list null until loaded; a stable value while none changes. */
function useLists(ids: string[]): (Item[] | null)[] {
  const { cache } = useStore();
  const idsKey = ids.join(",");
  const subscribe = useCallback(
    (onChange: () => void) => {
      const stops = idsKey ? idsKey.split(",").map((id) => cache.items.subscribe(id, onChange)) : [];
      return () => stops.forEach((stop) => stop());
    },
    [cache, idsKey],
  );
  const last = useRef<{ snaps: unknown[]; lists: (Item[] | null)[] }>({ snaps: [], lists: [] });
  return useSyncExternalStore(subscribe, () => {
    const snaps = ids.map((id) => cache.items.snapshot(id));
    const held = last.current;
    if (held.snaps.length === snaps.length && snaps.every((s, i) => s === held.snaps[i])) return held.lists;
    last.current = { snaps, lists: snaps.map((s) => s.items) };
    return last.current.lists;
  });
}

/** The block's rows when its collection is a blend (null otherwise: the block filters its items itself). */
export function useBlendResult(collection: Collection, query: ViewQuery, search: string, enabled: boolean, all = false, page?: number): BlendResult | null {
  const { sources, collections } = useStore();
  const blendOn = enabled && !!collection.blend;
  // The blend and its parts as rows are made from them (names, fields, columns, sources): a change to another collection
  // makes every collection a new object, and that mustn't ask the parts again.
  const resolvedNow = resolveBlend(collection, collections);
  const madeFrom = collection.blend
    ? JSON.stringify([
        collection.id, collection.name, collection.titleField, collection.fields.map((f) => [f.id, f.name, f.kind]), collection.blend,
        resolvedNow.parts.map((p) => [p.collection.id, p.label, p.collection.source ?? null, [...p.fields].map(([id, f]) => [id, f.id, f.kind, f.column ?? null])]),
        resolvedNow.problems.map((p) => p.message),
      ])
    : "";
  const resolved = useMemo(() => resolvedNow, [madeFrom]); // eslint-disable-line react-hooks/exhaustive-deps
  const blend = useMemo(() => collection, [madeFrom]); // eslint-disable-line react-hooks/exhaustive-deps
  const remoteParts = resolved.parts.filter((p) => isRemote(p.collection));
  const nativeParts = resolved.parts.filter((p) => !isRemote(p.collection));
  const lists = useLists(blendOn ? nativeParts.map((p) => p.collection.id) : []);
  const nativeReady = lists.every((l) => l !== null);
  // The native lists and the memo of the blend items made from them (an item that didn't change keeps its blend item).
  const memos = useMemo(() => new Map<string, WeakMap<Item, Item>>(), [madeFrom]); // eslint-disable-line react-hooks/exhaustive-deps
  const typed = useSettled(search, remoteParts.length > 0 ? SEARCH_DELAY_MS : 0);
  const pageSize = all ? MAX_SOURCE_PAGE : Math.min(page ?? PAGE, MAX_SOURCE_PAGE);
  // Group dates by month and the like are the app's: a remote part's source groups a date by its day.
  const q = useMemo<ViewQuery>(() => (hasRemotePart(blend, collections) && query.groupDate ? { ...query, groupDate: undefined } : query), [query, blend, collections]);
  const queryKey = JSON.stringify(q);
  // The lists by what they hold: asking again only when a list's items changed.
  const listsKey = useRef(0);
  const heldLists = useRef<(Item[] | null)[]>([]);
  if (lists.length !== heldLists.current.length || lists.some((l, i) => l !== heldLists.current[i])) {
    heldLists.current = lists;
    listsKey.current++;
  }
  const key = blendOn ? `${hash(madeFrom)}:${queryKey}|${typed}|${pageSize}|${listsKey.current}|${nativeReady}` : "";
  const [refreshes, setRefreshes] = useState(0);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [stopped, setStopped] = useState("");
  const [cancelled, setCancelled] = useState("");
  const cancelledRef = useRef("");
  const [answered, setAnswered] = useState("");
  // The request now, so a late answer to an older one is dropped.
  const latest = useRef("");
  latest.current = `${key}#${refreshes}`;
  const cursor = useRef<BlendCursor | null>(null);
  // The rows shown when the cursor is made anew (a native item changed): as many are taken again.
  const shownRows = useRef(0);

  useEffect(
    () =>
      sources.onRefresh((id) => {
        if (id === null || id === collection.id || remoteParts.some((p) => p.collection.id === id)) setRefreshes((n) => n + 1);
      }),
    [sources, collection.id, remoteParts.map((p) => p.collection.id).join(",")], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // The latest inputs for the request, read when it is made (the key says when to).
  const inputs = useRef({ blend, resolved, q, typed, lists, pageSize, remoteParts, nativeParts, memos });
  inputs.current = { blend, resolved, q, typed, lists, pageSize, remoteParts, nativeParts, memos };

  useEffect(() => {
    if (!blendOn || !nativeReady) return;
    const asked = `${key}#${refreshes}`;
    const { blend, resolved, q, typed, lists, pageSize, nativeParts, memos } = inputs.current;
    const groupField = q.groupBy ? blend.fields.find((f) => f.id === q.groupBy) : undefined;
    const tz = deviceTimeZone();
    const streams: PartStream[] = resolved.parts.map((part) => {
      if (isRemote(part.collection)) return remoteStream(blend, part, q, typed, tz, (name, request) => sources.query(name, request));
      const at = nativeParts.indexOf(part);
      let memo = memos.get(part.collection.id);
      if (!memo) memos.set(part.collection.id, (memo = new WeakMap()));
      return nativeStream(blend, nativeItems(blend, part, lists[at] ?? [], memo), q, typed, NO_REFS);
    });
    const comparator = sortComparator(blend, q.sort, NO_REFS);
    const next = new BlendCursor(streams, comparator, q, groupField, pageSize);
    cursor.current = next;
    const wanted = () => latest.current === asked && cancelledRef.current !== asked;
    const want = Math.max(pageSize, Math.min(shownRows.current, 5 * MAX_SOURCE_PAGE));
    void next
      .open()
      .then(() => next.take(want))
      .then(
        (rows) => wanted() && (setAnswered(asked), setLoaded({ key, rows, total: next.total, groups: next.groups, more: !next.done })),
        (e) => wanted() && (setAnswered(asked), setLoaded({ key, rows: [], total: 0, groups: [], more: false, error: e instanceof Error ? e.message : String(e) })),
      );
    // Only what the key says: the rest is read from `inputs`.
  }, [blendOn, nativeReady, key, refreshes, sources]); // eslint-disable-line react-hooks/exhaustive-deps

  const more = useCallback(() => {
    const c = cursor.current;
    if (!loaded || !loaded.more || !c || loadingMore) return;
    const asked = latest.current;
    setLoadingMore(true);
    c.take(pageSize)
      .then(
        (rows) => latest.current === asked && setLoaded((l) => l && { ...l, rows: [...l.rows, ...rows], total: c.total, more: !c.done }),
        (e) => latest.current === asked && setLoaded((l) => l && { ...l, error: e instanceof Error ? e.message : String(e) }),
      )
      .finally(() => setLoadingMore(false));
  }, [loaded, loadingMore, pageSize]);

  const isStopped = stopped === `${key}#${refreshes}`;
  const fresh = loaded?.key === key;
  // Every row wanted: the next page is asked as soon as the last one is in.
  const loadingAll = all && fresh && !!loaded?.more && !isStopped && !loaded.error;
  useEffect(() => {
    if (loadingAll && !loadingMore) more();
  }, [loadingAll, loadingMore, more]);
  shownRows.current = loaded?.rows.length ?? 0;

  const groupField = q.groupBy ? blend.fields.find((f) => f.id === q.groupBy) : undefined;
  const grouped = !!groupField && isGroupable(groupField.kind);
  // Rows that didn't change keep their item (memoized rows rely on it): a new first page reuses the items of the one before.
  const known = useRef(new Map<string, { json: string; item: Item }>());
  const result = useMemo(() => {
    if (!loaded) return null;
    const seen = new Map<string, { json: string; item: Item }>();
    const rows = loaded.rows.map((r) => {
      const json = JSON.stringify(r.item);
      const before = seen.get(r.item.id) ?? known.current.get(r.item.id);
      const entry = before && before.json === json ? before : { json, item: r.item };
      seen.set(r.item.id, entry);
      return entry.item === r.item ? r : { ...r, item: entry.item };
    });
    known.current = seen;
    return blendQueryResult(rows, loaded.groups, loaded.total, grouped);
  }, [loaded, grouped]);
  const shown = useThrottled(result, loadingAll ? LOADING_SHOWN_MS : 0);

  if (!blendOn) return null;
  const nothing = resolved.parts.length === 0;
  return {
    result: nothing ? EMPTY : (shown?.result ?? EMPTY),
    items: nothing ? [] : (shown?.items ?? null),
    error: fresh ? loaded?.error : undefined,
    more: fresh && loaded?.more && !loadingAll ? (all ? () => setStopped("") : more) : null,
    loadingMore,
    progress: loadingAll && loaded ? { loaded: loaded.rows.length, total: loaded.total, cancel: () => setStopped(latest.current) } : null,
    // Waiting only for the remote parts: native rows come at once.
    waiting: !nothing && answered !== latest.current && cancelled !== latest.current && remoteParts.length > 0,
    stop: () => {
      setStopped(latest.current);
      if (answered !== latest.current) {
        cancelledRef.current = latest.current;
        setCancelled(latest.current);
      }
    },
    stopped: cancelled === latest.current && answered !== latest.current,
    resume: () => setRefreshes((n) => n + 1),
    problems: [...resolved.problems, ...(blend.blend?.problems ?? [])],
  };
}
