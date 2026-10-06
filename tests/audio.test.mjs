import { test } from 'node:test';
import assert from 'node:assert/strict';
import { manifestEntries } from '../src/audio.js';

test('manifestEntries accepts both slot shapes and drops empty slots', () => {
  const m = { slots: { driver: { want: 3, files: ['d1.ogg', 'd2.ogg'] }, iron: ['i1.ogg'], cup: { want: 2, files: [] }, pin: [] } };
  assert.deepEqual(manifestEntries(m, 'audio/'), [
    { slot: 'driver', files: ['audio/d1.ogg', 'audio/d2.ogg'] },
    { slot: 'iron', files: ['audio/i1.ogg'] },
  ]);
});

test('manifestEntries ignores junk', () => {
  assert.deepEqual(manifestEntries(null), []);
  assert.deepEqual(manifestEntries({ slots: 3 }), []);
  assert.deepEqual(manifestEntries({ slots: { a: [1, '', null, 'x.ogg'] } }), [{ slot: 'a', files: ['x.ogg'] }]);
});

test('the shipped manifest parses and has no files yet', async () => {
  const { readFile } = await import('node:fs/promises');
  const m = JSON.parse(await readFile(new URL('../audio/manifest.json', import.meta.url), 'utf8'));
  assert.ok(Object.keys(m.slots).length >= 15);
  assert.deepEqual(manifestEntries(m), []);
});
