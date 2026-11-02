// Platform adapter: which shell the app runs in.

/** Whether the app runs in the Tauri desktop window (which bundles its build), not in a browser. */
export const inDesktopShell = (): boolean => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/**
 * Whether the app runs as an iOS home-screen app (added with "Add to Home Screen", started from its
 * icon): iOS has `navigator.standalone` only there (true when started from the icon).
 */
export const inIosHomeScreenApp = (): boolean =>
  typeof navigator !== "undefined" && (navigator as { standalone?: boolean }).standalone === true;
