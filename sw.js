// Service worker: makes the game installable and playable offline.
// Network-first, so a reload always picks up new code when online; the cache is
// the fallback when there's no connection. Bump VERSION to drop old caches.
const VERSION = 'psg-v10';
const SHELL = [
  './', 'index.html', 'styles.css', 'manifest.json', 'icon.svg', 'audio/manifest.json',
  'vendor/three/build/three.module.js', 'vendor/three/addons/objects/Sky.js',
  'vendor/three/addons/postprocessing/EffectComposer.js', 'vendor/three/addons/postprocessing/RenderPass.js', 'vendor/three/addons/postprocessing/ShaderPass.js',
  'vendor/three/addons/postprocessing/UnrealBloomPass.js', 'vendor/three/addons/postprocessing/GTAOPass.js', 'vendor/three/addons/postprocessing/OutputPass.js',
  'vendor/three/addons/postprocessing/Pass.js', 'vendor/three/addons/postprocessing/MaskPass.js', 'vendor/three/addons/math/SimplexNoise.js',
  'vendor/three/addons/shaders/CopyShader.js', 'vendor/three/addons/shaders/GTAOShader.js', 'vendor/three/addons/shaders/LuminosityHighPassShader.js',
  'vendor/three/addons/shaders/OutputShader.js', 'vendor/three/addons/shaders/PoissonDenoiseShader.js',
  'fonts/barlow-latin-400-normal.woff2', 'fonts/barlow-latin-500-normal.woff2', 'fonts/barlow-latin-600-normal.woff2', 'fonts/barlow-latin-700-normal.woff2', 'fonts/barlow-latin-800-normal.woff2',
  'fonts/barlow-condensed-latin-600-normal.woff2', 'fonts/barlow-condensed-latin-700-normal.woff2', 'fonts/barlow-condensed-latin-800-normal.woff2',
  'src/main.js', 'src/ui.js', 'src/game.js', 'src/academy.js', 'src/round.js', 'src/history.js',
  'src/config.js', 'src/util.js', 'src/world.js', 'src/golfer.js', 'src/stats.js', 'src/meter.js',
  'src/audio.js', 'src/coach.js', 'src/caddie.js', 'src/camera.js', 'src/input.js', 'src/rules.js', 'src/shot.js', 'src/scoring.js', 'src/tutorial.js', 'src/units.js', 'src/post.js', 'src/fx.js', 'src/foliage.js',
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
  if (!sameOrigin) return;
  e.respondWith(
    fetch(req).then((res) => {
      if (res.ok || res.type === 'opaque') {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(req, copy));
      }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || (req.mode === 'navigate' ? caches.match('index.html') : Response.error()))),
  );
});
