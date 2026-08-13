/* =====================================================================
   mp-standard.js — Componentes estándar de la suite Mi Portal CC
   ---------------------------------------------------------------------
   1) window.MP: formateadores centralizados (moneda ₲, números,
      porcentajes y fechas DD/MM/YYYY) para uso compartido.
   2) Bloque de metadatos estándar bajo el header de cada dashboard:
        · Datos disponibles hasta:  máxima fecha REAL encontrada en las
          respuestas de Google Sheets (calculada dinámicamente, nunca
          escrita a mano).
        · Última sincronización:    momento real de la consulta a la
          fuente (o del snapshot guardado, si se está offline).
        · Fuente: Google Sheets
        · Semáforo:  🟢 Datos actualizados
                     🟡 Datos con retraso (fuente responde, pero la
                        última fecha de negocio es vieja) o datos
                        servidos desde caché local
                     🔴 Fuente no disponible / error de conexión

   Se alimenta de los eventos 'mp:gviz-data' que emite offline-core.js
   cada vez que un dashboard consulta gviz. No modifica la lógica de
   ningún tablero ni sus conexiones.
   ===================================================================== */
(function () {
  'use strict';

  /* Umbral de "retraso": si la última fecha de negocio es anterior a
     hoy − N días, el estado pasa a 🟡. Ajustable por página con
     window.MP_STALE_DAYS antes de cargar este script. */
  var STALE_DAYS = (typeof window.MP_STALE_DAYS === 'number') ? window.MP_STALE_DAYS : 3;

  /* ------------------------------------------------------------------ */
  /* 1) Formateadores centralizados                                     */
  /* ------------------------------------------------------------------ */
  var nf = new Intl.NumberFormat('es-PY');
  function p2(n) { return (n < 10 ? '0' : '') + n; }

  var MP = {
    /* Moneda completa:  ₲ 125.450.000 */
    fmtGs: function (n) { return '\u20B2 ' + nf.format(Math.round(n || 0)); },
    /* Moneda compacta:  ₲ 1,25 MM (1e9) · ₲ 125 M (1e6) */
    fmtGsCompact: function (n) {
      n = n || 0; var s = n < 0 ? '-' : ''; var a = Math.abs(n);
      if (a >= 1e9) return s + '\u20B2 ' + (a / 1e9).toFixed(2).replace('.', ',') + ' MM';
      if (a >= 1e6) return s + '\u20B2 ' + Math.round(a / 1e6) + ' M';
      return s + MP.fmtGs(a);
    },
    fmtNum: function (n) { return nf.format(Math.round(n || 0)); },
    fmtPct: function (n, d) { return (isFinite(n) ? (+n).toFixed(d == null ? 1 : d).replace('.', ',') : '0') + '%'; },
    /* Fecha estándar de la plataforma: DD/MM/YYYY */
    fmtDate: function (d) {
      if (!(d instanceof Date) || isNaN(d)) return '\u2014';
      return p2(d.getDate()) + '/' + p2(d.getMonth() + 1) + '/' + d.getFullYear();
    },
    fmtDateTime: function (d) {
      if (!(d instanceof Date) || isNaN(d)) return '\u2014';
      return MP.fmtDate(d) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes());
    }
  };
  window.MP = MP;

  /* ------------------------------------------------------------------ */
  /* 2) Estado agregado de la página                                    */
  /* ------------------------------------------------------------------ */
  var state = {
    maxDataDate: null,   // máxima fecha de negocio real en la(s) fuente(s)
    lastSyncAt: null,    // última consulta / snapshot
    anyFromCache: false, // alguna respuesta vino de IndexedDB
    anyNetError: false,  // alguna consulta a la fuente falló
    gotAnyData: false
  };

  /* Extrae la fecha máxima de una respuesta gviz cruda leyendo solo
     los valores tipados Date(y,m,d[,...]) que Google devuelve.
     No estima ni completa: si no hay columnas de fecha, no hay fecha. */
  function scanMaxDate(gvizText) {
    var re = /"v":"Date\((\d{4}),(\d{1,2}),(\d{1,2})/g;
    var m, max = null;
    while ((m = re.exec(gvizText)) !== null) {
      var d = new Date(+m[1], +m[2], +m[3]);
      if (!isNaN(d) && (!max || d > max)) max = d;
    }
    return max;
  }

  document.addEventListener('mp:gviz-data', function (ev) {
    var d = ev.detail || {};
    state.gotAnyData = true;
    if (d.fromCache) state.anyFromCache = true;
    if (d.netError) state.anyNetError = true;
    if (d.syncedAt && (!state.lastSyncAt || d.syncedAt > state.lastSyncAt)) state.lastSyncAt = d.syncedAt;
    var mx = d.text ? scanMaxDate(d.text) : null;
    if (mx && (!state.maxDataDate || mx > state.maxDataDate)) state.maxDataDate = mx;
    render();
  });

  document.addEventListener('mp:gviz-error', function () {
    state.anyNetError = true;
    render();
  });

  /* ------------------------------------------------------------------ */
  /* 3) Render del bloque estándar                                      */
  /* ------------------------------------------------------------------ */
  var host = null;
  function ensureHost() {
    if (host && document.body.contains(host)) return host;
    host = document.createElement('div');
    host.className = 'mp-meta';
    host.setAttribute('role', 'status');
    var header = document.querySelector('header');
    if (header && header.parentNode) header.parentNode.insertBefore(host, header.nextSibling);
    else document.body.insertBefore(host, document.body.firstChild);
    return host;
  }

  function computeStatus() {
    if (state.anyNetError && !state.gotAnyData) {
      return { cls: 'bad', label: '\uD83D\uDD34 Fuente no disponible / error de conexi\u00F3n' };
    }
    if (state.anyNetError || state.anyFromCache) {
      return { cls: 'warn', label: '\uD83D\uDFE1 Mostrando \u00FAltimos datos v\u00E1lidos guardados' };
    }
    if (state.maxDataDate) {
      var limit = new Date(); limit.setHours(0, 0, 0, 0);
      limit.setDate(limit.getDate() - STALE_DAYS);
      if (state.maxDataDate < limit) return { cls: 'warn', label: '\uD83D\uDFE1 Datos con retraso' };
    }
    return { cls: 'ok', label: '\uD83D\uDFE2 Datos actualizados' };
  }

  function render() {
    if (!document.body) { document.addEventListener('DOMContentLoaded', render); return; }
    if (!state.gotAnyData && !state.anyNetError) return; // páginas sin datos (hub)
    var el = ensureHost();
    var st = computeStatus();
    el.innerHTML =
      '<span class="mp-status ' + st.cls + '"><span class="dot"></span>' + st.label + '</span>' +
      '<span class="mp-item">Datos disponibles hasta: <b>' +
        (state.maxDataDate ? MP.fmtDate(state.maxDataDate) : '\u2014 (la fuente no expone columnas de fecha)') +
      '</b></span>' +
      '<span class="mp-sep">\u00B7</span>' +
      '<span class="mp-item">\u00DAltima sincronizaci\u00F3n: <b>' +
        (state.lastSyncAt ? MP.fmtDateTime(new Date(state.lastSyncAt)) : '\u2014') +
      '</b></span>' +
      '<span class="mp-sep">\u00B7</span>' +
      '<span class="mp-item">Fuente: <b>Google Sheets</b></span>';

    /* Hook opcional por página (ej. footer dinámico de promo_dashboard) */
    document.querySelectorAll('[data-mp-daterange]').forEach(function (n) {
      n.textContent = state.maxDataDate
        ? 'Datos disponibles hasta ' + MP.fmtDate(state.maxDataDate)
        : 'Per\u00EDodo seg\u00FAn datos disponibles en la fuente';
    });
  }
})();
