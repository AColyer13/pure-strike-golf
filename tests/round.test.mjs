// Headless rounds: the pure shot and scoring pipeline (the same code the Game
// class delegates to) plays whole holes in Node, with no renderer, UI or audio.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hole, YD } from '../src/hole.js';
import { buildBag } from '../src/clubs.js';
import { COURSES } from '../src/courses/index.js';
import { MAX_STROKES, MIN_SWING } from '../src/config.js';
import { angOf, clamp } from '../src/util.js';
import { createRound, holeEnv, SIGNATURE } from '../src/round.js';
import { reliefOptions } from '../src/rules.js';
import { wantsPutter, canPutt, puttSetup, powerForCarry } from '../src/caddie.js';
import {
  distToPin, teeBall, groundBall, ballLiftFor, lieKeyFor, shotSeedFor, computeBagDistances,
  normalizeSwing, shotStartOf, launchShot, runToRest, shotInfoFor,
} from '../src/shot.js';
import { settleShot, settleRelief, pickedUp, finishHoleScore, nextTurn, nextHole } from '../src/scoring.js';

const aimAtCup = (hole, ball) => angOf(hole.cup.x - ball.p[0], hole.cup.z - ball.p[2]);

// A sensible player: putter on the green (and from short grass just off it),
// otherwise the shortest club that carries the distance (driver only from the
// tee), eased off for pitches. Reads no break: it aims straight at the cup.
const SHORT_GRASS = new Set(['fairway', 'fringe', 'cut', 'tee']);
function straightPolicy({ hole, ball, d, bag, env }) {
  const aim = aimAtCup(hole, ball);
  const texas = canPutt(hole, ball) && SHORT_GRASS.has(ball.surface) && d < 25;
  if (wantsPutter(hole, ball) || texas) {
    const ps = puttSetup(hole, ball, env);
    return { club: bag.find((c) => c.putter), aim: ps.aim, puttRange: ps.range, elevIn: ps.elevIn, swing: { power: clamp(ps.eqFt / ps.range, 0.02, 1), face: 0, path: 0, strike: 1 } };
  }
  const usable = bag.filter((c) => !c.putter && (ball.isTee || c.key !== 'DR'));
  const fits = usable.filter((c) => c.carry >= d * 0.985).sort((a, b) => a.carry - b.carry);
  const club = fits[0] || usable.sort((a, b) => b.carry - a.carry)[0];
  const lie = lieKeyFor(ball, hole, club);
  const power = d < club.carry * 0.9 ? powerForCarry(club, d, { traj: 0, lie, rho: env.rho }) : 1;
  return { club, aim, swing: { power, face: 0, path: 0, strike: 1 } };
}

// Dribbles a lob wedge a few yards at a time: never gets there.
function dribblePolicy({ hole, ball, bag }) {
  return { club: bag.find((c) => c.key === 'LW'), aim: aimAtCup(hole, ball), swing: { power: 0.03, face: 0, path: 0, strike: 1 } };
}

function playHole(courseId, holeIndex, seed, policy, { profile = 'tour' } = {}) {
  const round = createRound({ courseId, holes: [holeIndex], mode: 'single', seed });
  const course = round.course;
  const S0 = round.setup[holeIndex];
  const hole = new Hole(course.holes[holeIndex], course, holeIndex, { pinIndex: S0.pinIndex });
  const env = holeEnv(course, hole, S0);
  const bag = computeBagDistances(buildBag(profile), course);
  const stats = round.stats;
  stats.startHole(hole.number, hole.par, hole.length / YD);
  let ball = teeBall(hole), strokes = 0, penalties = 0, holed = false, pu = false;
  const log = [];
  for (let guard = 0; guard < 40; guard++) {
    ball = groundBall(hole, ball.p, ball.isTee);
    const d = distToPin(hole, ball);
    const pick = policy({ hole, ball, d, bag, env, strokes });
    const sw = normalizeSwing(pick.swing, !!pick.club.putter);
    const lie = lieKeyFor(ball, hole, pick.club);
    const S = shotStartOf({ hole, ball, club: pick.club, aim: pick.aim, pl: null, strokes, lie, duffed: sw.duffed });
    const seed2 = shotSeedFor(round, strokes, 0);
    const shot = launchShot({ hole, env, ball, club: pick.club, swing: sw, aim: pick.aim, shape: 'straight', traj: 0, puttRange: pick.puttRange, ballLift: ballLiftFor(ball, pick.club), seed: seed2 });
    const { landV } = runToRest(shot.sim);
    strokes++;
    const info = shotInfoFor({ sim: shot.sim, hole, shotStart: S, club: pick.club, ld: shot.ld, landV, puttElevIn: pick.elevIn });
    const r = settleShot({ hole, shotStart: S, sim: shot.sim, info, stats, strokes });
    const entry = { n: strokes, club: pick.club.key, lie, result: r.result, after: info.after, rest: shot.sim.p.map((x) => +x.toFixed(3)), events: shot.sim.events.map((e) => e.type).join(','), carryYd: +info.carryYd.toFixed(2) };
    if (r.next === 'water') {
      const opts = reliefOptions(hole, r.entry, S);
      const o = opts.reduce((a, b) => (b.es < a.es ? b : a));
      const rr = settleRelief({ shotStart: S, option: o, stats, strokes });
      strokes = rr.strokes; penalties += rr.penalty; ball = rr.ball;
      entry.relief = o.id; entry.sg = rr.sg?.sg;
    } else {
      strokes = r.strokes; penalties += r.penalty; ball = r.ball;
      entry.sg = r.sg?.sg;
    }
    entry.strokesAfter = strokes;
    log.push(entry);
    if (r.next === 'holed') { holed = true; break; }
    if (pickedUp(strokes)) { pu = true; break; }
  }
  const score = finishHoleScore(round, hole, strokes, { pickedUp: pu });
  return { round, hole, stats, strokes, penalties, holed, pickedUp: pu, log, score };
}

// the signature hole of each course (Sawgrass 17 is the island green: water relief)
const CASES = COURSES.filter((c) => SIGNATURE[c.id] !== undefined).map((c) => [c.id, SIGNATURE[c.id]]);

for (const [courseId, idx] of CASES) {
  test(`${courseId} #${idx + 1}: a straight hitter holes out within ${MAX_STROKES}`, () => {
    const r = playHole(courseId, idx, 4242, straightPolicy);
    const where = `${courseId} #${idx + 1}: ${JSON.stringify(r.log)}`;
    assert.ok(r.holed && !r.pickedUp, `holed out: ${where}`);
    assert.ok(r.strokes <= MAX_STROKES, `strokes ${r.strokes}: ${where}`);
    assert.equal(r.score.strokes, r.strokes);
    assert.equal(r.round.scores[0].strokes, r.strokes);
    const h = r.stats.holes[0];
    assert.equal(h.strokes, r.strokes);
    assert.equal(h.penalties, r.penalties);
    assert.equal(h.putts, r.log.filter((e) => e.club === 'PT').length, 'every putter stroke is a putt, from the fringe too');
    // every stroke (and every penalty) is a Strokes Gained record
    assert.equal(h.shots.length, r.log.length, 'one SG record per stroke');
    assert.equal(h.shots.reduce((s, x) => s + x.penalty, 0), r.penalties);
    const t = r.stats.totals();
    for (const k of ['OTT', 'APP', 'ARG', 'PUTT']) assert.ok(Number.isFinite(t.sg[k]), `finite SG ${k}`);
    assert.ok(Number.isFinite(t.sgTotal));
    if (r.hole.par === 3) assert.equal(h.fir, null, 'no FIR on a par 3');
    else assert.equal(typeof h.fir, 'boolean', 'FIR recorded on a par 4/5');
    const girExpected = r.log.some((e) => (e.after === 'green' || e.result === 'holed') && e.strokesAfter <= r.hole.par - 2);
    assert.equal(h.gir, girExpected, 'GIR consistent with the shot log');
  });
}

test('the same seed replays the identical hole; a different seed does not', () => {
  const a = playHole('pebble', 6, 777, straightPolicy);
  const b = playHole('pebble', 6, 777, straightPolicy);
  assert.deepEqual(a.log, b.log);
  assert.equal(a.strokes, b.strokes);
  const c = playHole('pebble', 6, 778, straightPolicy);
  assert.notDeepEqual(a.round.setup, c.round.setup, 'different seed, different pin or wind');
});

test('a player who never gets there picks up at the maximum', () => {
  const r = playHole('augusta', 1, 99, dribblePolicy);
  assert.equal(r.hole.par, 5);
  assert.ok(r.pickedUp && !r.holed);
  assert.equal(r.strokes, MAX_STROKES);
  assert.equal(r.score.pickedUp, true);
  assert.equal(r.stats.holes[0].pickedUp, true);
  assert.equal(r.round.scores[0].strokes, MAX_STROKES);
  // a mis-timed full swing is a chunk, not a 3 mph tap: the floor applies to every stroke
  assert.ok(r.log.every((e) => e.carryYd < 15), 'dribbles stay short');
  assert.equal(normalizeSwing({ power: 0.03, strike: 1 }, false).power, MIN_SWING);
  assert.equal(normalizeSwing({ power: 0.03, strike: 1 }, true).power, 0.03, 'putts are never floored');
});

function waterFixture() {
  const round = createRound({ courseId: 'sawgrass', holes: [16], mode: 'single', seed: 5 });
  const hole = new Hole(round.course.holes[16], round.course, 16, { pinIndex: 0 });
  // walk the line from the tee to the island green and stop in the water
  const t = hole.tee, c = hole.cup;
  let wp = null;
  for (let k = 0.05; k < 1 && !wp; k += 0.01) {
    const x = t.x + (c.x - t.x) * k, z = t.z + (c.z - t.z) * k;
    if (hole.surface(x, z) === 'water') wp = [x, hole.height(x, z), z];
  }
  assert.ok(wp, 'the line to the 17th green crosses water');
  return { round, hole, wp };
}

test('a ball in the water costs exactly one penalty stroke and the drop is recorded', () => {
  const { round, hole, wp } = waterFixture();
  const stats = round.stats;
  stats.startHole(hole.number, hole.par, hole.length / YD);
  const ball = teeBall(hole);
  const club = buildBag('tour').find((c) => c.key === '9I');
  const S = shotStartOf({ hole, ball, club, aim: aimAtCup(hole, ball), pl: null, strokes: 0, lie: 'tee' });
  const sim = { p: wp, trail: [ball.p.slice()], events: [{ type: 'land', t: 3 }, { type: 'water', t: 3 }], state: 'rest' };
  const info = { result: 'water', putt: false };
  const r = settleShot({ hole, shotStart: S, sim, info, stats, strokes: 1 });
  assert.equal(r.next, 'water');
  assert.equal(r.penalty, 0, 'no penalty until the drop is chosen');
  assert.equal(info.after, 'water');
  assert.equal(stats.cur.shots.length, 0, 'nothing recorded until the drop');
  assert.notEqual(hole.surface(r.entry.x, r.entry.z), 'water', 'entry point is on the dry side');
  const opts = reliefOptions(hole, r.entry, S);
  assert.ok(opts.length >= 2 && opts[0].id === 'replay');
  for (const o of opts) { assert.ok(Number.isFinite(o.es), `${o.id} has an expected score`); assert.notEqual(o.surface, 'water'); }
  const o = opts.reduce((a, b) => (b.es < a.es ? b : a));
  const rr = settleRelief({ shotStart: S, option: o, stats, strokes: 1 });
  assert.equal(rr.penalty, 1);
  assert.equal(rr.strokes, 2, 'stroke plus one penalty');
  assert.deepEqual(rr.ball.p, o.p);
  assert.equal(stats.cur.penalties, 1);
  assert.equal(stats.cur.shots.length, 1);
  assert.equal(stats.cur.shots[0].penalty, 1);
  assert.ok(rr.sg.sg < 0, 'Strokes Gained is negative after a penalty');
});

test('out of bounds: stroke and distance, ball back where it was played from', () => {
  const { round, hole } = waterFixture();
  const stats = round.stats;
  stats.startHole(hole.number, hole.par, hole.length / YD);
  const ball = teeBall(hole);
  const club = buildBag('tour').find((c) => c.key === '9I');
  const S = shotStartOf({ hole, ball, club, aim: aimAtCup(hole, ball), pl: null, strokes: 0, lie: 'tee' });
  const sim = { p: [9999, 0, 9999], trail: [ball.p.slice()], events: [{ type: 'ob', t: 2 }], state: 'rest' };
  const r = settleShot({ hole, shotStart: S, sim, info: { result: 'ob' }, stats, strokes: 1 });
  assert.equal(r.next, 'next');
  assert.equal(r.penalty, 1);
  assert.equal(r.strokes, 2);
  assert.deepEqual(r.ball.p, S.p);
  assert.equal(r.ball.isTee, true, 'back on the tee');
  assert.equal(stats.cur.penalties, 1);
  assert.equal(stats.cur.shots[0].penalty, 1);
  // challenge modes keep no stats: the same call must not throw
  const r2 = settleShot({ hole, shotStart: S, sim, info: { result: 'ob' }, stats: null, strokes: 1 });
  assert.equal(r2.strokes, 2);
  assert.equal(r2.sg, null);
});

test('fairways and greens in regulation', () => {
  const round = createRound({ courseId: 'augusta', holes: [0, 5], mode: 'single', seed: 1 });
  const h1 = new Hole(round.course.holes[0], round.course, 0, { pinIndex: 0 }); // par 4
  const h6 = new Hole(round.course.holes[5], round.course, 5, { pinIndex: 0 }); // par 3
  assert.equal(h1.par, 4); assert.equal(h6.par, 3);
  const bag = buildBag('tour');
  const dr = bag.find((c) => c.key === 'DR'), si = bag.find((c) => c.key === '7I');
  const restOn = (hole, surface) => {
    // somewhere on the hole with the requested surface: walk back from the cup
    // along the centre line, then sideways from each point
    const t = hole.tee, c = hole.cup, L = Math.hypot(c.x - t.x, c.z - t.z);
    const sx = -(c.z - t.z) / L, sz = (c.x - t.x) / L;
    for (let k = 1; k >= 0; k -= 0.01) {
      for (let w = 0; w <= 80; w += 2) for (const side of [1, -1]) {
        const x = t.x + (c.x - t.x) * k + sx * w * side, z = t.z + (c.z - t.z) * k + sz * w * side;
        if (hole.surface(x, z) === surface) return [x, hole.height(x, z), z];
      }
    }
    throw new Error(`no ${surface} on the hole`);
  };
  const stroke = (hole, stats, ball, club, rest, strokes) => {
    const S = shotStartOf({ hole, ball, club, aim: aimAtCup(hole, ball), pl: null, strokes: strokes - 1, lie: lieKeyFor(ball, hole, club) });
    const sim = { p: rest, trail: [ball.p.slice()], events: [{ type: 'land', t: 1 }], state: 'rest' };
    const info = { result: 'ok', after: hole.surface(rest[0], rest[2]) };
    return settleShot({ hole, shotStart: S, sim, info, stats, strokes });
  };
  // par 4: drive finds the fairway, second finds the green -> FIR and GIR
  const st = round.stats; st.startHole(h1.number, 4, h1.length / YD);
  let r = stroke(h1, st, teeBall(h1), dr, restOn(h1, 'fairway'), 1);
  assert.equal(st.cur.fir, true);
  stroke(h1, st, r.ball, si, restOn(h1, 'green'), 2);
  assert.equal(st.cur.gir, true);
  finishHoleScore(round, h1, 4);
  // par 4: drive in the second cut, on the green in three -> no FIR, no GIR
  assert.equal(nextTurn(round), 'hole'); nextHole(round);
  st.startHole(h1.number, 4, h1.length / YD);
  r = stroke(h1, st, teeBall(h1), dr, restOn(h1, 'second'), 1);
  assert.equal(st.cur.fir, false);
  r = stroke(h1, st, r.ball, si, restOn(h1, 'fairway'), 2);
  stroke(h1, st, r.ball, si, restOn(h1, 'green'), 3);
  assert.equal(st.cur.gir, false);
  finishHoleScore(round, h1, 5);
  assert.equal(nextTurn(round), 'end');
  // par 3: no FIR ever, GIR on the tee shot
  st.startHole(h6.number, 3, h6.length / YD);
  stroke(h6, st, teeBall(h6), si, restOn(h6, 'green'), 1);
  assert.equal(st.cur.fir, null);
  assert.equal(st.cur.gir, true);
  finishHoleScore(round, h6, 3);
  const t = st.totals();
  assert.equal(t.firN, 2); assert.equal(t.fir, 1); assert.equal(t.gir, 2);
  assert.equal(round.scores.length, 3);
});

test('hot seat: every player plays the hole before the round moves on', () => {
  const round = createRound({ courseId: 'standrews', holes: [0, 1], mode: 'front', seed: 3, players: ['Ann', 'Bo'] });
  assert.equal(round.players.length, 2);
  assert.equal(round.player.name, 'Ann');
  assert.equal(nextTurn(round), 'player');
  assert.equal(round.player.name, 'Bo');
  assert.equal(nextTurn(round), 'hole');
  assert.equal(round.p, 0);
  nextHole(round);
  assert.equal(round.i, 1);
  nextTurn(round);
  assert.equal(nextTurn(round), 'end');
  assert.equal(round.p, 0);
});
