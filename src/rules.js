// Rules of Golf helpers: where a ball entered a penalty area and the relief
// options (Rule 17: stroke and distance, back-on-the-line, lateral relief).
import { BALL } from './physics.js';
import { expectedStrokes } from './stats.js';
import { YD } from './hole.js';

// Point where the ball last crossed into the penalty area, refined by bisection
// along the recorded trail. Falls back to `fallback` ([x, y, z]) if never dry.
export function findEntry(hole, sim, fallback) {
  const tr = sim.trail.concat([sim.p]);
  for (let i = tr.length - 1; i > 0; i--) {
    const a = tr[i - 1];
    if (hole.surface(a[0], a[2]) !== 'water') {
      let lo = a, hi = tr[i];
      for (let k = 0; k < 12; k++) {
        const m = [(lo[0] + hi[0]) / 2, 0, (lo[2] + hi[2]) / 2];
        if (hole.surface(m[0], m[2]) === 'water') hi = m; else lo = m;
      }
      return { x: lo[0], z: lo[2] };
    }
  }
  return { x: fallback[0], z: fallback[2] };
}

// Steepest slope (degrees) a ball may rest or be dropped on. Anything steeper is a mound flank or a bank
// nobody could play from, so the ball is placed on the nearest gentler ground instead.
export const MAX_LIE_SLOPE = 30;
// Rules of Golf: lateral relief is two club-lengths of the longest club except the putter.
// 46 inches is the tour limit on driver length.
export const TWO_CLUB_LENGTHS = 46 * 0.0254 * 2;
export const slopeDeg = (hole, x, z) => Math.acos(Math.min(1, hole.normal(x, z)[1])) * 180 / Math.PI;

// [x, y, z] ball position -> the same position when it is playable, else the nearest point (searching outward
// up to 10 m) that is in bounds, dry and gentler than MAX_LIE_SLOPE. A bunker stays a bunker's worth of sand
// where it can: a point on the same surface is preferred. Points on a ring are the same distance from the ball,
// so the one that does not move the ball nearer the hole wins; if every point on the ring is nearer, the drop
// gives up the least ground. Returns the input when nothing fits.
export function playableNear(hole, p) {
  if (slopeDeg(hole, p[0], p[2]) <= MAX_LIE_SLOPE) return p;
  const surf = hole.surface(p[0], p[2]);
  const d0 = Math.hypot(p[0] - hole.cup.x, p[2] - hole.cup.z);
  const ok = (x, z) => {
    const sf = hole.surface(x, z);
    return hole.inBounds(x, z) && sf !== 'water' && sf !== 'ob' && hole.waterSdf(x, z).d > 0.6 && slopeDeg(hole, x, z) <= MAX_LIE_SLOPE;
  };
  for (const same of [true, false]) {
    for (let r = 0.5; r <= 10; r += 0.5) {
      let best = null;
      for (let a = 0; a < 24; a++) {
        const x = p[0] + Math.cos((a / 24) * Math.PI * 2) * r, z = p[2] + Math.sin((a / 24) * Math.PI * 2) * r;
        if (!ok(x, z) || (same && hole.surface(x, z) !== surf)) continue;
        const d = Math.hypot(x - hole.cup.x, z - hole.cup.z);
        const gift = d < d0 - 0.02;
        // not-nearer beats nearer. Among not-nearer points, stay closest to the original distance.
        // Among only-nearer points, give up as little as possible.
        if (!best || (best.gift && !gift) || (gift === best.gift && (gift ? d > best.d : d < best.d))) best = { x, z, d, gift };
      }
      if (best) return [best.x, hole.height(best.x, best.z) + BALL.radius, best.z];
    }
  }
  return p;
}

// shotStart: { p, surface, isTee } of the stroke that went in. Each option has the
// drop point p, its surface, distance to the hole and the tour expected score from there.
export function reliefOptions(hole, entry, shotStart) {
  const h = hole, e = entry, cup = h.cup, S = shotStart;
  const dryOK = (x, z, margin = 1) => { const s = h.surface(x, z); return s !== 'water' && s !== 'ob' && h.waterSdf(x, z).d > margin && s !== 'green'; };
  const opts = [];
  opts.push({ id: 'replay', title: 'Stroke and distance', desc: 'Replay from where you last played.', p: S.p.slice(), surface: S.surface, isTee: S.isTee });
  // back on the line: keep the crossing point between the hole and the drop
  const dx = e.x - cup.x, dz = e.z - cup.z, dl = Math.hypot(dx, dz) || 1;
  for (let k = 1; k < 400; k += 1) {
    const x = e.x + (dx / dl) * k, z = e.z + (dz / dl) * k;
    if (!h.inBounds(x, z)) break;
    if (dryOK(x, z, 1.5) && h.surface(x, z) !== 'bunker') {
      const x2 = x + (dx / dl) * 1.5, z2 = z + (dz / dl) * 1.5;
      opts.push({ id: 'line', title: 'Back-on-the-line relief', desc: 'Drop on the line from the hole through the crossing point, as far back as you like.', p: [x2, 0, z2] });
      break;
    }
  }
  // lateral (red penalty area): within two club-lengths, no nearer the hole
  const eD = Math.hypot(e.x - cup.x, e.z - cup.z);
  let best = null;
  for (let i = 1; !best; i++) {
    const r = Math.min(i * 0.5, TWO_CLUB_LENGTHS);
    for (let a = 0; a < 32; a++) {
      const x = e.x + Math.cos((a / 32) * Math.PI * 2) * r, z = e.z + Math.sin((a / 32) * Math.PI * 2) * r;
      if (Math.hypot(x - cup.x, z - cup.z) < eD) continue;
      if (!dryOK(x, z, 0.6) || !h.inBounds(x, z)) continue;
      const d = Math.hypot(x - cup.x, z - cup.z);
      if (!best || d < best.d) best = { x, z, d };
    }
    if (r === TWO_CLUB_LENGTHS) break;
  }
  if (best) opts.push({ id: 'lateral', title: 'Lateral relief', desc: 'Drop within two club-lengths of where the ball crossed the edge, no nearer the hole.', p: [best.x, 0, best.z] });
  for (const o of opts) {
    if (!o.isTee) o.p = playableNear(h, [o.p[0], h.height(o.p[0], o.p[2]) + BALL.radius, o.p[2]]);
    o.p[1] = h.height(o.p[0], o.p[2]) + BALL.radius;
    o.dist = Math.hypot(cup.x - o.p[0], cup.z - o.p[2]);
    o.surface = h.surface(o.p[0], o.p[2]);
    o.es = expectedStrokes(o.isTee ? 'tee' : o.surface, o.dist / YD, !!o.isTee);
  }
  // A slope nudge can walk a legal reference point out of the relief area. That drop is not offered.
  return opts.filter((o) => o.id !== 'lateral'
    || (Math.hypot(o.p[0] - e.x, o.p[2] - e.z) <= TWO_CLUB_LENGTHS + 1e-6 && o.dist + 1e-6 >= eD));
}
