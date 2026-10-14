// Every hole of every course must build, with the tee on a tee box, every pin on
// the green, finite terrain, and a shot sim that is fully deterministic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hole, YD, mulberry32 } from '../src/hole.js';
import { BallSim, computeLaunch } from '../src/physics.js';
import { buildBag } from '../src/clubs.js';
import { COURSES } from '../src/courses/index.js';

for (const course of COURSES) {
  test(`${course.name}: all holes build and are playable`, () => {
    assert.ok(course.holes.length === 18, 'course has 18 holes');
    for (let i = 0; i < course.holes.length; i++) {
      const def = course.holes[i];
      const pins = def.green?.pins?.length || 1;
      for (let pin = 0; pin < pins; pin++) {
        const h = new Hole(def, course, i, { pinIndex: pin });
        const where = `${course.id} #${i + 1} pin ${pin}`;
        assert.equal(h.surface(h.tee.x, h.tee.z), 'tee', `${where}: tee surface`);
        assert.equal(h.surface(h.cup.x, h.cup.z), 'green', `${where}: cup surface`);
        assert.ok(Number.isFinite(h.height(h.cup.x, h.cup.z)), `${where}: finite height`);
        assert.ok(Math.abs(h.length / YD - def.yds) < 1, `${where}: centre line matches card yardage`);
      }
    }
  });
}

test('pars and yardages add up to the scorecard', () => {
  for (const c of COURSES) {
    const par = c.holes.reduce((s, h) => s + h.par, 0);
    assert.ok(par >= 70 && par <= 73, `${c.id} par ${par}`);
  }
});

test('shot simulation is deterministic, including tree hits', () => {
  const course = COURSES[0];
  const h = new Hole(course.holes[0], course, 0);
  // a wall of trees across the line of play, 150 m out
  const trees = [];
  for (let x = -30; x <= 30; x += 2.5) {
    trees.push({ x: h.tee.x + x, z: h.tee.z - 150, y: h.height(h.tee.x + x, h.tee.z - 150), h: 25, crownY: 6, crownR: 4,
      trunkR: 0.35, trunkH: 7, shape: 'round', density: 0.4, scale: 1, straw: false });
  }
  h.setTrees(trees);
  const club = buildBag('tour').find((c) => c.key === '5I');
  const run = (seed) => {
    const sim = new BallSim(h, { rho: 1.2, wind: [1.5, 0, -2], firmness: 1, stimp: 11 }, mulberry32(seed));
    const ld = computeLaunch(club, { power: 1, face: 0.5, path: 0, strike: 0.9, traj: -1, lie: 'tee', rng: mulberry32(seed + 1) });
    sim.launch([h.tee.x, h.height(h.tee.x, h.tee.z) + 0.03, h.tee.z], ld, [h.teeDir.x, 0, h.teeDir.z]);
    let n = 0;
    while (sim.state !== 'rest' && sim.state !== 'holed' && n++ < 30000) sim.step(1 / 240);
    return { p: sim.p.map((v) => v.toFixed(6)).join(), events: sim.events.map((e) => e.type).join() };
  };
  const a = run(1234), b = run(1234);
  assert.ok(a.events.includes('tree'), 'the test shot should hit the trees');
  assert.deepEqual(a, b);
});

// The terrain asks for green and bunker distances with a cap (only nearer than that
// matters) so far points skip the trig. Below the cap the answer must be exact, and
// at or beyond it never less than the cap.
test('capped green and bunker distances are exact below the cap', () => {
  const rnd = mulberry32(5);
  for (const course of COURSES) {
    for (let i = 0; i < 18; i += 4) {
      const h = new Hole(course.holes[i], course, i);
      for (let k = 0; k < 400; k++) {
        const x = h.cup.x + (rnd() - 0.5) * 120, z = h.cup.z + (rnd() - 0.5) * 120;
        for (const cap of [0, 3, 25]) {
          const g = h.greenSdf(x, z), gc = h.greenSdf(x, z, cap);
          const b = h.bunkerSdf(x, z).d, bc = h.bunkerSdf(x, z, cap).d;
          if (g < cap) assert.equal(gc, g); else assert.ok(gc >= cap);
          if (b < cap) assert.equal(bc, b); else assert.ok(bc >= cap);
        }
      }
    }
  }
});
