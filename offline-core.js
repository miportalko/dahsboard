/* =====================================================================
   offline-core.js — Capa Offline-First para la suite Mi Portal CC (v2)
   ---------------------------------------------------------------------
   Intercepta window.fetch SOLO para URLs de Google Sheets (gviz/tq):

   · CON internet  → fetch real → guarda snapshot en IndexedDB → dashboard
   · SIN internet  → último snapshot válido de IndexedDB → dashboard
   · Sin snapshot  → deja fallar el fetch y avisa
                     "No hay datos disponibles offline."

   Correcciones v2:
   · Las respuestas gviz con "status":"error" (SELECT rechazado, hoja
     inexistente, etc.) se PASAN AL DASHBOARD sin cachear ni mostrar
     badges: son parte de su cascada normal de reintentos.
   · El fallback a IndexedDB solo se activa cuando la RED falla de
     verdad (reject/abort). Con internet activo se hace primero un
     reintento silencioso con timeout extendido.
   · Timeouts ampliados (30s / 60s) para fuentes grandes (97 columnas).
   · Badges verde/ámbar se muestran UNA vez por carga, no por consulta.
   · Snapshots de error heredados de v1 se detectan y eliminan.
   · La recarga automática al volver internet tiene guarda anti-bucle.
   ===================================================================== */
(function () {
  'use strict';

  var DB_NAME = 'mp_offline';
  var DB_VERSION = 1;
  var STORE = 'gvizSnapshots';
  var META = 'meta';
  var FETCH_TIMEOUT_MS = 30000;       // 1er intento
  var RETRY_TIMEOUT_MS = 60000;       // reintento silencioso online
  var SW_FILE = 'service-worker.js';

  var GVIZ_HOST = 'docs.google.com';
  var GVIZ_PATH = '/gviz/tq';
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
        tx.oncomplete = resolve; tx.onerror = function () { reject(tx.error); };
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
  function idbDelete(store, key) {
    return openDB().then(function (db) {
      return new Promise(function (resolve) {
        var tx = db.transaction(store, 'readwrite');
        tx.objectStore(store).delete(key);
        tx.oncomplete = resolve; tx.onerror = resolve;
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
  function normalizeKey(url) {
    var u = new URL(url, location.href);
    var params = [];
    u.searchParams.forEach(function (v, k) {
      if (VOLATILE_PARAMS.indexOf(k) === -1) params.push(k + '=' + v);
    });
    params.sort();
    return u.hostname + u.pathname + '?' + params.join('&');
  }

  /* Válido = respuesta gviz real Y sin estado de error.
     Los errores gviz llegan con HTTP 200: nunca deben cachearse. */
  function isValidGviz(text) {
    return !!text &&
      text.indexOf('google.visualization.Query.setResponse') !== -1 &&
      text.indexOf('"status":"error"') === -1 &&
      text.indexOf("'status':'error'") === -1;
  }
  function isGvizError(text) {
    return !!text &&
      text.indexOf('google.visualization.Query.setResponse') !== -1 &&
      !isValidGviz(text);
  }

  function fmtDate(ts) {
    if (!ts) return '—';
    var d = new Date(ts);
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return p(d.getDate()) + '/' + p(d.getMonth() + 1) + '/' + d.getFullYear() +
           ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function fetchWithTimeout(url, opts, ms) {
    var ctrl = ('AbortController' in window) ? new AbortController() : null;
    var o = Object.assign({}, opts || {});
    if (ctrl) o.signal = ctrl.signal;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, ms || FETCH_TIMEOUT_MS);
    return NATIVE_FETCH(url, o).finally(function () { clearTimeout(timer); });
  }

  function mkResponse(text, extraHeaders) {
    var h = Object.assign({ 'Content-Type': 'text/plain; charset=utf-8' }, extraHeaders || {});
    return new Response(text, { status: 200, headers: h });
  }

  /* ------------------------------------------------------------------ */
  /* Indicador de estado                                                 */
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

  /* ------------------------------------------------------------------ */
  /* Estado de sesión                                                    */
  /* ------------------------------------------------------------------ */
  var usedOfflineData = false;
  var hadNoData = false;
  var sessionKeys = {};
  var oldestShownSync = null;
  var shownGreen = false;   // badge verde: máx. 1 vez por carga
  var shownAmber = false;   // badge ámbar: máx. 1 vez por carga

  function updateOfflineBadge() {
    if (hadNoData && !usedOfflineData) {
      showBadge('🔴 Offline — <b>No hay datos disponibles offline.</b><br>Conectate a internet al menos una vez para sincronizar.', '#D8342E');
    } else if (usedOfflineData) {
      showBadge('🔴 Offline — Mostrando últimos datos sincronizados<br>Última sincronización: <b>' + fmtDate(oldestShownSync) + '</b>', '#D8342E');
    }
  }

  function emitData(key, text, fromCache, netError, syncedAt) {
    document.dispatchEvent(new CustomEvent('mp:gviz-data', {
      detail: { key: key, text: text, fromCache: fromCache, netError: netError, syncedAt: syncedAt }
    }));
  }

  /* ------------------------------------------------------------------ */
  /* Interceptor de fetch (solo gviz)                                    */
  /* ------------------------------------------------------------------ */
  var NATIVE_FETCH = window.fetch.bind(window);

  function handleSuccess(key, url, text) {
    var now = Date.now();
    idbPut(STORE, { key: key, url: url.split(/[?&](?:_|cb|_ts)=/)[0], text: text, syncedAt: now, schema: DB_VERSION })
      .then(function () { return idbPut(META, { key: 'lastSync', ts: now }); })
      .catch(function () { /* best-effort */ });
    emitData(key, text, false, false, now);
    if (!shownGreen) {
      shownGreen = true;
      showBadge('🟢 Online — Datos actualizados · ' + fmtDate(now), '#1E9E5A', 4000);
    }
    return mkResponse(text);
  }

  function fallbackToCache(key, netErr) {
    return idbGet(STORE, key).then(function (rec) {
      /* Limpiar snapshots de error heredados de la v1 */
      if (rec && rec.text && !isValidGviz(rec.text)) {
        idbDelete(STORE, key);
        rec = null;
      }
      if (rec && rec.text) {
        usedOfflineData = true;
        if (!oldestShownSync || rec.syncedAt < oldestShownSync) oldestShownSync = rec.syncedAt;
        emitData(key, rec.text, true, true, rec.syncedAt);
        if (navigator.onLine) {
          if (!shownAmber) {
            shownAmber = true;
            showBadge('🟠 No se pudieron actualizar los datos. Mostrando última información disponible.<br>Última sincronización: <b>' + fmtDate(rec.syncedAt) + '</b>', '#E6A100', 8000);
          }
        } else {
          updateOfflineBadge();
        }
        return mkResponse(rec.text, { 'X-MP-Offline': '1' });
      }
      hadNoData = true;
      document.dispatchEvent(new CustomEvent('mp:gviz-error', { detail: { key: key } }));
      updateOfflineBadge();
      throw netErr;
    });
  }

  window.fetch = function (input, init) {
    var url = (typeof input === 'string') ? input : (input && input.url) || '';
    if (!isGvizUrl(url)) return NATIVE_FETCH(input, init);

    var key = normalizeKey(url);
    sessionKeys[key] = url;

    return fetchWithTimeout(url, init, FETCH_TIMEOUT_MS).then(function (res) {
      /* HTTP != 200 (permisos, etc.): passthrough — el dashboard tiene
         su propio mensaje ("¿el Sheet está compartido…?"). */
      if (!res.ok) return res;
      return res.text().then(function (text) {
        if (isValidGviz(text)) return handleSuccess(key, url, text);
        /* Error gviz ("status":"error") o cuerpo no-gviz con red viva:
           PASSTHROUGH sin cachear, sin badges, sin IDB. Es la cascada
           normal de reintentos del dashboard (SELECT → hoja completa). */
        return mkResponse(text);
      });
    }).catch(function (netErr) {
      /* La red falló de verdad (reject / abort por timeout). */
      if (navigator.onLine) {
        /* Con internet activo: un reintento silencioso con timeout
           extendido antes de tocar IndexedDB (fuentes grandes). */
        return fetchWithTimeout(url, init, RETRY_TIMEOUT_MS).then(function (res2) {
          if (!res2.ok) return res2;
          return res2.text().then(function (text2) {
            if (isValidGviz(text2)) return handleSuccess(key, url, text2);
            return mkResponse(text2);
          });
        }).catch(function (err2) {
          return fallbackToCache(key, err2);
        });
      }
      return fallbackToCache(key, netErr);
    });
  };

  /* ------------------------------------------------------------------ */
  /* Online/offline + resincronización con guarda anti-bucle             */
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
    /* Anti-bucle: máximo una recarga automática por minuto. */
    var last = +(sessionStorage.getItem('mp_resync_reload') || 0);
    if (Date.now() - last < 60000) return;

    showBadge('🟢 Conexión recuperada — sincronizando datos…', '#1E9E5A');
    var keys = Object.keys(sessionKeys);
    var jobs = keys.map(function (k) {
      var freshUrl = sessionKeys[k] + (sessionKeys[k].indexOf('?') > -1 ? '&' : '?') + '_=' + Date.now();
      return fetchWithTimeout(freshUrl, { cache: 'no-store' }, RETRY_TIMEOUT_MS)
        .then(function (r) { if (!r.ok) throw 0; return r.text(); })
        .then(function (text) {
          if (!isValidGviz(text)) throw 0;
          return idbPut(STORE, { key: k, url: sessionKeys[k], text: text, syncedAt: Date.now(), schema: DB_VERSION });
        });
    });
    Promise.allSettled(jobs).then(function (results) {
      var okCount = results.filter(function (r) { return r.status === 'fulfilled'; }).length;
      if (okCount > 0) {
        sessionStorage.setItem('mp_resync_reload', String(Date.now()));
        showBadge('🟢 Online — Datos actualizados. Recargando tablero…', '#1E9E5A');
        setTimeout(function () { location.reload(); }, 1200);
      } else {
        showBadge('🟠 No se pudieron actualizar los datos. Mostrando última información disponible.', '#E6A100');
      }
    });
  });

  document.addEventListener('DOMContentLoaded', function () {
    if (!navigator.onLine) {
      showBadge('🔴 Offline — Mostrando últimos datos sincronizados', '#D8342E');
    }
  });

  /* ------------------------------------------------------------------ */
  /* Service Worker + API de diagnóstico                                 */
  /* ------------------------------------------------------------------ */
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register(SW_FILE).catch(function (err) {
        console.warn('[offline-core] SW no registrado:', err);
      });
    });
  }
  window.__mpOffline = {
    lastSync: function () { return idbGet(META, 'lastSync'); },
    snapshot: function (k) { return idbGet(STORE, k); }
  };
})();
