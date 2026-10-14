// Caddie: club selection, plays-like distances, expected-strokes lay-up analysis,
// meter-marker power suggestions and putt reads. Reads the game state (hole, ball,
// wind, shot shape) and only changes the club/aim through the game's setters.
import { BallSim, computeLaunch, simulateCarry, puttSpeedFor, BALL, G } from './physics.js';
import { YD, FT, mulberry32 } from './hole.js';
import { expectedStrokes } from './stats.js';
import { dirOf, angOf, clamp, DEG } from './util.js';
import { SHAPES } from './config.js';
import { findEntry } from './rules.js';

// run a step generator to the end and return its value (the synchronous form of a search
// that address frames otherwise spread a few milliseconds at a time)
const drain = (it) => { for (;;) { const r = it.next(); if (r.done) return r.value; } };
// CPU per frame for the background searches at address (lay-up analysis, meter marker).
// One full sim is ~2 ms on a desktop and several on a phone; at least one runs a frame.
export const SLICE_MS = 5;
// the putt read gets a little more: the player is standing over the ball waiting for it,
// and a putt over a ridge can take a few hundred rolls
const READ_MS = 8;

// Pure helpers (no game instance) so the rules can be tested and reused.
// The caddie reaches for the putter on the green, or from the fringe / first
// cut when a chip has more ways to go wrong than a putt.
export function wantsPutter(hole, ball) {
  const d = Math.hypot(hole.cup.x - ball.p[0], hole.cup.z - ball.p[2]);
  const s = ball.surface;
  if (s === 'green' || (s === 'fringe' && d < 18)) return true;
  const lineIs = (ok) => {
    for (let t = 0.1; t < 1; t += 0.1) {
      if (!ok.includes(hole.surface(ball.p[0] + (hole.cup.x - ball.p[0]) * t, ball.p[2] + (hole.cup.z - ball.p[2]) * t))) return false;
    }
    return true;
  };
  // a long one from the fringe with only putting surface ahead: still a putt. A chip
  // across a big green has to land on a spot and check (on a tiered green a few
  // percent short rolls back down the tier), while a putt only has to be paced.
  if (s === 'fringe') return d < 30 && lineIs(['green', 'fringe']);
  // just off the green on short grass: putt it if the whole line to the hole is mown
  if ((s !== 'cut' && s !== 'fairway') || d > 15 || hole.greenSdf(ball.p[0], ball.p[2]) > 4) return false;
  return lineIs(['green', 'fringe', 'cut', 'fairway']);
}
// Where a putt is at least a sensible option: on or around the green (a
// "Texas wedge" from the apron is fine; a 465 ft putt from the tee is not).
export function canPutt(hole, ball) {
  if (!hole || !ball || ball.isTee) return false;
  const s = ball.surface;
  if (s === 'green' || s === 'fringe') return true;
  if (s === 'water' || s === 'ob' || s === 'bunker') return false;
  return hole.greenSdf(ball.p[0], ball.p[2]) < 25;
}

// The read's rolls take the pin out and, for the pace and break solvers, cover the hole.
// Sim options rather than edits to the hole itself: a read pauses mid-roll (see
// ROLL_SLICE) and the game carries on with the real hole in between.
const PIN_OUT = { pinOut: true };
const covered = (h) => ({ pinOut: true, cup: { ...h.cup, x: 1e6, z: 1e6 } });
// steps between yields inside one roll: a long putt down a bank rolls for 20 s of game
// time (2400 steps), which on a phone is longer than a frame
const ROLL_SLICE = 200;

// Rolls a putt from p along `dir` at speed v (sim options `opts`), calling each(pos) every step
// (false stops it). Yields every ROLL_SLICE steps; returns the sim.
function* rollSteps(hole, opts, env, p, dir, v, each) {
  const sim = new BallSim(hole, env, mulberry32(3), opts);
  sim.putt(p.slice(), [dir.x, 0, dir.z], v);
  let n = 0;
  while (sim.state === 'roll' && n++ < 3000) {
    sim.step(1 / 120);
    if (each && each(sim.p) === false) break;
    if (n % ROLL_SLICE === 0) yield;
  }
  return sim;
}

// bisect on full green sims (slopes included) for the start speed that rolls `d` metres
// from p along dir (unit, {x, z}). "Reaches d" is judged on the furthest point of the
// roll, not where the ball stops: on a green with a rise beyond the hole a hot putt
// runs up and back past its start, which would otherwise read as "not far enough".
// `launch` (default dir) starts the ball on a different line, for a putt aimed outside
// the hole; `guess` narrows the bracket when a nearby answer is already known.
export function puttSpeedToReach(hole, env, p, dir, d, launch = dir, guess = 0) {
  return drain(speedSteps(hole, env, p, dir, d, launch, guess));
}
// the same bisection, yielding after each roll (for the time-sliced read)
function* speedSteps(hole, env, p, dir, d, launch = dir, guess = 0) {
  const opts = covered(hole);
  // (the roll stops as soon as it gets there: only whether it does matters)
  const reach = function* (v) {
    let got = false;
    yield* rollSteps(hole, opts, env, p, launch, v, (q) => { if ((q[0] - p[0]) * dir.x + (q[2] - p[2]) * dir.z >= d) { got = true; return false; } });
    return got;
  };
  let lo = 0.2, hi = 14, its = 12;
  if (guess > 0) {
    // walk out from the guess until the answer is bracketed (a re-solve after a small
    // change of line is rarely 4% out), then bisect to ~0.25% of it
    if (yield* reach(guess * 0.97)) {
      hi = guess * 0.97;
      for (const k of [0.9, 0.7]) { yield; if (yield* reach(guess * k)) hi = guess * k; else { lo = guess * k; break; } }
    } else {
      lo = guess * 0.97;
      for (const k of [1.04, 1.15, 1.4]) { yield; if (yield* reach(guess * k)) { hi = guess * k; break; } lo = guess * k; }
    }
    yield;
    its = Math.max(1, Math.ceil(Math.log2((hi - lo) / (guess * 0.0025))));
  }
  for (let it = 0; it < its; it++) {
    const v = it === 0 && !guess ? puttSpeedFor(d, hole.greenRoll) : (lo + hi) / 2;
    if (yield* reach(v)) hi = v; else lo = v;
    yield;
  }
  return (lo + hi) / 2;
}

// The putter meter's full-power distance (ft) for a stroke of eqFt: the smallest
// standard scale with some headroom, or a bigger one for a monster up a bank.
export function puttRangeFor(eqFt) {
  const need = eqFt * 1.15;
  return [10, 20, 40, 70, 120, 150].find((r) => r >= need) || Math.ceil(need / 50) * 50;
}

// Putt read for the ball's position. Effective (flat-equivalent) distance eqFt is the
// speed that would finish ~17 in (43 cm) past the hole if it missed – Pelz's optimum,
// and what the meter marker teaches. range is the meter's full-power distance in feet.
// This is the straight-at-the-cup read; puttRead() below adds the break.
export function puttSetup(hole, ball, env) { return drain(setupSteps(hole, ball, env)); }
function* setupSteps(hole, ball, env) {
  const h = hole, b = ball;
  const d = Math.hypot(h.cup.x - b.p[0], h.cup.z - b.p[2]) || 1e-6;
  const dir = { x: (h.cup.x - b.p[0]) / d, z: (h.cup.z - b.p[2]) / d };
  const v = yield* speedSteps(h, env, b.p, dir, d + 0.43, dir, quickSetup(h, b).speed);
  return setupFor(h, b, dir, v);
}
function setupFor(h, b, dir, v) {
  const eqFt = (v * v) / (2 * h.greenRoll * G) / FT;
  const range = puttRangeFor(eqFt);
  const elevIn = (h.height(h.cup.x, h.cup.z) - h.height(b.p[0], b.p[2])) / 0.0254;
  return { eqFt, range, elevIn, aim: angOf(dir.x, dir.z), speed: v };
}
// A first guess with no rolls (flat green plus the climb to the hole), for the frames
// before the real read is ready.
function quickSetup(h, b) {
  const d = Math.hypot(h.cup.x - b.p[0], h.cup.z - b.p[2]) || 1e-6;
  const dir = { x: (h.cup.x - b.p[0]) / d, z: (h.cup.z - b.p[2]) / d };
  const rise = h.height(h.cup.x, h.cup.z) - h.height(b.p[0], b.p[2]);
  const v2 = 2 * (h.greenRoll * G * (d + 0.43) + G * rise);
  return setupFor(h, b, dir, Math.sqrt(Math.max(v2, puttSpeedFor(0.5, h.greenRoll) ** 2)));
}

// Sideways miss (metres, + = right of the cup as the player looks at it) of a putt
// started along aim `a` at speed v: where the roll crosses the line through the cup
// square to the putt, or where it stops if it never gets there.
function* missSteps(hole, env, p, cupDir, d, a, v) {
  const launch = dirOf(a);
  const rx = -cupDir.z, rz = cupDir.x; // player's right when facing the cup
  let hit = null;
  const end = (yield* rollSteps(hole, covered(hole), env, p, launch, v, (q) => {
    if ((q[0] - p[0]) * cupDir.x + (q[2] - p[2]) * cupDir.z >= d) { hit = q.slice(); return false; }
  })).p;
  const q = hit || end;
  return (q[0] - hole.cup.x) * rx + (q[2] - hole.cup.z) * rz;
}

// Where a putt along aim `a` at speed v really finishes, hole in play: 0 when it drops.
function* leaveSteps(hole, env, p, a, v) {
  const h = hole, d = dirOf(a);
  const sim = yield* rollSteps(h, PIN_OUT, env, p, d, v);
  if (sim.state === 'holed') return 0;
  if (sim.state !== 'rest') return 1e3; // water, out of bounds
  return Math.hypot(sim.p[0] - h.cup.x, sim.p[2] - h.cup.z);
}

// The caddie's full read: the start line and pace that roll the ball into the hole,
// finishing ~17 in past if it lips out. Starts from the straight read, then walks the
// aim with a secant on the sideways miss, re-solving the pace for the curved line.
// Every candidate is checked with the hole in play (a line that crosses the cup too
// fast to drop is no read), and the one that finishes closest wins.
// `brk` is how far outside the cup the line starts (m, + = aim right of the hole).
// A generator: it yields between rolls so the game can spread a hard read over a few
// frames (see Caddie.setupPutt); puttRead() runs it straight through. The first yield
// hands back the straight-at-the-cup setup to use while the read is still going.
// (`straight` stops at the straight-at-the-cup read: a Pro reads their own break)
export function* puttReadSteps(hole, ball, env, straight = false) {
  const h = hole, b = ball;
  yield quickSetup(h, b);
  const base = yield* setupSteps(h, b, env);
  if (straight) return base;
  const d = Math.hypot(h.cup.x - b.p[0], h.cup.z - b.p[2]) || 1e-6;
  const cupDir = { x: (h.cup.x - b.p[0]) / d, z: (h.cup.z - b.p[2]) / d };
  const puttLeave = (ca, cv) => leaveSteps(h, env, b.p, ca, cv);
  const puttMiss = (ca, cv) => missSteps(h, env, b.p, cupDir, d, ca, cv);
  const a0 = base.aim;
  let v = base.speed, a = a0;
  let best = { a, v, leave: yield* puttLeave(a, v) };
  let m = yield* puttMiss(a, v);
  best.m = Math.abs(m);
  yield;
  let aPrev = null, mPrev = null;
  // (a line that drops on the high or low edge is no read either: the smallest pull or
  // push the wrong way misses, so carry on until it rolls over the middle of the hole.
  // That moves the aim a couple of centimetres, too little to re-solve the pace for.)
  const edge = best.leave === 0;
  for (let it = 0; it < 6 && Math.abs(m) > 0.012; it++) {
    let next;
    if (aPrev === null || Math.abs(m - mPrev) < 1e-5) next = a - m / Math.max(d, 0.5);
    else next = a - m * (a - aPrev) / (m - mPrev);
    // a putt never needs to start more than ~60° outside the hole
    next = a0 + clamp(next - a0, -1, 1);
    aPrev = a; mPrev = m; a = next;
    if (it < 3 && !edge) v = yield* speedSteps(h, env, b.p, cupDir, d + 0.43, dirOf(a), v);
    const leave = yield* puttLeave(a, v);
    m = yield* puttMiss(a, v);
    if (leave < best.leave || (leave === 0 && best.leave === 0 && Math.abs(m) < best.m)) best = { a, v, leave, m: Math.abs(m) };
    yield;
  }
  // Over a ridge or down a tier the miss isn't smooth in aim and pace (a touch softer
  // stops on the shelf, a touch firmer runs off the green), so fall back to a coarse
  // search for the line that finishes closest, then a pattern search around it.
  if (best.leave > 0.6) {
    const try1 = function* (ca, cv) { const leave = yield* puttLeave(ca, cv); if (leave < best.leave) best = { a: ca, v: cv, leave }; };
    // (the pace solve can overshoot on a bank – reaching the far point may mean running
    // up and back – so the grid also tries much softer strokes, and lines well outside
    // the hole for a putt along a tier face)
    const offs = [0, -0.09, 0.09, -0.18, 0.18, -0.27, 0.27, -0.36, 0.36, -0.45, 0.45, -0.6, 0.6, -0.75, 0.75, -0.9, 0.9];
    for (const o of offs) {
      for (const f of [0.35, 0.5, 0.65, 0.8, 0.9, 1, 1.15, 1.3, 1.5, 1.75, 2.1]) { yield* try1(a0 + o, base.speed * f); yield; }
      if (best.leave === 0) break;
    }
    let da = 0.06, fv = 0.15;
    for (let r = 0; r < 8 && best.leave > 0; r++) {
      const c = best;
      for (const [sa, sv] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { yield* try1(c.a + sa * da, c.v * (1 + sv * fv)); yield; }
      if (best === c) { da /= 2; fv /= 2; }
    }
  }
  // Over a ridge the best line is often a knife edge: the ball just stops on a shelf
  // (or just drops), and 1% firmer or half a degree off runs 20-30 ft down the tier.
  // Nobody strokes it that exactly, so judge the line by its average leave over a
  // normal stroke's errors (±3% pace, ±0.5° line); when that is poor, search for the
  // line and pace that forgive them. (An ordinary putt averages well under a metre.)
  const ERR = [[0, 0], [0, 0.03], [0, -0.03], [0.0087, 0], [-0.0087, 0]];
  // (the first sample is the exact stroke, so robust() also hands back its leave; a
  // candidate stops rolling once its total can no longer beat `bound`)
  const robust = function* (ca, cv, bound = Infinity) {
    let s = 0, exact = 0;
    for (const [ea, ev] of ERR) {
      const l = yield* puttLeave(ca + ea, cv * (1 + ev));
      if (!ea && !ev) exact = l;
      s += Math.min(l, 30);
      yield;
      if (s >= bound * ERR.length) return null;
    }
    return { a: ca, v: cv, leave: exact, score: s / ERR.length };
  };
  let rb = yield* robust(best.a, best.v);
  if (rb.score > 1.5 || best.leave > 0.6) {
    let ra = 0.03, rv = 0.08;
    for (let r = 0; r < 5 && rb.score > 0.6; r++) {
      const c = rb;
      for (const [sa, sv] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const t = yield* robust(c.a + sa * ra, c.v * (1 + sv * rv), rb.score);
        if (t) rb = t;
      }
      if (rb === c) { ra /= 2; rv /= 2; }
    }
    best = rb;
  }
  const score = rb.score;
  ({ a, v } = best);
  const eqFt = (v * v) / (2 * h.greenRoll * G) / FT;
  const range = puttRangeFor(eqFt);
  const brk = Math.sin(a - a0) * d;
  return { ...base, eqFt, range, aim: a, speed: v, cupAim: a0, brk, leave: best.leave, spread: score };
}
export function puttRead(hole, ball, env) {
  const it = puttReadSteps(hole, ball, env);
  it.next(); // (the first guess)
  return drain(it);
}

// The caddie's read in words: where to start it (cup = 4.25 in), which way it
// breaks, and how the slope changes the pace.
export function puttNote(rd) {
  const CUP = 0.108, side = rd.brk > 0 ? 'right' : 'left';
  const out = Math.abs(rd.brk) - CUP / 2; // past the edge of the hole
  let line;
  if (Math.abs(rd.brk) < 0.02) line = 'Straight – hit it firm at the middle';
  else if (out < -0.02) line = `Aim inside the ${side} edge`;
  else if (out <= 0.03) line = `Aim at the ${side} edge`;
  else if (out < CUP * 6) {
    const n = Math.max(0.5, Math.round(out / CUP * 2) / 2);
    const txt = (n % 1 ? (n > 1 ? `${Math.floor(n)}½` : '½') : `${n}`);
    line = `Aim ${txt} cup${n > 1 ? 's' : ''} outside the ${side} edge`;
  } else line = `Aim ${Math.round(Math.abs(rd.brk) / FT)} ft ${side} of the hole`;
  const breaks = Math.abs(rd.brk) < 0.02 ? '' : `, breaks ${side === 'right' ? 'right to left' : 'left to right'}`;
  const e = Math.round(rd.elevIn);
  const slope = Math.abs(e) < 2 ? 'Level' : `${e > 0 ? 'Uphill' : 'Downhill'} ${Math.abs(e)} in`;
  let msg = `Read: ${line}${breaks}. ${slope}, stroke it ${Math.round(rd.eqFt)} ft.`;
  if (rd.leave > 0.9 || rd.spread > 1.5) msg += ' No easy line here – lag it close.';
  return msg;
}

// meter power that carries `need` metres in still air from the given lie
export function powerForCarry(club, need, { traj = 0, lie = 'fairway', rho = 1.2 } = {}) {
  let lo = 0.1, hi = 1.1;
  for (let i = 0; i < 12; i++) {
    const p = (lo + hi) / 2;
    const ld = computeLaunch(club, { power: p, face: 0, path: 0, strike: 1, traj, lie });
    const c = simulateCarry(ld, { rho, wind: [0, 0, 0] }, { fwd: [0, 0, -1], dt: 1 / 120 }).carry;
    if (c < need) lo = p; else hi = p;
  }
  return (lo + hi) / 2;
}

export class Caddie {
  constructor(game) {
    this.g = game;
    this.analysis = null;
    this.reading = null; // putt read in progress (see setupPutt)
    this.lastRead = null; // { ms, cpu } of the last finished read
    this.puttLead = ''; // advice shown ahead of the putt read (e.g. why putt from the fringe)
    this.results = null; // last lay-up analysis, kept so the note can follow a club change
    this.msg = '';
  }

  // Plays-like distance: compares the club's carry on flat ground in still air
  // with its carry to the target's elevation in the current wind.
  playsLike(club, targetDist, dh, dir) {
    const g = this.g;
    const ld = computeLaunch(club, { power: 1, face: 0, path: 0, strike: 1, traj: g.traj, lie: 'fairway' });
    const fwd = [dir.x, 0, dir.z];
    const flat = simulateCarry(ld, { rho: g.env.rho, wind: [0, 0, 0] }, { fwd });
    const elev = simulateCarry(ld, { rho: g.env.rho, wind: [0, 0, 0] }, { fwd, landY: dh });
    const both = simulateCarry(ld, { rho: g.env.rho, wind: g.env.wind }, { fwd, landY: dh });
    if (!elev.reached || !both.reached) {
      // the target is above this club's apex (a weak swing up a long hill): elevation by the
      // rule of thumb (1 m of distance per metre of rise), wind from a level landing
      const wind = simulateCarry(ld, { rho: g.env.rho, wind: g.env.wind }, { fwd });
      const fw = flat.carry / Math.max(1, wind.carry);
      return { plays: targetDist * fw + dh, elevAdj: dh, windAdj: targetDist * (fw - 1) };
    }
    const fe = flat.carry / Math.max(1, elev.carry), fb = flat.carry / Math.max(1, both.carry);
    return { plays: targetDist * fb, elevAdj: targetDist * (fe - 1), windAdj: targetDist * (fb - fe) };
  }

  chooseClub() {
    const g = this.g, h = g.hole, b = g.ball;
    const d = g.distToPin();
    const dir = dirOf(g.aim);
    const dh = h.height(h.cup.x, h.cup.z) - (b.p[1] - BALL.radius);
    g.pl = null;
    this.msg = '';
    this.puttLead = '';
    this.analysis = null;
    this.results = null;
    if (wantsPutter(h, b)) {
      // set before setClub so the putt read (which may finish a few frames later) keeps it
      this.puttLead = b.surface !== 'green' ? 'Putt it from here. A poor putt usually finishes closer than a poor chip.' : '';
      g.setClub(g.bag.length - 1);
      return;
    }
    const usable = g.bag.filter((c) => !c.putter && (c.key !== 'DR' || b.isTee));
    // plays-like distance using the club that carries about the distance, then refine
    const club = usable.find((c) => c.carry <= d * 1.02) || usable[usable.length - 1];
    let pl = this.playsLike(club, d, dh, dir);
    // a heavy lie takes distance off every club (deep rough ~25%): club up for it
    const lieK = g.lieKey(), keep = lieK === 'fairway' || lieK === 'tee' || lieK === 'splash' ? 1 : this.lieCarry(club, lieK);
    const pick = (need, k = keep) => {
      let best = null;
      for (const c of usable) if (c.carry * k >= need * 0.985) best = c; // smallest club that carries
      return best;
    };
    let target = pick(pl.plays);
    if (target) { pl = this.playsLike(target, d, dh, dir); target = pick(pl.plays) || target; }
    g.pl = pl;
    const lie = g.lieKey();
    if (lie === 'splash' || (b.surface === 'bunker' && h.greenSdf(b.p[0], b.p[2]) < 30)) {
      target = g.bag.find((c) => c.key === 'SW');
      this.msg = 'Greenside bunker: open the face, splash the sand – the ball rides out on it.';
    }
    if (target && !(h.par >= 4 && b.isTee && pl.plays > target.carry + 30)) {
      g.setClub(g.bag.indexOf(target));
      // a club that needs everything (into the wind, spinning back) leaves no room for a
      // slightly short swing: take one more and swing within yourself
      const up = usable[usable.indexOf(target) - 1];
      let power = this.finishAtPin(pl.plays);
      if (up && !this.msg && power > 0.97) {
        target = up;
        g.setClub(g.bag.indexOf(target));
        g.pl = pl = this.playsLike(target, d, dh, dir);
        power = this.finishAtPin(pl.plays);
      }
      if (!this.msg && keep < 0.9) {
        const short = `Heavy lie: the ball comes out ~${Math.round((1 - keep) * 100)}% short`;
        this.msg = pick(pl.plays, 1) !== target ? `${short}, so take more club.` : `${short}: swing harder than the yardage says.`;
      }
      const pinAim = g.aim, wind = this.aimForWind(power);
      const side = this.aimAwayFromTrouble(power);
      if (!this.msg) this.msg = this.aimNote(pinAim, wind, side);
      return;
    }
    // pin out of range (tee shots / lay-ups): evaluate options by expected strokes
    const longest = usable[0];
    g.setClub(g.bag.indexOf(longest));
    this.aimForClub(longest);
    this.startAnalysis(usable);
  }

  // In range, but a typical miss to one side finds water or out of bounds (the road behind
  // the Road Hole, a green on the cliff edge): aim off toward the safe side, 1° at a time
  // up to 4°, while that lowers the expected score (aiming so far away that a good swing
  // finds a bunker is no better). Returns the caddie's line for it, or ''.
  aimAwayFromTrouble(power) {
    const g = this.g, c = g.club;
    if (c.putter) return '';
    const miss = (c.loft < 20 ? 3.2 : c.loft < 30 ? 2.4 : 1.8) * 0.6;
    const out = (aim, face) => this.simOutcome(c, aim, { face, power, withWind: true, dt: 1 / 90 });
    const wet = (o) => o.result === 'water' || o.result === 'ob';
    const aim0 = g.aim, oL = out(aim0, -miss), oR = out(aim0, miss), o0 = out(aim0, 0);
    if (wet(oL) === wet(oR) || wet(o0)) return '';
    const W = [0.3, 0.4, 0.3];
    const score = (aim) => this.strokesFor(aim, power, [[-miss, 1, W[0]], [0, 1, W[1]], [miss, 1, W[2]]]);
    const s0 = W[0] * this.strokesAfter(oL) + W[1] * this.strokesAfter(o0) + W[2] * this.strokesAfter(oR);
    // which way is away from the trouble: try a degree each side first
    let best = { aim: aim0, s: s0 };
    for (const sgn of [1, -1]) {
      const aim = aim0 + sgn * DEG, s = score(aim);
      if (s < best.s) best = { aim, s, sgn };
    }
    for (let k = 2; best.sgn && k <= 4; k++) {
      const aim = aim0 + best.sgn * k * DEG, s = score(aim);
      if (s >= best.s) break;
      best = { aim, s, sgn: best.sgn };
    }
    if (best.s > s0 - 0.03) return null;
    g.aim = best.aim;
    g.placeGolfer();
    return { right: best.aim > aim0, what: (wet(oL) ? oL : oR).result === 'ob' ? 'out of bounds' : 'the water' };
  }

  // A crosswind moves the ball off the line: aim off by the drift so the ball finishes at the
  // pin, as a caddie would ("five right, the wind brings it back"). A Pro judges it for
  // themselves (the landing marker still shows the drift). Returns true if the aim moved.
  aimForWind(power) {
    const g = this.g, c = g.club, b = g.ball, h = g.hole;
    if (c.putter || g.settings?.difficulty === 'pro') return false;
    const aim0 = g.aim, toPin = angOf(h.cup.x - b.p[0], h.cup.z - b.p[2]);
    for (let k = 0; k < 2; k++) {
      const o = this.simOutcome(c, g.aim, { power, withWind: true, dt: 1 / 90 });
      let err = toPin - angOf(o.rest[0] - b.p[0], o.rest[2] - b.p[2]);
      err = Math.atan2(Math.sin(err), Math.cos(err));
      if (Math.abs(err) * g.distToPin() < 1.5) break;
      g.aim += clamp(err, -12 * DEG, 12 * DEG);
    }
    if (g.aim === aim0) return false;
    g.placeGolfer();
    return true;
  }

  // the caddie's line for the aim it chose: off the pin for the wind, away from trouble
  aimNote(pinAim, wind, side) {
    const g = this.g, yd = Math.round(Math.sin(g.aim - pinAim) * g.distToPin() / YD);
    const lr = (right) => (right ? 'right' : 'left');
    const miss = side ? `a miss ${lr(!side.right)} finds ${side.what}` : '';
    if (wind && Math.abs(yd) >= 3) {
      const msg = `Aim ${Math.abs(yd)} yd ${lr(yd > 0)} of the pin: the wind moves it ${lr(yd < 0)}.`;
      return side ? `${msg} A${miss.slice(1)}.` : msg;
    }
    return side ? `Favour the ${lr(side.right)} of the pin: ${miss}.` : '';
  }

  // fraction of a club's still-air carry left from the given lie
  lieCarry(club, lie) {
    const g = this.g;
    const carry = (l) => simulateCarry(computeLaunch(club, { power: 1, face: 0, path: 0, strike: 1, traj: g.traj, lie: l }), { rho: g.env.rho, wind: [0, 0, 0] }, { fwd: [0, 0, -1] }).carry;
    return clamp(carry(lie) / Math.max(1, carry('fairway')), 0.3, 1.1);
  }

  // point on the centre line `dist` metres from the ball (or the cup if the hole is shorter)
  centreLineTarget(dist) {
    const g = this.g, h = g.hole, b = g.ball;
    const pr = h.project(b.p[0], b.p[2]);
    for (let s = pr.s; s <= h.length; s += 2) {
      const q = h.pointAt(s);
      if (Math.hypot(q.x - b.p[0], q.z - b.p[2]) >= dist) return q;
    }
    return null;
  }

  // aim along the centre line at the club's typical total distance
  aimForClub(club) {
    const g = this.g, b = g.ball;
    const want = club.total * (b.surface === 'fairway' || b.isTee ? 1 : 0.9);
    const best = this.centreLineTarget(want) || { x: g.hole.cup.x, z: g.hole.cup.z };
    g.aim = angOf(best.x - b.p[0], best.z - b.p[2]);
    g.placeGolfer();
  }

  startAnalysis(clubs) {
    const cands = clubs.slice(0, 9).filter((c) => c.total * 0.8 < this.g.distToPin());
    this.analysis = { cands, i: 0, results: [] };
    this.msg = 'Caddie is checking the landing areas…';
  }

  // a few milliseconds a frame so the game stays responsive (the full search is ~200 sims)
  stepAnalysis() {
    const A = this.analysis;
    if (!A || this.g.state !== 'address') return;
    A.it ??= this.analysisSteps(A);
    const t0 = performance.now();
    do { if (A.it.next().done) { this.finishAnalysis(); return; } } while (performance.now() - t0 < SLICE_MS);
  }

  // every candidate club on the centre line, then lines up to 40 m either side of the centre
  // for the two best clubs and any club that finds trouble (out of bounds or water hugging
  // one side of a fairway moves the best line away from it). Yields after each sim.
  *analysisSteps(A) {
    const b = this.g.ball;
    for (const club of A.cands) {
      const tgt = this.centreLineTarget(club.total);
      if (!tgt) continue;
      const aim = angOf(tgt.x - b.p[0], tgt.z - b.p[2]);
      A.results.push({ club, aim, ...(yield* this.rateAimSteps(club, aim)) });
    }
    // every club that brings trouble into play, plus the two best, looks for a better line
    const top = A.results.slice().sort((p, q) => p.es - q.es).slice(0, 2);
    const aimQ = [];
    for (const r of A.results) if (top.includes(r) || r.notes.length) for (const off of [-10, 10, -20, 20, -30, 30, -40, 40]) aimQ.push({ r, off, aim0: r.aim });
    // the target shifted sideways by `off` metres at the club's distance (in order of size,
    // so a smaller shift wins a tie)
    for (const q of aimQ) {
      const dir = dirOf(q.aim0), dist = q.r.club.total;
      const aim = angOf(dir.x * dist - dir.z * q.off, dir.z * dist + dir.x * q.off);
      const out = yield* this.rateAimSteps(q.r.club, aim);
      if (out.es < q.r.es - 0.02) Object.assign(q.r, { aim, ...out });
    }
  }

  // expected strokes (including this one) for a full swing on `aim`: straight, a typical
  // miss either way, and one a touch long and short (a lay-up that only just stops short
  // of a pond at 100% is in it when the swing is hot), in the current wind
  rateAim(club, aim) { return drain(this.rateAimSteps(club, aim)); }
  *rateAimSteps(club, aim) {
    const spread = club.loft < 20 ? 3.2 : club.loft < 30 ? 2.4 : 1.8;
    let es = 0; const notes = [];
    for (const [face, power, w] of [[-spread, 1, 0.25], [0, 1, 0.3], [spread, 1, 0.25], [0, 1.05, 0.1], [0, 0.95, 0.1]]) {
      const out = this.simOutcome(club, aim, { face, power, dt: 1 / 90, withWind: true });
      yield;
      if (out.result === 'water') notes.push('water');
      else if (out.result === 'ob') notes.push('out of bounds');
      else if (out.surface === 'bunker') notes.push('bunkers');
      else if (out.surface === 'deep' || out.surface === 'straw') notes.push('trees');
      es += this.strokesAfter(out) * w;
    }
    return { es: es + 1, notes: [...new Set(notes)] };
  }

  // tour-average strokes still to play after a shot that finishes as `out` (a simOutcome),
  // penalty included
  strokesAfter(out) {
    const g = this.g, b = g.ball;
    if (out.result === 'holed') return 0;
    if (out.result === 'water') return 1 + expectedStrokes('rough', out.entryDist / YD);
    if (out.result === 'ob') return 1 + expectedStrokes(b.isTee ? 'fairway' : b.surface, g.distToPin() / YD, b.isTee);
    return expectedStrokes(out.surface, out.dist / YD);
  }

  // expected strokes after the shot on (aim, power) and its ordinary misses either way;
  // `misses` lists [face°, power factor, weight]
  strokesFor(aim, power, misses) {
    let es = 0;
    for (const [face, k, w] of misses) es += w * this.strokesAfter(this.simOutcome(this.g.club, aim, { face, power: power * k, withWind: true, dt: 1 / 90 }));
    return es;
  }

  finishAnalysis() {
    const A = this.analysis, g = this.g;
    this.analysis = null;
    if (!A.results.length) { this.msg = ''; return; }
    A.results.sort((a, b) => a.es - b.es);
    const best = A.results[0];
    this.longestCand = A.cands[0];
    if (!g.userClub) {
      g.setClub(g.bag.indexOf(best.club));
      g.aim = best.aim;
      g.placeGolfer();
      g.previewDirty = true;
    }
    this.results = A.results;
    this.msg = this.noteForClub(g.club);
    g.updateHUD(true);
  }

  // The caddie's line for the club in the player's hands: the lay-up analysis ranks every
  // candidate, so a club the player picks gets its own number next to the caddie's choice.
  noteForClub(club) {
    const R = this.results;
    if (!R?.length) return '';
    const best = R[0];
    const fmt = (r) => `${r.club.name} ${r.es.toFixed(2)}`;
    const mine = R.find((r) => r.club === club);
    if (!mine) return `Caddie's pick from here: ${fmt(best)}.`;
    if (mine === best) {
      let msg = `Caddie: ${best.club.name} – expected score from here ${best.es.toFixed(2)}.`;
      const longest = R.find((r) => r.club === this.longestCand);
      if (longest && longest !== best) msg += ` ${fmt(longest)}${longest.notes.length ? ` (brings ${longest.notes.join(' & ')} into play)` : ''}.`;
      return msg;
    }
    return `${mine.club.name}: expected score ${mine.es.toFixed(2)}${mine.notes.length ? ` (brings ${mine.notes.join(' & ')} into play)` : ''}. Caddie's pick: ${fmt(best)}.`;
  }

  // A sloping lie turns a lofted face (physics.js lieFace): warn before the shot, not after
  lieNote() {
    const g = this.g;
    if (!g.club || g.club.putter || g.state !== 'address') return '';
    const f = computeLaunch(g.club, { power: 1, face: 0, path: 0, strike: 1, lie: g.lieKey(), slope: g.slope() }).lieFace;
    if (Math.abs(f) < 3) return '';
    return `Ball ${f < 0 ? 'above' : 'below'} your feet: the ${g.club.name} face points ~${Math.round(Math.abs(f))}° ${f < 0 ? 'left' : 'right'} – aim ${f < 0 ? 'right' : 'left'} of the target.`;
  }

  // the player took a different club: drop notes written for the previous one
  clubChanged() {
    if (this.analysis) return; // still deciding – the message is "checking…"
    this.msg = this.noteForClub(this.g.club);
    this.g.caddieNote();
  }

  // Deterministic outcome of a shot (used by the caddie and previews)
  simOutcome(club, aim, o = {}) {
    const g = this.g, h = g.hole, b = g.ball;
    const dir = dirOf(aim);
    const sh = SHAPES[g.shape];
    const ld = computeLaunch(club, { power: o.power ?? 1, face: (o.face || 0) + sh.face, path: sh.path, strike: 1, traj: g.traj, lie: g.lieKey(), slope: g.slope() });
    const env = { ...g.env, wind: o.withWind ? g.env.wind : [0, 0, 0] };
    const sim = new BallSim(h, env, mulberry32(7));
    const start = [b.p[0], b.p[1] + (g.ballLift || 0), b.p[2]];
    sim.launch(start, ld, [dir.x, 0, dir.z]);
    const dt = o.dt || 1 / 120;
    const pts = o.path ? [start.slice()] : null;
    let n = 0, land = null;
    while (sim.state !== 'rest' && sim.state !== 'holed' && n++ < 9000) {
      sim.step(dt);
      if (pts && n % 3 === 0 && !land) pts.push(sim.p.slice());
      if (!land && sim.landed) { land = sim.landed.slice(); if (o.stopAtLand) break; }
    }
    const ev = sim.events.map((e) => e.type);
    let result = 'ok';
    if (ev.includes('water')) result = 'water';
    if (ev.includes('ob')) result = 'ob';
    if (sim.state === 'holed') result = 'holed';
    const p = sim.p;
    const out = { result, land, rest: p.slice(), path: pts, ld, surface: h.surface(p[0], p[2]), dist: Math.hypot(h.cup.x - p[0], h.cup.z - p[2]) };
    if (result === 'water') {
      const e = findEntry(h, sim, g.ball.p);
      out.entryDist = Math.hypot(h.cup.x - e.x, h.cup.z - e.z);
    }
    return out;
  }

  // ------------------------------------------------------------------ putting
  // Effective (flat-equivalent) distance: the speed that would finish ~17 in (43 cm) past
  // the hole if it missed – Pelz's optimum, and what the meter marker teaches. On
  // Beginner and Standard the caddie also reads the break and lines the putter up on
  // it; a Pro reads their own greens (aimed at the cup, pace for the straight line).
  setupPutt() {
    const g = this.g;
    this.reading = null;
    // A Pro gets the straight-at-the-cup pace only.
    const read = g.settings?.difficulty !== 'pro';
    // Most reads take a few ms. A putt over a ridge or along a tier face can take a
    // second or two, so after a short budget the rest is spread over the next frames
    // (stepReading) with the putter lined up at the cup in the meantime.
    const it = puttReadSteps(g.hole, g.ball, g.env, !read);
    const t0 = performance.now();
    const guess = it.next().value;
    for (;;) {
      const r = it.next();
      if (r.done) { const ms = performance.now() - t0; this.lastRead = { ms, cpu: ms }; this.applyPutt(r.value, read); return; }
      if (performance.now() - t0 > SLICE_MS) break;
    }
    this.applyPutt(guess, false);
    if (read) {
      this.msg = this.withLead('Caddie is reading the putt…');
      if (g.ui) g.caddieNote();
    }
    this.reading = { it, read, aim: g.aim, ball: g.ball.p.slice(), t0, cpu: performance.now() - t0 };
  }

  // a few ms of the putt read per frame; dropped if the swing starts or anything changes
  stepReading() {
    const R = this.reading, g = this.g;
    if (!R) return;
    const b = g.ball.p;
    if (g.state !== 'address' || !g.club?.putter || b[0] !== R.ball[0] || b[2] !== R.ball[2]) { this.reading = null; return; }
    const t0 = performance.now();
    for (;;) {
      const r = R.it.next();
      if (r.done) {
        this.reading = null;
        // wall time from address to a finished read, and the CPU time it took (shown by ?perf)
        this.lastRead = { ms: performance.now() - R.t0, cpu: R.cpu + performance.now() - t0 };
        const userAimed = Math.abs(g.aim - R.aim) > 1e-6;
        this.applyPutt(r.value, R.read, userAimed);
        if (!userAimed) g.placeGolfer();
        g.previewDirty = true;
        return;
      }
      if (performance.now() - t0 > READ_MS) { R.cpu += performance.now() - t0; return; }
    }
  }

  withLead(m) { return [this.puttLead, m].filter(Boolean).join(' '); }

  applyPutt(ps, read, keepAim = false) {
    const g = this.g;
    g.puttRead = read ? ps : null;
    g.puttEqFt = ps.eqFt;
    g.puttRange = ps.range;
    g.puttElevIn = ps.elevIn;
    const R = g.puttRange;
    g.meter.configure({ labels: [[0.25, `${Math.round(R * 0.25)}ft`], [0.5, `${Math.round(R * 0.5)}ft`], [0.75, `${Math.round(R * 0.75)}ft`], [1, `${R}ft`]], rangeLabel: `Putter range ${R} ft` });
    if (!keepAim) g.aim = ps.aim;
    this.msg = this.withLead(read ? puttNote(ps) : '');
    if (g.ui) g.caddieNote();
  }

  // ------------------------------------------------------------------ meter marker
  // Like a real caddie: the number that matters is where the ball FINISHES. Start from the
  // plays-like carry, then bisect on full terrain sims so the release (bounce + roll) is included.
  powerForFinish(need) { return drain(this.powerSteps(need)); }
  // the same search a sim at a time, so aiming can spread it over frames (game.stepPower)
  *powerSteps(need) {
    const p = yield* this.finishSteps(need);
    return this.g.club.putter ? p : yield* this.clearSteps(p);
  }

  // A swing ~4-6% off the number is an ordinary miss. If that miss on one side finds water
  // or out of bounds (a front pin just over a creek), move the number away from it, the
  // way a caddie says "take enough to carry the water" and accepts the longer putt.
  clearOfTrouble(p) { return drain(this.clearSteps(p)); }
  *clearSteps(p) {
    // newer players miss by more, so their caddie leaves more room
    const g = this.g, M = { beginner: 0.06, standard: 0.05 }[g.settings?.difficulty] ?? 0.04;
    const wet = (pw) => pw <= 1.05 && ['water', 'ob'].includes(this.simOutcome(g.club, g.aim, { power: pw, withWind: true, dt: 1 / 90 }).result);
    const short = wet(p * (1 - M)); yield;
    const long = wet(p * (1 + M)); yield;
    if (short === long) return p;
    const step = short ? 0.01 : -0.01, side = short ? 1 - M : 1 + M;
    for (let q = p + step, i = 0; i < 8 && q > 0.1 && q <= 1; q += step, i++) {
      const near = wet(q * side); yield;
      if (near) continue;
      const far = wet(q * (2 - side)); yield;
      if (far) return p;
      // only if it is the better bet: carrying the creek is no help if the swing that
      // does it runs off the back of a shallow green into a bunker
      const misses = [[0, 1 - M, 0.25], [0, 1, 0.5], [0, 1 + M, 0.25]];
      const sq = this.strokesFor(g.aim, q, misses); yield;
      return sq < this.strokesFor(g.aim, p, misses) ? q : p;
    }
    return p;
  }

  finishAtPin(need) { return drain(this.finishSteps(need)); }
  *finishSteps(need) {
    const g = this.g, h = g.hole, b = g.ball;
    const p0 = this.powerForCarry(need);
    if (g.club.putter) return p0;
    const dir = dirOf(g.aim);
    const toCup = (h.cup.x - b.p[0]) * dir.x + (h.cup.z - b.p[2]) * dir.z;
    const along = (pw) => {
      const o = this.simOutcome(g.club, g.aim, { power: pw, withWind: true, dt: 1 / 90 });
      return (o.rest[0] - b.p[0]) * dir.x + (o.rest[2] - b.p[2]) * dir.z - toCup;
    };
    const a0 = along(p0); yield;
    if (Math.abs(a0) <= 1.5) return p0;
    // released past the pin → less power; spun back short → more power (capped at a full swing)
    let lo = a0 > 0 ? Math.max(0.1, p0 - 0.35) : p0, hi = a0 > 0 ? p0 : Math.min(1, p0 + 0.2);
    const end = a0 > 0 ? lo : hi, a1 = along(end); yield;
    if (a0 > 0 ? a1 > 0 : a1 < 0) return end;
    for (let i = 0; i < 8; i++) {
      const m = (lo + hi) / 2, a = along(m); yield;
      if (a > 0.3) hi = m; else lo = m;
    }
    return (lo + hi) / 2;
  }

  powerForCarry(need) {
    const g = this.g;
    return powerForCarry(g.club, need, { traj: g.traj, lie: g.lieKey(), rho: g.env.rho });
  }
}
