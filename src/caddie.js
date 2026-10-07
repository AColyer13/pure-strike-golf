// Caddie: club selection, plays-like distances, expected-strokes lay-up analysis,
// meter-marker power suggestions and putt reads. Reads the game state (hole, ball,
// wind, shot shape) and only changes the club/aim through the game's setters.
import { BallSim, computeLaunch, simulateCarry, puttSpeedFor, BALL, G } from './physics.js';
import { YD, FT, mulberry32 } from './hole.js';
import { expectedStrokes } from './stats.js';
import { dirOf, angOf, clamp } from './util.js';
import { SHAPES } from './config.js';
import { findEntry } from './rules.js';

// Pure helpers (no game instance) so the rules can be tested and reused.
// The caddie reaches for the putter on the green, or from the fringe / first
// cut when a chip has more ways to go wrong than a putt.
export function wantsPutter(hole, ball) {
  const d = Math.hypot(hole.cup.x - ball.p[0], hole.cup.z - ball.p[2]);
  const s = ball.surface;
  return s === 'green' || (s === 'fringe' && d < 18) || (s === 'cut' && d < 12 && hole.greenSdf(ball.p[0], ball.p[2]) < 4);
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

// Rolls a putt from p along `dir` at speed v with the hole covered, calling each(pos)
// every step. Shared by the pace and break solvers below.
function rollCovered(hole, env, p, dir, v, each) {
  const h = hole;
  const sim = new BallSim(h, env, mulberry32(3));
  const oldPin = h.pinIn, cup = h.cup; h.pinIn = false;
  h.cup = { ...cup, x: 1e6, z: 1e6 }; // measure the roll with the hole covered
  try {
    sim.putt(p.slice(), [dir.x, 0, dir.z], v);
    let n = 0;
    while (sim.state === 'roll' && n++ < 3000) { sim.step(1 / 120); if (each(sim.p) === false) break; }
  } finally { h.pinIn = oldPin; h.cup = cup; }
  return sim.p;
}

// bisect on full green sims (slopes included) for the start speed that rolls `d` metres
// from p along dir (unit, {x, z}). "Reaches d" is judged on the furthest point of the
// roll, not where the ball stops: on a green with a rise beyond the hole a hot putt
// runs up and back past its start, which would otherwise read as "not far enough".
// `launch` (default dir) starts the ball on a different line, for a putt aimed outside
// the hole; `guess` narrows the bracket when a nearby answer is already known.
export function puttSpeedToReach(hole, env, p, dir, d, launch = dir, guess = 0) {
  const it = speedSteps(hole, env, p, dir, d, launch, guess);
  for (;;) { const r = it.next(); if (r.done) return r.value; }
}
// the same bisection, yielding after each roll (for the time-sliced read)
function* speedSteps(hole, env, p, dir, d, launch, guess) {
  const reach = (v) => {
    let far = 0;
    rollCovered(hole, env, p, launch, v, (q) => { far = Math.max(far, (q[0] - p[0]) * dir.x + (q[2] - p[2]) * dir.z); });
    return far;
  };
  let lo = 0.2, hi = 14, its = 12;
  if (guess > 0) {
    const short = reach(guess * 0.85) < d;
    yield;
    if (short && reach(guess * 1.2) >= d) { lo = guess * 0.85; hi = guess * 1.2; its = 7; }
    yield;
  }
  for (let it = 0; it < its; it++) {
    const v = it === 0 && !guess ? puttSpeedFor(d, hole.greenRoll) : (lo + hi) / 2;
    if (reach(v) >= d) hi = v; else lo = v;
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
export function puttSetup(hole, ball, env) {
  const h = hole, b = ball;
  const d = Math.hypot(h.cup.x - b.p[0], h.cup.z - b.p[2]) || 1e-6;
  const dir = { x: (h.cup.x - b.p[0]) / d, z: (h.cup.z - b.p[2]) / d };
  const v = puttSpeedToReach(h, env, b.p, dir, d + 0.43);
  const eqFt = (v * v) / (2 * h.greenRoll * G) / FT;
  const range = puttRangeFor(eqFt);
  const elevIn = (h.height(h.cup.x, h.cup.z) - h.height(b.p[0], b.p[2])) / 0.0254;
  return { eqFt, range, elevIn, aim: angOf(dir.x, dir.z), speed: v };
}

// Sideways miss (metres, + = right of the cup as the player looks at it) of a putt
// started along aim `a` at speed v: where the roll crosses the line through the cup
// square to the putt, or where it stops if it never gets there.
function puttMiss(hole, env, p, cupDir, d, a, v) {
  const launch = dirOf(a);
  const rx = -cupDir.z, rz = cupDir.x; // player's right when facing the cup
  let hit = null;
  const end = rollCovered(hole, env, p, launch, v, (q) => {
    if ((q[0] - p[0]) * cupDir.x + (q[2] - p[2]) * cupDir.z >= d) { hit = q.slice(); return false; }
  });
  const q = hit || end;
  return (q[0] - hole.cup.x) * rx + (q[2] - hole.cup.z) * rz;
}

// Where a putt along aim `a` at speed v really finishes, hole in play: 0 when it drops.
function puttLeave(hole, env, p, a, v) {
  const h = hole, d = dirOf(a);
  const sim = new BallSim(h, env, mulberry32(3));
  const oldPin = h.pinIn; h.pinIn = false;
  try {
    sim.putt(p.slice(), [d.x, 0, d.z], v);
    let n = 0;
    while (sim.state === 'roll' && n++ < 3000) sim.step(1 / 120);
  } finally { h.pinIn = oldPin; }
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
export function* puttReadSteps(hole, ball, env) {
  const h = hole, b = ball;
  const base = puttSetup(h, b, env);
  yield base;
  const d = Math.hypot(h.cup.x - b.p[0], h.cup.z - b.p[2]) || 1e-6;
  const cupDir = { x: (h.cup.x - b.p[0]) / d, z: (h.cup.z - b.p[2]) / d };
  const a0 = base.aim;
  let v = base.speed, a = a0;
  let best = { a, v, leave: puttLeave(h, env, b.p, a, v) };
  let m = puttMiss(h, env, b.p, cupDir, d, a, v);
  yield;
  let aPrev = null, mPrev = null;
  for (let it = 0; it < 6 && best.leave > 0 && Math.abs(m) > 0.012; it++) {
    let next;
    if (aPrev === null || Math.abs(m - mPrev) < 1e-5) next = a - m / Math.max(d, 0.5);
    else next = a - m * (a - aPrev) / (m - mPrev);
    // a putt never needs to start more than ~60° outside the hole
    next = a0 + clamp(next - a0, -1, 1);
    aPrev = a; mPrev = m; a = next;
    if (it < 3) v = yield* speedSteps(h, env, b.p, cupDir, d + 0.43, dirOf(a), v);
    const leave = puttLeave(h, env, b.p, a, v);
    if (leave < best.leave) best = { a, v, leave };
    m = puttMiss(h, env, b.p, cupDir, d, a, v);
    yield;
  }
  // Over a ridge or down a tier the miss isn't smooth in aim and pace (a touch softer
  // stops on the shelf, a touch firmer runs off the green), so fall back to a coarse
  // search for the line that finishes closest, then a pattern search around it.
  if (best.leave > 0.6) {
    const try1 = (ca, cv) => { const leave = puttLeave(h, env, b.p, ca, cv); if (leave < best.leave) best = { a: ca, v: cv, leave }; };
    // (the pace solve can overshoot on a bank – reaching the far point may mean running
    // up and back – so the grid also tries much softer strokes, and lines well outside
    // the hole for a putt along a tier face)
    const offs = [0, -0.09, 0.09, -0.18, 0.18, -0.27, 0.27, -0.36, 0.36, -0.45, 0.45, -0.6, 0.6, -0.75, 0.75, -0.9, 0.9];
    for (const o of offs) {
      for (const f of [0.35, 0.5, 0.65, 0.8, 0.9, 1, 1.15, 1.3, 1.5, 1.75, 2.1]) { try1(a0 + o, base.speed * f); yield; }
      if (best.leave === 0) break;
    }
    let da = 0.06, fv = 0.15;
    for (let r = 0; r < 8 && best.leave > 0; r++) {
      const c = best;
      for (const [sa, sv] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { try1(c.a + sa * da, c.v * (1 + sv * fv)); yield; }
      if (best === c) { da /= 2; fv /= 2; }
    }
  }
  ({ a, v } = best);
  const eqFt = (v * v) / (2 * h.greenRoll * G) / FT;
  const range = puttRangeFor(eqFt);
  const brk = Math.sin(a - a0) * d;
  return { ...base, eqFt, range, aim: a, speed: v, cupAim: a0, brk, leave: best.leave };
}
export function puttRead(hole, ball, env) {
  const it = puttReadSteps(hole, ball, env);
  for (;;) { const r = it.next(); if (r.done) return r.value; }
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
  if (rd.leave > 0.9) msg += ' No easy line here – lag it close.';
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
    const pick = (need) => {
      let best = null;
      for (const c of usable) if (c.carry >= need * 0.985) best = c; // smallest club that carries
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
      return;
    }
    // pin out of range (tee shots / lay-ups): evaluate options by expected strokes
    const longest = usable[0];
    g.setClub(g.bag.indexOf(longest));
    this.aimForClub(longest);
    this.startAnalysis(usable);
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

  // one candidate club per frame so the game stays responsive
  stepAnalysis() {
    const A = this.analysis, g = this.g;
    if (!A || g.state !== 'address') return;
    if (A.i >= A.cands.length) { this.finishAnalysis(); return; }
    const club = A.cands[A.i++];
    const b = g.ball;
    const tgt = this.centreLineTarget(club.total);
    if (!tgt) return;
    const aim = angOf(tgt.x - b.p[0], tgt.z - b.p[2]);
    const spread = club.loft < 20 ? 3.2 : club.loft < 30 ? 2.4 : 1.8;
    let es = 0; const notes = [];
    for (const face of [-spread, 0, spread]) {
      const out = this.simOutcome(club, aim, { face, power: 1, dt: 1 / 90, withWind: true });
      let e;
      if (out.result === 'water') { e = 1 + expectedStrokes('rough', out.entryDist / YD); notes.push('water'); }
      else if (out.result === 'ob') { e = 1 + expectedStrokes(b.isTee ? 'fairway' : b.surface, g.distToPin() / YD, b.isTee); notes.push('out of bounds'); }
      else {
        e = expectedStrokes(out.surface, out.dist / YD);
        if (out.surface === 'bunker') notes.push('bunkers');
        if (out.surface === 'deep' || out.surface === 'straw') notes.push('trees');
      }
      es += e / 3;
    }
    A.results.push({ club, aim, es: es + 1, notes: [...new Set(notes)] });
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
    if (g.settings?.difficulty === 'pro') { this.applyPutt(puttSetup(g.hole, g.ball, g.env), false); return; }
    // Most reads take a few ms. A putt over a ridge or along a tier face can take ~1 s,
    // so after a short budget the rest is spread over the next frames (stepReading)
    // with the putter lined up at the cup in the meantime.
    const it = puttReadSteps(g.hole, g.ball, g.env);
    const t0 = performance.now();
    const base = it.next().value;
    for (;;) {
      const r = it.next();
      if (r.done) { this.applyPutt(r.value, true); return; }
      if (performance.now() - t0 > 30) break;
    }
    this.applyPutt(base, false);
    this.msg = this.withLead('Caddie is reading the putt…');
    if (g.ui) g.caddieNote();
    this.reading = { it, aim: g.aim, ball: g.ball.p.slice() };
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
        const userAimed = Math.abs(g.aim - R.aim) > 1e-6;
        this.applyPutt(r.value, true, userAimed);
        if (!userAimed) g.placeGolfer();
        g.previewDirty = true;
        return;
      }
      if (performance.now() - t0 > 6) return;
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
  powerForFinish(need) {
    const g = this.g, h = g.hole, b = g.ball;
    const p0 = this.powerForCarry(need);
    if (g.club.putter) return p0;
    const dir = dirOf(g.aim);
    const toCup = (h.cup.x - b.p[0]) * dir.x + (h.cup.z - b.p[2]) * dir.z;
    const along = (pw) => {
      const o = this.simOutcome(g.club, g.aim, { power: pw, withWind: true, dt: 1 / 90 });
      return (o.rest[0] - b.p[0]) * dir.x + (o.rest[2] - b.p[2]) * dir.z - toCup;
    };
    const a0 = along(p0);
    if (Math.abs(a0) <= 1.5) return p0;
    // released past the pin → less power; spun back short → more power (capped at a full swing)
    let lo = a0 > 0 ? Math.max(0.1, p0 - 0.35) : p0, hi = a0 > 0 ? p0 : Math.min(1, p0 + 0.2);
    if (a0 > 0 && along(lo) > 0) return lo;
    if (a0 < 0 && along(hi) < 0) return hi;
    for (let i = 0; i < 8; i++) {
      const m = (lo + hi) / 2;
      if (along(m) > 0.3) hi = m; else lo = m;
    }
    return (lo + hi) / 2;
  }

  powerForCarry(need) {
    const g = this.g;
    return powerForCarry(g.club, need, { traj: g.traj, lie: g.lieKey(), rho: g.env.rho });
  }
}
