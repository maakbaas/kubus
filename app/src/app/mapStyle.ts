import { useEffect, useSyncExternalStore } from "react";
import { DEFAULT_MAP_STYLE, MAP_STYLE_IDS, type MapStyleId } from "../../../shared/settings";
import { useStore } from "./store";

// How every map looks (Settings → Maps), one style for all Map blocks: the server's when this device
// is connected to one (shared/settings.ts, the same for every device), else this device's own. The
// last one known is kept on the device (kubus.mapStyle), so maps look the same offline and before
// the server answers.

const KEY = "kubus.mapStyle";
const listeners = new Set<() => void>();

function stored(): MapStyleId {
  try {
    const v = localStorage.getItem(KEY);
    return MAP_STYLE_IDS.includes(v as MapStyleId) ? (v as MapStyleId) : DEFAULT_MAP_STYLE;
  } catch {
    return DEFAULT_MAP_STYLE;
  }
}
let current = stored();

/** Sets the style maps are drawn with (and keeps it on this device). */
export function setMapStyle(style: MapStyleId) {
  if (style === current) return;
  current = style;
  try {
    localStorage.setItem(KEY, style);
  } catch {
    // Not kept (private mode): this session still has it.
  }
  for (const l of listeners) l();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** The server's style, asked for once per server and token while maps are shown. */
let asked: string | null = null;

/** The style maps are drawn with; while one is shown, the server's is fetched once (it may have changed). */
export function useMapStyle(): MapStyleId {
  const { repo, sources } = useStore();
  const { url, token } = repo.sync.config;
  useEffect(() => {
    const key = url && token ? `${url} ${token}` : null;
    if (!key || asked === key) return;
    asked = key;
    sources.serverSettings().then(
      (view) => view.map && setMapStyle(view.map.style),
      () => {
        asked = null; // offline: asked again by the next map
      },
    );
  }, [sources, url, token]);
  return useSyncExternalStore(subscribe, () => current);
}
