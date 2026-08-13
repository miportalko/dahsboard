/* =====================================================================
   offline-core.js — Capa Offline-First para la suite Mi Portal CC
   ---------------------------------------------------------------------
   NO modifica la lógica de ningún dashboard. Funciona interceptando
   window.fetch SOLO para las URLs de Google Sheets (gviz/tq):

   · CON internet  → fetch real → guarda snapshot en IndexedDB → dashboard
   · SIN internet  → lee el último snapshot válido de IndexedDB → dashboard
   · Sin snapshot  → deja fallar el fetch (el dashboard muestra su error)
                     y el indicador dice "No hay datos disponibles offline."

   Reglas de integridad:
   · Nunca inventa datos: solo devuelve respuestas reales previamente
     recibidas de la fuente, byte a byte (idempotente por diseño: cada
     sync reemplaza el snapshot completo de esa hoja; no hay merge,
     no hay duplicados, no se mezclan períodos ni estados).
   · Registra fecha/hora real de la última sincronización por hoja.

   También: registra el Service Worker, muestra el indicador de estado
   (🟢/🔴) y resincroniza automáticamente al recuperar conexión.
   ===================================================================== */
(function () {
  'use strict';

  /* ------------------------------------------------------------------ */
  /* Configuración                                                       */
  /* ------------------------------------------------------------------ */
  var DB_NAME = 'mp_offline';
  var DB_VERSION = 1;                 // versionado del esquema IndexedDB
  var STORE = 'gvizSnapshots';        // snapshots de respuestas gviz
  var META = 'meta';                  // metadatos (última sync global, etc.)
  var FETCH_TIMEOUT_MS = 15000;       // timeout de red antes de caer a IDB
  var SW_FILE = 'service-worker.js';

  var GVIZ_HOST = 'docs.google.com';
  var GVIZ_PATH = '/gviz/tq';

  /* Parámetros "cache-buster" que NO forman parte de la identidad de la
     consulta (cada dashboard usa uno distinto: _, cb, _ts). */
  var VOLATILE_PARAMS = ['_', 'cb', '_ts', 't'];

  /* ------------------------------------------------------------------ */
  /* IndexedDB                                                           */
  /* ------------------------------------------------------------------ */
  var dbPromise = null;
  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      if (!('indexedDB' in window)) { reject(new Error('IndexedDB no disponible')); return; }
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function (e) {
        var db = e.target.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' });
        if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'key' });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
    return dbPromise;
  }

  function idbPut(store, value) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(store, 'readwrite');
        tx.objectStore(store).put(value);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  function idbGet(store, key) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(store, 'readonly');
        var rq = tx.objectStore(store).get(key);
        rq.onsuccess = function () { resolve(rq.result || null); };
        rq.onerror = function () { reject(rq.error); };
      });
    });
  }

  /* ------------------------------------------------------------------ */
  /* Utilidades                                                          */
  /* ------------------------------------------------------------------ */
  function isGvizUrl(url) {
    try {
      var u = new URL(url, location.href);
      return u.hostname === GVIZ_HOST && u.pathname.indexOf(GVIZ_PATH) !== -1;
    } catch (e) { return false; }
  }

  /* Identidad estable de la consulta: host+path+params ordenados,
     sin cache-busters. Misma hoja/gid/tq ⇒ misma clave ⇒ sync idempotente. */
  function normalizeKey(url) {
    var u = new URL(url, location.href);
    var params = [];
    u.searchParams.forEach(function (v, k) {
      if (VOLATILE_PARAMS.indexOf(k) === -1) params.push(k + '=' + v);
    });
    params.sort();
    return u.hostname + u.pathname + '?' + params.join('&');
  }

  function fmtDate(ts) {
    if (!ts) return '—';
    var d = new Date(ts);
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return p(d.getDate()) + '/' + p(d.getMonth() + 1) + '/' + d.getFullYear() +
           ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function fetchWithTimeout(url, opts) {
    var ctrl = ('AbortController' in window) ? new AbortController() : null;
    var o = Object.assign({}, opts || {});
    if (ctrl) o.signal = ctrl.signal;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, FETCH_TIMEOUT_MS);
    return NATIVE_FETCH(url, o).finally(function () { clearTimeout(timer); });
  }

  /* ------------------------------------------------------------------ */
  /* Indicador de estado (🟢/🔴)                                          */
  /* ------------------------------------------------------------------ */
  var badge = null, badgeMsg = null, badgeTimer = null;
  function ensureBadge() {
    if (badge) return badge;
    badge = document.createElement('div');
    badge.id = 'mp-offline-badge';
    badge.style.cssText = [
      'position:fixed', 'left:14px', 'bottom:14px', 'z-index:99999',
      'font-family:Inter,system-ui,sans-serif', 'font-size:12.5px', 'font-weight:600',
      'padding:9px 14px', 'border-radius:20px', 'color:#fff', 'background:#0D0D0D',
      'box-shadow:0 4px 18px rgba(0,0,0,.25)', 'display:none', 'max-width:min(92vw,480px)',
      'line-height:1.35', 'pointer-events:none'
    ].join(';');
    badgeMsg = document.createElement('span');
    badge.appendChild(badgeMsg);
    document.body.appendChild(badge);
    return badge;
  }
  function showBadge(html, bg, autoHideMs) {
    function apply() {
      ensureBadge();
      badge.style.background = bg;
      badge.style.display = 'block';
      badgeMsg.innerHTML = html;
      clearTimeout(badgeTimer);
      if (autoHideMs) badgeTimer = setTimeout(function () { badge.style.display = 'none'; }, autoHideMs);
    }
    if (document.body) apply();
    else document.addEventListener('DOMContentLoaded', apply);
  }
  function hideBadge() { if (badge) badge.style.display = 'none'; }

  /* ------------------------------------------------------------------ */
  /* Estado de sesión                                                    */
  /* ------------------------------------------------------------------ */
  var usedOfflineData = false;   // esta página está mostrando datos de IDB
  var hadNoData = false;         // se pidió algo y no había snapshot
  var sessionKeys = {};          // key normalizada → URL real usada (sin buster)
  var oldestShownSync = null;    // sync más vieja entre los snapshots mostrados

  function updateOfflineBadge() {
    if (hadNoData && !usedOfflineData) {
      showBadge('🔴 Offline — <b>No hay datos disponibles offline.</b><br>Conectate a internet al menos una vez para sincronizar.', '#D8342E');
    } else if (usedOfflineData) {
      showBadge('🔴 Offline — Mostrando últimos datos sincronizados<br>Última sincronización: <b>' + fmtDate(oldestShownSync) + '</b>', '#D8342E');
    }
  }

  /* ------------------------------------------------------------------ */
  /* Interceptor de fetch (solo gviz)                                    */
  /* ------------------------------------------------------------------ */
  var NATIVE_FETCH = window.fetch.bind(window);

  window.fetch = function (input, init) {
    var url = (typeof input === 'string') ? input : (input && input.url) || '';
    if (!isGvizUrl(url)) return NATIVE_FETCH(input, init);

    var key = normalizeKey(url);
    sessionKeys[key] = url;

    return fetchWithTimeout(url, init).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.text().then(function (text) {
        /* Validar que sea una respuesta gviz real antes de guardar:
           nunca persistir HTML de error ni respuestas vacías. */
        var looksGviz = text && text.indexOf('google.visualization.Query.setResponse') !== -1;
        if (looksGviz) {
          var now = Date.now();
          idbPut(STORE, { key: key, url: url.split(/[?&](?:_|cb|_ts)=/)[0], text: text, syncedAt: now, schema: DB_VERSION })
            .then(function () { return idbPut(META, { key: 'lastSync', ts: now }); })
            .catch(function () { /* best-effort: no bloquear el dashboard */ });
          document.dispatchEvent(new CustomEvent('mp:gviz-data', { detail: { key: key, text: text, fromCache: false, netError: false, syncedAt: now } }));
          showBadge('🟢 Online — Datos actualizados · ' + fmtDate(now), '#1E9E5A', 4000);
        }
        return new Response(text, { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      });
    }).catch(function (netErr) {
      /* Red caída, timeout, API con error, respuesta inválida → fallback IDB */
      return idbGet(STORE, key).then(function (rec) {
        if (rec && rec.text) {
          usedOfflineData = true;
          document.dispatchEvent(new CustomEvent('mp:gviz-data', { detail: { key: key, text: rec.text, fromCache: true, netError: true, syncedAt: rec.syncedAt } }));
          if (!oldestShownSync || rec.syncedAt < oldestShownSync) oldestShownSync = rec.syncedAt;
          if (navigator.onLine) {
            /* Hay conexión pero la fuente falló */
            showBadge('🟠 No se pudieron actualizar los datos. Mostrando última información disponible.<br>Última sincronización: <b>' + fmtDate(rec.syncedAt) + '</b>', '#E6A100');
          } else {
            updateOfflineBadge();
          }
          return new Response(rec.text, { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-MP-Offline': '1' } });
        }
        hadNoData = true;
        document.dispatchEvent(new CustomEvent('mp:gviz-error', { detail: { key: key } }));
        updateOfflineBadge();
        throw netErr; /* el dashboard muestra su propio mensaje de error */
      });
    });
  };

  /* ------------------------------------------------------------------ */
  /* Detección online/offline + resincronización automática              */
  /* ------------------------------------------------------------------ */
  window.addEventListener('offline', function () {
    if (usedOfflineData) updateOfflineBadge();
    else showBadge('🔴 Offline — Sin conexión a internet', '#D8342E');
  });

  window.addEventListener('online', function () {
    if (!usedOfflineData && !hadNoData) {
      showBadge('🟢 Online', '#1E9E5A', 3000);
      return;
    }
    /* La página está mostrando datos viejos (o ninguno): sincronizar
       en segundo plano las mismas consultas de esta sesión y recargar. */
    showBadge('🟢 Conexión recuperada — sincronizando datos…', '#1E9E5A');
    var keys = Object.keys(sessionKeys);
    var jobs = keys.map(function (k) {
      var freshUrl = sessionKeys[k] + (sessionKeys[k].indexOf('?') > -1 ? '&' : '?') + '_=' + Date.now();
      return fetchWithTimeout(freshUrl, { cache: 'no-store' })
        .then(function (r) { if (!r.ok) throw 0; return r.text(); })
        .then(function (text) {
          if (text.indexOf('google.visualization.Query.setResponse') === -1) throw 0;
          var now = Date.now();
          return idbPut(STORE, { key: k, url: sessionKeys[k], text: text, syncedAt: now, schema: DB_VERSION });
        });
    });
    Promise.allSettled(jobs).then(function (results) {
      var okCount = results.filter(function (r) { return r.status === 'fulfilled'; }).length;
      if (okCount > 0) {
        showBadge('🟢 Online — Datos actualizados. Recargando tablero…', '#1E9E5A');
        setTimeout(function () { location.reload(); }, 1200);
      } else {
        showBadge('🟠 No se pudieron actualizar los datos. Mostrando última información disponible.', '#E6A100');
      }
    });
  });

  /* Al cargar sin conexión, mostrar el estado apenas exista el body. */
  document.addEventListener('DOMContentLoaded', function () {
    if (!navigator.onLine) {
      showBadge('🔴 Offline — Mostrando últimos datos sincronizados', '#D8342E');
    }
  });

  /* ------------------------------------------------------------------ */
  /* Registro del Service Worker (app shell + PWA)                       */
  /* ------------------------------------------------------------------ */
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register(SW_FILE).catch(function (err) {
        console.warn('[offline-core] SW no registrado:', err);
      });
    });
  }

  /* API mínima de diagnóstico (opcional, no usada por los dashboards) */
  window.__mpOffline = {
    lastSync: function () { return idbGet(META, 'lastSync'); },
    snapshot: function (k) { return idbGet(STORE, k); }
  };
})();
