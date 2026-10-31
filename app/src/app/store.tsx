import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { openRepository, type Repository } from "../data";
import type { Bookmark } from "../domain/bookmarks";
import type { Component } from "../domain/components";
import type { Dashboard } from "../domain/dashboards";
import type { Collection } from "../domain/model";
import { DEFAULT_SPACE_ID, inSpace, withDefaultSpace, type Space } from "../domain/spaces";
import { readPref, writePref } from "../ui/localPrefs";
import { AiService } from "./ai";
import { ItemCache } from "./itemCache";
import { SourcesClient } from "../data/remote/client";

interface Store {
  repo: Repository;
  /** All spaces (the default one included); reloaded whenever they change. */
  spaces: Space[];
  /** The space shown: its items, bookmarks and tabs (remembered per device). */
  space: Space;
  setSpace(spaceId: string): void;
  /** All collections, of every space; reloaded whenever they change (the repository announces it). */
  collections: Collection[];
  /** The collections shown in the current space (side nav, pickers of collections). */
  spaceCollections: Collection[];
  /** Reloads them now: for a page that opens a just-saved collection right away. */
  reloadCollections(): Promise<void>;
  /** All components (kept up to date like the collections). */
  components: Component[];
  /** All dashboards, of every space (kept up to date like the collections). */
  dashboards: Dashboard[];
  /** The dashboards shown in the current space (side nav, Dashboards page, search). */
  spaceDashboards: Dashboard[];
  /** Reloads them now: for a page that opens a just-made dashboard right away. */
  reloadDashboards(): Promise<void>;
  /** The current space's side-nav bookmarks (kept up to date like the collections). */
  bookmarks: Bookmark[];
  /** The items (and labels) of the collections being shown, loaded once and shared (see useItems). */
  cache: ItemCache;
  /** Generates the values of AI fields (and holds the language model settings of this device). */
  ai: AiService;
  /** The server's remote sources, which remote collections read their rows from. */
  sources: SourcesClient;
}

const StoreContext = createContext<Store | null>(null);
/**
 * The components alone, for what renders in every cell of a table (views/cells.tsx): the store
 * changes with anything in it (a bookmark, a space), and every cell would render again.
 */
const ComponentsContext = createContext<Component[]>([]);

type State = { status: "loading" } | { status: "error"; error: string } | { status: "ready"; repo: Repository; cache: ItemCache; ai: AiService; sources: SourcesClient };

const SPACE_KEY = "kubus.space";

export function StoreProvider({
  children,
  fallback,
}: {
  children: ReactNode;
  fallback: (state: { loading: boolean; error?: string }) => ReactNode;
}) {
  const [state, setState] = useState<State>({ status: "loading" });
  const [spaces, setSpaces] = useState<Space[]>(() => withDefaultSpace([]));
  const [spaceId, setSpaceId] = useState(() => readPref<string>(SPACE_KEY, DEFAULT_SPACE_ID));
  const [collections, setCollections] = useState<Collection[]>([]);
  const [components, setComponents] = useState<Component[]>([]);
  const [dashboards, setDashboards] = useState<Dashboard[]>([]);
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  // A remembered space that is gone (deleted, here or elsewhere) falls back to the first.
  const space = spaces.find((s) => s.id === spaceId) ?? spaces[0];
  // The latest collections and space for the item cache, which reads them outside of rendering.
  const collectionsRef = useRef<Collection[]>([]);
  const spaceRef = useRef(space.id);
  spaceRef.current = space.id;
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
        const [spaces, collections, components, dashboards] = await Promise.all([repo.listSpaces(), repo.listCollections(), repo.listComponents(), repo.listDashboards()]);
        if (stopped) return;
        const cache = new ItemCache(repo, (collectionId) => collectionsRef.current.find((t) => t.id === collectionId), () => spaceRef.current);
        setSpaces(spaces);
        applyCollections(collections);
        setComponents(components);
        setDashboards(dashboards);
        const unsubscribe = repo.subscribe((change) => {
          if (change.scope === "spaces") repo.listSpaces().then(setSpaces, (e) => console.error("Reloading spaces failed", e));
          // Collection definitions changed anywhere: refresh them for every view (side nav, pages).
          if (change.scope === "collections") repo.listCollections().then((list) => applyCollections(list, cache), (e) => console.error("Reloading collections failed", e));
          if (change.scope === "components") repo.listComponents().then(setComponents, (e) => console.error("Reloading components failed", e));
          if (change.scope === "dashboards") repo.listDashboards().then(setDashboards, (e) => console.error("Reloading dashboards failed", e));
        });
        cleanup = () => {
          unsubscribe();
          cache.dispose();
        };
        // Dev builds only: the repository on `window.kubus`, for debugging from the console.
        if (import.meta.env.DEV) (window as unknown as { kubus: unknown }).kubus = { repo, cache };
        setState({ status: "ready", repo, cache, ai: new AiService(repo), sources: new SourcesClient(() => repo.sync.config) });
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
  const ai = ready?.ai ?? null;
  const sources = ready?.sources ?? null;

  // Another space: the cache holds the new one's items; its bookmarks replace the old ones.
  const shownSpace = useRef(space.id);
  useEffect(() => {
    if (shownSpace.current === space.id) return;
    shownSpace.current = space.id;
    cache?.spaceChanged();
  }, [cache, space.id]);
  useEffect(() => {
    if (!repo) return;
    let stale = false;
    const reload = () =>
      repo.listBookmarks(space.id).then((list) => {
        if (!stale) setBookmarks(list);
      }, (e) => console.error("Reloading bookmarks failed", e));
    void reload();
    // Deleting what a bookmark links to deletes the bookmark in the same write, which says so (scope "bookmarks").
    const unsubscribe = repo.subscribe((change) => {
      if (change.scope === "bookmarks") void reload();
    });
    return () => {
      stale = true;
      unsubscribe();
    };
  }, [repo, space.id]);

  const setSpace = useCallback((id: string) => {
    writePref(SPACE_KEY, id);
    setSpaceId(id);
  }, []);
  const spaceCollections = useMemo(() => collections.filter((c) => inSpace(c, space.id)), [collections, space.id]);
  const spaceDashboards = useMemo(() => dashboards.filter((d) => inSpace(d, space.id)), [dashboards, space.id]);
  const reloadDashboards = useCallback(async () => {
    if (repo) setDashboards(await repo.listDashboards());
  }, [repo]);
  const reloadCollections = useCallback(async () => {
    if (repo) applyCollections(await repo.listCollections(), cache ?? undefined);
  }, [repo, cache, applyCollections]);
  const value = useMemo(
    () =>
      repo && cache && ai && sources
        ? { repo, spaces, space, setSpace, collections, spaceCollections, reloadCollections, components, dashboards, spaceDashboards, reloadDashboards, bookmarks, cache, ai, sources }
        : null,
    [repo, cache, ai, sources, spaces, space, setSpace, collections, spaceCollections, reloadCollections, components, dashboards, spaceDashboards, reloadDashboards, bookmarks],

  );
  if (!value) {
    return <>{fallback({ loading: state.status === "loading", error: state.status === "error" ? state.error : undefined })}</>;
  }
  return (
    <StoreContext.Provider value={value}>
      <ComponentsContext.Provider value={components}>{children}</ComponentsContext.Provider>
    </StoreContext.Provider>
  );
}

/** All components (as useStore().components), without rendering again when anything else in the store changes. */
export function useComponents(): Component[] {
  return useContext(ComponentsContext);
}

export function useStore(): Store {
  const store = useContext(StoreContext);
  if (!store) throw new Error("useStore outside StoreProvider");
  return store;
}

export function useCollection(collectionId: string | undefined): Collection | undefined {
  return useStore().collections.find((t) => t.id === collectionId);
}

/** A dashboard by id, whichever spaces it is shown in (like useCollection). */
export function useDashboard(dashboardId: string | undefined): Dashboard | undefined {
  return useStore().dashboards.find((d) => d.id === dashboardId);
}
