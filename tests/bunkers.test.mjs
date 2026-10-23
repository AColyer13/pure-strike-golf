// A pot cut into a dune has to finish as a bunker: steep faces, a floor a ball can sit on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hole, mulberry32 } from '../src/hole.js';
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

// ---------------------------------------------------------------- putting from sand, plugged lies
import { computeLaunch, SAND_PUTT_ROLL, puttSpeedFor, PLUG_SINK } from '../src/physics.js';
import { buildBag } from '../src/clubs.js';
import { groundBall, lieKeyFor } from '../src/shot.js';
import { canPutt } from '../src/caddie.js';

// a level bunker all the way round: the ball can only be doing what the sand makes it do
const sandWorld = () => ({
  height: () => 0, normal: () => [0, 1, 0], surface: () => 'bunker', inBounds: () => true,
  cup: { x: 1e5, z: 1e5 }, pinIn: false, greenSdf: () => 5, waterSdf: () => ({ d: 99 }), bunkerSdf: () => ({ d: -1 }),
});
const ENV = { rho: 1.2, wind: [0, 0, 0], firmness: 1, stimp: 10 };

test('a putt struck from sand finishes about as far as the stroke was meant to go', () => {
  const w = sandWorld();
  for (const d of [1.5, 3, 6]) {
    const sim = new BallSim(w, ENV, () => 0.5);
    sim.putt([0, BALL.radius, 0], [0, 0, -1], puttSpeedFor(d, SAND_PUTT_ROLL));
    let n = 0;
    while (sim.state === 'roll' && n++ < 20000) sim.step(1 / 240);
    const got = -sim.p[2];
    assert.equal(sim.state, 'rest');
    assert.ok(Math.abs(got - d) < d * 0.06, `${d} m putt finished ${got.toFixed(2)} m`);
  }
});

test('the putter comes out in a greenside bunker but not when the ball is plugged', () => {
  const course = COURSES.find((c) => c.id === 'augusta');
  const hole = new Hole(course.holes[0], course, 0, {});
  const b = hole.bunkers.find((x) => hole.greenSdf(x.cx, x.cz) < 20);
  assert.ok(b, 'a greenside bunker');
  const ball = groundBall(hole, [b.cx, 0, b.cz]);
  assert.equal(ball.surface, 'bunker');
  assert.equal(canPutt(hole, ball), true);
  assert.equal(canPutt(hole, { ...ball, plugged: true }), false);
});

test('only a steep landing can bury a ball, and a buried ball sits below the sand', () => {
  const w = sandWorld();
  const bag = buildBag('tour');
  const shot = (club, seed, opts) => {
    const ld = computeLaunch(club, { power: 1, face: 0, path: 0, strike: 1, traj: 0, lie: 'fairway' });
    const sim = new BallSim(w, ENV, mulberry32(seed * 7919), opts);
    sim.launch([0, BALL.radius, 0], ld, [0, 0, -1]);
    let n = 0;
    while (sim.state !== 'rest' && n++ < 20000) sim.step(1 / 240);
    return sim;
  };
  const lw = bag.find((c) => c.key === 'SW'), si = bag.find((c) => c.key === 'DR');
  let lob = 0, iron = 0, silent = 0, sunk = true;
  for (let s = 1; s <= 400; s++) {
    const a = shot(lw, s);
    if (a.plugged) { lob++; sunk = sunk && a.p[1] < BALL.radius * (1 - PLUG_SINK + 0.01); }
    if (shot(si, s).plugged) iron++;
    if (shot(lw, s, { noPlug: true }).plugged) silent++;
  }
  assert.ok(lob > 8 && lob < 80, `sand wedge plugged ${lob}/400`);
  assert.equal(iron, 0, 'a driver lands too flat to plug');
  assert.equal(silent, 0, 'noPlug practice shots never bury');
  assert.ok(sunk, 'plugged balls rest sunk in the sand');
});

test('a plugged ball plays from a lie of its own and comes out short and low', () => {
  const course = COURSES.find((c) => c.id === 'augusta');
  const hole = new Hole(course.holes[0], course, 0, {});
  const b = hole.bunkers.find((x) => hole.greenSdf(x.cx, x.cz) < 20);
  const bag = buildBag('tour');
  const sw = bag.find((c) => c.key === 'SW');
  const ball = groundBall(hole, [b.cx, 0, b.cz], false, true);
  assert.equal(ball.plugged, true);
  assert.equal(lieKeyFor(ball, hole, sw), 'plugged');
  assert.equal(lieKeyFor({ ...ball, plugged: false }, hole, sw), 'splash');
  const splash = computeLaunch(sw, { power: 1, face: 0, path: 0, strike: 1, lie: 'splash' });
  const plug = computeLaunch(sw, { power: 1, face: 0, path: 0, strike: 1, lie: 'plugged' });
  assert.ok(plug.ballMph < splash.ballMph && plug.launch < splash.launch && plug.spinRpm < splash.spinRpm * 0.5);
});
