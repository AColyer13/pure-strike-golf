// Service worker: makes the game installable and playable offline.
// Network-first, so a reload always picks up new code when online; the cache is
// the fallback when there's no connection. Bump VERSION to drop old caches.
const VERSION = 'psg-v2';
const SHELL = [
  './', 'index.html', 'styles.css', 'manifest.json', 'icon.svg',
  'vendor/three/build/three.module.js', 'vendor/three/addons/objects/Sky.js',
  'src/main.js', 'src/ui.js', 'src/game.js', 'src/academy.js', 'src/round.js', 'src/history.js',
  'src/config.js', 'src/util.js', 'src/world.js', 'src/golfer.js', 'src/stats.js', 'src/meter.js',
  'src/audio.js', 'src/coach.js', 'src/caddie.js', 'src/camera.js', 'src/input.js', 'src/rules.js',
  'src/clubs.js', 'src/hole.js', 'src/physics.js', 'src/editor.js',
  'src/courses/index.js', 'src/courses/augusta.js', 'src/courses/standrews.js', 'src/courses/pebble.js', 'src/courses/sawgrass.js', 'src/courses/procedural.js',
];

self.addEventListener('install', (e) => {
  // cache what we can; a missing file must not block installation
  e.waitUntil(caches.open(VERSION).then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => null)))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  const fonts = url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
  if (!sameOrigin && !fonts) return;
  e.respondWith(
    fetch(req).then((res) => {
      if (res.ok || res.type === 'opaque') {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(req, copy));
      }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: sameOrigin }).then((r) => r || (req.mode === 'navigate' ? caches.match('index.html') : Response.error()))),
  );
});
