// Platform adapter: which shell the app runs in.

/** Whether the app runs in the Tauri desktop window (which bundles its build), not in a browser. */
export const inDesktopShell = (): boolean => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/**
 * The iOS major version when the app runs as an iOS home-screen app (added with "Add to Home
 * Screen", started from its icon), else null. iOS has `navigator.standalone` only there (true when
 * started from the icon); an iPad says it is a Mac, so its version is read from `Version/<n>`.
 */
export function iosHomeScreenVersion(): number | null {
  if (typeof navigator === "undefined" || (navigator as { standalone?: boolean }).standalone !== true) return null;
  const ua = navigator.userAgent;
  const os = /\bOS (\d+)_/.exec(ua) ?? /\bVersion\/(\d+)/.exec(ua);
  // Unread: taken for a current one (17 and later share Safari's link scheme).
  return os ? Number(os[1]) : 17;
}
