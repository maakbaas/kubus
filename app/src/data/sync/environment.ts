// What the sync engine needs from where it runs: the browser (the app) or Node (the server's
// headless device). The engine itself only uses this, `fetch` and timers.

export interface SyncEnvironment {
  /** Small settings kept per device (the browser's localStorage). Never throws. */
  storage: {
    get(key: string): string | null;
    set(key: string, value: string): void;
    remove(key: string): void;
  };
  /** The server to suggest when none is set. */
  defaultUrl(): string;
  /** Calls `sync` whenever syncing now is worthwhile (back online, the app shown again). */
  watch(sync: () => void): void;
}

/** The app: settings in localStorage, syncing when the device comes online or the app is shown. */
export const browserEnvironment: SyncEnvironment = {
  storage: {
    get(key) {
      try {
        return localStorage.getItem(key);
      } catch {
        return null; // storage blocked
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, value);
      } catch {
        // storage blocked: it lasts until the page closes
      }
    },
    remove(key) {
      try {
        localStorage.removeItem(key);
      } catch {
        // storage blocked: nothing to forget
      }
    },
  },
  /** The server serving this very page is the natural default (the installed home-screen app). */
  defaultUrl() {
    const web = location.protocol.startsWith("http") && !location.hostname.endsWith("tauri.localhost") && !import.meta.env.DEV;
    return web ? location.origin : "";
  },
  watch(sync) {
    addEventListener("online", sync);
    document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && sync());
  },
};

/** Settings in memory only, nothing to watch (the server's headless device). */
export function memoryEnvironment(): SyncEnvironment {
  const values = new Map<string, string>();
  return {
    storage: {
      get: (key) => values.get(key) ?? null,
      set: (key, value) => void values.set(key, value),
      remove: (key) => void values.delete(key),
    },
    defaultUrl: () => "",
    watch: () => {},
  };
}
