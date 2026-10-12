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

test('every file the shipped manifest lists exists, is credited and is precached', async () => {
  const { readFile, stat } = await import('node:fs/promises');
  const root = new URL('../', import.meta.url);
  const m = JSON.parse(await readFile(new URL('audio/manifest.json', root), 'utf8'));
  assert.ok(Object.keys(m.slots).length >= 15);
  const credits = await readFile(new URL('audio/CREDITS.md', root), 'utf8');
  const sw = await readFile(new URL('sw.js', root), 'utf8');
  const files = manifestEntries(m, 'audio/').flatMap((e) => e.files);
  assert.ok(files.length >= 13);
  for (const f of files) {
    assert.ok((await stat(new URL(f, root))).size > 1000, f);
    assert.ok(credits.includes(f.slice('audio/'.length)), `${f} missing from CREDITS.md`);
    assert.ok(sw.includes(`'${f}'`), `${f} missing from the service worker shell`);
  }
});
