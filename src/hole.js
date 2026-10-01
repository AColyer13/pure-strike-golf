// Hole geometry: turns a compact hole description (yards, relative to the tee
// and the centre line) into analytic functions for height, surface type and
// normals that both the renderer and the ball physics use.
//
// Hole description coordinates: s = yards along the centre line from the tee,
// o = yards to the right of the centre line. Green-relative features use the
// green frame: dx = yards right, dy = yards long (away from the approach).
// World space: metres, +x = right of the tee line, -z = toward the green, +y up.

import { stimpToRoll } from './physics.js';
import { clamp, smooth, lerp } from './util.js';

export const YD = 0.9144;
export const FT = 0.3048;

// ---------------------------------------------------------------- noise
function hash(i, j, seed) {
  let h = (i * 374761393 + j * 668265263 + seed * 1442695041) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
export function vnoise(x, y, seed = 0) {
  const i = Math.floor(x), j = Math.floor(y);
  const fx = x - i, fy = y - j;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  const a = hash(i, j, seed), b = hash(i + 1, j, seed), c = hash(i, j + 1, seed), d = hash(i + 1, j + 1, seed);
  return (a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v) * 2 - 1;
}
export function fbm(x, y, seed = 0, oct = 3) {
  let s = 0, a = 1, f = 1, n = 0;
  for (let o = 0; o < oct; o++) { s += vnoise(x * f, y * f, seed + o * 17) * a; n += a; a *= 0.5; f *= 2.03; }
  return s / n;
}
export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}


// Blob: rotated ellipse with a wobbly outline. Returns approx signed distance (m).
function makeBlob(cx, cz, rx, ry, rotRad, seed, wob = 1) {
  const rnd = mulberry32(seed * 9973 + 7);
  return {
    cx, cz, rx, ry, c: Math.cos(rotRad), s: Math.sin(rotRad),
    p1: rnd() * 6.28, p2: rnd() * 6.28, p3: rnd() * 6.28,
    a1: (0.05 + rnd() * 0.05) * wob, a2: (0.03 + rnd() * 0.04) * wob, a3: (0.015 + rnd() * 0.02) * wob,
    rmax: Math.max(rx, ry) * 1.2,
  };
}
function blobSdf(b, x, z) {
  const dx = x - b.cx, dz = z - b.cz;
  if (Math.abs(dx) > b.rmax + 30 || Math.abs(dz) > b.rmax + 30) return 99;
  const u = dx * b.c + dz * b.s, v = -dx * b.s + dz * b.c;
  const qx = u / b.rx, qy = v / b.ry;
  const q = Math.hypot(qx, qy);
  const th = Math.atan2(qy, qx);
  const w = 1 + b.a1 * Math.sin(2 * th + b.p1) + b.a2 * Math.sin(3 * th + b.p2) + b.a3 * Math.sin(5 * th + b.p3);
  return (q - w) * Math.min(b.rx, b.ry);
}

function segDist(px, pz, ax, az, bx, bz) {
  const vx = bx - ax, vz = bz - az;
  const l2 = vx * vx + vz * vz || 1;
  const t = clamp(((px - ax) * vx + (pz - az) * vz) / l2, 0, 1);
  const qx = ax + vx * t, qz = az + vz * t;
  return { d: Math.hypot(px - qx, pz - qz), t, side: Math.sign(vx * (pz - az) - vz * (px - ax)) };
}

export class Hole {
  constructor(def, course, index, opts = {}) {
    this.def = def;
    this.course = course;
    this.index = index;
    this.number = index + 1;
    this.par = def.par;
    this.name = def.name;
    this.seed = (course.seed || 1) * 131 + index * 17;
    this.style = course.style;
    this.build(opts);
  }

  // ------------------------------------------------------------ construction
  build(opts) {
    const d = this.def;
    // path: scale so the centre line length equals the card yardage
    let pts = d.path || [[0, 0], [0, d.yds]];
    let L = 0;
    for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    const k = d.yds / L;
    this.path = pts.map(([x, y]) => ({ x: x * k * YD, z: -y * k * YD }));
    this.cum = [0];
    for (let i = 1; i < this.path.length; i++) {
      this.cum.push(this.cum[i - 1] + Math.hypot(this.path[i].x - this.path[i - 1].x, this.path[i].z - this.path[i - 1].z));
    }
    this.length = this.cum[this.cum.length - 1];

    // green frame (approach direction = last segment)
    const n = this.path.length;
    const a = this.path[n - 2], g = this.path[n - 1];
    const fl = Math.hypot(g.x - a.x, g.z - a.z);
    this.gf = { x: g.x, z: g.z, fx: (g.x - a.x) / fl, fz: (g.z - a.z) / fl };
    this.gf.rx = -this.gf.fz; this.gf.rz = this.gf.fx; // right-hand vector of the approach

    // tee
    this.tee = { x: this.path[0].x, z: this.path[0].z };
    const f0 = this.dirAt(0);
    this.teeDir = f0;

    const style = this.style;
    const seed = this.seed;

    // fairway control points [s, halfWidth] in metres
    let fw = d.fw;
    if (fw === undefined) {
      if (d.par === 3) fw = [];
      else {
        const Ly = d.yds;
        const w = style.fairwayWidth || 34;
        fw = d.par === 4
          ? [[Math.min(200, Ly * 0.42), w * 0.9], [Math.min(290, Ly * 0.65), w], [Ly - 25, w * 0.7]]
          : [[190, w * 0.9], [300, w], [Ly - 140, w * 0.85], [Ly - 25, w * 0.75]];
      }
    }
    this.fw = fw.map(([s, w]) => [s * YD, (w * YD) / 2]).sort((p, q) => p[0] - q[0]);
    if (d.fwGreen !== false && this.fw.length) {
      // continue the fairway into the front of the green
      const last = this.fw[this.fw.length - 1];
      if (last[0] < this.length - 8) this.fw.push([this.length - 6, Math.min(last[1], 12)]);
    }

    // greens (list of ellipses in the green frame, yards)
    const gd = d.green || {};
    const gShapes = gd.shape || [[0, 0, (gd.w || 30) / 2, (gd.d || 32) / 2, gd.rot || 0]];
    this.greens = gShapes.map(([dx, dy, rx, ry, rot], i) => {
      const w = this.gToW(dx, dy);
      const baseAng = Math.atan2(this.gf.rz, this.gf.rx);
      return makeBlob(w.x, w.z, rx * YD, ry * YD, baseAng + ((rot || 0) * Math.PI) / 180, seed + i, 0.5);
    });
    this.green = gd;

    // bunkers
    this.bunkers = [];
    const addB = (w, rx, ry, rot, kind, depth, i) => {
      const baseAng = rot.base;
      this.bunkers.push({ ...makeBlob(w.x, w.z, rx * YD, ry * YD, baseAng + (rot.deg * Math.PI) / 180, seed + 50 + i, kind === 'pot' ? 0.3 : 1.2), kind, depth });
    };
    const gAng = Math.atan2(this.gf.rz, this.gf.rx);
    (d.gb || []).forEach(([dx, dy, rx, ry, rot = 0, kind = style.bunker || 'bunker'], i) => {
      const w = this.gToW(dx, dy);
      addB(w, rx, ry, { base: gAng, deg: rot }, kind, kind === 'pot' ? 1.7 : kind === 'waste' ? 0.25 : 0.9, i);
    });
    (d.fb || []).forEach(([s, o, rx, ry, rot = 0, kind = style.bunker || 'bunker'], i) => {
      const w = this.soToW(s * YD, o * YD);
      const f = this.dirAt(s * YD);
      addB(w, rx, ry, { base: Math.atan2(-f.x, f.z) , deg: rot }, kind, kind === 'pot' ? 1.6 : kind === 'waste' ? 0.25 : 0.8, i + 20);
    });

    // base elevation profile (feet, along s) sampled into a smooth field
    const elev = d.elev || [[0, 0], [d.yds, 0]];
    this.elevProfile = elev.map(([s, h]) => [s * YD, h * FT]);
    this.elevSamples = [];
    for (let s = 0; s <= this.length + 1; s += 18) {
      const p = this.pointAt(s);
      this.elevSamples.push({ x: p.x, z: p.z, h: this.profileAt(s) });
    }
    const gp = this.pointAt(this.length);
    this.elevSamples.push({ x: gp.x, z: gp.z, h: this.profileAt(this.length) });
    this.tilt = (d.tilt || 0) / 100; // cross slope, rise per metre to the right

    // water
    this.waters = [];
    (d.water || []).forEach((w, i) => {
      if (w.k === 'pond') {
        const c = w.g ? this.gToW(w.g[0], w.g[1]) : this.soToW(w.s * YD, (w.o || 0) * YD);
        const base = w.g ? gAng : Math.atan2(-this.dirAt(w.s * YD).x, this.dirAt(w.s * YD).z);
        const b = makeBlob(c.x, c.z, w.r[0] * YD, w.r[1] * YD, base + ((w.rot || 0) * Math.PI) / 180, seed + 90 + i, 0.8);
        b.kind = 'pond';
        b.island = !!w.island;
        this.waters.push(b);
      } else if (w.k === 'creek') {
        const pts = w.pts.map((p) => (w.gpts ? this.gToW(p[0], p[1]) : this.soToW(p[0] * YD, p[1] * YD)));
        this.waters.push({ kind: 'creek', pts, hw: ((w.w || 6) * YD) / 2 });
      } else if (w.k === 'ocean') {
        const pts = w.pts.map((p) => this.soToW(p[0] * YD, p[1] * YD));
        this.waters.push({ kind: 'ocean', pts, side: w.side || 1, cliff: w.cliff ?? 10, beach: !!w.beach });
      }
    });
    // water levels: sample base terrain
    for (const w of this.waters) {
      if (w.kind === 'pond') w.level = this.baseHeight(w.cx, w.cz) - 1.3;
      else if (w.kind === 'creek') w.levels = w.pts.map((p) => this.baseHeight(p.x, p.z) - 1.6);
    }
    this.mounds = (d.mounds || []).map(([dx, dy, r, h]) => ({ ...this.gToW(dx, dy), r: r * YD, h: h * FT }));
    this.roads = (d.roads || []).map((r) => ({
      pts: r.pts.map((p) => (r.gpts ? this.gToW(p[0], p[1]) : this.soToW(p[0] * YD, p[1] * YD))), hw: ((r.w || 4) * YD) / 2,
    }));
    this.seaLevel = (style.seaLevel ?? -14) + Math.min(...this.elevProfile.map((e) => e[1]));

    // bounds (metres)
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of this.path) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z); }
    const mL = (d.margin?.[0] ?? style.margin ?? 70) * YD, mR = (d.margin?.[1] ?? style.margin ?? 70) * YD;
    this.bounds = { minX: minX - mL, maxX: maxX + mR, minZ: minZ - 55, maxZ: maxZ + 30 };
    this.playBounds = { minX: this.bounds.minX + 4, maxX: this.bounds.maxX - 4, minZ: this.bounds.minZ + 4, maxZ: this.bounds.maxZ - 4 };

    // green pad height and pin
    this.greenBase = this.baseHeight(this.gf.x, this.gf.z) + (gd.raise || 0) * FT;
    const pins = gd.pins || [[0, 0]];
    const pi = opts.pinIndex != null ? opts.pinIndex % pins.length : 0;
    const pw = this.gToW(pins[pi][0], pins[pi][1]);
    this.cup = { x: pw.x, z: pw.z };
    // make sure the pin is on the green
    if (this.greenSdf(pw.x, pw.z) > -1.5) { this.cup = { x: this.gf.x, z: this.gf.z }; }

    this.stimp = (this.course.stimp || 11) * (d.stimpMul || 1);
    this.greenRoll = stimpToRoll(this.stimp);
    this.trees = [];
  }

  // ------------------------------------------------------------ frames
  dirAt(s) {
    const i = this.segIndex(s);
    const a = this.path[i], b = this.path[i + 1];
    const l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    return { x: (b.x - a.x) / l, z: (b.z - a.z) / l };
  }
  segIndex(s) {
    for (let i = 0; i < this.path.length - 1; i++) if (s <= this.cum[i + 1]) return i;
    return this.path.length - 2;
  }
  pointAt(s) {
    const i = this.segIndex(s);
    const a = this.path[i], b = this.path[i + 1];
    const t = clamp((s - this.cum[i]) / (this.cum[i + 1] - this.cum[i] || 1), 0, 1.5);
    return { x: lerp(a.x, b.x, t), z: lerp(a.z, b.z, t) };
  }
  soToW(s, o) {
    const p = this.pointAt(s);
    const f = this.dirAt(s);
    // right vector of forward f in (x, z): (-f.z, f.x)
    return { x: p.x - f.z * o, z: p.z + f.x * o };
  }
  gToW(dx, dy) {
    const g = this.gf;
    return { x: g.x + (g.rx * dx + g.fx * dy) * YD, z: g.z + (g.rz * dx + g.fz * dy) * YD };
  }
  wToG(x, z) {
    const g = this.gf;
    const dx = x - g.x, dz = z - g.z;
    return { dx: dx * g.rx + dz * g.rz, dy: dx * g.fx + dz * g.fz }; // metres
  }
  // project to centre line: s (m) and signed lateral o (m, + right)
  project(x, z) {
    let best = { d: Infinity, s: 0, o: 0 };
    for (let i = 0; i < this.path.length - 1; i++) {
      const a = this.path[i], b = this.path[i + 1];
      const r = segDist(x, z, a.x, a.z, b.x, b.z);
      if (r.d < best.d) {
        const s = this.cum[i] + r.t * (this.cum[i + 1] - this.cum[i]);
        // side: + when right of the segment direction
        const fx = b.x - a.x, fz = b.z - a.z;
        const cr = fx * (z - a.z) - fz * (x - a.x);
        best = { d: r.d, s, o: cr > 0 ? r.d : -r.d };
      }
    }
    return best;
  }
  profileAt(s) {
    const e = this.elevProfile;
    if (s <= e[0][0]) return e[0][1];
    for (let i = 1; i < e.length; i++) {
      if (s <= e[i][0]) {
        const t = (s - e[i - 1][0]) / (e[i][0] - e[i - 1][0]);
        const u = t * t * (3 - 2 * t);
        return lerp(e[i - 1][1], e[i][1], u);
      }
    }
    return e[e.length - 1][1];
  }

  // ------------------------------------------------------------ signed distances
  fairwaySdf(x, z, pr) {
    if (!this.fw.length) return 99;
    const p = pr || this.project(x, z);
    const s = p.s;
    const fw = this.fw;
    let hw;
    if (s < fw[0][0]) hw = fw[0][1] - (fw[0][0] - s) * 1.2;
    else if (s > fw[fw.length - 1][0]) hw = fw[fw.length - 1][1] - (s - fw[fw.length - 1][0]) * 1.5;
    else {
      for (let i = 1; i < fw.length; i++) if (s <= fw[i][0]) {
        const t = (s - fw[i - 1][0]) / (fw[i][0] - fw[i - 1][0]);
        hw = lerp(fw[i - 1][1], fw[i][1], t * t * (3 - 2 * t)); break;
      }
    }
    hw += fbm(s * 0.02, p.o > 0 ? 3 : 7, this.seed, 2) * 3.2;
    const off = (this.def.fwOff ? this.fwOffAt(s) : 0);
    return Math.abs(p.o - off) - hw;
  }
  fwOffAt(s) {
    const e = this.def.fwOff; // [[s, o], ...] yards
    const sy = s / YD;
    if (sy <= e[0][0]) return e[0][1] * YD;
    for (let i = 1; i < e.length; i++) if (sy <= e[i][0]) {
      const t = (sy - e[i - 1][0]) / (e[i][0] - e[i - 1][0]);
      return lerp(e[i - 1][1], e[i][1], t * t * (3 - 2 * t)) * YD;
    }
    return e[e.length - 1][1] * YD;
  }
  greenSdf(x, z) {
    let m = 99;
    for (const g of this.greens) m = Math.min(m, blobSdf(g, x, z));
    return m;
  }
  bunkerSdf(x, z) {
    let m = 99, b = null;
    for (const k of this.bunkers) { const d = blobSdf(k, x, z); if (d < m) { m = d; b = k; } }
    return { d: m, b };
  }
  waterSdf(x, z) {
    let m = 99, w = null;
    for (const k of this.waters) {
      let d;
      if (k.kind === 'pond') {
        d = blobSdf(k, x, z);
        if (k.island) d = Math.max(d, 5 - this.greenSdf(x, z));
      }
      else if (k.kind === 'creek') {
        d = 99;
        for (let i = 0; i < k.pts.length - 1; i++) {
          const r = segDist(x, z, k.pts[i].x, k.pts[i].z, k.pts[i + 1].x, k.pts[i + 1].z);
          const wob = vnoise((k.pts[i].x + r.t * 10) * 0.05, i, 5) * 0.8;
          d = Math.min(d, r.d - k.hw - wob);
        }
      } else if (k.kind === 'ocean') d = -this.coastDist(k, x, z);
      if (d < m) { m = d; w = k; }
    }
    return { d: m, w };
  }
  // + seaward distance from the coastline (m)
  coastDist(k, x, z) {
    let best = Infinity, side = 1;
    for (let i = 0; i < k.pts.length - 1; i++) {
      const a = k.pts[i], b = k.pts[i + 1];
      const r = segDist(x, z, a.x, a.z, b.x, b.z);
      if (r.d < best) {
        best = r.d;
        const cr = (b.x - a.x) * (z - a.z) - (b.z - a.z) * (x - a.x);
        side = cr > 0 ? 1 : -1;
      }
    }
    const wob = fbm(x * 0.04, z * 0.04, 77, 2) * 5;
    return (side === k.side ? best : -best) - wob;
  }
  roadSdf(x, z) {
    let m = 99;
    for (const r of this.roads) for (let i = 0; i < r.pts.length - 1; i++) {
      m = Math.min(m, segDist(x, z, r.pts[i].x, r.pts[i].z, r.pts[i + 1].x, r.pts[i + 1].z).d - r.hw);
    }
    return m;
  }
  teeSdf(x, z) {
    // tee box: 12 x 30 yd strip centred slightly behind the tee marker
    const f = this.teeDir;
    const dx = x - this.tee.x, dz = z - this.tee.z;
    const along = dx * f.x + dz * f.z; // + toward hole
    const lat = dx * -f.z + dz * f.x;
    const a = Math.abs(along + 6) - 13, b = Math.abs(lat) - 7;
    return Math.max(a, b);
  }

  // ------------------------------------------------------------ height
  baseHeight(x, z) {
    // smooth IDW elevation field from the profile samples
    let sw = 0, sh = 0;
    for (const e of this.elevSamples) {
      const d2 = (x - e.x) ** 2 + (z - e.z) ** 2 + 60;
      const w = 1 / (d2 * d2);
      sw += w; sh += w * e.h;
    }
    let h = sh / sw;
    const st = this.style;
    h += fbm(x * 0.006, z * 0.006, this.seed + 3, 2) * (st.hills ?? 3);
    h += fbm(x * 0.03, z * 0.03, this.seed + 9, 2) * (st.bumps ?? 0.6);
    return h;
  }

  height(x, z) {
    const pr = this.project(x, z);
    const st = this.style;
    let h = this.baseHeight(x, z) + pr.o * this.tilt;
    // links humps (St Andrews), reduced on fairways
    const fsd = this.fairwaySdf(x, z, pr);
    if (st.humps) h += fbm(x * 0.07, z * 0.07, this.seed + 21, 2) * st.humps * (0.45 + 0.55 * smooth(-4, 10, fsd));
    // mounding along the edges of the rough (Sawgrass style)
    if (st.mounds) h += Math.max(0, fbm(x * 0.025, z * 0.025, this.seed + 33, 2)) * st.mounds * smooth(6, 30, fsd);

    // tee pad
    const tsd = this.teeSdf(x, z);
    if (tsd < 6) {
      const th = this.baseHeight(this.tee.x, this.tee.z) + 0.45 + (this.def.teeH || 0) * FT;
      h = lerp(h, th, 1 - smooth(0, 6, tsd));
    }

    // green complex
    const gsd = this.greenSdf(x, z);
    const gw = 1 - smooth(0, this.green.apron ?? 9, gsd);
    if (gw > 0) h = lerp(h, this.greenSurface(x, z), gw);
    for (const m of this.mounds) {
      const d2 = (x - m.x) ** 2 + (z - m.z) ** 2;
      if (d2 < 9 * m.r * m.r) h += m.h * Math.exp(-d2 / (m.r * m.r));
    }

    // bunkers
    const { d: bd, b } = this.bunkerSdf(x, z);
    if (b && bd < 3) {
      const depth = b.depth;
      if (b.kind === 'pot') h -= depth * smooth(0.2, -1.0, bd) + 0.25 * Math.exp(-((bd - 0.8) ** 2) / 0.6);
      else if (b.kind === 'waste') h -= depth * smooth(1, -2, bd);
      else h -= depth * smooth(0.6, -2.4, bd) - 0.28 * Math.exp(-((bd - 1.0) ** 2) / 1.2);
    }

    // water
    const { d: wd, w } = this.waterSdf(x, z);
    if (w && wd < 14) {
      if (w.kind === 'ocean') {
        const drop = w.beach ? smooth(-8, 14, wd * -1 + 6) : smooth(-2, w.cliff > 6 ? 2.5 : 10, -wd);
        // wd < 0 when seaward (−coast dist); land when wd > 0
        const t = w.beach ? 1 - smooth(-6, 10, wd) : 1 - smooth(-3, 3, wd);
        h = lerp(h, this.seaLevel - 3, clamp(t, 0, 1));
        void drop;
      } else {
        let level = w.level;
        if (w.kind === 'creek') {
          // nearest control point level
          let bi = 0, bd2 = Infinity;
          w.pts.forEach((p, i) => { const d2 = (p.x - x) ** 2 + (p.z - z) ** 2; if (d2 < bd2) { bd2 = d2; bi = i; } });
          level = w.levels[bi];
        }
        const bank = level + 0.25 + (h - level - 0.25) * smooth(-0.5, 7, wd);
        h = Math.min(h, bank);
        if (wd < 0) h = Math.min(h, level - 0.2 - 1.2 * smooth(0, -5, wd));
      }
    }
    return h;
  }

  greenSurface(x, z) {
    const gd = this.green;
    const { dx, dy } = this.wToG(x, z); // metres
    let h = this.greenBase;
    const tl = gd.tilt || [0, 1.5]; // % rise to the right, % rise to the back
    h += (dx * tl[0] + dy * tl[1]) / 100;
    for (const t of gd.tiers || []) {
      // tier: [dirDeg (0 = back), offset yd from centre, rise ft, width yd]
      const a = (t[0] * Math.PI) / 180;
      const along = dx * Math.sin(a) + dy * Math.cos(a);
      h += t[2] * FT * smooth(-(t[3] || 3) * YD / 2, (t[3] || 3) * YD / 2, along - t[1] * YD);
    }
    for (const bm of gd.bumps || []) {
      // bump: [dx yd, dy yd, radius yd, height ft]
      const ddx = dx - bm[0] * YD, ddy = dy - bm[1] * YD;
      h += bm[3] * FT * Math.exp(-(ddx * ddx + ddy * ddy) / ((bm[2] * YD) ** 2));
    }
    if (gd.ff) {
      // false front: steep drop across the front edge
      const front = -this.greenFrontDepth();
      h -= gd.ff * FT * (1 - smooth(front - 2, front + 5, dy));
    }
    // subtle micro contour
    h += fbm(x * 0.08, z * 0.08, this.seed + 55, 2) * 0.05;
    return h;
  }
  greenFrontDepth() {
    // distance (m) from green centre to its front edge along the approach
    if (this._gfd) return this._gfd;
    let d = 0;
    for (let k = 0; k < 80; k++) {
      const p = this.gToW(0, -k * 0.5);
      if (this.greenSdf(p.x, p.z) > 0) { d = k * 0.5 * YD; break; }
    }
    return (this._gfd = d || 12);
  }

  normal(x, z) {
    const e = 0.15;
    const hx = this.height(x + e, z) - this.height(x - e, z);
    const hz = this.height(x, z + e) - this.height(x, z - e);
    const nx = -hx, ny = 2 * e, nz = -hz;
    const l = Math.hypot(nx, ny, nz);
    return [nx / l, ny / l, nz / l];
  }

  // ------------------------------------------------------------ surface type
  surface(x, z) {
    if (!this.inBounds(x, z)) return 'ob';
    const { d: wd } = this.waterSdf(x, z);
    if (wd < 0) return 'water';
    const { d: bd, b } = this.bunkerSdf(x, z);
    if (bd < 0) return b.kind === 'waste' ? 'waste' : 'bunker';
    const gsd = this.greenSdf(x, z);
    if (gsd < 0) return 'green';
    if (gsd < 1.3) return 'fringe';
    if (this.teeSdf(x, z) < 0) return 'tee';
    if (this.roadSdf(x, z) < 0) return 'path';
    const fsd = this.fairwaySdf(x, z);
    if (fsd < 0) return 'fairway';
    const st = this.style;
    if (fsd < (st.cutWidth ?? 2.2) || gsd < (st.greenCut ?? 5)) return 'cut';
    if (st.straw && this.nearTreeCluster(x, z)) return 'straw';
    if (fsd < (st.roughWidth ?? 20)) return st.roughType || 'rough';
    return st.farType || 'deep';
  }
  nearTreeCluster(x, z) {
    if (!this.treeGrid) return false;
    const t = this.treeNear(x, z, 7);
    return !!t;
  }

  inBounds(x, z) {
    const b = this.playBounds;
    return x > b.minX && x < b.maxX && z > b.minZ && z < b.maxZ;
  }

  // ------------------------------------------------------------ trees (spatial hash)
  setTrees(trees) {
    this.trees = trees;
    this.treeGrid = new Map();
    for (const t of trees) {
      const key = Math.floor(t.x / 12) + ',' + Math.floor(t.z / 12);
      if (!this.treeGrid.has(key)) this.treeGrid.set(key, []);
      this.treeGrid.get(key).push(t);
    }
  }
  treesAround(x, z) {
    const out = [];
    const ci = Math.floor(x / 12), cj = Math.floor(z / 12);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      const c = this.treeGrid?.get(ci + i + ',' + (cj + j));
      if (c) out.push(...c);
    }
    return out;
  }
  treeNear(x, z, r) {
    for (const t of this.treesAround(x, z)) if (t.straw && Math.hypot(t.x - x, t.z - z) < r * t.scale) return t;
    return null;
  }
  treeHit(p, v, dt, rng) {
    if (!this.treeGrid) return null;
    const sp = Math.hypot(v[0], v[1], v[2]);
    for (const t of this.treesAround(p[0], p[2])) {
      const dx = p[0] - t.x, dz = p[2] - t.z;
      const dh = Math.hypot(dx, dz);
      const y = p[1] - t.y;
      if (y < 0 || y > t.h) continue;
      // trunk
      // (the vn < 0 test stops a ball that is already moving away from being hit twice,
      // so the result depends only on the inputs and the seeded rng – forecasts match)
      if (y < t.trunkH && dh < t.trunkR + 0.03) {
        const nx = dx / (dh || 1), nz = dz / (dh || 1);
        const vn = v[0] * nx + v[2] * nz;
        if (vn < 0) return { v: [(v[0] - 1.6 * vn * nx) * 0.45, v[1] * 0.5, (v[2] - 1.6 * vn * nz) * 0.45], kind: 'trunk' };
      }
      // canopy (ellipsoid / cone)
      if (y > t.crownY) {
        let rAt = t.crownR;
        if (t.shape === 'cone') rAt = t.crownR * (1 - (y - t.crownY) / (t.h - t.crownY));
        else if (t.shape === 'palm') rAt = y > t.h - 2.5 ? t.crownR : 0;
        else {
          const cy = (t.crownY + t.h) / 2, ry = (t.h - t.crownY) / 2;
          const q = 1 - ((y - cy) / ry) ** 2;
          rAt = q > 0 ? t.crownR * Math.sqrt(q) : 0;
        }
        if (dh < rAt) {
          const density = t.density ?? 0.3;
          if (rng() < 1 - Math.exp(-density * sp * dt)) {
            const keep = 0.15 + rng() * 0.45;
            const rv = [rng() - 0.5, rng() - 0.7, rng() - 0.5];
            const nv = [v[0] * keep + rv[0] * sp * 0.25, v[1] * keep + rv[1] * sp * 0.25, v[2] * keep + rv[2] * sp * 0.25];
            return { v: nv, kind: 'leaves' };
          }
        }
      }
    }
    return null;
  }

  // ------------------------------------------------------------ helpers for gameplay
  distToPin(x, z) { return Math.hypot(this.cup.x - x, this.cup.z - z); }
}
