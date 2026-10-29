// Platform adapter: which shell the app runs in.

/** Whether the app runs in the Tauri desktop window (which bundles its build), not in a browser. */
export const inDesktopShell = (): boolean => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
