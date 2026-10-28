import { useEffect, useState, useSyncExternalStore } from "react";
import { isRemote } from "../domain/sources";
import { useStore } from "./store";

/**
 * Whether the Remotes page has anything to offer, which the side nav shows its node for: the
 * server this device syncs with has a remote connection (a source, Settings → Server), or remote
 * collections exist (they stay reachable, to edit or delete, while the server is offline or its
 * source is gone). Asked again when the sync settings change and when the server's settings are
 * saved (`sources.refresh(null)`).
 */
export function useRemotesShown(): boolean {
  const { repo, sources, collections } = useStore();
  // Follows the sync settings (another server, another token).
  useSyncExternalStore(repo.sync.subscribe.bind(repo.sync), () => repo.sync.status);
  const { url, token } = repo.sync.config;
  const [offered, setOffered] = useState(false);
  const [asked, setAsked] = useState(0);
  useEffect(() => sources.onRefresh((id) => id === null && setAsked((n) => n + 1)), [sources]);
  useEffect(() => {
    if (!url || !token) {
      setOffered(false);
      return;
    }
    let stale = false;
    sources.list().then(
      (list) => !stale && setOffered(list.length > 0),
      () => undefined, // offline: as it was
    );
    return () => {
      stale = true;
    };
  }, [sources, url, token, asked]);
  return offered || collections.some(isRemote);
}
