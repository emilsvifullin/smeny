const CACHE_NAME="shift-register-runtime-v1";

const INDEX_FILE="./index.html";

const ASSETS=[
  "./",
  INDEX_FILE,
  "./styles.css",
  "./manifest.webmanifest",
  "./src/config.js",
  "./src/domain.js",
  "./src/storage.js",
  "./src/app.js",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-maskable-512.png"
];

self.addEventListener("install",event=>{
  event.waitUntil((async()=>{
    const cache=await caches.open(CACHE_NAME);

    try{
      await cache.addAll(ASSETS);
    }catch(error){
      console.error("Не удалось предварительно заполнить кеш",error);
    }

    /*
      Новый service worker становится активным сам.
      Страница при этом насильно НЕ перезагружается.
    */
    await self.skipWaiting();
  })());
});

self.addEventListener("activate",event=>{
  event.waitUntil((async()=>{
    const names=await caches.keys();

    await Promise.all(
      names
        .filter(name=>name!==CACHE_NAME)
        .filter(name=>
          name.startsWith("shift-register-")
        )
        .map(name=>caches.delete(name))
    );

    await self.clients.claim();
  })());
});

function fetchWithTimeout(request,timeoutMs=5000){
  const controller=new AbortController();

  const timer=setTimeout(
    ()=>controller.abort(),
    timeoutMs
  );

  return fetch(
    request,
    {
      cache:"no-store",
      signal:controller.signal
    }
  ).finally(
    ()=>clearTimeout(timer)
  );
}

async function networkFirst(request){
  const cache=
    await caches.open(CACHE_NAME);

  try{
    const response=
      await fetchWithTimeout(request);

    if(response.ok){
      await cache.put(
        request,
        response.clone()
      );
    }

    return response;
  }catch{
    const cached=
      await cache.match(
        request,
        {ignoreSearch:true}
      );

    return cached || Response.error();
  }
}

async function navigationResponse(request){
  const cache=
    await caches.open(CACHE_NAME);

  try{
    const response=
      await fetchWithTimeout(request);

    if(response.ok){
      const contentType=
        response.headers.get("content-type") || "";

      if(contentType.includes("text/html")){
        await cache.put(
          INDEX_FILE,
          response.clone()
        );
      }
    }

    return response;
  }catch{
    return (
      await cache.match(INDEX_FILE)
    ) || Response.error();
  }
}

self.addEventListener("fetch",event=>{
  const request=event.request;

  if(request.method!=="GET"){
    return;
  }

  const url=
    new URL(request.url);

  const scope=
    new URL(self.registration.scope);

  if(url.origin!==scope.origin){
    return;
  }

  if(request.mode==="navigate"){
    event.respondWith(
      navigationResponse(request)
    );

    return;
  }

  const assetPaths=
    new Set(
      ASSETS.map(
        path=>
          new URL(
            path,
            self.registration.scope
          ).pathname
      )
    );

  if(assetPaths.has(url.pathname)){
    event.respondWith(
      networkFirst(request)
    );
  }
});
