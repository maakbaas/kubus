// Service worker: lets the installed app start without a network (the data is local anyway).
//  * Installing downloads the app shell: index.html and every file it leads to (found by
//    scanning the build output for asset names), so the very first visit is enough.
//  * Pages: network first (a new build shows up at once), the cached shell when offline.
//  * Everything else of this origin: from the cache, else the network (hashed build files never change).
//  * /api (the sync server) is never cached.
// The build replaces __BUILD__ (vite.config.ts), so every build installs a fresh worker and
// the previous build's cache is removed.

const CACHE = "kubus-__BUILD__";
const SHELL = ["./", "manifest.webmanifest", "favicon.svg", "apple-touch-icon.png"];
const ASSET = /(?:\.\/|\/assets\/|assets\/)([\w.-]+\.(?:js|css|wasm|woff2?|svg|png|json))/g;

async function precache() {
  const cache = await caches.open(CACHE);
  const base = self.registration.scope;
  const queue = SHELL.map((p) => new URL(p, base).href);
  const seen = new Set(queue);
  while (queue.length > 0) {
    const url = queue.shift();
    const response = await fetch(url, { cache: "reload" });
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

self.addEventListener("install", (event) => {
  event.waitUntil(precache().then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function page(request) {
  const cache = await caches.open(CACHE);
  const shell = () => cache.match(new URL("./", self.registration.scope).href);
  try {
    // A flaky connection must not hang the app when the shell is cached.
    return await Promise.race([
      fetch(request),
      new Promise((_, reject) => setTimeout(reject, 4000)),
    ]);
  } catch {
    return (await shell()) ?? fetch(request);
  }
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
    caches.open(CACHE).then(async (cache) => {
      const hit = await cache.match(request);
      if (hit) return hit;
      const response = await fetch(request);
      if (response.ok && response.status === 200) cache.put(request, response.clone());
      return response;
    }),
  );
});
