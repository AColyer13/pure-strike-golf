// Caddie: club selection, plays-like distances, expected-strokes lay-up analysis,
// meter-marker power suggestions and putt reads. Reads the game state (hole, ball,
// wind, shot shape) and only changes the club/aim through the game's setters.
import { BallSim, computeLaunch, simulateCarry, puttSpeedFor, BALL, G } from './physics.js';
import { YD, FT, mulberry32 } from './hole.js';
import { expectedStrokes } from './stats.js';
import { dirOf, angOf } from './util.js';
import { SHAPES } from './config.js';
import { findEntry } from './rules.js';

export class Caddie {
  constructor(game) {
    this.g = game;
    this.analysis = null;
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
    this.analysis = null;
    if (b.surface === 'green' || (b.surface === 'fringe' && d < 18) || (b.surface === 'cut' && d < 12 && h.greenSdf(b.p[0], b.p[2]) < 4)) {
      g.setClub(g.bag.length - 1);
      if (b.surface !== 'green') this.msg = 'Putt it from here. A poor putt usually finishes closer than a poor chip.';
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
    const longest = A.results.find((r) => r.club === A.cands[0]);
    if (!g.userClub) {
      g.setClub(g.bag.indexOf(best.club));
      g.aim = best.aim;
      g.placeGolfer();
      g.previewDirty = true;
    }
    const fmt = (r) => `${r.club.name} ${r.es.toFixed(2)}`;
    let msg = `Caddie: ${best.club.name} – expected score from here ${best.es.toFixed(2)}.`;
    if (longest && longest !== best) {
      msg += ` ${fmt(longest)}${longest.notes.length ? ` (brings ${longest.notes.join(' & ')} into play)` : ''}.`;
    }
    this.msg = msg;
    g.updateHUD(true);
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
  // the hole if it missed – Pelz's optimum, and what the meter marker teaches.
  setupPutt() {
    const g = this.g, h = g.hole, b = g.ball;
    const d = g.distToPin();
    const dir = { x: (h.cup.x - b.p[0]) / d, z: (h.cup.z - b.p[2]) / d };
    const v = this.puttSpeedToReach(dir, d + 0.43);
    const eqFt = (v * v) / (2 * h.greenRoll * G) / FT;
    g.puttEqFt = eqFt;
    const ranges = [10, 20, 40, 70, 120];
    g.puttRange = ranges.find((r) => r >= eqFt * 1.15) || 150;
    g.puttElevIn = (h.height(h.cup.x, h.cup.z) - h.height(b.p[0], b.p[2])) / 0.0254;
    const R = g.puttRange;
    g.meter.configure({ labels: [[0.25, `${Math.round(R * 0.25)}ft`], [0.5, `${Math.round(R * 0.5)}ft`], [0.75, `${Math.round(R * 0.75)}ft`], [1, `${R}ft`]], rangeLabel: `Putter range ${R} ft` });
    g.aim = angOf(dir.x, dir.z);
  }

  // bisect on full green sims (slopes included) for the start speed that rolls `d` metres
  puttSpeedToReach(dir, d) {
    const g = this.g, h = g.hole, b = g.ball;
    let lo = 0.2, hi = 14;
    const flat = puttSpeedFor(d, h.greenRoll);
    for (let it = 0; it < 12; it++) {
      const v = it === 0 ? flat : (lo + hi) / 2;
      const sim = new BallSim(h, g.env, mulberry32(3));
      const oldPin = h.pinIn, cup = h.cup; h.pinIn = false;
      h.cup = { ...cup, x: 1e6, z: 1e6 }; // measure the roll with the hole covered
      sim.putt(b.p.slice(), [dir.x, 0, dir.z], v);
      let n = 0;
      while (sim.state === 'roll' && n++ < 3000) sim.step(1 / 120);
      h.pinIn = oldPin; h.cup = cup;
      const along = (sim.p[0] - b.p[0]) * dir.x + (sim.p[2] - b.p[2]) * dir.z;
      if (it === 0) { if (along < d && sim.state !== 'holed') lo = v; else hi = v; continue; }
      if (sim.state === 'holed' || along >= d) hi = v; else lo = v;
    }
    return (lo + hi) / 2;
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
    let lo = 0.1, hi = 1.1;
    for (let i = 0; i < 12; i++) {
      const p = (lo + hi) / 2;
      const ld = computeLaunch(g.club, { power: p, face: 0, path: 0, strike: 1, traj: g.traj, lie: g.lieKey() });
      const c = simulateCarry(ld, { rho: g.env.rho, wind: [0, 0, 0] }, { fwd: [0, 0, -1], dt: 1 / 120 }).carry;
      if (c < need) lo = p; else hi = p;
    }
    return (lo + hi) / 2;
  }
}
