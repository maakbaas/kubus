import { inDesktopShell } from "./shell";

const enabled = () => import.meta.env.PROD && "serviceWorker" in navigator && !inDesktopShell();

/** A page shown again this recently (ms) is still "coming back": a new build that takes over now reloads it. */
const RESUMING = 3000;

/**
 * Registers the service worker (app/sw.js) that makes the web and home-screen app start from its cache, offline
 * or on a weak connection alike. Only in a production build on the web: not in development, and not in the Tauri
 * shell, which bundles the app itself. A new build is looked for in the background whenever the app is shown again
 * (iOS resumes a home-screen app without loading the page, so the browser's own check wouldn't run) and downloaded
 * whole while the old one keeps running.
 * Once it has taken over, the page reloads the next time it is shown again (or at once, when that was just now): iOS
 * hardly ever starts a home-screen app afresh (opening it resumes the page, even hours later), so waiting for "the next
 * start" left it on the old build. The reload comes from the cache too, so it is as quick and works offline; it never
 * happens while the app is being used.
 */
export function registerServiceWorker() {
  if (!enabled()) return;
  // A page that started without a worker gets its first one by `clients.claim`: that is no new build.
  const hadWorker = !!navigator.serviceWorker.controller;
  let newBuild = false;
  let shownAt = performance.now();
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadWorker) return;
    newBuild = true;
    if (document.visibilityState === "visible" && performance.now() - shownAt < RESUMING) location.reload();
  });
  addEventListener("load", () => {
    navigator.serviceWorker
      .register("sw.js", { updateViaCache: "none" })
      .then((registration) => {
        document.addEventListener("visibilitychange", () => {
          if (document.visibilityState !== "visible") return;
          shownAt = performance.now();
          if (newBuild) location.reload();
          else registration.update().catch(() => undefined);
        });
      })
      .catch((e) => console.warn("Service worker not registered", e));
  });
}

/**
 * Loads the newest build ("Reload to update"): asks for a new worker, waits (at most a minute) while it downloads
 * the build and takes over, then reloads. The page is served from the cache, so a plain reload would show the
 * cached build again.
 */
export async function updateAndReload() {
  try {
    const registration = enabled() ? await navigator.serviceWorker.getRegistration() : undefined;
    if (registration) {
      const tookOver = new Promise<void>((resolve) => navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true }));
      await registration.update();
      if (registration.installing || registration.waiting) await Promise.race([tookOver, new Promise((r) => setTimeout(r, 60_000))]);
    }
  } catch (e) {
    console.warn("Checking for a new version failed", e);
  }
  location.reload();
}
