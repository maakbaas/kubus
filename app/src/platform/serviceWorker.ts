/**
 * Registers the service worker (public/sw.js) that makes the home-screen app start offline.
 * Only in a production build on the web: not in development, and not in the Tauri shell,
 * which bundles the app itself.
 */
export function registerServiceWorker() {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator) || "__TAURI_INTERNALS__" in window) return;
  addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch((e) => console.warn("Service worker not registered", e));
  });
}
