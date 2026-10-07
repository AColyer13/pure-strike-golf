// Greens must be puttable: every pin is cut where a ball can stop, and the
// caddie's read (start line + pace) rolls the ball in, or close, on any green.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hole, mulberry32 } from '../src/hole.js';
import { BallSim } from '../src/physics.js';
import { COURSES, courseById } from '../src/courses/index.js';
import { puttRead, puttSetup, puttNote, puttRangeFor } from '../src/caddie.js';
import { dirOf } from '../src/util.js';

const envOf = (course, h) => ({ rho: course.rho, wind: [0, 0, 0], firmness: course.firmness, stimp: h.stimp });

test('every pin is cut on a puttable slope (≤ 3%)', () => {
  const courses = [...COURSES, courseById('gen', 7), courseById('gen', 31)];
  for (const course of courses) {
    for (let i = 0; i < course.holes.length; i++) {
      const pins = course.holes[i].green?.pins?.length || 1;
      for (let pin = 0; pin < pins; pin++) {
        const h = new Hole(course.holes[i], course, i, { pinIndex: pin });
        const where = `${course.id} #${i + 1} pin ${pin}`;
        assert.ok(h.pinSlope(h.cup.x, h.cup.z) <= 0.03, `${where}: cup slope ${(h.pinSlope(h.cup.x, h.cup.z) * 100).toFixed(1)}%`);
        assert.equal(h.surface(h.cup.x, h.cup.z), 'green', `${where}: cup on the green`);
      }
    }
  }
});

test("the caddie's read holes most putts and leaves the rest close", () => {
  for (const course of COURSES) {
    let n = 0, holed = 0;
    for (let i = 0; i < course.holes.length; i += 3) {
      const h = new Hole(course.holes[i], course, i, { pinIndex: 0 });
      const env = envOf(course, h);
      for (const [k, r] of [[0, 3], [1, 6], [2, 9]]) {
        const a = k * 2.1 + i;
        const x = h.cup.x + Math.cos(a) * r, z = h.cup.z + Math.sin(a) * r;
        // only lies a ball can rest on (not the lip of a bunker cut into the green)
        if (h.surface(x, z) !== 'green' || h.pinSlope(x, z) > 0.05) continue;
        const ball = { p: [x, h.height(x, z) + 0.0214, z], surface: 'green' };
        const rd = puttRead(h, ball, env);
        h.pinIn = false;
        const sim = new BallSim(h, env, mulberry32(3));
        const d = dirOf(rd.aim);
        sim.putt(ball.p.slice(), [d.x, 0, d.z], rd.speed);
        let s = 0;
        while (sim.state === 'roll' && s++ < 6000) sim.step(1 / 120);
        n++;
        if (sim.state === 'holed') holed++;
        else assert.ok(Math.hypot(sim.p[0] - h.cup.x, sim.p[2] - h.cup.z) < 3, `${course.id} #${i + 1} r${r}: read leaves it close`);
      }
    }
    assert.ok(n >= 6, `${course.id}: enough sample putts`);
    assert.ok(holed / n >= 0.8, `${course.id}: read holes ${holed}/${n}`);
  }
});

test('a straight-in putt reads straight; a sidehill putt aims above the hole', () => {
  // flat field and a 2% cross-slope rising to +x, on the same synthetic green
  const course = COURSES[0];
  const h = new Hole(course.holes[0], course, 0, { pinIndex: 0 });
  const env = envOf(course, h);
  const cup = { x: h.cup.x, z: h.cup.z };
  for (const [slope, expect] of [[0, 0], [0.02, 1]]) {
    h.height = (x) => (x - cup.x) * slope;
    h.normal = () => { const l = Math.hypot(slope, 1); return [-slope / l, 1 / l, 0]; };
    h.surface = () => 'green';
    const ball = { p: [cup.x, 0.0214, cup.z + 5], surface: 'green' }; // 5 m below (+z), putting toward -z
    const rd = puttRead(h, ball, env);
    if (!expect) assert.ok(Math.abs(rd.brk) < 0.02, `flat: brk ${rd.brk}`);
    else assert.ok(rd.brk > 0.05, `ground rises to the right (+x): aim right, brk ${rd.brk}`);
    assert.equal(rd.leave, 0, `slope ${slope}: holed`);
    assert.match(puttNote(rd), expect ? /right edge|right of the hole/ : /Straight/);
    assert.ok(Math.abs(rd.eqFt - puttSetup(h, ball, env).eqFt) < 3, 'pace close to the straight read');
  }
});

test('putter range covers a monster up a bank', () => {
  assert.equal(puttRangeFor(8), 10);
  assert.equal(puttRangeFor(100), 120);
  assert.ok(puttRangeFor(206) >= 206 * 1.1);
});
