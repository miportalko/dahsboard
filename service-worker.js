/* =====================================================================
   service-worker.js — Suite de dashboards Mi Portal CC
   ---------------------------------------------------------------------
   Cachea el "app shell": los 7 HTML, la capa offline, el manifest,
   los iconos y las librerías de CDN (Chart.js, SheetJS, Lucide, fuentes).

   Estrategias:
   · HTML (navegaciones)        → Network First  (si hay red, versión nueva;
                                                  sin red, la última cacheada)
   · Librerías CDN versionadas  → Cache First    (URLs inmutables)
   · Google Fonts (CSS + woff)  → Stale-While-Revalidate
   · Archivos propios (js/json) → Stale-While-Revalidate
   · docs.google.com (gviz)     → NO se intercepta: los datos dinámicos
                                  los maneja offline-core.js con IndexedDB.
   ===================================================================== */
'use strict';

const VERSION = 'v1';                       // ← subir a v2, v3… al publicar cambios
const SHELL_CACHE = 'mp-shell-' + VERSION;
const CDN_CACHE   = 'mp-cdn-' + VERSION;

/* App shell propio (rutas relativas al scope del SW) */
const SHELL_ASSETS = [
  './',
  './index.html',
  './dashboardgeneral.html',
  './promo_dashboard.html',
  './mailingWoowup.html',
  './saludBase.html',
  './dashboard_ciudades.html',
  './Retornables.html',
  './offline-core.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

/* Librerías externas exactas usadas por los dashboards */
const CDN_ASSETS = [
  'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js',
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js',
  'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js',
  'https://unpkg.com/lucide@latest/dist/umd/lucide.min.js'
];

const CDN_HOSTS = ['cdnjs.cloudflare.com', 'cdn.jsdelivr.net', 'unpkg.com'];
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

/* ------------------------------------------------------------------ */
/* Install: precache (tolerante a fallos individuales de CDN)          */
/* ------------------------------------------------------------------ */
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const shell = await caches.open(SHELL_CACHE);
    await shell.addAll(SHELL_ASSETS);
    const cdn = await caches.open(CDN_CACHE);
    await Promise.allSettled(CDN_ASSETS.map((u) => cdn.add(u)));
    await self.skipWaiting();
  })());
});

/* ------------------------------------------------------------------ */
/* Activate: limpiar versiones viejas                                  */
/* ------------------------------------------------------------------ */
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(
      names
        .filter((n) => (n.startsWith('mp-shell-') || n.startsWith('mp-cdn-')) &&
                       n !== SHELL_CACHE && n !== CDN_CACHE)
        .map((n) => caches.delete(n))
    );
    await self.clients.claim();
  })());
});

/* ------------------------------------------------------------------ */
/* Estrategias                                                         */
/* ------------------------------------------------------------------ */
async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const fresh = await fetch(request);
    if (fresh && fresh.ok) cache.put(request, fresh.clone());
    return fresh;
  } catch (e) {
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    /* Última red de seguridad para navegaciones: el hub */
    if (request.mode === 'navigate') {
      const hub = await cache.match('./index.html');
      if (hub) return hub;
    }
    throw e;
  }
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const fresh = await fetch(request);
  if (fresh && (fresh.ok || fresh.type === 'opaque')) cache.put(request, fresh.clone());
  return fresh;
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const refresh = fetch(request).then((fresh) => {
    if (fresh && (fresh.ok || fresh.type === 'opaque')) cache.put(request, fresh.clone());
    return fresh;
  }).catch(() => null);
  return cached || (await refresh) || Promise.reject(new Error('offline sin cache: ' + request.url));
}

/* ------------------------------------------------------------------ */
/* Fetch router                                                        */
/* ------------------------------------------------------------------ */
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  /* Datos dinámicos (gviz): pasar de largo. La página resuelve el
     offline con IndexedDB (offline-core.js). El SW no debe cachearlos
     para no servir datos viejos sin control de metadatos. */
  if (url.hostname === 'docs.google.com') return;

  /* Navegaciones / documentos HTML propios → Network First */
  if (req.mode === 'navigate' ||
      (url.origin === self.location.origin && url.pathname.endsWith('.html'))) {
    event.respondWith(networkFirst(req, SHELL_CACHE));
    return;
  }

  /* Librerías CDN versionadas → Cache First */
  if (CDN_HOSTS.includes(url.hostname)) {
    event.respondWith(cacheFirst(req, CDN_CACHE));
    return;
  }

  /* Google Fonts → Stale While Revalidate */
  if (FONT_HOSTS.includes(url.hostname)) {
    event.respondWith(staleWhileRevalidate(req, CDN_CACHE));
    return;
  }

  /* Recursos propios (offline-core.js, manifest, iconos) → SWR */
  if (url.origin === self.location.origin) {
    event.respondWith(staleWhileRevalidate(req, SHELL_CACHE));
  }
});
