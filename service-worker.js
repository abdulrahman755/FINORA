// ══════════════════════════════════════════════════════════════════════════
// FINORA — Service Worker
// ──────────────────────────────────────────────────────────────────────────
// This app is single-file and local-first: index.html holds all HTML/CSS/JS,
// and every record (banks, daily transactions, site custody, savings…) is
// stored in localStorage on the device — there is no backend for app data,
// so there is nothing to "sync" for CRUD. The only real network traffic is:
//   1) same-origin static assets (this file's own icons, brand-logo SVGs)
//   2) a few read-only third-party GETs (Google Fonts, the xlsx export
//      library, FX/gold rate lookups — all of which already degrade
//      gracefully in index.html if they fail)
//   3) POSTs to the user's own AI proxy worker (AI_PROXY_URL in index.html),
//      used for receipt scanning / AI Quick Entry / insights
// This worker caches (1) and (2) with the right strategy for each, and
// queues (3) in IndexedDB + Background Sync so a request made while offline
// is retried automatically instead of silently failing.
// ══════════════════════════════════════════════════════════════════════════

const CACHE_VERSION   = 'v1';
const SHELL_CACHE     = `finora-shell-${CACHE_VERSION}`;
const RUNTIME_CACHE   = `finora-runtime-${CACHE_VERSION}`;
const FONT_CACHE      = `finora-fonts-${CACHE_VERSION}`;
const CURRENT_CACHES  = new Set([SHELL_CACHE, RUNTIME_CACHE, FONT_CACHE]);

// Core app shell — precached on install so the app starts instantly offline
// from the very first load onward. Kept intentionally small since index.html
// is itself the entire application (no separate JS/CSS bundles to list).
const SHELL_ASSETS = [
  './',
  'index.html',
  'manifest.json',
  'offline.html',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-192-maskable.png',
  'icons/icon-512-maskable.png',
];

// Hosts we're willing to runtime-cache GETs from (read-only, non-sensitive).
const FONT_HOSTS   = new Set(['fonts.googleapis.com', 'fonts.gstatic.com']);
const CDN_HOSTS    = new Set(['cdnjs.cloudflare.com']);
const RATE_HOSTS   = new Set(['open.er-api.com', 'api.gold-api.com']);

// ── IndexedDB — mirrors the WDP_IDB schema defined in index.html ──────────
// Same DB name/version/stores so both the page and this worker read/write
// the same queue. Used only for POST requests that failed while offline
// (currently: the AI proxy). Never used for auth tokens or secrets — the
// app has none; it's a fully local, unauthenticated single-user tool.
const DB_NAME      = 'wdp-offline-db';
const DB_VERSION   = 1;
const QUEUE_STORE  = 'wdp_sync_queue';
const CACHE_STORE  = 'wdp_data_cache';

function openDB(){
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if(!db.objectStoreNames.contains(QUEUE_STORE)) db.createObjectStore(QUEUE_STORE, {keyPath:'id', autoIncrement:true});
      if(!db.objectStoreNames.contains(CACHE_STORE)) db.createObjectStore(CACHE_STORE, {keyPath:'key'});
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

async function queueRequest(request){
  const body = await request.clone().text().catch(() => null);
  const entry = {
    url: request.url,
    method: request.method,
    headers: [...request.headers.entries()],
    body,
    queuedAt: Date.now(),
  };
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(QUEUE_STORE, 'readwrite');
    tx.objectStore(QUEUE_STORE).add(entry);
    tx.oncomplete = resolve;
    tx.onerror    = () => reject(tx.error);
  });
}

async function readQueue(){
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(QUEUE_STORE, 'readonly');
    const req = tx.objectStore(QUEUE_STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror   = () => reject(req.error);
  });
}

async function removeFromQueue(id){
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(QUEUE_STORE, 'readwrite');
    tx.objectStore(QUEUE_STORE).delete(id);
    tx.oncomplete = resolve;
    tx.onerror    = () => reject(tx.error);
  });
}

async function notifyClients(message){
  const clients = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
  for(const client of clients) client.postMessage(message);
}

// Retries every queued request in order. Stops (leaves the rest queued) on
// the first failure, so a still-offline device doesn't burn through retries
// pointlessly and later items don't get reordered ahead of earlier ones.
async function flushQueue(){
  const items = await readQueue();
  if(!items.length) return;
  let flushedAny = false;
  for(const item of items){
    try{
      const res = await fetch(item.url, {
        method: item.method,
        headers: item.headers,
        body: item.body ?? undefined,
      });
      if(!res.ok) throw new Error('non-2xx response: ' + res.status);
      await removeFromQueue(item.id);
      flushedAny = true;
    }catch(e){
      break; // still offline / still failing — stop and try again next time
    }
  }
  const remaining = await readQueue();
  if(flushedAny) await notifyClients({ type: 'wdp-sync-complete', remaining: remaining.length });
}

// ── Install — precache the app shell ───────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // addAll fails the whole batch on any single 404 — go one-by-one so a
    // missing optional icon doesn't break offline support for everything else.
    await Promise.all(SHELL_ASSETS.map(async url => {
      try{ await cache.add(new Request(url, { cache: 'reload' })); }
      catch(e){ /* asset not deployed yet — skip, don't fail install */ }
    }));
  })());
  // Deliberately no self.skipWaiting() here — index.html already shows an
  // "Update ready — refresh to apply" toast when a new worker finishes
  // installing, and only swaps versions on the user's own reload.
});

// ── Activate — drop old cache versions, take control ───────────────────────
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(
      names
        .filter(name => name.startsWith('finora-') && !CURRENT_CACHES.has(name))
        .map(name => caches.delete(name))
    );
    await self.clients.claim();
  })());
});

// ── Fetch — route each request to the right strategy ───────────────────────
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Only ever handle GET/POST; let everything else (rare) pass through.
  if(request.method === 'POST'){
    event.respondWith(handlePost(request));
    return;
  }
  if(request.method !== 'GET') return;

  // Page navigations — network first, cached shell fallback, offline page
  // as the last resort. This is what makes reloading while offline work.
  if(request.mode === 'navigate'){
    event.respondWith(networkFirstNavigation(request));
    return;
  }

  const sameOrigin = url.origin === self.location.origin;

  if(sameOrigin){
    event.respondWith(cacheFirst(request, RUNTIME_CACHE));
    return;
  }
  if(FONT_HOSTS.has(url.hostname)){
    event.respondWith(staleWhileRevalidate(request, FONT_CACHE));
    return;
  }
  if(CDN_HOSTS.has(url.hostname)){
    event.respondWith(cacheFirst(request, RUNTIME_CACHE));
    return;
  }
  if(RATE_HOSTS.has(url.hostname)){
    event.respondWith(networkFirst(request, RUNTIME_CACHE));
    return;
  }
  // Unknown third-party GET — just try the network, no caching assumptions.
});

// ── Strategies ───────────────────────────────────────────────────────────
async function cacheFirst(request, cacheName){
  const cached = await caches.match(request);
  if(cached) return cached;
  try{
    const res = await fetch(request);
    if(res && res.ok) (await caches.open(cacheName)).put(request, res.clone());
    return res;
  }catch(e){
    return cached || new Response('', { status: 504, statusText: 'Offline' });
  }
}

async function staleWhileRevalidate(request, cacheName){
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const network = fetch(request).then(res => {
    if(res && res.ok) cache.put(request, res.clone());
    return res;
  }).catch(() => null);
  return cached || (await network) || new Response('', { status: 504, statusText: 'Offline' });
}

async function networkFirst(request, cacheName){
  const cache = await caches.open(cacheName);
  try{
    const res = await fetch(request);
    if(res && res.ok) cache.put(request, res.clone());
    return res;
  }catch(e){
    const cached = await cache.match(request);
    if(cached) return cached;
    return new Response(JSON.stringify({ offline: true }), {
      status: 503, headers: { 'Content-Type': 'application/json' },
    });
  }
}

async function networkFirstNavigation(request){
  try{
    const res = await fetch(request);
    if(res && res.ok) (await caches.open(SHELL_CACHE)).put('index.html', res.clone());
    return res;
  }catch(e){
    const shell = await caches.match('index.html', { cacheName: SHELL_CACHE });
    if(shell) return shell;
    const cachedAnywhere = await caches.match('index.html');
    if(cachedAnywhere) return cachedAnywhere;
    const offline = await caches.match('offline.html');
    if(offline) return offline;
    return new Response('Offline', { status: 503 });
  }
}

// POSTs (the AI proxy) — try the network; if it fails because the device is
// offline, queue the request in IndexedDB, tell any open tabs, and register
// a Background Sync so it retries automatically the moment connectivity
// returns (with an explicit client-triggered flush as a Safari fallback,
// already wired up on the page side).
async function handlePost(request){
  try{
    return await fetch(request.clone());
  }catch(e){
    try{
      await queueRequest(request);
      if('sync' in self.registration){
        try{ await self.registration.sync.register('wdp-flush-queue'); }catch(_){}
      }
      await notifyClients({ type: 'wdp-request-queued' });
    }catch(queueErr){ /* IndexedDB unavailable — nothing more we can do */ }
    return new Response(JSON.stringify({ queued: true, offline: true }), {
      status: 202, headers: { 'Content-Type': 'application/json' },
    });
  }
}

// ── Background Sync — fires automatically on Chrome/Edge/Android when
// connectivity returns, even if no tab is open. Safari has no Background
// Sync API, which is why index.html also nudges a flush on its own
// 'online' event via postMessage — both paths call the same flushQueue().
self.addEventListener('sync', event => {
  if(event.tag === 'wdp-flush-queue') event.waitUntil(flushQueue());
});

// ── Messages from the page ─────────────────────────────────────────────────
self.addEventListener('message', event => {
  const type = event.data && event.data.type;
  if(type === 'wdp-flush-queue') event.waitUntil(flushQueue());
  if(type === 'SKIP_WAITING') self.skipWaiting();
});

// ── Local reminder notifications (already triggered from index.html via
// navigator.serviceWorker.ready.then(reg => reg.showNotification(...))) —
// just handle the tap so it focuses/opens the app instead of doing nothing.
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    const clientsArr = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for(const client of clientsArr){
      if('focus' in client) return client.focus();
    }
    if(self.clients.openWindow) return self.clients.openWindow('./index.html');
  })());
});
