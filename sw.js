// Service worker: makes the game installable and playable offline.
// Network-first, so a reload always picks up new code when online; the cache is
// the fallback when there's no connection. VERSION is stamped by tools/bundle.mjs (a hash of what is cached), so old caches drop on their own.
const VERSION = 'psg-61745d02';
const SHELL = [
  './', 'index.html', 'styles.css', 'manifest.json', 'icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png', 'audio/manifest.json', 'dist/game.js',
  'fonts/barlow-latin-400-normal.woff2', 'fonts/barlow-latin-500-normal.woff2', 'fonts/barlow-latin-600-normal.woff2', 'fonts/barlow-latin-700-normal.woff2', 'fonts/barlow-latin-800-normal.woff2',
  'fonts/barlow-condensed-latin-600-normal.woff2', 'fonts/barlow-condensed-latin-700-normal.woff2', 'fonts/barlow-condensed-latin-800-normal.woff2',
  'audio/sfx/driver.mp3', 'audio/sfx/iron.mp3', 'audio/sfx/wedge1.mp3', 'audio/sfx/wedge2.mp3', 'audio/sfx/putter.mp3', 'audio/sfx/whoosh.mp3', 'audio/sfx/land.mp3',
  'audio/sfx/cup.mp3', 'audio/sfx/pin.mp3', 'audio/sfx/tree.mp3', 'audio/sfx/splash.mp3', 'audio/sfx/cheer.mp3', 'audio/sfx/applause.mp3', 'audio/sfx/groan.mp3',
  'audio/sfx/driver2.mp3', 'audio/sfx/wood.mp3', 'audio/sfx/iron2.mp3', 'audio/sfx/iron3.mp3', 'audio/sfx/iron4.mp3', 'audio/sfx/wedge3.mp3', 'audio/sfx/wedge4.mp3',
  'audio/sfx/sand1.mp3', 'audio/sfx/sand2.mp3', 'audio/sfx/land-sand.mp3', 'audio/sfx/land-path.mp3', 'audio/sfx/cup2.mp3',
];

self.addEventListener('install', (e) => {
  // cache what we can; a missing file must not block installation
  e.waitUntil(caches.open(VERSION).then((c) => Promise.all(SHELL.map((u) => c.add(new Request(u, { cache: 'reload' })).catch(() => null)))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  if (!sameOrigin) return;
  e.respondWith(
    fetch(req, { cache: 'no-cache' }).then((res) => {
      if (res.ok || res.type === 'opaque') {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(req, copy));
      }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || (req.mode === 'navigate' ? caches.match('index.html') : Response.error()))),
  );
});
