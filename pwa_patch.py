#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
pwa_patch.py — Inyecta la capa PWA/Offline-First en los tableros
y reemplaza las librerías de CDN por copias locales (vendor/).

No toca la lógica de ningún dashboard: solo el <head>.
Idempotente: se puede correr varias veces sin duplicar nada.
"""
import re, sys, pathlib

ROOT = pathlib.Path(__file__).parent

# archivo -> nombre de la función que recarga el tablero (window.MP_RESYNC)
TARGETS = {
    'index.html':              None,            # hub, no consulta datos
    'dashboardgeneral.html':   'iniciar',
    'promo_dashboard.html':    'autoSyncPromo',
    'mailingWoowup.html':      None,            # carga en DOMContentLoaded -> recarga controlada
    'saludBase.html':          'loadData',
    'dashboard_ciudades.html': 'loadFromSheet',
    'Retornables.html':        'init',
    'Automatizadas.html':      'loadData',
}

CDN_MAP = [
    ('https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js',            'vendor/chart-4.4.1.umd.min.js'),
    ('https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js',            'vendor/chart-4.4.0.umd.min.js'),
    ('https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js',       'vendor/chart-4.4.1.umd.min.js'),
    ('https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.0/chart.umd.min.js',       'vendor/chart-4.4.0.umd.min.js'),
    ('https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.4/chart.umd.min.js',       'vendor/chart-4.4.1.umd.min.js'),
    ('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js',               'vendor/xlsx-0.18.5.full.min.js'),
    ('https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',          'vendor/xlsx-0.18.5.full.min.js'),
    ('https://unpkg.com/lucide@latest/dist/umd/lucide.min.js',                       'vendor/lucide.min.js'),
]

BLOCK_START = '<!-- ===== PWA / OFFLINE-FIRST · Tablero Mi Portal (no toca la lógica del tablero) ===== -->'
BLOCK_END   = '<!-- ===== FIN PWA / OFFLINE-FIRST ===== -->'

# bloque viejo de saludBase (v1) que hay que reemplazar
OLD_BLOCK = re.compile(
    r'<!-- =+ OFFLINE / PWA.*?<!-- =+ FIN OFFLINE / PWA =+ -->\s*',
    re.DOTALL)
NEW_BLOCK_RE = re.compile(
    re.escape(BLOCK_START) + r'.*?' + re.escape(BLOCK_END) + r'\s*',
    re.DOTALL)

GFONT_LINK = re.compile(
    r'[ \t]*<link[^>]+href="https://fonts\.googleapis\.com/css2\?family=Inter[^"]*"[^>]*>\s*',
    re.IGNORECASE)
PRECONNECT = re.compile(
    r'[ \t]*<link[^>]+rel="preconnect"[^>]+fonts\.(googleapis|gstatic)\.com"[^>]*>\s*',
    re.IGNORECASE)


def build_block(resync):
    hook = ("\n<script>window.MP_RESYNC='%s';</script>" % resync) if resync else ""
    return (
        BLOCK_START +
        '\n<link rel="manifest" href="manifest.json">'
        '\n<meta name="theme-color" content="#0D0D0D">'
        '\n<meta name="mobile-web-app-capable" content="yes">'
        '\n<link rel="apple-touch-icon" href="icons/icon-192.png">' +
        hook +
        '\n<script src="offline-core.js"></script>\n' +
        BLOCK_END + '\n'
    )


def patch(path, resync):
    p = ROOT / path
    src = p.read_text(encoding='utf-8')
    orig = src
    report = []

    # 1) limpiar bloques previos (v1 y re-ejecuciones)
    src, n = OLD_BLOCK.subn('', src)
    if n: report.append('bloque PWA v1 reemplazado')
    src, n = NEW_BLOCK_RE.subn('', src)
    if n: report.append('bloque PWA previo reemplazado')

    # 2) CDN -> vendor local
    for cdn, local in CDN_MAP:
        if cdn in src:
            src = src.replace(cdn, local)
            report.append('%s -> %s' % (cdn.split('/')[-1], local))

    # 3) Google Fonts -> Inter autohospedada
    if GFONT_LINK.search(src):
        src = GFONT_LINK.sub('', src)
        src = PRECONNECT.sub('', src)
        report.append('Google Fonts -> vendor/inter.css')
        font_link = '<link rel="stylesheet" href="vendor/inter.css">\n'
    else:
        font_link = ''

    # 4) insertar el bloque justo después de <head>
    block = build_block(resync) + font_link
    # (se inserta DESPUÉS del <meta charset> para no romper la codificación)
    m = re.search(r'<meta[^>]+charset=[^>]*>', src, re.IGNORECASE)
    if not m:
        m = re.search(r'<head[^>]*>', src, re.IGNORECASE)
    if not m:
        print('  !! sin <head>: %s' % path); return
    i = m.end()
    src = src[:i] + '\n' + block + src[i:]
    report.append('bloque PWA insertado' + (' (MP_RESYNC=%s)' % resync if resync else ''))

    if src != orig:
        p.write_text(src, encoding='utf-8')
    print('%-26s %s' % (path, ' · '.join(report)))


if __name__ == '__main__':
    for f, hook in TARGETS.items():
        if (ROOT / f).exists():
            patch(f, hook)
        else:
            print('  !! no encontrado: %s' % f)
