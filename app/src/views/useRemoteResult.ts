import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MAX_SOURCE_PAGE, type SourceResult, type SourceRow } from "../../../shared/sources";
import { useStore } from "../app/store";
import { withComputed } from "../domain/components";
import type { Collection, Item } from "../domain/model";
import type { ItemGroup, QueryResult, ViewQuery } from "../domain/query";
import { addRows, deviceTimeZone, groupLabel, rowItem, sourceQuery, sourceShape, type BuiltRows } from "../domain/sources";

// A block of a remote collection: its query asked of the source (filter, sort, grouping and search
// worked out there, shared/sources.ts), a page at a time. What it gives the block type is the same
// QueryResult as applyQuery's, so tables, cards and components show remote rows as they show items.
// A block that needs every row (a chart) loads the pages one after the other until they are in; that can be stopped.

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
  /** Loading every row (`all`): the rows in, of the source's total, and a way to stop; null when done or stopped. */
  progress: { loaded: number; total: number; cancel: () => void } | null;
  /** The first page of the request now (a new query, "Read again") is still on its way. */
  waiting: boolean;
}

const EMPTY: QueryResult = { groups: [], total: 0 };
const noLabel = () => "";

interface Loaded {
  /** The request these rows answer. */
  key: string;
  /** Which first page these rows start with: pages added after it keep it (their rows are only added). */
  batch: number;
  rows: SourceRow[];
  total: number;
  groups: SourceResult["groups"];
  more: boolean;
  error?: string;
}

/** While rows come in, a block is shown them at most this often (its chart or map drawn anew each time). */
const LOADING_SHOWN_MS = 1000;

/** `value`, but while `ms` is more than 0 at most once per `ms` (then the latest); at once when it is 0. */
function useThrottled<T>(value: T, ms: number): T {
  const [shown, setShown] = useState(value);
  const last = useRef(0);
  useEffect(() => {
    if (ms === 0 || Object.is(value, shown)) return;
    const show = () => {
      last.current = Date.now();
      setShown(value);
    };
    const wait = ms - (Date.now() - last.current);
    if (wait <= 0) return show();
    const timer = setTimeout(show, wait);
    return () => clearTimeout(timer);
  }, [value, ms, shown]);
  return ms === 0 ? value : shown;
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
export function useRemoteResult(
  collection: Collection,
  query: ViewQuery,
  search: string,
  enabled: boolean,
  all = false,
  /** Rows per page (a block's Limit); else PAGE. */
  page?: number,
): RemoteResult | null {
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
  // The request whose remaining pages the person stopped loading.
  const [stopped, setStopped] = useState("");
  const pageSize = all ? MAX_SOURCE_PAGE : Math.min(page ?? PAGE, MAX_SOURCE_PAGE);
  // The request now, so a late answer to an older one is dropped.
  const current = useRef("");
  const batches = useRef(0);
  // The request whose first page is in (or failed).
  const [answered, setAnswered] = useState("");
  current.current = `${key}#${refreshes}`;

  useEffect(() => sources.onRefresh((id) => (id === null || id === collection.id) && setRefreshes((n) => n + 1)), [sources, collection.id]);

  useEffect(() => {
    if (!remote || !collection.source) return;
    const asked = `${key}#${refreshes}`;
    const request = requestRef.current;
    if (!request) return;
    const got = (l: Omit<Loaded, "key" | "batch">) => {
      if (current.current !== asked) return;
      setAnswered(asked);
      setLoaded({ key, batch: ++batches.current, ...l });
    };
    sources.query(collection.source.name, { ...request, offset: 0, limit: pageSize, counts: true }).then(
      // A total under the rows in (a source that couldn't count them all) counts at least those.
      (r) => got({ rows: r.rows, total: Math.max(r.total ?? 0, r.rows.length), groups: r.groups, more: r.more }),
      (e) => got({ rows: [], total: 0, groups: [], more: false, error: e instanceof Error ? e.message : String(e) }),
    );
    // The source by its name: the rest of the request is in `key` (the collection is a new object whenever any collection changes).
  }, [remote, collection.source?.name, key, refreshes, sources, pageSize]); // eslint-disable-line react-hooks/exhaustive-deps

  const more = useCallback(() => {
    if (!loaded || !loaded.more || !request || !collection.source || loadingMore) return;
    const asked = current.current;
    setLoadingMore(true);
    sources
      .query(collection.source.name, { ...request, offset: loaded.rows.length, limit: pageSize, counts: false })
      .then(
        (r) =>
          current.current === asked &&
          setLoaded((l) => l && { ...l, rows: [...l.rows, ...r.rows], total: Math.max(l.total, l.rows.length + r.rows.length), more: r.more }),
        (e) => current.current === asked && setLoaded((l) => l && { ...l, error: e instanceof Error ? e.message : String(e) }),
      )
      .finally(() => setLoadingMore(false));
  }, [loaded, request, collection.source, loadingMore, sources, pageSize]);

  const isStopped = stopped === `${key}#${refreshes}`;
  const fresh = loaded?.key === key;
  // Every row wanted: the next page is asked as soon as the last one is in.
  const loadingAll = all && fresh && !!loaded?.more && !isStopped && !loaded.error;
  useEffect(() => {
    if (loadingAll && !loadingMore) more();
  }, [loadingAll, loadingMore, more]);

  // Rows are made into items as they come in: a page added ("Show more", or loading every row) adds only its
  // own, so many pages cost as much as their rows, not their square. A new first page (another query, "Read
  // again") builds them anew, rows that didn't change keeping their item (memoized rows and computed values rely on it).
  // The collection as rows are made from it (its name, title, source and fields): a change to another
  // collection makes every collection a new object, and that mustn't make every row (and its computed values) anew.
  const madeFrom = collection.source ? JSON.stringify([collection.id, collection.name, collection.titleField, collection.source, collection.fields]) : "";
  const rowsFrom = useMemo(() => collection, [madeFrom]); // eslint-disable-line react-hooks/exhaustive-deps
  const built = useRef<BuiltRows | null>(null);
  const memo = useMemo(() => new WeakMap<Item, Item>(), [rowsFrom, components]); // eslint-disable-line react-hooks/exhaustive-deps
  const shape = useMemo(() => (rowsFrom.source ? sourceShape(rowsFrom) : null), [rowsFrom]);
  const grouped = !!request?.groupBy && !!loaded?.groups;
  const made = useMemo(() => {
    // While a changed query is asked, the rows of the one before stay (nothing flashes away).
    if (!remote || !shape || !loaded) return null;
    built.current = addRows(built.current, [loaded.batch, rowsFrom, components, memo, shape, grouped], loaded.rows, grouped, (row) => rowItem(rowsFrom, shape, row), (items) => {
      sources.remember(items);
      return withComputed(rowsFrom, items, components, noLabel, memo);
    });
    return built.current;
  }, [remote, shape, loaded, rowsFrom, components, memo, grouped, sources]);
  const result = useMemo(() => {
    if (!made || !loaded || !shape) return null;
    const b = made;
    const groupField = query.groupBy ? collection.fields.find((f) => f.id === query.groupBy) : undefined;
    // Copies: what the block got before stays as it was.
    const groups: ItemGroup[] = grouped
      ? // In the source's order; a group shows once rows of it are in.
        loaded.groups!.filter((g) => b.byGroup.has(g.key)).map((g) => ({ key: g.key, label: groupLabel(groupField, g.key), items: b.byGroup.get(g.key)!.slice() }))
      : [{ key: "", label: "", items: b.computed.slice() }];
    const all = b.all.slice();
    return { result: { groups, total: loaded.total } satisfies QueryResult, items: all };
  }, [made, loaded, shape, collection, query.groupBy, grouped]);

  // While every row is loading, the block (a chart, a map: drawn anew each time) gets them at most once a second.
  const shown = useThrottled(result, loadingAll ? LOADING_SHOWN_MS : 0);

  if (!remote) return null;
  return {
    result: shown?.result ?? EMPTY,
    items: shown?.items ?? null,
    error: fresh ? loaded?.error : undefined,
    more: fresh && loaded?.more && !loadingAll ? (all ? () => setStopped("") : more) : null,
    loadingMore,
    progress: loadingAll && loaded ? { loaded: loaded.rows.length, total: loaded.total, cancel: () => setStopped(current.current) } : null,
    waiting: answered !== current.current,
  };
}
