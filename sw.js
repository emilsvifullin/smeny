const VERSION="6.0.2";
const CACHE_NAME=`shift-register-v${VERSION}`;
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
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache=>cache.addAll(ASSETS))
  );
});

self.addEventListener("message",event=>{
  if(event.data?.type==="SKIP_WAITING"){
    self.skipWaiting();
  }
});

self.addEventListener("activate",event=>{
  event.waitUntil((async()=>{
    const names=await caches.keys();
    await Promise.all(
      names
        .filter(name=>name.startsWith("shift-register-v") && name!==CACHE_NAME)
        .map(name=>caches.delete(name))
    );
    await self.clients.claim();
  })());
});

function timeoutFetch(request,timeoutMs=4000){
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),timeoutMs);
  return fetch(request,{cache:"no-store",signal:controller.signal})
    .finally(()=>clearTimeout(timer));
}

function isCanonicalNavigation(url){
  const scope=new URL(self.registration.scope);
  const root=scope.pathname.endsWith("/") ? scope.pathname : scope.pathname+"/";
  return url.origin===scope.origin &&
    (url.pathname===root || url.pathname===root+"index.html");
}

async function navigationResponse(request){
  try{
    const response=await timeoutFetch(request);
    const url=new URL(request.url);
    const contentType=response.headers.get("content-type") || "";

    if(response.ok && contentType.includes("text/html") && isCanonicalNavigation(url)){
      const cache=await caches.open(CACHE_NAME);
      await cache.put(INDEX_FILE,response.clone());
    }

    return response;
  }catch{
    const cache=await caches.open(CACHE_NAME);
    return (await cache.match(INDEX_FILE)) || Response.error();
  }
}

async function assetResponse(request,event){
  const cache=await caches.open(CACHE_NAME);
  const cached=await cache.match(request,{ignoreSearch:true});

  const refresh=fetch(request).then(async response=>{
    if(response.ok) await cache.put(request,response.clone());
    return response;
  }).catch(()=>null);

  if(cached){
    event.waitUntil(refresh);
    return cached;
  }

  return (await refresh) || Response.error();
}

self.addEventListener("fetch",event=>{
  const request=event.request;
  if(request.method!=="GET") return;

  const url=new URL(request.url);
  const scope=new URL(self.registration.scope);
  if(url.origin!==scope.origin) return;

  if(request.mode==="navigate"){
    event.respondWith(navigationResponse(request));
    return;
  }

  const assetPaths=new Set(
    ASSETS.map(path=>new URL(path,self.registration.scope).pathname)
  );

  if(assetPaths.has(url.pathname)){
    event.respondWith(assetResponse(request,event));
  }
});
