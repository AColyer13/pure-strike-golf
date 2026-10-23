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
const yd = (m) => m * YD;
const m = (y) => y / YD;

const TARGET = {
  DR: [275, 32, 37], '3W': [243, 30, 43], '5W': [230, 31, 47], '3H': [225, 29, 47],
  '4I': [203, 28, 48], '5I': [194, 31, 49], '6I': [183, 30, 50], '7I': [172, 32, 50],
  '8I': [160, 31, 50], '9I': [148, 30, 51], PW: [136, 29, 52],
};

const carry = [];
let worstCarry = null;
for (const [key, [tCarry, tApex, tLand]] of Object.entries(TARGET)) {
  const r = simulateCarry(full(club(key)), env);
  const row = {
    key,
    dCarry: +(yd(r.carry) - tCarry).toFixed(2),
    dApex: +(yd(r.apex) - tApex).toFixed(2),
    dLand: +(r.landAngle - tLand).toFixed(2),
    carry: +yd(r.carry).toFixed(2),
    apex: +yd(r.apex).toFixed(2),
    land: +r.landAngle.toFixed(2),
  };
  carry.push(row);
  if (!worstCarry || Math.abs(row.dCarry) > Math.abs(worstCarry.dCarry)) worstCarry = row;
}
const wedges = {};
for (const key of ['GW', 'SW', 'LW', 'PW']) {
  const c = club(key);
  const fair = simulateCarry(full(c), env);
  const splash = simulateCarry(full(c, { lie: 'splash' }), env);
  const plugged = simulateCarry(full(c, { lie: 'plugged' }), env);
  wedges[key] = {
    fair: +yd(fair.carry).toFixed(2),
    splash: +yd(splash.carry).toFixed(2),
    plugged: +yd(plugged.carry).toFixed(2),
    label: c.tourCarry,
  };
}

const sw = club('SW');
const into = { rho: 1.18, wind: [0, 0, -4.47] };
const fair0 = simulateCarry(full(sw), env).carry;
const fair1 = simulateCarry(full(sw), into).carry;
const spl0 = simulateCarry(full(sw, { lie: 'splash' }), env).carry;
const spl1 = simulateCarry(full(sw, { lie: 'splash' }), into).carry;
const pin = spl0; // full splash carry, metres
const playsFairRatio = pin * (fair0 / fair1);
const playsSplashRatio = pin * (spl0 / spl1);
const wind = {
  fairPct: +((1 - fair1 / fair0) * 100).toFixed(2),
  splashPct: +((1 - spl1 / spl0) * 100).toFixed(2),
  playsYd: +yd(playsFairRatio).toFixed(2),
  honestYd: +yd(playsSplashRatio).toFixed(2),
  pinYd: +yd(pin).toFixed(2),
  errYd: +yd(playsFairRatio - playsSplashRatio).toFixed(2),
};

const powers = {};
for (const y of [10, 20, 30]) {
  const need = m(y);
  const ps = powerForCarry(sw, need, { lie: 'splash', rho: 1.18 });
  const pf = powerForCarry(sw, need, { lie: 'fairway', rho: 1.18 });
  const gotS = yd(simulateCarry(computeLaunch(sw, { power: ps, face: 0, path: 0, strike: 1, traj: 0, lie: 'splash' }), env).carry);
  const gotF = yd(simulateCarry(computeLaunch(sw, { power: pf, face: 0, path: 0, strike: 1, traj: 0, lie: 'splash' }), env).carry);
  powers[y] = { splashPower: +ps.toFixed(3), fairwayPower: +pf.toFixed(3), splashLands: +gotS.toFixed(2), fairwayPowerLands: +gotF.toFixed(2) };
}

const shot = { p: [0, 0, 0], surface: 'tee', isTee: true };
const relief = { entries: 0, lateral: 0, noLateral: 0, illegal: 0, missingLegal: 0, worst: 0, worstWhere: '', lineN: 0, lineD: [], noLine: 0 };

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

const seen = [];
function fresh(p) {
  return !seen.some((q) => Math.hypot(q.x - p.x, q.z - p.z) < 8);
}

const sand = { n: 0, lt10: 0, s10: 0, hold: 0, shed: 0, moved: 0, moveSum: 0, moveMax: 0, intoCup: 0, offSand: 0, holdSamples: [] };
const ratings = [];

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
      const edge = [[10, 0], [-10, 0], [0, 10], [0, -10]].some(([dx, dz]) => !waterSet.has(`${x + dx},${z + dz}`));
      if (!edge) continue;
      const dry = nearestDry(h, x, z);
      if (!dry || !fresh(dry)) continue;
      seen.push(dry);
      relief.entries++;
      const opts = reliefOptions(h, dry, { ...shot, p: [dry.x, h.height(dry.x, dry.z), dry.z - 40] });
      const lat = opts.find((o) => o.id === 'lateral');
      const line = opts.find((o) => o.id === 'line');
      if (line) {
        relief.lineN++;
        relief.lineD.push(Math.hypot(line.p[0] - dry.x, line.p[2] - dry.z));
      } else relief.noLine++;
      if (!lat) {
        relief.noLateral++;
        if (legalLateral(h, dry)) {
          relief.missingLegal++;
          if (relief.missingWhere == null) relief.missingWhere = `${course.id} ${def.name}`;
        }
      } else {
        relief.lateral++;
        const d = Math.hypot(lat.p[0] - dry.x, lat.p[2] - dry.z);
        const nearer = lat.dist + 1e-6 < Math.hypot(dry.x - h.cup.x, dry.z - h.cup.z);
        if (d > TWO_CLUB_LENGTHS + 0.05 || nearer) {
          relief.illegal++;
          if (d > relief.worst) {
            relief.worst = d;
            relief.worstWhere = `${course.id} ${i + 1} ${def.name}`;
          }
        }
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
          if (sl < 10) sand.lt10++;
          else if (sl <= 30) sand.s10++;
          else if (sl <= 34) sand.hold++;
          else sand.shed++;
          if (sl > 30 && sl <= 34) {
            const p0 = [x, h.height(x, z) + BALL.radius, z];
            const p1 = playableNear(h, p0);
            const mv = Math.hypot(p1[0] - x, p1[2] - z);
            if (mv > 0.05) {
              sand.moved++;
              sand.moveSum += mv;
              if (mv > sand.moveMax) sand.moveMax = mv;
              if (h.surface(p1[0], p1[2]) !== 'bunker') sand.offSand++;
              if (Math.hypot(p1[0] - h.cup.x, p1[2] - h.cup.z) < CUP_RADIUS) sand.intoCup++;
              if (sand.holdSamples.length < 5) sand.holdSamples.push({ where: `${course.id} ${def.name}`, sl: +sl.toFixed(1), mv: +mv.toFixed(2), to: h.surface(p1[0], p1[2]) });
            }
          }
        }
      }
    }
  }
  const [rating, slope] = RATINGS[course.id];
  ratings.push({
    id: course.id,
    name: course.name,
    par,
    yards: Math.round(yards),
    tour: +exp.toFixed(2),
    rating,
    slope,
    gap: +(rating - exp).toFixed(2),
  });
}

relief.lineD.sort((a, b) => a - b);
const mid = relief.lineD[Math.floor(relief.lineD.length / 2)] || 0;
const lineStats = {
  n: relief.lineN,
  none: relief.noLine,
  min: +(Math.min(...relief.lineD) || 0).toFixed(2),
  med: +mid.toFixed(2),
  max: +(Math.max(...relief.lineD) || 0).toFixed(2),
};

const cupHole = {
  cup: { x: 0, z: 0 },
  inBounds: () => true,
  height: () => 0,
  waterSdf: () => ({ d: 5 }),
  surface: (x, z) => (Math.hypot(x - 3, z) < 0.4 ? 'rough' : 'green'),
  normal: (x, z) => (Math.hypot(x - 3, z) < 0.4 ? [0.55, 0.835, 0] : [0, 1, 0]),
};
const cupDrop = playableNear(cupHole, [3, BALL.radius, 0]);
const cupDist = Math.hypot(cupDrop[0], cupDrop[2]);

console.log(JSON.stringify({
  carry, worstCarry, wedges, wind, powers,
  relief: { ...relief, lineD: undefined },
  lineStats,
  sand: { ...sand, moveAvg: sand.moved ? +(sand.moveSum / sand.moved).toFixed(2) : 0, moveMax: +sand.moveMax.toFixed(2) },
  ratings,
  two: +TWO_CLUB_LENGTHS.toFixed(3),
  cupDrop: { x: +cupDrop[0].toFixed(2), z: +cupDrop[2].toFixed(2), dist: +cupDist.toFixed(2), inCup: cupDist < CUP_RADIUS },
}, null, 2));
