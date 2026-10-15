import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { moduleGraph, update } from '../tools/preload.mjs';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

test('index.html preloads every module in the import graph', () => {
  const have = new Set([...html.matchAll(/<link rel="modulepreload" href="([^"]+)">/g)].map((m) => m[1]));
  const want = moduleGraph(html);
  assert.ok(want.length > 40, 'graph walk found the modules');
  assert.deepEqual(want.filter((f) => !have.has(f)), [], 'missing modulepreload links (run node tools/preload.mjs)');
  assert.deepEqual([...have].filter((f) => !want.includes(f)), [], 'stale modulepreload links');
});

test('modulepreload block is up to date', () => {
  assert.equal(update(html), html);
});
