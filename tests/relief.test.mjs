// Rule 17 lateral relief: the drop stays inside two club-lengths of the crossing
// point, and no nearer the hole. A 46-inch driver is the tour length limit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reliefOptions } from '../src/rules.js';

const TWO = 46 * 0.0254 * 2;
const shot = { p: [0, 0, 40], surface: 'tee', isTee: true };

function flat(surface, waterSdf) {
  return {
    cup: { x: 0, z: 0 },
    inBounds: () => true,
    height: () => 0,
    normal: () => [0, 1, 0],
    surface, waterSdf,
  };
}

function lateral(hole, entry) {
  const o = reliefOptions(hole, entry, shot).find((x) => x.id === 'lateral');
  if (!o) return null;
  return { d: Math.hypot(o.p[0] - entry.x, o.p[2] - entry.z), toCup: o.dist, surface: o.surface };
}

test('lateral relief stays within two club-lengths or is not offered', () => {
  const entry = { x: 0, z: 20 };
  // The first dry ground is one search ring past two club-lengths (2.5 m).
  const far = flat(
    (x, z) => (Math.hypot(x - entry.x, z - entry.z) < 1.8 ? 'water' : 'fairway'),
    (x, z) => ({ d: Math.hypot(x - entry.x, z - entry.z) - 1.8 }),
  );
  assert.equal(lateral(far, entry), null);

  // The bank is 1 m back: that drop is inside the relief area and no nearer the hole.
  const near = flat(
    (x, z) => (z < 20 ? 'water' : 'fairway'),
    (x, z) => ({ d: z - 20 }),
  );
  const got = lateral(near, entry);
  assert.ok(got, 'a dry spot inside two club-lengths is offered');
  assert.ok(got.d <= TWO, `${got.d.toFixed(2)} m is outside two club-lengths`);
  assert.ok(got.toCup >= 20, 'the drop is nearer the hole');
  assert.equal(got.surface, 'fairway');
});
