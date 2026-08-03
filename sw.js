const VERSION = "5";
const CACHE_NAME = `shifts-cache-v${VERSION}`;
const APP_FILE = "./index.html";

const APP_FILES = [
  "./index.html",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-maskable-512.png"
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then(cache => cache.addAll(APP_FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    Promise.all([
      caches.keys().then(names =>
        Promise.all(
          names
            .filter(name =>
              name.startsWith("shifts-cache-v") &&
              name !== CACHE_NAME
            )
            .map(name => caches.delete(name))
        )
      ),

      self.clients.claim()
    ])
  );
});

self.addEventListener("fetch", event => {
  if(event.request.method !== "GET") return;
  if(event.request.mode !== "navigate") return;

  event.respondWith(
    (async()=>{
      try{
        const response=await fetch(
          event.request,
          {cache:"no-store"}
        );

        if(response.ok){
          const cache=await caches.open(CACHE_NAME);

          await cache.put(
            APP_FILE,
            response.clone()
          );
        }

        return response;
      }catch{
        const cached=
          await caches.match(APP_FILE);

        return cached || Response.error();
      }
    })()
  );
});
