import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SourceResult, SourceRow } from "../../../shared/sources";
import { useStore } from "../app/store";
import { withComputed } from "../domain/components";
import type { Collection, Item } from "../domain/model";
import type { ItemGroup, QueryResult, ViewQuery } from "../domain/query";
import { deviceTimeZone, groupLabel, rowItem, sourceQuery, sourceShape } from "../domain/sources";

// A block of a remote collection: its query asked of the source (filter, sort, grouping and search
// worked out there, shared/sources.ts), a page at a time. What it gives the block type is the same
// QueryResult as applyQuery's, so tables, cards and components show remote rows as they show items.

/** Rows per page ("Show more" asks for the next). */
const PAGE = 100;
/** Typing in the search box asks again once it pauses this long. */
const SEARCH_DELAY_MS = 300;

export interface RemoteResult {
  result: QueryResult;
  /** The rows loaded so far, as items (a component's $all); null until the first page is in. */
  items: Item[] | null;
  error?: string;
  /** Loads the next page; null when every row is in. */
  more: (() => void) | null;
  loadingMore: boolean;
}

const EMPTY: QueryResult = { groups: [], total: 0 };
const noLabel = () => "";

interface Loaded {
  /** The request these rows answer. */
  key: string;
  rows: SourceRow[];
  total: number;
  groups: SourceResult["groups"];
  more: boolean;
  error?: string;
}

/** The value after it stopped changing for `ms`. */
function useSettled<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    if (Object.is(value, settled)) return;
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, settled, ms]);
  return settled;
}

/** The block's rows when its collection is remote (null otherwise: the block filters its items itself). */
export function useRemoteResult(collection: Collection, query: ViewQuery, search: string, enabled: boolean): RemoteResult | null {
  const { sources, components } = useStore();
  const remote = enabled && !!collection.source;
  const typed = useSettled(search, SEARCH_DELAY_MS);
  const request = useMemo(() => (remote ? sourceQuery(collection, query, typed, deviceTimeZone()) : undefined), [remote, collection, query, typed]);
  const key = request === undefined ? "" : JSON.stringify(request);
  // The request by its key: a block renders it anew each time (its filters are new arrays), and
  // asking again on that would put the first page back over pages "Show more" added.
  const requestRef = useRef(request);
  requestRef.current = request;
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshes, setRefreshes] = useState(0);
  // The request now, so a late answer to an older one is dropped.
  const current = useRef("");
  current.current = `${key}#${refreshes}`;

  useEffect(() => sources.onRefresh((id) => (id === null || id === collection.id) && setRefreshes((n) => n + 1)), [sources, collection.id]);

  useEffect(() => {
    if (!remote || !collection.source) return;
    const asked = `${key}#${refreshes}`;
    const request = requestRef.current;
    if (!request) return;
    sources.query(collection.source.name, { ...request, offset: 0, limit: PAGE, counts: true }).then(
      // A total under the rows in (a source that couldn't count them all) counts at least those.
      (r) => current.current === asked && setLoaded({ key, rows: r.rows, total: Math.max(r.total ?? 0, r.rows.length), groups: r.groups, more: r.more }),
      (e) => current.current === asked && setLoaded({ key, rows: [], total: 0, groups: [], more: false, error: e instanceof Error ? e.message : String(e) }),
    );
  }, [remote, collection.source, key, refreshes, sources]);

  const more = useCallback(() => {
    if (!loaded || !loaded.more || !request || !collection.source || loadingMore) return;
    const asked = current.current;
    setLoadingMore(true);
    sources
      .query(collection.source.name, { ...request, offset: loaded.rows.length, limit: PAGE, counts: false })
      .then(
        (r) =>
          current.current === asked &&
          setLoaded((l) => l && { ...l, rows: [...l.rows, ...r.rows], total: Math.max(l.total, l.rows.length + r.rows.length), more: r.more }),
        (e) => current.current === asked && setLoaded((l) => l && { ...l, error: e instanceof Error ? e.message : String(e) }),
      )
      .finally(() => setLoadingMore(false));
  }, [loaded, request, collection.source, loadingMore, sources]);

  // Rows that didn't change keep their item (memoized rows and computed values rely on it).
  const known = useRef(new Map<string, { values: string; item: Item }>());
  const memo = useMemo(() => new WeakMap<Item, Item>(), [collection, components]); // eslint-disable-line react-hooks/exhaustive-deps
  const shape = useMemo(() => (collection.source ? sourceShape(collection) : null), [collection]);
  const fresh = loaded?.key === key;
  const result = useMemo(() => {
    // While a changed query is asked, the rows of the one before stay (nothing flashes away).
    if (!remote || !shape || !loaded) return null;
    const seen = new Map<string, { values: string; item: Item }>();
    const items = loaded.rows.map((row) => {
      const values = JSON.stringify(row.values);
      const before = known.current.get(row.key) ?? seen.get(row.key);
      const entry = before && before.values === values ? before : { values, item: rowItem(collection, shape, row) };
      seen.set(row.key, entry);
      return entry.item;
    });
    known.current = seen;
    sources.remember(items);
    const computed = withComputed(collection, items, components, noLabel, memo);
    const groupField = query.groupBy ? collection.fields.find((f) => f.id === query.groupBy) : undefined;
    let groups: ItemGroup[];
    if (request?.groupBy && loaded.groups) {
      const byKey = new Map<string, Item[]>();
      loaded.rows.forEach((row, i) => {
        const k = row.group ?? "";
        byKey.set(k, [...(byKey.get(k) ?? []), computed[i]]);
      });
      // In the source's order; a group shows once rows of it are in.
      groups = loaded.groups.filter((g) => byKey.has(g.key)).map((g) => ({ key: g.key, label: groupLabel(groupField, g.key), items: byKey.get(g.key)! }));
    } else {
      groups = [{ key: "", label: "", items: computed }];
    }
    const all = [...new Set(computed)];
    return { result: { groups, total: loaded.total } satisfies QueryResult, items: all };
  }, [remote, shape, loaded, collection, components, memo, query.groupBy, request?.groupBy, sources]);

  if (!remote) return null;
  return {
    result: result?.result ?? EMPTY,
    items: result?.items ?? null,
    error: fresh ? loaded?.error : undefined,
    more: fresh && loaded?.more ? more : null,
    loadingMore,
  };
}
