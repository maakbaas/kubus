import { useEffect, useSyncExternalStore } from "react";
import { DEFAULT_MAP_STYLE, MAP_STYLE_IDS, type MapStyleId } from "../../../shared/settings";
import { useDataChanges } from "./useDataChanges";
import { useStore } from "./store";
import { useMediaQuery } from "../ui/useMediaQuery";

// The user's settings that are content, not the device's (Settings → Display): the theme and how maps
// look. Local first and synced: stored in the synced `settings` table (Repository.getSettings /
// setSetting), so every device of the user gets them, and they work without a server. The last ones
// known are kept on the device too (`kubus.theme`, `kubus.mapStyle`), so the first paint, before the
// database opens, already has them.

export type ThemeChoice = "auto" | "light" | "dark";
const THEMES: ThemeChoice[] = ["auto", "light", "dark"];

export interface DisplaySettings {
  theme: ThemeChoice;
  mapStyle: MapStyleId;
}
const DEFAULTS: DisplaySettings = { theme: "auto", mapStyle: DEFAULT_MAP_STYLE };

const CACHE: Record<keyof DisplaySettings, string> = { theme: "kubus.theme", mapStyle: "kubus.mapStyle" };
const valid = {
  theme: (v: unknown): v is ThemeChoice => THEMES.includes(v as ThemeChoice),
  mapStyle: (v: unknown): v is MapStyleId => MAP_STYLE_IDS.includes(v as MapStyleId),
};

function cached(): DisplaySettings {
  const read = <K extends keyof DisplaySettings>(key: K): DisplaySettings[K] => {
    try {
      const v = localStorage.getItem(CACHE[key]);
      return valid[key](v) ? (v as DisplaySettings[K]) : DEFAULTS[key];
    } catch {
      return DEFAULTS[key];
    }
  };
  return { theme: read("theme"), mapStyle: read("mapStyle") };
}

let current = cached();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Takes the stored settings (absent or unreadable ones: the defaults) and keeps them on the device for the next start. */
function apply(stored: Record<string, unknown>) {
  const next: DisplaySettings = {
    theme: valid.theme(stored.theme) ? stored.theme : DEFAULTS.theme,
    mapStyle: valid.mapStyle(stored.mapStyle) ? stored.mapStyle : DEFAULTS.mapStyle,
  };
  if (next.theme === current.theme && next.mapStyle === current.mapStyle) return;
  current = next;
  for (const key of Object.keys(CACHE) as (keyof DisplaySettings)[]) {
    try {
      localStorage.setItem(CACHE[key], next[key]);
    } catch {
      // Not kept (private mode): the database still has it.
    }
  }
  for (const l of listeners) l();
}

/** The display settings (from the device's copy until the database has answered). */
export const useDisplaySettings = (): DisplaySettings => useSyncExternalStore(subscribe, () => current);

/** Whether the app is drawn dark: the theme chosen, or the system's while it is Automatic. */
export function useDark(): boolean {
  const system = useMediaQuery("(prefers-color-scheme: dark)");
  const { theme } = useDisplaySettings();
  return theme === "auto" ? system : theme === "dark";
}

/** The style maps are drawn with. */
export const useMapStyle = (): MapStyleId => useDisplaySettings().mapStyle;

/**
 * Keeps the display settings in step with the database (on opening and on every change, a synced one
 * too). Mounted once, inside the store. A database without a map style yet (made before it was synced)
 * starts from the one in use: the server's (it was a server setting), else this device's own.
 */
export function DisplaySettingsSync() {
  const { repo, sources } = useStore();
  useEffect(() => {
    let live = true;
    repo.getSettings().then(
      async (stored) => {
        if (!live) return;
        const own = current.mapStyle; // the device's copy, before the database's (none) replaces it
        apply(stored);
        if (stored.mapStyle !== undefined) return;
        const { url, token } = repo.sync.config;
        const fromServer = url && token ? await sources.serverSettings().then((v) => v.map?.style, () => undefined) : undefined;
        const seed = fromServer ?? own;
        if (live && seed !== DEFAULTS.mapStyle) await repo.setSetting("mapStyle", seed);
      },
      (e) => console.error("Reading the settings failed", e),
    );
    return () => {
      live = false;
    };
  }, [repo, sources]);
  useDataChanges((change) => {
    if (change.scope === "settings") repo.getSettings().then(apply, (e) => console.error("Reading the settings failed", e));
  });
  return null;
}

/** Changes one display setting (synced). */
export async function setDisplaySetting<K extends keyof DisplaySettings>(repo: { setSetting(key: string, value: unknown): Promise<void> }, key: K, value: DisplaySettings[K]) {
  apply({ ...current, [key]: value });
  await repo.setSetting(key, value);
}

/** The page's own colours outside the app (the window's background, the scheme of scrollbars and the iOS bar) follow a chosen theme. */
export function usePageTheme(dark: boolean) {
  const { theme } = useDisplaySettings();
  useEffect(() => {
    const root = document.documentElement;
    if (theme === "auto") delete root.dataset.theme;
    else root.dataset.theme = theme;
    // The bar colour of browsers that take it from theme-color: both media variants say the chosen one.
    for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
      meta.dataset.auto ??= meta.content;
      meta.content = theme === "auto" ? meta.dataset.auto : dark ? "#393939" : "#e0e0e0";
    }
  }, [theme, dark]);
}
