# Tablero Mi Portal — Offline First (PWA)

Documentación de la conversión de la suite de dashboards en una aplicación
instalable que funciona sin internet y se resincroniza sola.

---

## 1. Arquitectura actual (análisis previo)

| Elemento | Cómo estaba |
|---|---|
| **Tableros** | 8 archivos HTML autocontenidos (hub + 7 módulos), cada uno con su propio CSS y JS embebido |
| **Fuente de datos** | Google Sheets leído en vivo por `gviz/tq` con `fetch()`, un `fetch` por tablero |
| **Librerías** | Chart.js, SheetJS (xlsx), Lucide e Inter, todas por CDN externo |
| **PWA** | Existía un intento parcial: `manifest.json`, `service-worker.js` y `offline-core.js`, pero **solo `saludBase.html` los incluía**, y el `manifest.json` apuntaba a iconos (`icons/*.png`) **que no existían en el repo** — por eso Chrome nunca ofrecía instalar |
| **Duplicados** | `offline-core (1).js` y `service-worker (1).js` eran copias viejas sin uso |

### Sheets conectados (se mantienen intactos)

| Tablero | Sheet ID | gid |
|---|---|---|
| `dashboardgeneral.html` | `1oDuPtSd…BgUp8` (2026) + fuentes 2025 / 2024 / 2023 | varios |
| `promo_dashboard.html` | `1oDuPtSd…BgUp8` | según config |
| `dashboard_ciudades.html` | `1oDuPtSd…BgUp8` | `1742393063` |
| `Retornables.html` | `SHEETS_BY_YEAR` (2023→2026) | varios |
| `saludBase.html` | `1p7A8yRj…yx4n4` | `1755798486` |
| `mailingWoowup.html` | `1l6cCYgN…WHbCI` | `898845227` |
| `Automatizadas.html` | `1B_sY1v6…w5H4M` | `1726393836` |

**No se modificó ni un ID, ni un gid, ni una consulta.**

---

## 2. Arquitectura de sincronización implementada

```
Google Sheets (gviz)
        │
        ▼
offline-core.js  ← interceptor de window.fetch (solo docs.google.com/gviz/tq)
        │
        ├──► IndexedDB  "mp_offline"
        │      · gvizSnapshots : una entrada por consulta (respuesta byte a byte + syncedAt)
        │      · meta          : última sincronización global
        │
        ▼
Dashboard (su propio código, sin cambios)
```

Separación exigida — **fuente → proceso de actualización → almacenamiento local → dashboard** —
resuelta sin tocar la lógica de los tableros: cada uno sigue llamando a su `fetch()` de siempre;
la capa intermedia decide si eso se resuelve con red o con la copia local.

### Reglas de integridad

- Cada sincronización **reemplaza el snapshot completo** de esa consulta → idempotente,
  sin merges, sin duplicados, sin mezclar períodos ni estados.
- La clave del snapshot ignora los *cache-busters* (`_`, `cb`, `_ts`, `t`), así que la
  misma consulta siempre cae en la misma entrada.
- Las respuestas gviz con `"status":"error"` (HTTP 200 igual) **nunca se guardan**: son
  parte de la cascada normal de reintentos de los tableros.
- Si la actualización falla, **se conservan los datos anteriores** y se reintenta.

### Ciclo de vida de una carga

1. **Hay copia local** → se entrega al instante (pintado inmediato) y se revalida contra
   la fuente en segundo plano.
2. Si la fuente devuelve **lo mismo** → no se re-renderiza nada (evita trabajo inútil).
3. Si devuelve **algo distinto** → se guarda y se llama al cargador propio del tablero
   (`window.MP_RESYNC`), que vuelve a leer, ahora desde IndexedDB.
4. **Sin copia local** → red normal; si la red falla, reintento con timeout extendido y
   recién ahí el aviso de "sin datos offline".

> **Sobre la descarga incremental:** `gviz` no expone deltas ni cabeceras de última
> modificación, así que no hay forma confiable de bajar "solo lo nuevo" sin inventar
> supuestos sobre la base. Lo que sí se hace: comparar la respuesta nueva contra la
> guardada y **no reescribir ni re-renderizar cuando no cambió nada**.

---

## 3. Archivos modificados y creados

### Nuevos

| Archivo | Para qué sirve |
|---|---|
| `vendor/chart-4.4.0.umd.min.js`<br>`vendor/chart-4.4.1.umd.min.js` | Chart.js local (las dos versiones que usaban los tableros, sin cambiar comportamiento) |
| `vendor/xlsx-0.18.5.full.min.js` | SheetJS local (exportación a Excel offline) |
| `vendor/lucide.min.js` | Iconos del hub, local |
| `vendor/inter.css` + `vendor/inter/*.woff2` | Tipografía Inter autohospedada (reemplaza Google Fonts) |
| `icons/icon-192.png`, `icon-512.png`, `icon-512-maskable.png`, `icon-1024.png` | Iconos de la app, generados del logo **mp** de Mi Portal. **Esto es lo que faltaba para que Chrome ofreciera instalar** |
| `pwa_patch.py` | Script que inyecta el bloque PWA en un HTML y le cambia los CDN por `vendor/`. Idempotente: sirve para los tableros nuevos que vengan |
| `README-PWA.md` | Este documento |

### Reescritos

| Archivo | Cambios |
|---|---|
| `offline-core.js` | **v3.** Interceptor gviz + IndexedDB + *local primero con revalidación en segundo plano* + indicador de estado (🟢/🟠/🔄/✅) + botón **📲 Instalar Tablero** + resincronización automática llamando al cargador de cada tablero + reintento periódico ante fallo + API de diagnóstico `window.MPOffline` |
| `service-worker.js` | **v6.** Precachea el app shell completo (8 HTML + librerías locales + iconos + estilos, ~35 archivos). Network First para HTML, Cache First para `vendor/` e `icons/`. Nunca intercepta `docs.google.com`. Soporta actualización de la app sin cerrar pestañas (`SKIP_WAITING`) |
| `manifest.json` | Nombre **Tablero Mi Portal**, `display: standalone`, iconos reales (incluido *maskable*), accesos directos a General / Campañas / Salud de la Base / Ciudades |

### Modificados (solo el `<head>`)

`index.html` · `dashboardgeneral.html` · `promo_dashboard.html` · `mailingWoowup.html` ·
`saludBase.html` · `dashboard_ciudades.html` · `Retornables.html` · `Automatizadas.html`

En cada uno se insertó, justo después del `<meta charset>`:

```html
<!-- ===== PWA / OFFLINE-FIRST · Tablero Mi Portal ===== -->
<link rel="manifest" href="manifest.json">
<meta name="theme-color" content="#0D0D0D">
<meta name="mobile-web-app-capable" content="yes">
<link rel="apple-touch-icon" href="icons/icon-192.png">
<script>window.MP_RESYNC='iniciar';</script>   <!-- varía por tablero -->
<script src="offline-core.js"></script>
<!-- ===== FIN PWA / OFFLINE-FIRST ===== -->
<link rel="stylesheet" href="vendor/inter.css">
```

y se reemplazaron las URLs de CDN por las copias de `vendor/`.
**Ni una línea de la lógica de negocio, filtros, cálculos o gráficos fue tocada.**

`window.MP_RESYNC` es el nombre de la función que ya existía en cada tablero para recargar:

| Tablero | Función |
|---|---|
| `dashboardgeneral.html` | `iniciar` |
| `promo_dashboard.html` | `autoSyncPromo` |
| `saludBase.html` | `loadData` |
| `dashboard_ciudades.html` | `loadFromSheet` |
| `Retornables.html` | `init` |
| `Automatizadas.html` | `loadData` |
| `mailingWoowup.html` | *(sin función global — usa recarga controlada, máx. 1 por minuto)* |

### Eliminados

`offline-core (1).js` y `service-worker (1).js` — copias viejas sin uso.
**Si los tenés en el repo, borralos también ahí.**

---

## 4. Indicador de estado

Chip flotante abajo a la izquierda, discreto y plegable (se contrae solo a los 6 s;
un clic lo vuelve a abrir):

| Estado | Cuándo |
|---|---|
| 🟢 **ONLINE** | Conectado y con datos sincronizados |
| 🔄 **SINCRONIZANDO** | Consultando la fuente |
| ✅ **ACTUALIZADO** | Sincronización recién completada |
| 🟠 **SIN CONEXIÓN** | Sin internet, mostrando la última información disponible |
| 🟠 **SIN ACTUALIZAR** | Hay internet pero la fuente no responde — datos viejos conservados |
| 🔴 **SIN DATOS LOCALES** | Nunca se sincronizó y no hay internet |

Siempre acompañado de **Última actualización: DD/MM/AAAA HH:MM**, y con un botón ↻ para
forzar la sincronización a mano.

> El chip vive **fuera** del header negro, así que no interfiere con la fecha de corte
> discreta que definiste para los encabezados.

---

## 5. Instalación en Windows

La app se instala desde la URL publicada (el Service Worker **no funciona con `file://`**):

```
https://miportalko.github.io/dahsboard/
```

1. Abrí esa dirección en **Chrome** o **Edge**.
2. Esperá a que cargue una vez con internet (así se guarda el shell y la primera copia de datos).
3. Instalá de cualquiera de estas formas:
   - Botón rojo **📲 Instalar Tablero** abajo a la izquierda.
   - Ícono de instalación en la barra de direcciones (⊕ / monitor con flecha).
   - Menú ⋮ → *Instalar* / *Aplicaciones → Instalar este sitio como una aplicación*.
4. Se crea el acceso directo con el ícono **mp** en Escritorio y Menú Inicio.
5. Abre en ventana propia, sin barra del navegador.

**Para actualizar la aplicación** (cuando subas cambios al repo): subí `VERSION` en
`service-worker.js` (`v6` → `v7`). El tablero avisa que hay versión nueva y se aplica
con un clic. **Actualizar la app no borra los datos locales.**

---

## 6. Cómo probar los 5 escenarios

| # | Prueba | Resultado esperado |
|---|---|---|
| 1 | Abrir con internet | Carga, consulta, sincroniza, chip 🟢 con fecha/hora |
| 2 | DevTools → Network → *Offline* (o desconectar el WiFi), cerrar la app y volver a abrirla | Abre igual, muestra los últimos datos, chip 🟠 **SIN CONEXIÓN** con la fecha de la última sincronización |
| 3 | Reconectar internet | Detecta solo, chip 🔄 → ✅ y los gráficos se actualizan sin recargar a mano |
| 4 | Instalar desde Chrome/Edge, cerrar el navegador y abrir desde el escritorio | Ventana independiente, ícono propio, funciona offline |
| 5 | Quitar el permiso de la planilla o cortar la fuente | Conserva los últimos datos válidos, chip 🟠 **SIN ACTUALIZAR**, reintenta cada 2 minutos |

### Diagnóstico desde la consola (F12)

```js
await MPOffline.snapshots()   // qué hojas hay guardadas, tamaño y fecha de sync
await MPOffline.lastSync()    // última sincronización global
await MPOffline.syncNow()     // forzar sincronización
await MPOffline.purgeData()   // borrar SOLO los datos locales (no desinstala la app)
```

Estas pruebas están automatizadas y corren limpias: **22 verificaciones, 0 fallas**
(escenarios 1, 2, 3 y 5 + carga sin errores de los 8 archivos).

---

## 7. Seguridad

- No se guardan credenciales, tokens ni claves: los Sheets se leen como **públicos de solo
  lectura**, exactamente como antes.
- No se usa LocalStorage para nada sensible (solo un guardia anti-bucle de recarga en
  `sessionStorage`).
- En IndexedDB queda únicamente la respuesta pública de la fuente, lo mínimo para que el
  tablero funcione offline.
- **Pendiente a considerar**: hoy cualquiera con el link del Sheet puede leerlo. Si en algún
  momento se necesita cerrar ese acceso, el camino es un proxy con credenciales del lado del
  servidor (Apps Script o función serverless) que exponga solo el JSON necesario — la capa
  offline seguiría funcionando igual, cambiando solo la URL.

---

## 8. Alcance y pendientes

**Cubierto:** el hub + los 7 módulos activos.

**No incluido** (no están enlazados desde el hub): `dashboard_miportal.html`, `cupones.html`,
`explorador_skus.html`, `exploradorskus.html`, `DashGA4.html`, `Segmentación_ClientesVTEX.html`,
`Retornables_10.html`, `dashboard_ciudades_1.html`, `saludBase_2.html`.

Para sumar cualquiera de ellos:

1. Agregalo a `TARGETS` en `pwa_patch.py` con el nombre de su función de recarga y corré
   `python pwa_patch.py`.
2. Agregá la ruta a `SHELL_ASSETS` en `service-worker.js` y subí `VERSION`.

**Sobre los filtros:** hoy se persisten los datos y la configuración de la app, no la selección
de filtros de cada tablero (eso vive en la memoria de cada página y tocarlo implicaba entrar en
la lógica de los 7). La API ya está lista por si querés hacerlo tablero por tablero:
`MPOffline.saveUIState({...})` / `MPOffline.loadUIState()`.
