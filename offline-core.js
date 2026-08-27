/* =====================================================================
   offline-core.js — Capa Offline-First · Tablero Mi Portal  (v3)
   ---------------------------------------------------------------------
   QUÉ HACE (sin tocar la lógica de ningún dashboard):

   1) Intercepta window.fetch SOLO para URLs de Google Sheets (gviz/tq).
        · Hay snapshot local  → lo devuelve YA (pintado inmediato) y
                                revalida contra la fuente en segundo plano.
        · No hay snapshot     → va a la red normalmente y lo guarda.
        · Sin internet        → devuelve el último snapshot válido.
        · Sin internet ni snapshot → falla y avisa
                                "No hay datos disponibles offline."
   2) Guarda cada respuesta REAL de la fuente en IndexedDB, byte a byte.
      Nunca inventa, nunca mezcla, nunca hace merge: cada sincronización
      reemplaza el snapshot completo de esa consulta (idempotente).
   3) Indicador de estado flotante: 🟢 ONLINE · 🟠 SIN CONEXIÓN ·
      🔄 SINCRONIZANDO · ✅ ACTUALIZADO + "Última actualización DD/MM/AAAA HH:MM".
   4) Detecta el regreso de internet y resincroniza automáticamente,
      llamando al cargador propio de cada tablero (window.MP_RESYNC).
   5) Registra el Service Worker y ofrece el botón "📲 Instalar Tablero".

   REGLAS DURAS
   · Si una actualización falla, se conservan los últimos datos válidos.
   · Las respuestas gviz con "status":"error" NUNCA se cachean (son parte
     de la cascada normal de reintentos de los tableros).
   · No se guardan credenciales ni tokens: solo respuestas públicas de
     lectura de Google Sheets.

   CONFIGURACIÓN POR PÁGINA (antes de cargar este script):
     window.MP_RESYNC       = 'iniciar';   // función que recarga el tablero
     window.MP_SWR          = false;       // desactiva el modo "local primero"
     window.MP_STATUS_CHIP  = false;       // oculta el indicador flotante
   ===================================================================== */
(function () {
  'use strict';

  /* ------------------------------------------------------------------ */
  /* Configuración                                                       */
  /* ------------------------------------------------------------------ */
  var DB_NAME = 'mp_offline';
  var DB_VERSION = 2;
  var STORE = 'gvizSnapshots';     // snapshots de respuestas gviz
  var META = 'meta';               // metadatos (última sync global, estado UI)
  var FETCH_TIMEOUT_MS = 30000;    // 1er intento
  var RETRY_TIMEOUT_MS = 60000;    // reintento con timeout extendido
  var RETRY_EVERY_MS = 120000;     // reintento periódico tras un fallo
  var SW_FILE = 'service-worker.js';

  var GVIZ_HOST = 'docs.google.com';
  var GVIZ_PATH = '/gviz/tq';
  /* Parámetros "cache-buster" que NO son parte de la identidad de la
     consulta (cada tablero usa uno distinto: _, cb, _ts, t). */
  var VOLATILE_PARAMS = ['_', 'cb', '_ts', 't', '_mp'];

  var NATIVE_FETCH = window.fetch.bind(window);
  var SWR_ENABLED = (window.MP_SWR !== false);
  var CHIP_ENABLED = (window.MP_STATUS_CHIP !== false);

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
        tx.oncomplete = function () { resolve(true); };
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
  function idbDelete(store, key) {
    return openDB().then(function (db) {
      return new Promise(function (resolve) {
        var tx = db.transaction(store, 'readwrite');
        tx.objectStore(store).delete(key);
        tx.oncomplete = resolve; tx.onerror = resolve;
      });
    });
  }
  function idbAll(store) {
    return openDB().then(function (db) {
      return new Promise(function (resolve) {
        var out = [];
        var tx = db.transaction(store, 'readonly');
        var rq = tx.objectStore(store).openCursor();
        rq.onsuccess = function (e) {
          var c = e.target.result;
          if (c) { out.push(c.value); c.continue(); } else resolve(out);
        };
        rq.onerror = function () { resolve(out); };
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
  /* Identidad estable de la consulta: host + path + params ordenados,
     descartando los cache-busters. Así el mismo pedido cae siempre en la
     misma clave y nunca se duplican snapshots. */
  function normalizeKey(url) {
    var u = new URL(url, location.href);
    var params = [];
    u.searchParams.forEach(function (v, k) {
      if (VOLATILE_PARAMS.indexOf(k) === -1) params.push(k + '=' + v);
    });
    params.sort();
    return u.hostname + u.pathname + '?' + params.join('&');
  }
  function bustUrl(url) {
    return url + (url.indexOf('?') > -1 ? '&' : '?') + '_mp=' + Date.now();
  }
  /* Válido = respuesta gviz real Y sin estado de error.
     Los errores gviz llegan con HTTP 200: nunca deben cachearse. */
  function isValidGviz(text) {
    return !!text &&
      text.indexOf('google.visualization.Query.setResponse') !== -1 &&
      text.indexOf('"status":"error"') === -1 &&
      text.indexOf("'status':'error'") === -1;
  }
  function p2(n) { return (n < 10 ? '0' : '') + n; }
  function fmtDateTime(ts) {
    if (!ts) return '\u2014';
    var d = new Date(ts);
    if (isNaN(d)) return '\u2014';
    return p2(d.getDate()) + '/' + p2(d.getMonth() + 1) + '/' + d.getFullYear() +
           ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes());
  }
  function fetchWithTimeout(url, opts, ms) {
    var ctrl = ('AbortController' in window) ? new AbortController() : null;
    var o = {};
    if (opts) for (var k in opts) if (Object.prototype.hasOwnProperty.call(opts, k)) o[k] = opts[k];
    if (ctrl) o.signal = ctrl.signal;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, ms || FETCH_TIMEOUT_MS);
    return NATIVE_FETCH(url, o).then(
      function (r) { clearTimeout(timer); return r; },
      function (e) { clearTimeout(timer); throw e; }
    );
  }
  function mkResponse(text, extraHeaders) {
    var h = { 'Content-Type': 'text/plain; charset=utf-8' };
    if (extraHeaders) for (var k in extraHeaders) h[k] = extraHeaders[k];
    return new Response(text, { status: 200, headers: h });
  }

  /* ------------------------------------------------------------------ */
  /* Estado de la sesión                                                 */
  /* ------------------------------------------------------------------ */
  var S = {
    keys: {},              // key -> url original (para resincronizar)
    revalidated: {},       // key -> true (ya revalidada en esta carga)
    usedCache: false,      // alguna respuesta salió de IndexedDB
    noData: false,         // se pidió algo que no existe offline
    lastSync: null,        // timestamp del dato más reciente mostrado
    syncing: 0,            // consultas en vuelo
    lastError: null
  };

  function emitData(key, text, fromCache, netError, syncedAt) {
    document.dispatchEvent(new CustomEvent('mp:gviz-data', {
      detail: { key: key, text: text, fromCache: fromCache, netError: netError, syncedAt: syncedAt }
    }));
  }

  /* ------------------------------------------------------------------ */
  /* Indicador de estado flotante                                        */
  /* ------------------------------------------------------------------ */
  var chip = null, chipDot = null, chipTxt = null, chipSub = null,
      chipBtn = null, installBtn = null, collapseTimer = null;

  var CHIP_CSS = [
    '#mp-chip{position:fixed;left:14px;bottom:14px;z-index:99999;display:none;',
      'align-items:center;gap:9px;font-family:Inter,system-ui,sans-serif;',
      'background:#0D0D0D;color:#fff;border-radius:22px;padding:8px 13px;',
      'box-shadow:0 4px 18px rgba(0,0,0,.28);font-size:12.5px;line-height:1.3;',
      'max-width:min(92vw,460px);cursor:pointer;user-select:none}',
    '#mp-chip .mp-dot{width:9px;height:9px;border-radius:50%;flex:0 0 auto;',
      'box-shadow:0 0 0 3px rgba(255,255,255,.10)}',
    '#mp-chip .mp-dot.ok{background:#1E9E5A}',
    '#mp-chip .mp-dot.warn{background:#E6A100}',
    '#mp-chip .mp-dot.bad{background:#D8342E}',
    '#mp-chip .mp-dot.busy{background:#82E1FF;animation:mpPulse 1s ease-in-out infinite}',
    '@keyframes mpPulse{0%,100%{opacity:1}50%{opacity:.35}}',
    '#mp-chip .mp-body{display:none;min-width:0}',
    '#mp-chip.open .mp-body{display:block}',
    '#mp-chip .mp-txt{font-weight:700;letter-spacing:.02em;white-space:nowrap}',
    '#mp-chip .mp-sub{color:rgba(255,255,255,.62);font-size:11px}',
    '#mp-chip .mp-sub b{color:#fff;font-weight:700}',
    '#mp-chip .mp-act{display:none;background:transparent;border:0;color:rgba(255,255,255,.75);',
      'cursor:pointer;font-size:14px;padding:2px 5px;border-radius:6px;line-height:1}',
    '#mp-chip.open .mp-act{display:inline-block}',
    '#mp-chip .mp-act:hover{background:rgba(255,255,255,.12);color:#fff}',
    '#mp-install{position:fixed;left:14px;bottom:60px;z-index:99999;display:none;',
      'align-items:center;gap:7px;font-family:Inter,system-ui,sans-serif;font-size:12.5px;',
      'font-weight:700;background:#E8241B;color:#fff;border:0;border-radius:22px;',
      'padding:9px 15px;cursor:pointer;box-shadow:0 4px 18px rgba(232,36,27,.35)}',
    '#mp-install:hover{background:#E61A27}',
    '@media print{#mp-chip,#mp-install{display:none !important}}'
  ].join('');

  function buildChip() {
    if (chip || !CHIP_ENABLED || !document.body) return chip;
    var st = document.createElement('style');
    st.textContent = CHIP_CSS;
    document.head.appendChild(st);

    chip = document.createElement('div');
    chip.id = 'mp-chip';
    chip.className = 'open';
    chip.setAttribute('role', 'status');
    chip.title = 'Estado de los datos \u00B7 toc\u00E1 para expandir o contraer';
    chip.innerHTML =
      '<span class="mp-dot ok"></span>' +
      '<span class="mp-body">' +
        '<span class="mp-txt">ONLINE</span><br>' +
        '<span class="mp-sub">\u00DAltima actualizaci\u00F3n: \u2014</span>' +
      '</span>' +
      '<button class="mp-act" type="button" title="Sincronizar ahora">&#8635;</button>';
    document.body.appendChild(chip);

    chipDot = chip.querySelector('.mp-dot');
    chipTxt = chip.querySelector('.mp-txt');
    chipSub = chip.querySelector('.mp-sub');
    chipBtn = chip.querySelector('.mp-act');

    chip.addEventListener('click', function (ev) {
      if (ev.target === chipBtn) return;
      chip.classList.toggle('open');
    });
    chipBtn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      syncNow();
    });

    installBtn = document.createElement('button');
    installBtn.id = 'mp-install';
    installBtn.type = 'button';
    installBtn.textContent = '\uD83D\uDCF2 Instalar Tablero';
    document.body.appendChild(installBtn);
    installBtn.addEventListener('click', doInstall);

    return chip;
  }

  /* estados: online | offline | syncing | updated | stale | nodata */
  function setChip(state, sub, autoCollapseMs) {
    if (!CHIP_ENABLED) return;
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', function () { setChip(state, sub, autoCollapseMs); });
      return;
    }
    buildChip();
    var map = {
      online:  { cls: 'ok',   txt: '\uD83D\uDFE2 ONLINE' },
      updated: { cls: 'ok',   txt: '\u2705 ACTUALIZADO' },
      syncing: { cls: 'busy', txt: '\uD83D\uDD04 SINCRONIZANDO' },
      offline: { cls: 'warn', txt: '\uD83D\uDFE0 SIN CONEXI\u00D3N' },
      stale:   { cls: 'warn', txt: '\uD83D\uDFE0 SIN ACTUALIZAR' },
      nodata:  { cls: 'bad',  txt: '\uD83D\uDD34 SIN DATOS LOCALES' }
    };
    var m = map[state] || map.online;
    chipDot.className = 'mp-dot ' + m.cls;
    chipTxt.textContent = m.txt;
    chipSub.innerHTML = sub || ('\u00DAltima actualizaci\u00F3n: <b>' + fmtDateTime(S.lastSync) + '</b>');
    chip.style.display = 'flex';
    chip.classList.add('open');
    clearTimeout(collapseTimer);
    if (autoCollapseMs) {
      collapseTimer = setTimeout(function () { if (chip) chip.classList.remove('open'); }, autoCollapseMs);
    }
  }

  function refreshChip() {
    if (S.syncing > 0) { setChip('syncing', 'Actualizando datos\u2026'); return; }
    if (!navigator.onLine) {
      if (S.noData && !S.usedCache) {
        setChip('nodata', 'No hay datos disponibles offline.<br>Conectate a internet una vez para sincronizar.');
      } else {
        setChip('offline', 'Mostrando la \u00FAltima informaci\u00F3n disponible<br>\u00DAltima actualizaci\u00F3n: <b>' + fmtDateTime(S.lastSync) + '</b>');
      }
      return;
    }
    if (S.lastError) {
      setChip('stale', 'No se pudo actualizar (' + S.lastError + ').<br>\u00DAltima actualizaci\u00F3n: <b>' + fmtDateTime(S.lastSync) + '</b>');
      return;
    }
    setChip('online', null, 6000);
  }

  /* ------------------------------------------------------------------ */
  /* Guardado / lectura de snapshots                                     */
  /* ------------------------------------------------------------------ */
  function saveSnapshot(key, url, text) {
    var now = Date.now();
    return idbPut(STORE, {
      key: key,
      url: url.split(/[?&](?:_|cb|_ts|t|_mp)=/)[0],
      text: text,
      bytes: text.length,
      syncedAt: now,
      schema: DB_VERSION
    }).then(function () {
      return idbPut(META, { key: 'lastSync', ts: now });
    }).then(function () { return now; })
      .catch(function () { return now; });   // best-effort: nunca rompe el tablero
  }

  function readSnapshot(key) {
    return idbGet(STORE, key).then(function (rec) {
      /* Higiene: descartar snapshots inválidos heredados de versiones viejas */
      if (rec && rec.text && !isValidGviz(rec.text)) { idbDelete(STORE, key); return null; }
      return (rec && rec.text) ? rec : null;
    }).catch(function () { return null; });
  }

  /* ------------------------------------------------------------------ */
  /* Revalidación en segundo plano (stale-while-revalidate)              */
  /* ------------------------------------------------------------------ */
  var resyncTimer = null;
  function scheduleResync() {
    clearTimeout(resyncTimer);
    resyncTimer = setTimeout(runResyncHook, 900);
  }
  function runResyncHook() {
    var name = window.MP_RESYNC;
    if (name && typeof window[name] === 'function') {
      try { window[name](); return; } catch (e) { /* cae al reload */ }
    }
    /* Sin hook declarado: recarga controlada, máx. 1 por minuto */
    var last = +(sessionStorage.getItem('mp_reload_guard') || 0);
    if (Date.now() - last < 60000) return;
    sessionStorage.setItem('mp_reload_guard', String(Date.now()));
    location.reload();
  }

  function revalidate(key, url, cachedText) {
    if (S.revalidated[key] || !navigator.onLine) return;
    S.revalidated[key] = true;
    S.syncing++; refreshChip();
    fetchWithTimeout(bustUrl(url), { cache: 'no-store' }, RETRY_TIMEOUT_MS)
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.text();
      })
      .then(function (text) {
        if (!isValidGviz(text)) return null;            // error gviz: no se cachea
        if (text === cachedText) {                      // sin cambios: no se re-renderiza
          S.lastError = null;
          S.lastSync = Date.now();
          return idbPut(META, { key: 'lastSync', ts: S.lastSync });
        }
        return saveSnapshot(key, url, text).then(function (ts) {
          S.lastSync = ts; S.lastError = null;
          setChip('updated', 'Datos actualizados \u00B7 <b>' + fmtDateTime(ts) + '</b>', 6000);
          scheduleResync();                             // el tablero relee (ya desde IDB)
        });
      })
      .catch(function (e) {
        S.lastError = (e && e.message) ? e.message : 'sin respuesta de la fuente';
        scheduleRetry();
      })
      .then(function () { S.syncing--; refreshChip(); });
  }

  /* ------------------------------------------------------------------ */
  /* Reintento periódico tras un fallo                                   */
  /* ------------------------------------------------------------------ */
  var retryTimer = null;
  function scheduleRetry() {
    if (retryTimer) return;
    retryTimer = setTimeout(function () {
      retryTimer = null;
      if (navigator.onLine && S.lastError) syncNow(true);
    }, RETRY_EVERY_MS);
  }

  /* ------------------------------------------------------------------ */
  /* Sincronización manual / al volver internet                          */
  /* ------------------------------------------------------------------ */
  function syncNow(silent) {
    var keys = Object.keys(S.keys);
    if (!keys.length) {
      if (!silent) setChip('online', 'Este m\u00F3dulo no consulta datos externos.', 5000);
      return Promise.resolve(false);
    }
    S.syncing++; refreshChip();
    var changed = false;
    var jobs = keys.map(function (k) {
      var url = S.keys[k];
      return fetchWithTimeout(bustUrl(url), { cache: 'no-store' }, RETRY_TIMEOUT_MS)
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
        .then(function (text) {
          if (!isValidGviz(text)) throw new Error('respuesta inv\u00E1lida');
          return readSnapshot(k).then(function (rec) {
            if (rec && rec.text === text) return false;
            return saveSnapshot(k, url, text).then(function () { changed = true; return true; });
          });
        });
    });
    return Promise.all(jobs.map(function (p) {
      return p.then(function (v) { return { ok: true, v: v }; }, function (e) { return { ok: false, e: e }; });
    })).then(function (res) {
      S.syncing--;
      var okCount = res.filter(function (r) { return r.ok; }).length;
      if (okCount === 0) {
        S.lastError = 'la fuente no respondi\u00F3';
        refreshChip();
        scheduleRetry();
        return false;
      }
      S.lastError = null;
      S.lastSync = Date.now();
      if (changed) {
        setChip('updated', 'Datos actualizados \u00B7 <b>' + fmtDateTime(S.lastSync) + '</b>', 6000);
        S.revalidated = {};                 // el tablero volverá a leer de IDB
        scheduleResync();
      } else {
        setChip('updated', 'Ya ten\u00EDas la \u00FAltima versi\u00F3n \u00B7 <b>' + fmtDateTime(S.lastSync) + '</b>', 5000);
      }
      return true;
    });
  }

  /* ------------------------------------------------------------------ */
  /* Interceptor de fetch (solo gviz)                                    */
  /* ------------------------------------------------------------------ */
  function fromNetwork(key, url, init, timeout) {
    return fetchWithTimeout(url, init, timeout).then(function (res) {
      /* HTTP != 200 (permisos, etc.): passthrough — cada tablero tiene su
         propio mensaje ("¿el Sheet está compartido…?"). */
      if (!res.ok) return res;
      return res.text().then(function (text) {
        if (!isValidGviz(text)) return mkResponse(text);   // error gviz: sin cachear
        return saveSnapshot(key, url, text).then(function (ts) {
          S.lastSync = ts; S.lastError = null;
          emitData(key, text, false, false, ts);
          refreshChip();
          return mkResponse(text);
        });
      });
    });
  }

  function fromCacheOrFail(key, netErr) {
    return readSnapshot(key).then(function (rec) {
      if (rec) {
        S.usedCache = true;
        if (!S.lastSync || rec.syncedAt < S.lastSync) S.lastSync = rec.syncedAt;
        S.lastError = navigator.onLine ? ((netErr && netErr.message) || 'sin respuesta') : null;
        emitData(key, rec.text, true, true, rec.syncedAt);
        refreshChip();
        if (navigator.onLine) scheduleRetry();
        return mkResponse(rec.text, { 'X-MP-Offline': '1' });
      }
      S.noData = true;
      document.dispatchEvent(new CustomEvent('mp:gviz-error', { detail: { key: key } }));
      refreshChip();
      throw netErr;
    });
  }

  function retryThenCache(key, url, init, err) {
    if (!navigator.onLine) return fromCacheOrFail(key, err);
    /* Con internet activo: un reintento silencioso con timeout extendido
       antes de tocar IndexedDB (las fuentes VTEX son grandes). */
    return fromNetwork(key, bustUrl(url), init, RETRY_TIMEOUT_MS)
      .catch(function (e2) { return fromCacheOrFail(key, e2); });
  }

  window.fetch = function (input, init) {
    var url = (typeof input === 'string') ? input : (input && input.url) || '';
    if (!isGvizUrl(url)) return NATIVE_FETCH(input, init);

    var key = normalizeKey(url);
    S.keys[key] = url;

    /* SIN internet → directo al snapshot local */
    if (!navigator.onLine) return fromCacheOrFail(key, new Error('offline'));

    /* CON internet + snapshot local → local primero, revalidar detrás */
    if (SWR_ENABLED) {
      return readSnapshot(key).then(function (rec) {
        if (rec) {
          S.usedCache = true;
          if (!S.lastSync || rec.syncedAt > S.lastSync) S.lastSync = rec.syncedAt;
          emitData(key, rec.text, true, false, rec.syncedAt);
          revalidate(key, url, rec.text);
          return mkResponse(rec.text, { 'X-MP-Offline': '1' });
        }
        return fromNetwork(key, url, init, FETCH_TIMEOUT_MS)
          .catch(function (e) { return retryThenCache(key, url, init, e); });
      });
    }

    return fromNetwork(key, url, init, FETCH_TIMEOUT_MS)
      .catch(function (e) { return retryThenCache(key, url, init, e); });
  };

  /* ------------------------------------------------------------------ */
  /* Eventos de conexión                                                 */
  /* ------------------------------------------------------------------ */
  window.addEventListener('offline', function () { refreshChip(); });

  window.addEventListener('online', function () {
    setChip('syncing', 'Conexi\u00F3n recuperada \u2014 sincronizando\u2026');
    S.revalidated = {};
    syncNow();
  });

  document.addEventListener('DOMContentLoaded', function () {
    buildChip();
    idbGet(META, 'lastSync').then(function (m) {
      if (m && m.ts && !S.lastSync) S.lastSync = m.ts;
      refreshChip();
    }).catch(refreshChip);
  });

  /* ------------------------------------------------------------------ */
  /* Instalación (PWA)                                                   */
  /* ------------------------------------------------------------------ */
  var deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferredPrompt = e;
    buildChip();
    if (installBtn) installBtn.style.display = 'flex';
  });
  window.addEventListener('appinstalled', function () {
    deferredPrompt = null;
    if (installBtn) installBtn.style.display = 'none';
  });
  function doInstall() {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    deferredPrompt.userChoice.then(function () {
      deferredPrompt = null;
      if (installBtn) installBtn.style.display = 'none';
    });
  }

  /* ------------------------------------------------------------------ */
  /* Service Worker: registro + actualización de la APLICACIÓN           */
  /* (distinta de la actualización de los DATOS, que vive en IndexedDB)  */
  /* ------------------------------------------------------------------ */
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register(SW_FILE).then(function (reg) {
        reg.addEventListener('updatefound', function () {
          var sw = reg.installing;
          if (!sw) return;
          sw.addEventListener('statechange', function () {
            if (sw.state === 'installed' && navigator.serviceWorker.controller) {
              /* Hay una versión nueva de la APLICACIÓN esperando.
                 Los datos locales NO se tocan. */
              setChip('updated', 'Hay una versi\u00F3n nueva del tablero.<br><u>Toc\u00E1 el indicador para aplicarla</u>.');
              if (chip) {
                chip.addEventListener('click', function once() {
                  sw.postMessage({ type: 'SKIP_WAITING' });
                  chip.removeEventListener('click', once);
                });
              }
            }
          });
        });
      }).catch(function (err) {
        console.warn('[offline-core] Service Worker no registrado:', err);
      });

      var reloaded = false;
      navigator.serviceWorker.addEventListener('controllerchange', function () {
        if (reloaded) return;
        reloaded = true;
        location.reload();
      });
    });
  }

  /* ------------------------------------------------------------------ */
  /* API pública de diagnóstico (consola del navegador)                  */
  /* ------------------------------------------------------------------ */
  window.MPOffline = {
    version: 'v3',
    lastSync: function () { return idbGet(META, 'lastSync'); },
    snapshots: function () {
      return idbAll(STORE).then(function (all) {
        return all.map(function (r) {
          return { key: r.key, kb: Math.round((r.bytes || 0) / 1024), sync: fmtDateTime(r.syncedAt) };
        });
      });
    },
    syncNow: function () { return syncNow(); },
    /* Borra SOLO los datos locales (no desinstala la app) */
    purgeData: function () {
      return idbAll(STORE).then(function (all) {
        return Promise.all(all.map(function (r) { return idbDelete(STORE, r.key); }));
      });
    },
    /* Guardado opcional de estado de UI (filtros, selecciones) por página */
    saveUIState: function (obj) {
      return idbPut(META, { key: 'ui:' + location.pathname, state: obj, ts: Date.now() });
    },
    loadUIState: function () {
      return idbGet(META, 'ui:' + location.pathname).then(function (r) { return r ? r.state : null; });
    }
  };
})();
