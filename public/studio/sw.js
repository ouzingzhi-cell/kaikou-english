/* Offline course files only. API requests and private voice messages are never cached. */
'use strict';

const VERSION = '2026-10-18-2';
const PREFIX = 'kaikou-ipad-';
const SHELL_CACHE = `${PREFIX}shell-${VERSION}`;
const MEDIA_CACHE = `${PREFIX}media-1`;
const BASE = new URL('./', self.location.href);
const SHELL_FILES = [
  'index.html', 'styles.css', 'theme-lilac.css', 'mobile.css', 'pwa.js',
  'manifest.webmanifest', 'application.js', 'audio-engine.js', 'checkin.js',
  'practice-units.js', 'pronunciation.js', 'scenarios.js', 'scheduler.js',
  'study-store.js', 'voice-chat.js', 'mobile-voice-chat.js',
  'data/curriculum.json', 'data/audio-manifest.json', 'data/ambience.json',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png', 'icons/leaf.svg',
];
const OPTIONAL_FILES = ['data/content-audit.json', 'data/audio-audit.json', 'assets/ambience/CREDITS.txt'];
const SHELL_URLS = new Set([...SHELL_FILES, ...OPTIONAL_FILES].map(path => new URL(path, BASE).href));
const AMBIENCE_NAMES = new Set(['restaurant-original.mp3', 'cafe-original.mp3', 'station-original.mp3']);

function assetKind(value) {
  const url = new URL(value, BASE);
  if (url.origin !== BASE.origin || url.username || url.password || url.search || url.hash) return null;
  if (url.href === BASE.href) return 'shell';
  if (SHELL_URLS.has(url.href)) return 'shell';
  if (!url.pathname.startsWith(BASE.pathname)) return null;
  const path = url.pathname.slice(BASE.pathname.length);
  const dialogue = /^assets\/audio\/(\d{1,2})\.([1-5])\.mp3$/.exec(path);
  if (dialogue && Number(dialogue[1]) >= 1 && Number(dialogue[1]) <= 20) return 'media';
  const ambience = /^assets\/ambience\/([^/]+)$/.exec(path);
  return ambience && AMBIENCE_NAMES.has(ambience[1]) ? 'media' : null;
}

function canonicalUrl(value) {
  const url = new URL(value, BASE);
  return url.href === BASE.href ? new URL('index.html', BASE).href : url.href;
}

function parseByteRange(header, size) {
  if (!Number.isSafeInteger(size) || size <= 0) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return null;
  let start, end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix); end = size - 1;
  } else {
    start = Number(match[1]); end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) return null;
    end = Math.min(end, size - 1);
  }
  return {start, end};
}

async function rangeResponse(request, cached) {
  const bytes = await cached.arrayBuffer();
  const range = parseByteRange(request.headers.get('range') || '', bytes.byteLength);
  const headers = new Headers({
    'Content-Type': cached.headers.get('Content-Type') || 'audio/mpeg',
    'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store',
  });
  if (!range) {
    headers.set('Content-Range', `bytes */${bytes.byteLength}`);
    headers.set('Content-Length', '0');
    return new Response(null, {status: 416, headers});
  }
  headers.set('Content-Range', `bytes ${range.start}-${range.end}/${bytes.byteLength}`);
  headers.set('Content-Length', String(range.end - range.start + 1));
  return new Response(request.method === 'HEAD' ? null : bytes.slice(range.start, range.end + 1), {status: 206, headers});
}

function validStaticResponse(response, url) {
  if (response.status !== 200 || response.type === 'opaque') return false;
  if (response.url && new URL(response.url).origin !== BASE.origin) return false;
  const type = response.headers.get('Content-Type') || '';
  if (/\.json$|\.webmanifest$/.test(url)) return /json|manifest/i.test(type);
  if (/\.m?js$/.test(url)) return /javascript|ecmascript/i.test(type);
  if (/\.css$/.test(url)) return /text\/css/i.test(type);
  if (/\.png$/.test(url)) return /image\/png/i.test(type);
  return /\.html$/.test(url) ? /text\/html/i.test(type) : true;
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    try {
      await Promise.all(SHELL_FILES.map(async path => {
        const url = new URL(path, BASE).href;
        const response = await fetch(url, {cache: 'reload', credentials: 'same-origin'});
        if (!validStaticResponse(response, url)) throw new Error(`Offline shell unavailable: ${path}`);
        await cache.put(url, response);
      }));
    } catch (error) {
      await caches.delete(SHELL_CACHE);
      throw error;
    }
    await Promise.all(OPTIONAL_FILES.map(async path => {
      try {
        const url = new URL(path, BASE).href;
        const response = await fetch(url, {cache: 'reload', credentials: 'same-origin'});
        if (validStaticResponse(response, url)) await cache.put(url, response);
      } catch {}
    }));
    // First install activates normally; updates wait until the user asks to refresh.
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(name =>
      (name.startsWith(`${PREFIX}shell-`) && name !== SHELL_CACHE) ||
      (name.startsWith(`${PREFIX}media-`) && name !== MEDIA_CACHE)
    ).map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

async function serveAsset(request, kind) {
  const key = canonicalUrl(request.url);
  let cache, cached;
  try {
    cache = await caches.open(kind === 'media' ? MEDIA_CACHE : SHELL_CACHE);
    cached = await cache.match(key);
  } catch {
    // Storage can be denied or evicted by the device; online practice still works.
  }
  if (cached?.status === 200) {
    if (kind === 'media' && request.headers.has('range')) return rangeResponse(request, cached);
    if (request.method === 'HEAD') return new Response(null, {status: 200, headers: cached.headers});
    return cached;
  }
  try {
    // Media is stored only by the explicit course-download panel, never on incidental playback.
    const response = await fetch(request);
    if (cache && kind === 'shell' && request.method === 'GET' && validStaticResponse(response, key)) {
      try { await cache.put(key, response.clone()); } catch {}
    }
    return response;
  } catch {
    return new Response(request.method === 'HEAD' ? null : kind === 'media'
      ? '这段原音尚未下载。联网后请打开“离线课程”。'
      : '首次使用请联网打开本应用，等待离线准备完成。', {
      status: 503, headers: {'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store'},
    });
  }
}

self.addEventListener('fetch', event => {
  if (!['GET', 'HEAD'].includes(event.request.method)) return;
  if (event.request.headers.has('authorization') || [...event.request.headers.keys()].some(name => name.toLowerCase().startsWith('x-kaikou-'))) return;
  const kind = assetKind(event.request.url);
  if (kind) event.respondWith(serveAsset(event.request, kind));
});

self.addEventListener('message', event => {
  if (event.data?.type === 'OFFLINE_STATUS') {
    event.ports?.[0]?.postMessage({version: VERSION, shellCache: SHELL_CACHE, mediaCache: MEDIA_CACHE, scope: BASE.href});
  }
  if (event.data?.type === 'ACTIVATE_UPDATE') self.skipWaiting();
});
