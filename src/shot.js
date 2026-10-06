// Pure shot logic: everything about a stroke that does not touch the renderer,
// the UI or the audio. The Game class delegates here so the same code runs
// headless in tests (see tests/round.test.mjs).
import { BallSim, computeLaunch, LIES, puttSpeedFor, BALL } from './physics.js';
import { YD, FT, mulberry32 } from './hole.js';
import { SHAPES, MIN_SWING } from './config.js';
import { DEG, dirOf, clamp } from './util.js';
import { seedFrom } from './round.js';

export const STEP = 1 / 240; // physics step during play

export const distToPin = (hole, ball) => Math.hypot(hole.cup.x - ball.p[0], hole.cup.z - ball.p[2]);

// a ball on the tee of the hole
export function teeBall(hole) {
  const h = hole;
  return { p: [h.tee.x, h.height(h.tee.x, h.tee.z) + BALL.radius, h.tee.z], surface: 'tee', isTee: true };
}
// a ball resting on the ground at (x, z): height and surface re-read from the terrain
export function groundBall(hole, p, isTee = false) {
  return { p: [p[0], hole.height(p[0], p[2]) + BALL.radius, p[2]], surface: isTee ? 'tee' : hole.surface(p[0], p[2]), isTee };
}

// how high the ball sits above the turf: on a peg for woods and long irons
export function ballLiftFor(ball, club) {
  if (!ball.isTee) return 0;
  const teed = !club.putter && club.loft < 30;
  return teed ? (club.loft < 13 ? 0.035 : 0.012) : 0.005;
}

// LIES key for the ball's position (the club matters only in a bunker)
export function lieKeyFor(ball, hole, club) {
  const s = ball.surface;
  if (ball.isTee) return 'tee';
  if (s === 'tee') return 'fairway'; // ball sitting on the tee box turf (topped drive): mown like fairway
  if (s === 'bunker') {
    const nearGreen = hole.greenSdf(ball.p[0], ball.p[2]) < 30;
    return nearGreen && club && club.loft >= 50 ? 'splash' : 'bunker';
  }
  return LIES[s] ? s : 'rough';
}

// slope under the ball relative to the aim line, degrees: up (+ uphill), side (+ ball above feet)
export function slopeAt(hole, p, aim) {
  const n = hole.normal(p[0], p[2]);
  const f = dirOf(aim);
  const r = { x: -f.z, z: f.x };
  const up = Math.atan(-(n[0] * f.x + n[2] * f.z) / n[1]) / DEG;
  const side = Math.atan(-(n[0] * r.x + n[2] * r.z) / n[1]) / DEG;
  return { up, side };
}

// how much of the meter's accuracy zone the lie and stance leave the player
export function lieZoneFor(ball, hole, club, aim) {
  const k = { tee: 1, fairway: 1, green: 1, fringe: 1, cut: 0.95, second: 0.85, rough: 0.75, deep: 0.55, bunker: 0.8, splash: 0.85, straw: 0.8, waste: 0.85, path: 0.9 }[lieKeyFor(ball, hole, club)] ?? 0.8;
  const sl = slopeAt(hole, ball.p, aim);
  return k * clamp(1 - (Math.abs(sl.side) + Math.abs(sl.up) * 0.5) * 0.025, 0.6, 1);
}

// Shot seed: the same round seed, hole, stroke and ball always give the same
// random lie/strike variation – so a shared challenge is fair to everyone.
export function shotSeedFor(round, strokesBefore, ballNo) {
  return seedFrom(`${round.seed}:${round.holes[round.i]}:${strokesBefore}:${ballNo}`);
}

// wind relative to the aim line: along + = helping (downwind), side + = left-to-right
export function windRelOf(windAng, windMph, aim) {
  const a = windAng - aim;
  return { along: Math.cos(a) * windMph, side: Math.sin(a) * windMph, ang: a };
}

// full-swing carry/total on flat fairway, no wind (the "yardage book"); written onto each club
export function computeBagDistances(bag, course) {
  const flat = { height: () => 0, normal: () => [0, 1, 0], surface: () => 'fairway', inBounds: () => true, cup: { x: 1e5, z: 1e5 }, pinIn: false };
  for (const club of bag) {
    if (club.putter) continue;
    const ld = computeLaunch(club, { power: 1, face: 0, path: 0, strike: 1, traj: 0, lie: 'fairway' });
    const sim = new BallSim(flat, { rho: course.rho, wind: [0, 0, 0], firmness: course.firmness, stimp: course.stimp });
    sim.launch([0, BALL.radius, 0], ld, [0, 0, -1]);
    let n = 0;
    while (sim.state !== 'rest' && n++ < 8000) sim.step(1 / 120);
    club.carry = Math.hypot(sim.landed[0], sim.landed[2]);
    club.total = Math.hypot(sim.p[0], sim.p[2]);
  }
  return bag;
}

// sound/effects family of a stroke
export function swingKind(club, lie) {
  if (club.putter) return 'putt';
  if (lie === 'splash' || lie === 'bunker') return 'sand';
  return club.key === 'DR' ? 'driver' : club.loft <= 20 ? 'wood' : club.loft >= 45 ? 'wedge' : 'iron';
}

// Every input path (meter, mouse swing, gamepad stick) goes through here. A full
// swing below MIN_SWING power is a chunk: the club still moves at a sane speed
// but the strike is heavy, so the ball goes nowhere for a real reason.
export function normalizeSwing(sw, putter) {
  if (putter || sw.power >= MIN_SWING) return sw;
  return { ...sw, power: MIN_SWING, strike: Math.min(sw.strike, 0.45), duffed: true };
}

// snapshot of where a stroke is played from (kept for stats, relief and the cameras)
export function shotStartOf({ hole, ball, club, aim, pl, strokes, lie, duffed }) {
  const d = distToPin(hole, ball);
  return { p: ball.p.slice(), surface: ball.surface, isTee: ball.isTee, yards: d / YD, lie, dist: d, aim, pl: pl || null, club, strokesBefore: strokes, duffed: !!duffed };
}

// Launch a stroke into a fresh BallSim. Sets hole.pinIn (the flag is tended out
// for putts). Returns { sim, ld, start, fwd, putt, kind } with the sim at t = 0.
export function launchShot({ hole, env, ball, club, swing: sw, aim, shape = 'straight', traj = 0, puttRange = 10, ballLift = 0, seed }) {
  const h = hole;
  const sim = new BallSim(h, env, mulberry32(seed));
  const start = [ball.p[0], ball.p[1] + (ballLift || 0), ball.p[2]];
  const dir = dirOf(aim);
  const fwd = [dir.x, 0, dir.z];
  const putt = !!club.putter;
  h.pinIn = !putt;
  if (putt) {
    const speed = puttSpeedFor(sw.power * puttRange * FT, h.greenRoll) * (0.97 + 0.03 * sw.strike);
    const d2 = dirOf(aim + sw.face * DEG);
    sim.putt(start, [d2.x, 0, d2.z], speed);
    return { sim, ld: { putt: true, speed, face: sw.face, power: sw.power }, start, fwd, putt, kind: 'putt' };
  }
  const sh = SHAPES[shape] || SHAPES.straight;
  const lie = lieKeyFor(ball, h, club);
  const ld = computeLaunch(club, { power: sw.power, face: sw.face + sh.face, path: sw.path + sh.path, strike: sw.strike, traj, lie, slope: slopeAt(h, ball.p, aim), rng: mulberry32(seed + 1) });
  sim.launch(start, ld, fwd);
  return { sim, ld, start, fwd, putt, kind: swingKind(club, lie) };
}

// Step a sim until it rests or drops. landV is the velocity just before the first
// landing (descent angle). onStep(sim) runs after every step.
export function runToRest(sim, { dt = STEP, max = 40000, onStep } = {}) {
  let landV = null, n = 0;
  while (sim.state !== 'rest' && sim.state !== 'holed' && n++ < max) {
    const v = sim.v.slice();
    sim.step(dt);
    if (!landV && sim.landed) landV = v;
    if (onStep) onStep(sim);
  }
  return { landV, steps: n };
}

// The identical shot run to completion: where it lands and finishes, for the
// broadcast camera and slow-motion decisions.
export function forecastShot({ hole, env, shot, seed }) {
  const fc = new BallSim(hole, env, mulberry32(seed));
  if (shot.putt) {
    const sp = Math.hypot(...shot.sim.v);
    fc.putt(shot.start, shot.sim.v.map((x) => x / (sp || 1)), sp);
  } else fc.launch(shot.start, shot.ld, shot.fwd);
  runToRest(fc, { max: 20000 });
  const fev = fc.events.map((e) => e.type);
  return {
    land: fc.landed, rest: fc.p.slice(), t: fc.t, landT: fc.events.find((e) => e.type === 'land')?.t ?? 0,
    holed: fc.state === 'holed', lip: fev.includes('lip'), restSurface: hole.surface(fc.p[0], fc.p[2]),
    restDist: Math.hypot(hole.cup.x - fc.p[0], hole.cup.z - fc.p[2]),
  };
}

export function shotResult(sim) {
  if (sim.state === 'holed') return 'holed';
  const ev = sim.events.map((e) => e.type);
  if (ev.includes('water')) return 'water';
  if (ev.includes('ob')) return 'ob';
  return 'ok';
}

// Launch-monitor style numbers for the shot panel and the coach
export function shotInfoFor({ sim, hole: h, shotStart: S, club, ld, landV, puttElevIn }) {
  const putt = !!club.putter;
  const result = shotResult(sim);
  const p = sim.p, cup = h.cup;
  const dir = dirOf(S.aim);
  const info = {
    putt, club, ld, result, lie: S.lie, isTee: S.isTee, par: h.par,
    carryYd: sim.landed ? Math.hypot(sim.landed[0] - S.p[0], sim.landed[2] - S.p[2]) / YD : 0,
    totalYd: Math.hypot(p[0] - S.p[0], p[2] - S.p[2]) / YD,
    offlineYd: ((p[0] - S.p[0]) * -dir.z + (p[2] - S.p[2]) * dir.x) / YD,
    apexFt: (sim.apex - S.p[1]) / FT,
    descent: landV ? Math.atan2(-landV[1], Math.hypot(landV[0], landV[2])) / DEG : null,
    stimp: h.stimp,
    pinFt: Math.hypot(cup.x - p[0], cup.z - p[2]) / FT,
    duffed: !!S.duffed,
  };
  // how much of the club's normal carry this shot got – a chunk or a top is < 0.3
  info.carryFrac = putt ? 1 : info.carryYd / Math.max(1, (club.carry || 0) / YD);
  const toCup = { x: cup.x - S.p[0], z: cup.z - S.p[2] };
  const dC = Math.hypot(toCup.x, toCup.z) || 1;
  const along = ((p[0] - S.p[0]) * toCup.x + (p[2] - S.p[2]) * toCup.z) / dC;
  info.shortYd = (dC - along) / YD; info.longYd = (along - dC) / YD;
  info.approach = !putt && S.dist / YD > 40 && S.dist / YD < 240 && !(S.isTee && h.par > 3);
  if (S.pl && info.approach) { info.windAdj = S.pl.windAdj / YD; info.elevAdj = S.pl.elevAdj / YD; info.elevFt = (h.height(cup.x, cup.z) - S.p[1]) / FT; }
  if (putt) {
    info.startFt = S.dist / FT;
    info.afterFt = info.pinFt;
    info.shortFt = (dC - along) / FT;
    const lat = ((p[0] - S.p[0]) * -toCup.z + (p[2] - S.p[2]) * toCup.x) / dC;
    info.lateralFt = lat / FT;
    // was the miss on the low side? compare with the slope direction at the cup
    const n = h.normal(cup.x, cup.z);
    const downhillLat = (n[0] * -toCup.z + n[2] * toCup.x) / dC; // + when the slope falls to the right
    info.missLow = Math.sign(lat) === Math.sign(downhillLat) && Math.abs(downhillLat) > 0.004;
    info.holed = result === 'holed';
    info.uphillIn = puttElevIn;
  }
  if (result === 'ok') { info.after = h.surface(p[0], p[2]); info.onGreen = info.after === 'green'; }
  return info;
}
