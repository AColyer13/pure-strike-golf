// Golf ball physics: launch (D-plane), aerodynamics (drag + Magnus lift, spin decay,
// wind profile), impact with turf (restitution, friction, spin, crater effect),
// rolling (rolling resistance from Stimpmeter, gravity on slopes), cup capture.
// Everything is SI (metres, seconds, kg, rad). Pure JS – no Three.js dependency,
// so it can be unit tested / calibrated in Node.

import { DEG, clamp, smooth } from './util.js';

export const BALL = {
  mass: 0.04593,
  radius: 0.02135,
  area: Math.PI * 0.02135 * 0.02135,
  inertiaK: 0.4, // I = k m r^2 (a golf ball is close to a solid sphere)
};
export const G = 9.81;
export const CUP_RADIUS = 0.054; // 4.25" diameter

// Aerodynamic coefficients – calibrated against TrackMan PGA Tour averages
// (see tools/calibrate.mjs). S = spin factor = r*omega / v.
export const AERO = {
  cdHigh: 0.2668,   // drag coefficient in the super-critical Reynolds regime (fast)
  cdLow: 0.30,    // drag below the "drag crisis" (slow balls: < ~13 m/s)
  cdSpin: 0.0924,   // extra drag from spin (induced drag)
  cdRe: 0.17,     // drag keeps falling slightly with Reynolds number (fast drives)
  clMax: 0.353,    // lift: Cl = clMax*(1-exp(-(S/clS0)^clP)) – saturating with spin
  clS0: 0.1275,
  clP: 1.383,
  cr1: 11,        // drag crisis speed band (m/s)
  cr2: 20,
  spinTau: 36.447,    // spin decays exp(-t/tau) (fitted; tour data implies slow decay)
  cdReV: 47.1181,      // centre / half-width (m/s) of the Reynolds-number drag slope
  cdReW: 26.6162,
  clRe: 0.2176,        // lift falls slightly with speed (per cdReW above cdReV)
  clLin: -0.1065,       // linear lift term on top of the saturating curve
  spinS: 59.5605,       // spin decays faster at high spin ratio: rate = (1 + spinS*S) / spinTau
};

// ---------------------------------------------------------------- surfaces
// e: coefficient of restitution for the normal component (at ~10 m/s impact)
// mu: sliding friction at impact, roll: rolling-resistance deceleration / g
// crater: how much a soft surface "grabs" the ball (Penner crater angle scale)
export const SURFACES = {
  tee:     { name: 'Tee Box',       e: 0.40, mu: 0.45, roll: 0.12, rv: 0.02, crater: 1.0, color: '#5aa845' },
  fairway: { name: 'Fairway',       e: 0.40, mu: 0.45, roll: 0.12, rv: 0.03, crater: 1.0, color: '#5aa845' },
  cut:     { name: 'First Cut',     e: 0.32, mu: 0.52, roll: 0.17, rv: 0.03, crater: 1.1, color: '#4f9a3c' },
  second:  { name: 'Second Cut',    e: 0.26, mu: 0.55, roll: 0.24, rv: 0.04, crater: 1.2, color: '#3f8a2f' },
  rough:   { name: 'Rough',         e: 0.20, mu: 0.60, roll: 0.40, rv: 0.06, crater: 1.3, color: '#3f7f2f' },
  deep:    { name: 'Deep Rough',    e: 0.12, mu: 0.70, roll: 0.70, rv: 0.08, crater: 1.5, color: '#35692a' },
  fringe:  { name: 'Fringe',        e: 0.34, mu: 0.50, roll: 0.085, rv: 0.01, crater: 1.2, color: '#62b44c' },
  green:   { name: 'Green',         e: 0.26, mu: 0.46, roll: 0.045, crater: 1.6, color: '#6cc152' },
  bunker:  { name: 'Bunker',        e: 0.05, mu: 0.90, roll: 1.60, crater: 2.5, color: '#e8d9a8' },
  waste:   { name: 'Waste Area',    e: 0.18, mu: 0.70, roll: 0.45, crater: 1.2, color: '#d9c99a' },
  straw:   { name: 'Pine Straw',    e: 0.15, mu: 0.70, roll: 0.50, crater: 1.3, color: '#9a6b3a' },
  path:    { name: 'Cart Path',     e: 0.65, mu: 0.30, roll: 0.050, crater: 0.0, color: '#b0aca4' },
  water:   { name: 'Penalty Area',  e: 0.00, mu: 1.00, roll: 9.0, crater: 0.0, color: '#2b6b8f' },
  ob:      { name: 'Out of Bounds', e: 0.20, mu: 0.70, roll: 0.50, crater: 1.0, color: '#3f7f2f' },
};

// How the lie changes the strike. dist is the typical % range shown to the
// player (like Mario Golf's lie %), speed/spin/launch are multipliers/offsets.
export const LIES = {
  tee:     { speed: 1.00, spin: 1.00, launch: 0,   rand: 0.00, dist: [100, 100] },
  fairway: { speed: 1.00, spin: 1.00, launch: 0,   rand: 0.00, dist: [98, 100] },
  fringe:  { speed: 0.99, spin: 0.97, launch: 0,   rand: 0.01, dist: [96, 100] },
  green:   { speed: 1.00, spin: 1.00, launch: 0,   rand: 0.00, dist: [100, 100] },
  cut:     { speed: 0.98, spin: 0.85, launch: 0.5, rand: 0.02, dist: [93, 100] },
  second:  { speed: 0.97, spin: 0.72, launch: 0.8, rand: 0.04, dist: [90, 101] },
  rough:   { speed: 0.93, spin: 0.55, launch: 1.2, rand: 0.06, dist: [80, 102] },  // flyer risk
  deep:    { speed: 0.72, spin: 0.45, launch: 2.5, rand: 0.10, dist: [55, 80] },
  straw:   { speed: 0.94, spin: 0.75, launch: 0.5, rand: 0.05, dist: [85, 97] },
  waste:   { speed: 0.93, spin: 0.75, launch: 0,   rand: 0.05, dist: [85, 97] },
  bunker:  { speed: 0.90, spin: 0.75, launch: 0,   rand: 0.06, dist: [80, 95] },  // fairway bunker, clean pick
  path:    { speed: 0.97, spin: 0.9,  launch: -0.5, rand: 0.03, dist: [92, 100] },
  // greenside explosion shot: the club enters the sand ~2" behind the ball
  splash:  { speed: 0.52, spin: 0.45, launch: 6,   rand: 0.08, dist: [40, 60] },
};

// ---------------------------------------------------------------- vectors
const v3 = (x = 0, y = 0, z = 0) => [x, y, z];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
export const vec = { v3, add, sub, mul, dot, cross, len, norm };


// Rotate vector v around unit axis k by angle a (Rodrigues)
function rotAxis(v, k, a) {
  const c = Math.cos(a), s = Math.sin(a);
  return add(add(mul(v, c), mul(cross(k, v), s)), mul(k, dot(k, v) * (1 - c)));
}

// ---------------------------------------------------------------- aerodynamics
export function aeroCoeffs(speed, spinRad) {
  const S = speed > 0.1 ? (BALL.radius * spinRad) / speed : 0;
  // drag crisis: dimples trip the boundary layer only above ~Re 6e4
  const crisis = 1 - smooth(AERO.cr1, AERO.cr2, speed);
  const re = clamp((speed - AERO.cdReV) / AERO.cdReW, -1, 1);
  const cd = AERO.cdHigh - AERO.cdRe * re + (AERO.cdLow - AERO.cdHigh) * crisis + AERO.cdSpin * S;
  const cl = AERO.clMax * (1 - AERO.clRe * re) * (1 - Math.exp(-Math.pow(S / AERO.clS0, AERO.clP))) + AERO.clLin * S;
  return { cd, cl, S };
}

// Spin decay (viscous torque grows with spin ratio)
function decaySpin(w, v, dt) {
  const sp = len(v);
  const S = sp > 0.1 ? (BALL.radius * len(w)) / sp : 0;
  return mul(w, Math.exp((-dt * (1 + AERO.spinS * S)) / AERO.spinTau));
}

// Wind is quoted at 10 m (standard). Logarithmic boundary layer near the ground.
export function windAt(wind, h) {
  const z0 = 0.03;
  const f = clamp(Math.log(Math.max(h, 0.05) / z0 + 1) / Math.log(10 / z0 + 1), 0.25, 1.35);
  return [wind[0] * f, 0, wind[2] * f];
}

function flightAccel(p, v, w, env) {
  const air = windAt(env.wind, p[1] - (env.groundY ?? 0));
  const vr = sub(v, air);
  const sp = len(vr);
  const om = len(w);
  const { cd, cl } = aeroCoeffs(sp, om);
  const k = (0.5 * env.rho * BALL.area) / BALL.mass;
  let a = mul(vr, -k * cd * sp);
  if (om > 1e-3 && sp > 1e-3) {
    const ldir = norm(cross(w, vr));
    // only the spin component perpendicular to the airflow produces lift
    const perp = len(cross(w, vr)) / (om * sp);
    a = add(a, mul(ldir, k * cl * sp * sp * perp));
  }
  a[1] -= G;
  return a;
}

// ---------------------------------------------------------------- launch model
// Club spec: { loft, speed (club mph), smash, launch (deg), spin (rpm), spinLoft, faceWeight }
// Swing: { power 0..1.1, face (deg, + = open / right), path (deg, + = in-to-out),
//          strike 0..1 (1 = centre), traj -1..1, lie key, slope {up, side} (deg) }
export function computeLaunch(club, swing) {
  const lie = LIES[swing.lie] || LIES.fairway;
  const power = swing.power;
  const clubMph = club.speed * power;

  // centredness of strike: loses ball speed ("smash") and adds spin variance
  const strikeLoss = 1 - 0.14 * (1 - swing.strike) ** 1.5;
  const smash = club.smash * strikeLoss;
  let ballMph = clubMph * smash * lie.speed;

  // trajectory (ball position / shaft lean): low = knock-down, high = ball forward
  const t = swing.traj || 0;
  let launch = club.launch + (t < 0 ? t * club.launch * 0.28 : t * club.launch * 0.22) + lie.launch;
  let spinRpm = club.spin * (t < 0 ? 1 + 0.18 * t : 1 + 0.10 * t);
  ballMph *= t < 0 ? 1 + 0.015 * -t : 1 - 0.02 * t;

  // spin scales ~linearly with ball speed for a given spin loft (partial swings spin less)
  const fullBall = club.speed * club.smash;
  spinRpm *= 0.35 + 0.65 * clamp(ballMph / fullBall, 0, 1.2);
  spinRpm *= lie.spin;

  // Sloping lies: uphill adds dynamic loft, ball-above-feet points the face left.
  const up = swing.slope?.up || 0;       // + uphill (deg)
  const side = swing.slope?.side || 0;   // + ball above feet (deg)
  launch += up * 0.75;
  spinRpm *= 1 + up * 0.012;
  ballMph *= 1 - Math.abs(up) * 0.004 - Math.abs(side) * 0.003;
  // effective face rotation from lie-angle tilt: atan(tan(loft)*sin(slope))
  const lieFace = -Math.atan(Math.tan(club.loft * DEG) * Math.sin(side * DEG)) / DEG;

  const face = swing.face + lieFace;
  const path = swing.path;
  // D-plane: start direction mostly from face, curvature from face-to-path
  const hLaunch = face * club.faceWeight + path * (1 - club.faceWeight);
  const f2p = face - path;
  const spinLoft = Math.max(4, club.spinLoft + (launch - club.launch) * 1.2);
  const axisTilt = Math.atan2(Math.sin(f2p * DEG), Math.sin(spinLoft * DEG)) / DEG;
  // off-axis spin adds a little total spin
  spinRpm *= 1 + Math.abs(Math.sin(axisTilt * DEG)) * 0.08;

  // lie randomness (flyers, jumpers)
  if (lie.rand > 0 && swing.rng) {
    const r = swing.rng() * 2 - 1;
    ballMph *= 1 + r * lie.rand * 0.6;
    spinRpm *= 1 - Math.abs(r) * lie.rand * 2;
  }

  return {
    clubMph, ballMph, smash: ballMph / Math.max(clubMph, 1), strikeSmash: smash, // smash from strike quality alone (lie/slope excluded)
    launch: Math.max(0.5, launch), hLaunch, spinRpm: Math.max(150, spinRpm), axisTilt,
    face, path, f2p, lieFace,
  };
}

// Build initial state vectors. fwd = unit horizontal target direction.
export function launchVectors(ld, fwd) {
  const up = [0, 1, 0];
  const right = norm(cross(fwd, up));
  const speed = ld.ballMph * 0.44704;
  // horizontal direction: rotate fwd toward right by hLaunch
  const h = ld.hLaunch * DEG;
  const dirH = norm(add(mul(fwd, Math.cos(h)), mul(right, Math.sin(h))));
  const el = ld.launch * DEG;
  const dir = norm(add(mul(dirH, Math.cos(el)), [0, Math.sin(el), 0]));
  const v = mul(dir, speed);
  // pure backspin axis is horizontal, perpendicular to the launch direction.
  const back = norm(cross(dir, up));
  // tilt: positive tilt makes the ball curve right (fade/slice)
  const axis = rotAxis(back, dir, ld.axisTilt * DEG);
  const w = mul(axis, (ld.spinRpm * 2 * Math.PI) / 60);
  return { v, w };
}

// ---------------------------------------------------------------- flat-ground carry sim (previews & calibration)
export function simulateCarry(ld, env, opts = {}) {
  const fwd = opts.fwd || [0, 0, 1];
  let { v, w } = launchVectors(ld, fwd);
  let p = [0, 0.02, 0];
  const dt = opts.dt || 1 / 200;
  let apex = 0, t = 0;
  const pts = opts.path ? [p.slice()] : null;
  const e = { rho: env.rho, wind: env.wind || [0, 0, 0], groundY: 0 };
  const landY = opts.landY || 0;
  let prev = p;
  while (t < 20) {
    const a = flightAccel(p, v, w, e);
    // RK2 (midpoint)
    const pm = add(p, mul(v, dt / 2));
    const vm = add(v, mul(a, dt / 2));
    const am = flightAccel(pm, vm, w, e);
    prev = p;
    p = add(p, mul(vm, dt));
    v = add(v, mul(am, dt));
    w = decaySpin(w, v, dt);
    t += dt;
    if (p[1] > apex) apex = p[1];
    if (pts && Math.floor(t / dt) % 4 === 0) pts.push(p.slice());
    // a target above the apex is never reached: the ball comes back down to its own level
    if (p[1] < (apex >= landY ? landY : 0) && v[1] < 0) break;
  }
  // interpolate landing
  const reached = apex >= landY, Y = reached ? landY : 0;
  const f = (prev[1] - Y) / (prev[1] - p[1] || 1);
  const land = add(prev, mul(sub(p, prev), f));
  const hv = Math.hypot(v[0], v[2]);
  return {
    carry: Math.hypot(land[0], land[2]),
    lateral: dot(land, norm(cross(fwd, [0, 1, 0]))),
    land, apex, time: t, reached,
    landAngle: Math.atan2(-v[1], hv) / DEG,
    landSpeed: len(v),
    v, w, path: pts,
  };
}

// ---------------------------------------------------------------- full ball simulation on terrain
// world must provide: height(x,z), normal(x,z) -> [x,y,z], surface(x,z) -> key,
// treeHit(p, v, dt, rng) -> null | {v}, cup {x,z}, pinIn (bool), inBounds(x,z)
export class BallSim {
  constructor(world, env, rng = Math.random) {
    this.world = world;
    this.env = env;
    this.rng = rng;
    this.state = 'rest';
  }

  launch(pos, ld, fwd) {
    const { v, w } = launchVectors(ld, fwd);
    this.p = pos.slice();
    this.v = v;
    this.w = w;
    this.t = 0;
    this.state = 'flight';
    this.bounces = 0;
    this.landed = null;     // first landing point (carry)
    this.apex = pos[1];
    this.startY = pos[1];
    this.start = pos.slice();
    this.lastDry = pos.slice();
    this.events = [];
    this.trail = [pos.slice()];
    this.hitPin = false;
  }

  // putt: rolling start, speed in m/s
  putt(pos, fwd, speed) {
    this.p = pos.slice();
    this.v = mul(fwd, speed);
    this.w = [0, 0, 0];
    this.t = 0;
    this.state = 'roll';
    this.bounces = 0;
    this.landed = pos.slice();
    this.apex = pos[1];
    this.start = pos.slice();
    this.lastDry = pos.slice();
    this.events = [];
    this.trail = [pos.slice()];
    this.skid = 0.25; // brief skid phase
  }

  emit(type, data = {}) { this.events.push({ type, t: this.t, ...data }); }

  step(dt) {
    if (this.state === 'flight') this.stepFlight(dt);
    else if (this.state === 'roll') this.stepRoll(dt);
    this.t += dt;
    if (this.state !== 'rest' && this.state !== 'holed') {
      const last = this.trail[this.trail.length - 1];
      if (Math.hypot(this.p[0] - last[0], this.p[1] - last[1], this.p[2] - last[2]) > 0.8) this.trail.push(this.p.slice());
    }
    if (this.t > 60 && this.state !== 'holed') this.state = 'rest';
  }

  stepFlight(dt) {
    const W = this.world;
    const r = BALL.radius;
    const env = { rho: this.env.rho, wind: this.env.wind, groundY: W.height(this.p[0], this.p[2]) };
    const a = flightAccel(this.p, this.v, this.w, env);
    const pm = add(this.p, mul(this.v, dt / 2));
    const vm = add(this.v, mul(a, dt / 2));
    const am = flightAccel(pm, vm, this.w, env);
    const prev = this.p;
    this.p = add(this.p, mul(vm, dt));
    this.v = add(this.v, mul(am, dt));
    this.w = decaySpin(this.w, this.v, dt);
    if (this.p[1] > this.apex) this.apex = this.p[1];

    // trees
    if (W.treeHit) {
      const hit = W.treeHit(this.p, this.v, dt, this.rng);
      if (hit) {
        this.v = hit.v;
        this.w = mul(this.w, 0.3);
        this.emit('tree', { p: this.p.slice(), kind: hit.kind });
      }
    }
    // flagstick
    if (W.pinIn && this.checkPin()) return;

    if (!W.inBounds(this.p[0], this.p[2])) {
      if (this.p[1] < W.height(this.p[0], this.p[2]) + 3) { this.state = 'rest'; this.emit('ob', { p: this.p.slice() }); return; }
    }

    const gh = W.height(this.p[0], this.p[2]);
    if (this.p[1] - r <= gh) {
      // back up to the contact point (linear)
      const ph = W.height(prev[0], prev[2]);
      const d0 = prev[1] - r - ph, d1 = this.p[1] - r - gh;
      const f = d0 / (d0 - d1 || 1);
      this.p = add(prev, mul(sub(this.p, prev), clamp(f, 0, 1)));
      this.p[1] = W.height(this.p[0], this.p[2]) + r;
      this.impact();
    }
  }

  checkPin() {
    const c = this.world.cup;
    const dx = this.p[0] - c.x, dz = this.p[2] - c.z;
    const d = Math.hypot(dx, dz);
    const gh = this.world.height(c.x, c.z);
    const hh = this.p[1] - gh;
    if (d < BALL.radius + 0.012 && hh < 2.2 && hh > -0.1 && !this.hitPin) {
      this.hitPin = true;
      const n = norm([dx, 0, dz]);
      const vn = dot(this.v, n);
      if (vn < 0) {
        this.v = sub(this.v, mul(n, (1 + 0.35) * vn));
        this.v = mul(this.v, 0.6);
      }
      this.emit('pin', { p: this.p.slice() });
      // low, slow hits against the stick drop into the cup
      if (hh < 0.35 && len(this.v) < 6) { this.holeOut(); return true; }
    }
    return false;
  }

  impact() {
    const W = this.world;
    const surf = W.surface(this.p[0], this.p[2]);
    const S = SURFACES[surf] || SURFACES.rough;
    const r = BALL.radius;
    const speedIn = len(this.v);
    if (!this.landed) {
      this.landed = this.p.slice();
      this.emit('land', { p: this.p.slice(), surface: surf, speed: speedIn });
    } else this.emit('bounce', { p: this.p.slice(), surface: surf, speed: speedIn });
    this.bounces++;

    if (surf === 'water') { this.state = 'rest'; this.emit('water', { p: this.p.slice() }); return; }

    // dunk into the cup
    const c = W.cup;
    if (Math.hypot(this.p[0] - c.x, this.p[2] - c.z) < CUP_RADIUS - r * 0.3 && this.v[1] < 0 && speedIn < 25) {
      this.holeOut(); return;
    }

    let n = W.normal(this.p[0], this.p[2]);
    let vn = dot(this.v, n);
    if (vn >= 0) { this.p[1] += 0.001; return; }
    let vt = sub(this.v, mul(n, vn));

    // Penner crater: soft turf deforms, effectively tilting the plane toward the incoming ball.
    const firm = this.env.firmness ?? 1;
    const crater = S.crater * clamp(-vn / 18, 0, 1) * (1.25 - 0.5 * firm) * 20 * DEG;
    const vtl = len(vt);
    if (crater > 0 && vtl > 0.01) {
      const tdir = mul(vt, 1 / vtl);
      n = norm(sub(mul(n, Math.cos(crater)), mul(tdir, Math.sin(crater))));
      vn = dot(this.v, n);
      vt = sub(this.v, mul(n, vn));
    }

    // restitution drops with impact speed; firm courses bounce more
    const e = S.e * (0.75 + 0.35 * firm) * clamp(1.15 - (-vn) / 40, 0.55, 1.1);
    const vnOut = -vn * e;
    // contact-point slip velocity: u = vt + w x (-r n)
    const u = add(vt, cross(this.w, mul(n, -r)));
    const ut = sub(u, mul(n, dot(u, n)));
    const utl = len(ut);
    const k = BALL.inertiaK;
    const stickDv = utl * (k / (1 + k)) ; // tangential velocity change needed to reach rolling
    const maxDv = S.mu * (1 + e) * -vn;
    let dv;
    if (utl < 1e-6) dv = [0, 0, 0];
    else dv = mul(ut, -Math.min(stickDv, maxDv) / utl);
    let vtOut = add(vt, dv);
    // spin-back: the turf "check" reverses the ball, but grass deforms and bleeds most of that energy
    if (dot(vtOut, vt) < 0) vtOut = mul(vtOut, 0.45);
    // angular impulse from friction: dw = (r_c x dp)/I, r_c = -r n
    const dw = mul(cross(mul(n, -r), dv), 1 / (k * r * r));
    this.w = add(this.w, dw);
    if (stickDv <= maxDv) {
      // rolling: w consistent with vt
      this.w = mul(cross(n, vtOut), 1 / r);
    }
    this.v = add(vtOut, mul(n, vnOut));
    this.p = add(this.p, mul(n, 0.001));

    if (vnOut < 0.35 || this.bounces > 12) {
      this.state = 'roll';
      this.v = sub(this.v, mul(n, dot(this.v, n)));
      this.emit('roll', { p: this.p.slice(), surface: surf });
    }
  }

  stepRoll(dt) {
    const W = this.world;
    const r = BALL.radius;
    const x = this.p[0], z = this.p[2];
    const surf = W.surface(x, z);
    const S = SURFACES[surf] || SURFACES.rough;
    const n = W.normal(x, z);
    if (surf === 'water') { this.state = 'rest'; this.emit('water', { p: this.p.slice() }); return; }
    if (!W.inBounds(x, z)) { this.state = 'rest'; this.emit('ob', { p: this.p.slice() }); return; }
    if (surf !== 'water' && surf !== 'bunker') this.lastDry = this.p.slice();

    const k = BALL.inertiaK;
    const gPar = sub([0, -G, 0], mul(n, dot([0, -G, 0], n)));
    let v = this.v;
    const sp = len(v);
    let rollRes = S.roll * (this.env.rollScale?.[surf] ?? 1);
    // grass grabs slow balls more (rough) – and the ball sits down
    if (surf === 'green' && this.env.stimp) rollRes = stimpToRoll(this.env.stimp);
    let acc = mul(gPar, 1 / (1 + k)); // 5/7 g sin(theta) for a rolling sphere
    
    // turf drag: constant rolling resistance plus a speed-dependent part (grass bending)
    if (sp > 1e-4) acc = sub(acc, mul(v, ((rollRes + (S.rv || 0) * sp) * G * n[1]) / sp));
    v = add(v, mul(acc, dt));
    // friction cannot reverse the ball: if it would, stop (unless slope pulls it)
    if (dot(v, this.v) < 0 && len(gPar) / (1 + k) < rollRes * G * 1.05) v = [0, 0, 0];
    v = sub(v, mul(n, dot(v, n)));
    this.v = v;

    const np = add(this.p, mul(v, dt));
    const gh = W.height(np[0], np[2]);
    if (np[1] - r - gh > 0.08 && len(v) > 2.5) {
      // rolled off a ledge – airborne again
      this.p = np;
      this.state = 'flight';
      this.bounces = Math.max(this.bounces, 1);
      return;
    }
    np[1] = gh + r;
    this.p = np;
    this.w = mul(cross(n, v), 1 / r);

    // cup
    if (this.checkCup(dt)) return;

    const spd = len(v);
    const slopeAcc = len(gPar) / (1 + k);
    if (spd < 0.02 && slopeAcc < rollRes * G * 1.02) {
      this.v = [0, 0, 0];
      this.state = 'rest';
      this.emit('stop', { p: this.p.slice(), surface: surf });
    }
  }

  // Cup capture model (after Holmes, "The dynamics of repeated impacts with a
  // sinusoidally vibrating table"… simplified): a centred ball drops in below
  // ~1.6 m/s; the allowable speed shrinks as the ball catches more of the edge.
  checkCup() {
    const c = this.world.cup;
    const dx = this.p[0] - c.x, dz = this.p[2] - c.z;
    const d = Math.hypot(dx, dz);
    if (d > CUP_RADIUS) { this.cupSeen = false; return false; }
    const sp = Math.hypot(this.v[0], this.v[2]);
    if (sp < 0.05) { this.holeOut(); return true; }
    if (this.cupSeen) return false;
    this.cupSeen = true;
    // perpendicular offset of the ball's line from the cup centre
    const dir = [this.v[0] / sp, this.v[2] / sp];
    const b = Math.abs(dx * dir[1] - dz * dir[0]);
    const frac = clamp(b / CUP_RADIUS, 0, 1);
    const vcrit = 1.63 * Math.sqrt(Math.max(0, 1 - frac * frac)) + 0.05;
    if (sp < vcrit) { this.holeOut(); return true; }
    // lip-out: ball is deflected around the rim and loses speed
    const side = Math.sign(dx * dir[1] - dz * dir[0]) || 1;
    const ang = side * (0.25 + 0.9 * (1 - frac)) * (sp < vcrit * 1.6 ? 1 : 0.4);
    const c2 = Math.cos(ang), s2 = Math.sin(ang);
    const nvx = this.v[0] * c2 - this.v[2] * s2, nvz = this.v[0] * s2 + this.v[2] * c2;
    const keep = 0.55 + 0.3 * frac;
    this.v = [nvx * keep, this.v[1], nvz * keep];
    this.emit('lip', { p: this.p.slice(), speed: sp });
    return false;
  }

  holeOut() {
    const c = this.world.cup;
    this.p = [c.x, this.world.height(c.x, c.z) - 0.06, c.z];
    this.v = [0, 0, 0];
    this.state = 'holed';
    this.emit('holed', { p: this.p.slice() });
  }
}

// Stimpmeter: ball leaves the ramp at 1.83 m/s and rolls `stimp` feet on flat green.
export function stimpToRoll(stimp) {
  const d = stimp * 0.3048;
  return (1.83 * 1.83) / (2 * G * d);
}
// Putt speed needed to roll `dist` metres on a flat green of given roll resistance
export function puttSpeedFor(dist, roll) {
  return Math.sqrt(2 * roll * G * Math.max(0, dist));
}
