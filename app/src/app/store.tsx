import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { openRepository, type Repository } from "../data";
import type { Bookmark } from "../domain/bookmarks";
import type { Template } from "../domain/templates";
import type { ObjectType } from "../domain/model";
import { ObjectCache } from "./objectCache";

interface Store {
  repo: Repository;
  /** All types; reloaded whenever they change (the repository announces it). */
  types: ObjectType[];
  /** Reloads them now: for a page that opens a just-saved type right away. */
  reloadTypes(): Promise<void>;
  /** All templates (kept up to date like the types). */
  templates: Template[];
  /** Side-nav bookmarks (kept up to date like the types). */
  bookmarks: Bookmark[];
  /** The objects (and labels) of the types being shown, loaded once and shared (see useObjects). */
  cache: ObjectCache;
}

const StoreContext = createContext<Store | null>(null);

type State = { status: "loading" } | { status: "error"; error: string } | { status: "ready"; repo: Repository; cache: ObjectCache };

export function StoreProvider({
  children,
  fallback,
}: {
  children: ReactNode;
  fallback: (state: { loading: boolean; error?: string }) => ReactNode;
}) {
  const [state, setState] = useState<State>({ status: "loading" });
  const [types, setTypes] = useState<ObjectType[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  // The latest types for the object cache, which reads them outside of rendering.
  const typesRef = useRef<ObjectType[]>([]);
  const applyTypes = useCallback((list: ObjectType[], cache?: ObjectCache) => {
    typesRef.current = list;
    setTypes(list);
    cache?.typesChanged();
  }, []);

  useEffect(() => {
    let cleanup: (() => void) | undefined;
    let stopped = false;
    openRepository()
      .then(async (repo) => {
        const [types, templates, bookmarks] = await Promise.all([repo.listTypes(), repo.listTemplates(), repo.listBookmarks()]);
        if (stopped) return;
        const cache = new ObjectCache(repo, (typeId) => typesRef.current.find((t) => t.id === typeId));
        applyTypes(types);
        setTemplates(templates);
        setBookmarks(bookmarks);
        // Type definitions changed anywhere: refresh them for every view (side nav, pages).
        let bookmarked = new Set(bookmarks.map((b) => b.targetId));
        const reloadBookmarks = () =>
          repo.listBookmarks().then((list) => {
            bookmarked = new Set(list.map((b) => b.targetId));
            setBookmarks(list);
          }, (e) => console.error("Reloading bookmarks failed", e));
        const unsubscribe = repo.subscribe((change) => {
          if (change.scope === "types") repo.listTypes().then((list) => applyTypes(list, cache), (e) => console.error("Reloading types failed", e));
          if (change.scope === "templates") repo.listTemplates().then(setTemplates, (e) => console.error("Reloading templates failed", e));
          // Bookmarks of deleted views / objects disappear too. Object edits only matter
          // for a bookmarked object (it may have been deleted), not on every cell edit.
          const objectChange = change.scope === "objects" && (!change.objectId || bookmarked.has(change.objectId));
          if (change.scope === "bookmarks" || change.scope === "views" || change.scope === "types" || objectChange) reloadBookmarks();
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
  }, [applyTypes]);

  const ready = state.status === "ready" ? state : null;
  const repo = ready?.repo ?? null;
  const cache = ready?.cache ?? null;
  const reloadTypes = useCallback(async () => {
    if (repo) applyTypes(await repo.listTypes(), cache ?? undefined);
  }, [repo, cache, applyTypes]);
  const value = useMemo(
    () => (repo && cache ? { repo, types, reloadTypes, templates, bookmarks, cache } : null),
    [repo, cache, types, reloadTypes, templates, bookmarks],
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

export function useType(typeId: string | undefined): ObjectType | undefined {
  return useStore().types.find((t) => t.id === typeId);
}
