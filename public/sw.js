// Cache-first service worker with network fallback. Bumps the cache name
// to invalidate on new releases — change CACHE_NAME when you ship something
// users mustn't run an old copy of.
const CACHE_NAME = "spider-man-game-v1";

// Pre-cache the shell so first launch and offline launch are immediate. We
// can't list hashed Vite asset names statically; we let those land on first
// visit via the runtime fetch handler instead.
const PRECACHE = ["/", "/index.html", "/manifest.webmanifest", "/icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      cache.addAll(PRECACHE).catch(() => {
        // Some assets may 404 in dev; don't fail the install for that.
      }),
    ),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Drop any stale caches from prior versions.
      const names = await caches.keys();
      await Promise.all(
        names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  // Only handle GETs. POST/PUT etc. should always go to the network.
  if (event.request.method !== "GET") return;

  // Don't try to cache the dev-server's HMR / module endpoints.
  const url = new URL(event.request.url);
  if (
    url.pathname.startsWith("/@vite/") ||
    url.pathname.startsWith("/@react") ||
    url.pathname.includes("/node_modules/.vite/") ||
    url.searchParams.has("import")
  ) {
    return;
  }

  // Cache-first, network-fallback. On a successful fetch we update the cache
  // in the background so the next load reflects new content.
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const network = fetch(event.request)
        .then((response) => {
          if (response.ok && response.type === "basic") {
            const clone = response.clone();
            caches
              .open(CACHE_NAME)
              .then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => cached);
      return cached || network;
    }),
  );
});
