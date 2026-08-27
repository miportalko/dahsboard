/* =====================================================================
   service-worker.js — Tablero Mi Portal  (v6)
   ---------------------------------------------------------------------
   Se encarga de la APLICACIÓN (no de los datos).

   · Precachea el "app shell": los 8 HTML, la capa offline, los estilos,
     las librerías locales (vendor/) y los iconos. Después de la primera
     visita, el tablero abre sin internet.
   · Los DATOS (Google Sheets / gviz) NO pasan por acá: los maneja
     offline-core.js con IndexedDB, que es quien controla la fecha de
     sincronización y la validez de cada snapshot.

   Estrategias:
     · HTML (navegaciones)   → Network First  (con red, versión nueva;
                                               sin red, la última cacheada)
     · vendor/ e icons/      → Cache First    (archivos versionados)
     · Otros propios         → Stale While Revalidate
     · docs.google.com       → NO se intercepta

   ACTUALIZAR LA APLICACIÓN: subí VERSION (v6 → v7) al publicar cambios.
   Eso NO borra los datos locales guardados en IndexedDB.
   ===================================================================== */
'use strict';

const VERSION = 'v6';
const SHELL_CACHE = 'mp-shell-' + VERSION;
const RUNTIME_CACHE = 'mp-runtime-' + VERSION;

/* --- App shell (rutas relativas al scope del SW) --- */
const SHELL_ASSETS = [
  './',
  './index.html',
  './dashboardgeneral.html',
  './promo_dashboard.html',
  './mailingWoowup.html',
  './saludBase.html',
  './dashboard_ciudades.html',
  './Retornables.html',
  './Automatizadas.html',
  './offline-core.js',
  './mp-standard.css',
  './mp-standard.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-512-maskable.png',
  /* Librerías servidas localmente: sin CDN, el tablero funciona offline */
  './vendor/chart-4.4.0.umd.min.js',
  './vendor/chart-4.4.1.umd.min.js',
  './vendor/xlsx-0.18.5.full.min.js',
  './vendor/lucide.min.js',
  './vendor/inter.css'
];

/* --- Tipografía Inter autohospedada --- */
const FONT_ASSETS = [300, 400, 500, 600, 700, 800, 900].reduce((acc, w) => {
  acc.push('./vendor/inter/inter-latin-' + w + '-normal.woff2');
  acc.push('./vendor/inter/inter-latin-ext-' + w + '-normal.woff2');
  return acc;
}, []);

/* ------------------------------------------------------------------ */
/* Install: precache tolerante a fallos individuales                   */
/* ------------------------------------------------------------------ */
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    /* addAll() falla entero si un solo archivo falla: se cachea uno a uno
       para que un archivo faltante no rompa toda la instalación. */
    await Promise.allSettled(
      SHELL_ASSETS.concat(FONT_ASSETS).map((u) => cache.add(u))
    );
    await self.skipWaiting();
  })());
});

/* ------------------------------------------------------------------ */
/* Activate: limpiar versiones viejas de la APP (no toca IndexedDB)    */
/* ------------------------------------------------------------------ */
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(
      names
        .filter((n) => n.startsWith('mp-') && n !== SHELL_CACHE && n !== RUNTIME_CACHE)
        .map((n) => caches.delete(n))
    );
    await self.clients.claim();
  })());
});

/* Aplicar una versión nueva sin esperar a cerrar todas las pestañas */
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
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
  if (fresh && fresh.ok) cache.put(request, fresh.clone());
  return fresh;
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const refresh = fetch(request).then((fresh) => {
    if (fresh && fresh.ok) cache.put(request, fresh.clone());
    return fresh;
  }).catch(() => null);
  return cached || (await refresh) || Promise.reject(new Error('offline sin cache: ' + request.url));
}

/* ------------------------------------------------------------------ */
/* Router                                                              */
/* ------------------------------------------------------------------ */
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  /* Datos dinámicos: los maneja offline-core.js con IndexedDB. */
  if (url.hostname === 'docs.google.com') return;

  /* Cualquier otro origen externo (si quedara alguno): no se intercepta. */
  if (url.origin !== self.location.origin) return;

  /* Navegaciones / documentos HTML → Network First */
  if (req.mode === 'navigate' || url.pathname.endsWith('.html')) {
    event.respondWith(networkFirst(req, SHELL_CACHE));
    return;
  }

  /* Librerías, tipografías e iconos versionados → Cache First */
  if (url.pathname.indexOf('/vendor/') !== -1 || url.pathname.indexOf('/icons/') !== -1) {
    event.respondWith(cacheFirst(req, SHELL_CACHE));
    return;
  }

  /* Resto de archivos propios → Stale While Revalidate */
  event.respondWith(staleWhileRevalidate(req, SHELL_CACHE));
});
