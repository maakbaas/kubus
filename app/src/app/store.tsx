import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { openRepository, type Repository } from "../data";
import type { Bookmark } from "../domain/bookmarks";
import type { Component } from "../domain/components";
import type { Collection } from "../domain/model";
import { ItemCache } from "./itemCache";

interface Store {
  repo: Repository;
  /** All collections; reloaded whenever they change (the repository announces it). */
  collections: Collection[];
  /** Reloads them now: for a page that opens a just-saved collection right away. */
  reloadCollections(): Promise<void>;
  /** All components (kept up to date like the collections). */
  components: Component[];
  /** Side-nav bookmarks (kept up to date like the collections). */
  bookmarks: Bookmark[];
  /** The items (and labels) of the collections being shown, loaded once and shared (see useItems). */
  cache: ItemCache;
}

const StoreContext = createContext<Store | null>(null);

type State = { status: "loading" } | { status: "error"; error: string } | { status: "ready"; repo: Repository; cache: ItemCache };

export function StoreProvider({
  children,
  fallback,
}: {
  children: ReactNode;
  fallback: (state: { loading: boolean; error?: string }) => ReactNode;
}) {
  const [state, setState] = useState<State>({ status: "loading" });
  const [collections, setCollections] = useState<Collection[]>([]);
  const [components, setComponents] = useState<Component[]>([]);
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  // The latest collections for the item cache, which reads them outside of rendering.
  const collectionsRef = useRef<Collection[]>([]);
  const applyCollections = useCallback((list: Collection[], cache?: ItemCache) => {
    collectionsRef.current = list;
    setCollections(list);
    cache?.collectionsChanged();
  }, []);

  useEffect(() => {
    let cleanup: (() => void) | undefined;
    let stopped = false;
    openRepository()
      .then(async (repo) => {
        const [collections, components, bookmarks] = await Promise.all([repo.listCollections(), repo.listComponents(), repo.listBookmarks()]);
        if (stopped) return;
        const cache = new ItemCache(repo, (collectionId) => collectionsRef.current.find((t) => t.id === collectionId));
        applyCollections(collections);
        setComponents(components);
        setBookmarks(bookmarks);
        // Collection definitions changed anywhere: refresh them for every view (side nav, pages).
        let bookmarked = new Set(bookmarks.map((b) => b.targetId));
        const reloadBookmarks = () =>
          repo.listBookmarks().then((list) => {
            bookmarked = new Set(list.map((b) => b.targetId));
            setBookmarks(list);
          }, (e) => console.error("Reloading bookmarks failed", e));
        const unsubscribe = repo.subscribe((change) => {
          if (change.scope === "collections") repo.listCollections().then((list) => applyCollections(list, cache), (e) => console.error("Reloading collections failed", e));
          if (change.scope === "components") repo.listComponents().then(setComponents, (e) => console.error("Reloading components failed", e));
          // Bookmarks of deleted views / items disappear too. Item edits only matter
          // for a bookmarked item (it may have been deleted), not on every cell edit.
          const itemChange = change.scope === "items" && (!change.itemId || bookmarked.has(change.itemId));
          if (change.scope === "bookmarks" || change.scope === "views" || change.scope === "collections" || itemChange) reloadBookmarks();
        });
        cleanup = () => {
          unsubscribe();
          cache.dispose();
        };
        // Dev builds only: the repository on `window.kubus`, for debugging from the console.
        if (import.meta.env.DEV) (window as unknown as { kubus: unknown }).kubus = { repo, cache };
        setState({ status: "ready", repo, cache });
      })
      .catch((e) => !stopped && setState({ status: "error", error: String(e?.message ?? e) }));
    return () => {
      stopped = true;
      cleanup?.();
    };
  }, [applyCollections]);

  const ready = state.status === "ready" ? state : null;
  const repo = ready?.repo ?? null;
  const cache = ready?.cache ?? null;
  const reloadCollections = useCallback(async () => {
    if (repo) applyCollections(await repo.listCollections(), cache ?? undefined);
  }, [repo, cache, applyCollections]);
  const value = useMemo(
    () => (repo && cache ? { repo, collections, reloadCollections, components, bookmarks, cache } : null),
    [repo, cache, collections, reloadCollections, components, bookmarks],
  );
  if (!value) {
    return <>{fallback({ loading: state.status === "loading", error: state.status === "error" ? state.error : undefined })}</>;
  }
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): Store {
  const store = useContext(StoreContext);
  if (!store) throw new Error("useStore outside StoreProvider");
  return store;
}

export function useCollection(collectionId: string | undefined): Collection | undefined {
  return useStore().collections.find((t) => t.id === collectionId);
}
