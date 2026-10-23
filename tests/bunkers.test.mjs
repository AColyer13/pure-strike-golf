// A pot cut into a dune has to finish as a bunker: steep faces, a floor a ball can sit on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hole } from '../src/hole.js';
import { BallSim, BALL } from '../src/physics.js';
import { slopeDeg } from '../src/rules.js';
import { COURSES } from '../src/courses/index.js';

test("a ball in Lane's fairway pot comes to rest on flat sand", () => {
  const course = COURSES.find((c) => c.id === 'standrews');
  const i = course.holes.findIndex((h) => h.name === 'Lane');
  const hole = new Hole(course.holes[i], course, i, {});
  const dist = (b) => Math.hypot(b.cx - hole.cup.x, b.cz - hole.cup.z);
  const pot = hole.bunkers.filter((b) => b.kind === 'pot').sort((a, b) => dist(b) - dist(a))[0];
  let spot = null;
  for (let k = 0; k < 72; k++) {
    const a = (k / 72) * Math.PI * 2;
    for (const rad of [0.5, 1.2, 1.8, 2.4]) {
      const x = pot.cx + Math.cos(a) * rad;
      const z = pot.cz + Math.sin(a) * rad;
      if (hole.bunkerSdf(x, z).b !== pot || hole.surface(x, z) !== 'bunker') continue;
      const sl = slopeDeg(hole, x, z);
      if (!spot || sl > spot.sl) spot = { x, z, sl };
    }
  }
  const sim = new BallSim(hole, { rho: course.rho, wind: [0, 0, 0], firmness: course.firmness, stimp: course.stimp });
  sim.putt([spot.x, hole.height(spot.x, spot.z) + BALL.radius, spot.z], [0, 0, -1], 0.02);
  let n = 0;
  while (sim.state === 'roll' && n++ < 20000) sim.step(1 / 240);
  const sl = slopeDeg(hole, sim.p[0], sim.p[2]);
  assert.equal(sim.state, 'rest');
  assert.equal(hole.surface(sim.p[0], sim.p[2]), 'bunker', `finished on ${hole.surface(sim.p[0], sim.p[2])}`);
  assert.ok(sl < 10, `rest slope ${sl.toFixed(1)}° from a ${spot.sl.toFixed(1)}° lie`);
});
