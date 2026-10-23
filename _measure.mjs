import { Hole, YD } from './src/hole.js';
import { COURSES } from './src/courses/index.js';
import { reliefOptions, TWO_CLUB_LENGTHS, playableNear, slopeDeg, MAX_LIE_SLOPE } from './src/rules.js';
import { computeLaunch, simulateCarry, BALL, CUP_RADIUS } from './src/physics.js';
import { buildBag } from './src/clubs.js';
import { expectedStrokes } from './src/stats.js';
import { RATINGS } from './src/history.js';
import { powerForCarry } from './src/caddie.js';

const env = { rho: 1.18, wind: [0, 0, 0] };
const bag = buildBag('tour');
const club = (k) => bag.find((c) => c.key === k);
const full = (c, o = {}) => computeLaunch(c, { power: 1, face: 0, path: 0, strike: 1, traj: 0, lie: 'fairway', ...o });
const yd = (metres) => metres / YD;
const metres = (yards) => yards * YD;

const TARGET = {
  DR: [275, 32, 38], '3W': [243, 30, 43], '5W': [230, 31, 47], '3H': [225, 29, 47],
  '4I': [203, 28, 48], '5I': [194, 31, 49], '6I': [183, 30, 50], '7I': [172, 32, 50],
  '8I': [160, 31, 50], '9I': [148, 30, 51], PW: [136, 29, 52],
};
const carry = [];
for (const [key, [tCarry, tApex, tLand]] of Object.entries(TARGET)) {
  const r = simulateCarry(full(club(key)), env);
  carry.push({
    key,
    carry: +yd(r.carry).toFixed(1),
    apex: +yd(r.apex).toFixed(1),
    land: +r.landAngle.toFixed(1),
    dCarry: +(yd(r.carry) - tCarry).toFixed(1),
    dApex: +(yd(r.apex) - tApex).toFixed(1),
    dLand: +(r.landAngle - tLand).toFixed(1),
  });
}
const sw = club('SW');
const into = { rho: 1.18, wind: [0, 0, -4.47] };
const lieCarry = (lie, e = env) => simulateCarry(full(sw, { lie }), e).carry;
const fair0 = lieCarry('fairway'), fair1 = lieCarry('fairway', into);
const spl0 = lieCarry('splash'), spl1 = lieCarry('splash', into);
const wind = {
  fairYd: +yd(fair0).toFixed(1),
  splashYd: +yd(spl0).toFixed(1),
  pluggedYd: +yd(lieCarry('plugged')).toFixed(1),
  fairHeadPct: +((1 - fair1 / fair0) * 100).toFixed(1),
  splashHeadPct: +((1 - spl1 / spl0) * 100).toFixed(1),
  numberYd: +yd(spl0 * fair0 / fair1).toFixed(1),
  honestYd: +yd(spl0 * spl0 / spl1).toFixed(1),
};
const powers = {};
for (const y of [10, 20, 30]) {
  const need = metres(y);
  const ps = powerForCarry(sw, need, { lie: 'splash', rho: 1.18 });
  const pf = powerForCarry(sw, need, { lie: 'fairway', rho: 1.18 });
  const land = (p, lie) => yd(simulateCarry(computeLaunch(sw, { power: p, face: 0, path: 0, strike: 1, traj: 0, lie }), env).carry);
  powers[y] = { splashPct: Math.round(ps * 100), fairwayPct: Math.round(pf * 100), fairwayPowerOnSplash: +land(pf, 'splash').toFixed(1) };
}

function nearestDry(h, x, z) {
  for (let r = 2; r <= 20; r += 2) {
    for (let a = 0; a < 12; a++) {
      const px = x + Math.cos((a / 12) * Math.PI * 2) * r;
      const pz = z + Math.sin((a / 12) * Math.PI * 2) * r;
      const s = h.surface(px, pz);
      if (s !== 'water' && s !== 'ob') return { x: px, z: pz };
    }
  }
  return null;
}
function legalLateral(h, e) {
  const cup = h.cup;
  const eD = Math.hypot(e.x - cup.x, e.z - cup.z);
  for (let i = 1; i <= 8; i++) {
    const r = Math.min(i * 0.4, TWO_CLUB_LENGTHS);
    for (let a = 0; a < 24; a++) {
      const x = e.x + Math.cos((a / 24) * Math.PI * 2) * r;
      const z = e.z + Math.sin((a / 24) * Math.PI * 2) * r;
      if (Math.hypot(x - cup.x, z - cup.z) + 1e-6 < eD) continue;
      if (!h.inBounds(x, z)) continue;
      const s = h.surface(x, z);
      if (s === 'water' || s === 'ob' || s === 'green') continue;
      if (h.waterSdf(x, z).d <= 0.6) continue;
      if (slopeDeg(h, x, z) > MAX_LIE_SLOPE) continue;
      return true;
    }
    if (r === TWO_CLUB_LENGTHS) break;
  }
  return false;
}

const relief = { entries: 0, lateral: 0, illegal: 0, missing: {} };
const sand = { n: 0, hold: 0, moved: 0, nearer: 0, moveSum: 0, moveMax: 0, intoCup: 0 };
const cups = { steep: 0, inCup: 0, where: '' };
const ratings = [];
const seen = [];
const fresh = (p) => !seen.some((q) => Math.hypot(q.x - p.x, q.z - p.z) < 8);

for (const course of COURSES) {
  let exp = 0, par = 0, yards = 0;
  for (let i = 0; i < course.holes.length; i++) {
    const def = course.holes[i];
    const h = new Hole(def, course, i, { tees: 'back' });
    exp += expectedStrokes('tee', h.yards, true);
    par += def.par;
    yards += h.yards;
    const b = h.playBounds;
    const waters = [];
    for (let x = b.minX; x <= b.maxX; x += 10) {
      for (let z = b.minZ; z <= b.maxZ; z += 10) {
        if (h.surface(x, z) === 'water') waters.push([x, z]);
      }
    }
    const waterSet = new Set(waters.map(([x, z]) => `${x},${z}`));
    for (const [x, z] of waters) {
      if (![[10, 0], [-10, 0], [0, 10], [0, -10]].some(([dx, dz]) => !waterSet.has(`${x + dx},${z + dz}`))) continue;
      const dry = nearestDry(h, x, z);
      if (!dry || !fresh(dry)) continue;
      seen.push(dry);
      relief.entries++;
      const opts = reliefOptions(h, dry, { p: [dry.x, 0, dry.z - 40], surface: 'tee', isTee: true });
      const lat = opts.find((o) => o.id === 'lateral');
      if (lat) {
        relief.lateral++;
        const d = Math.hypot(lat.p[0] - dry.x, lat.p[2] - dry.z);
        const nearer = lat.dist + 1e-6 < Math.hypot(dry.x - h.cup.x, dry.z - h.cup.z);
        if (d > TWO_CLUB_LENGTHS + 0.05 || nearer) relief.illegal++;
      } else if (legalLateral(h, dry)) {
        const key = `${course.name} · ${i + 1} ${def.name}`;
        relief.missing[key] = (relief.missing[key] || 0) + 1;
      }
    }
    for (const k of h.bunkers) {
      if (k.kind === 'waste') continue;
      const R = Math.max(k.rx, k.ry) * 1.35;
      for (let x = k.cx - R; x <= k.cx + R; x += 0.7) {
        for (let z = k.cz - R; z <= k.cz + R; z += 0.7) {
          if (h.surface(x, z) !== 'bunker') continue;
          sand.n++;
          const sl = slopeDeg(h, x, z);
          if (sl <= 30 || sl > 34) continue;
          sand.hold++;
          const p1 = playableNear(h, [x, h.height(x, z) + BALL.radius, z]);
          const mv = Math.hypot(p1[0] - x, p1[2] - z);
          if (mv <= 0.05) continue;
          sand.moved++;
          sand.moveSum += mv;
          if (mv > sand.moveMax) sand.moveMax = mv;
          const d0 = Math.hypot(x - h.cup.x, z - h.cup.z);
          const d1 = Math.hypot(p1[0] - h.cup.x, p1[2] - h.cup.z);
          if (d1 < d0 - 0.05) sand.nearer++;
          if (d1 < CUP_RADIUS) sand.intoCup++;
        }
      }
    }
    for (let x = h.cup.x - 6; x <= h.cup.x + 6; x += 0.5) {
      for (let z = h.cup.z - 6; z <= h.cup.z + 6; z += 0.5) {
        if (slopeDeg(h, x, z) <= MAX_LIE_SLOPE) continue;
        if (!h.inBounds(x, z) || h.surface(x, z) === 'water') continue;
        cups.steep++;
        const p1 = playableNear(h, [x, h.height(x, z) + BALL.radius, z]);
        if (Math.hypot(p1[0] - h.cup.x, p1[2] - h.cup.z) < CUP_RADIUS + BALL.radius) {
          cups.inCup++;
          if (!cups.where) cups.where = `${course.name} ${def.name}`;
        }
      }
    }
  }
  const [rating, slope] = RATINGS[course.id];
  ratings.push({ name: course.name, yards: Math.round(yards), par, tour: +exp.toFixed(1), rating, slope, gap: +(rating - exp).toFixed(1) });
}

const missingN = Object.values(relief.missing).reduce((s, n) => s + n, 0);
console.log(JSON.stringify({
  carry, wind, powers, twoM: +TWO_CLUB_LENGTHS.toFixed(3),
  relief: { entries: relief.entries, lateral: relief.lateral, illegal: relief.illegal, missingN, missing: relief.missing },
  sand: { ...sand, moveAvg: sand.moved ? +(sand.moveSum / sand.moved).toFixed(2) : 0, moveMax: +sand.moveMax.toFixed(2) },
  cups, ratings,
}, null, 2));
