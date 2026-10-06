import test from 'node:test';
import assert from 'node:assert/strict';
import { RoundStats } from '../src/stats.js';

test('a putter stroke from the fringe counts as a putt but stays in the around-the-green category', () => {
  const s = new RoundStats();
  s.startHole(1, 4, 400);
  const fringe = s.recordShot({ surface: 'fringe', yards: 10, isTee: false }, { surface: 'green', yards: 1 }, false, 0, true);
  assert.equal(fringe.cat, 'ARG');
  s.recordShot({ surface: 'green', yards: 1, isTee: false }, { surface: 'green', yards: 0 }, true, 0, true);
  // a chip from the same spot with a wedge is not a putt
  s.recordShot({ surface: 'fringe', yards: 10, isTee: false }, { surface: 'green', yards: 3 }, false, 0, false);
  assert.equal(s.cur.putts, 2);
});
