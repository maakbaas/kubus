import { useCallback, useEffect, useState } from "react";
import { DEFAULT_HOME, HOME_SETTING, parseHomeLayout, type HomeLayout } from "../domain/home";
import { useDataChanges } from "./useDataChanges";
import { useStore } from "./store";

/**
 * The Home page's layout (domain/home.ts), a synced setting: read from the database, again on every change of the
 * settings (a synced one too), and stored at once when changed here (shown at once, before the write).
 */
export function useHomeLayout(onError: (e: unknown) => void): [HomeLayout, (next: HomeLayout) => void] {
  const { repo } = useStore();
  const [layout, setLayout] = useState<HomeLayout>(DEFAULT_HOME);
  const load = useCallback(() => {
    repo.getSettings().then((stored) => setLayout(parseHomeLayout(stored[HOME_SETTING])), onError);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo]);
  useEffect(load, [load]);
  useDataChanges((change) => change.scope === "settings" && load());
  const change = useCallback(
    (next: HomeLayout) => {
      setLayout(next);
      repo.setSetting(HOME_SETTING, next).catch(onError);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [repo],
  );
  return [layout, change];
}
