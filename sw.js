const VERSION = "0";
const CACHE_NAME = `shifts-cache-v${VERSION}`;
const APP_FILE = "./index.html";

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.add(APP_FILE))
  );

  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(names =>
      Promise.all(
        names
          .filter(name => name !== CACHE_NAME)
          .map(name => caches.delete(name))
      )
    )
  );

  self.clients.claim();
});

self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;
  if (event.request.mode !== "navigate") return;

  event.respondWith(
    fetch(event.request, { cache: "no-store" })
      .then(response => {
        const copy = response.clone();

        caches.open(CACHE_NAME).then(cache => {
          cache.put(APP_FILE, copy);
        });

        return response;
      })
      .catch(() => caches.match(APP_FILE))
  );
});
