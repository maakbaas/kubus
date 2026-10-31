// Service worker: the installed app starts from its cache, never waiting for the network (the data is
// local anyway). A weak connection the phone still counts as online (one bar) must not slow the start.
//  * Installing downloads the app shell: index.html and every file it leads to (found by scanning the
//    build output for asset names), so the very first visit is enough.
//  * Pages: the cached shell, always (cache first). Only without one (never installed) the network.
//  * Everything else of this origin: from the caches, else the network (hashed build files never change).
//  * /api (the sync server) is never cached.
//  * Updates: the browser checks sw.js in the background (and serviceWorker.ts asks when the app is shown
//    again); a new build's worker downloads all of its files while the old one keeps serving, then takes
//    over. The next start (or "Reload to update", `updateAndReload`) shows the new build, entirely from cache.
// The build replaces __BUILD__ (vite.config.ts), so every build installs a fresh worker. The previous
// build's cache is kept (a page still running the old build may load its lazy chunks), older ones go.

const PREFIX = "kubus-";
const CACHE = `${PREFIX}__BUILD__`;
const SHELL = ["./", "manifest.webmanifest", "favicon.svg", "apple-touch-icon.png"];
const ASSET = /(?:\.\/|\/assets\/|assets\/)([\w.-]+\.(?:js|css|wasm|woff2?|svg|png|json))/g;

async function precache() {
  const cache = await caches.open(CACHE);
  const base = self.registration.scope;
  const queue = SHELL.map((p) => new URL(p, base).href);
  const seen = new Set(queue);
  while (queue.length > 0) {
    const url = queue.shift();
    // Unchanged hashed files come from the previous build's cache instead of the (slow) network.
    const known = url.includes("/assets/") ? await caches.match(url) : undefined;
    const response = known ?? (await fetch(url, { cache: "reload" }));
    if (!response.ok) {
      if (SHELL.some((p) => new URL(p, base).href === url)) throw new Error(`Cannot cache ${url}`);
      continue; // a guessed name that doesn't exist
    }
    await cache.put(url, response.clone());
    const type = response.headers.get("content-type") ?? "";
    if (!/html|javascript|css/.test(type)) continue;
    for (const [, name] of (await response.text()).matchAll(ASSET)) {
      const next = new URL(`assets/${name}`, base).href;
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
}

/** The build stamp of a cache's name (base 36 of its build time), for keeping the newest. */
const built = (name) => parseInt(name.slice(PREFIX.length), 36) || 0;

self.addEventListener("install", (event) => {
  // A failed download (a dropped connection) fails the install: the old worker keeps serving and the
  // browser tries again at a later check.
  event.waitUntil(precache().then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => {
        const older = keys.filter((k) => k.startsWith(PREFIX) && k !== CACHE).sort((a, b) => built(b) - built(a));
        return Promise.all(older.slice(1).map((k) => caches.delete(k)));
      })
      .then(() => self.clients.claim()),
  );
});

async function page(request) {
  const shell = new URL("./", self.registration.scope).href;
  const cached = (await (await caches.open(CACHE)).match(shell)) ?? (await caches.match(shell));
  return cached ?? fetch(request);
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return;
  if (request.mode === "navigate") {
    event.respondWith(page(request));
    return;
  }
  event.respondWith(
    caches.match(request).then(async (hit) => {
      if (hit) return hit;
      const response = await fetch(request);
      if (response.ok && response.status === 200) (await caches.open(CACHE)).put(request, response.clone());
      return response;
    }),
  );
});
