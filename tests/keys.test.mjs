import test from 'node:test';
import assert from 'node:assert/strict';
import { keyConflict } from '../src/ui.js';
import { DEFAULT_KEYS } from '../src/config.js';

test('default bindings have no conflicts', () => {
  for (const [a, ks] of Object.entries(DEFAULT_KEYS)) {
    for (const k of ks) assert.equal(keyConflict(DEFAULT_KEYS, a, k), null, `${a} ${k}`);
  }
});

test('a key already used in the same state is a conflict', () => {
  assert.equal(keyConflict(DEFAULT_KEYS, 'clubUp', 'q'), 'shapeLeft');
  assert.equal(keyConflict(DEFAULT_KEYS, 'mute', 'a'), 'aimLeft'); // global actions clash with everything
  assert.equal(keyConflict(DEFAULT_KEYS, 'replay', 'f'), 'fastForward');
});

test('a key may be reused across states that never overlap', () => {
  assert.equal(keyConflict(DEFAULT_KEYS, 'replay', 'q'), null);
});
