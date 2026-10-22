import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { bundle, OUT, SW, stampedSw } from '../tools/bundle.mjs';

const lf = (b) => b.toString('utf8').replace(/\r\n/g, '\n');

test('dist/game.js is built from the current src/ and vendor/', async () => {
  assert.equal(lf(fs.readFileSync(OUT)), lf(await bundle()), 'stale bundle: run npm run bundle');
});

test('the service worker cache version matches what it caches', async () => {
  assert.equal(lf(fs.readFileSync(SW)), lf(stampedSw(await bundle())), 'stale cache version: run npm run bundle');
});

test('index.html loads the bundle and preloads it', () => {
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /<script type="module" src="dist\/game\.js"><\/script>/);
  assert.match(html, /<link rel="modulepreload" href="dist\/game\.js">/);
});

test('service worker precaches the bundle', () => {
  const sw = fs.readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
  assert.match(sw, /'dist\/game\.js'/);
});
