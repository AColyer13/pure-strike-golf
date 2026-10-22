// Camera director: hole flyover, address / target views, broadcast-style flight
// cameras and the menu showcase orbit. Every mode sets a target position + look
// point; apply() eases the real camera toward them and keeps it above the ground.
import * as THREE from 'three';
import { clamp, lerp, dirOf, DEG } from './util.js';

export class CameraDirector {
  constructor(game, camera) {
    this.g = game;
    this.camera = camera;
    this.pos = new THREE.Vector3(0, 50, 50);
    this.look = new THREE.Vector3();
    this.tPos = new THREE.Vector3(0, 50, 50);
    this.tLook = new THREE.Vector3();
    this.k = 3;                  // easing rate (1/s)
    this.orbit = { yaw: 0, pitch: 0, zoom: 1 };
    this.targetView = false;
    this.flightMode = 'behind';
    this.landCam = null;
    this.menuT = 0;
    this.menuInit = false;
    this.fov = 50;               // target field of view (degrees)
    this.fovKick = 0;            // short zoom punch, decays to 0
    this.shakeAmp = 0;           // positional shake: amplitude (m), time left and length (s)
    this.shakeT = 0;
    this.shakeDur = 0;
    this.shakeClock = 0;
    this.lift = 0; // fraction of the screen height the picture is slid up for the result card
    this.liftApplied = 0;
    this.sightM = 0; // metres the camera rises to see the green: sightLift()
    this.sightE = 0; // ...eased, so a step in it does not jolt the picture while aiming
    this.shiftY = 0; // fraction of the screen height the picture is slid down (portrait framing)
    this.shiftX = 0; // fraction of the screen width the picture is slid right (portrait framing)
    this.shiftApplied = 0;
  }

  kick(deg) { this.fovKick = deg; }
  // fov is vertical: on a portrait phone that leaves a keyhole across, so widen it until
  // the view across is ~80% of what a square screen would show
  fitFov(v) {
    const a = this.camera.aspect;
    if (!(a > 0 && a < 1)) return v; // (a hidden page can report 0×0)
    const across = Math.tan((v / 2) * DEG) * 0.8;
    return clamp((2 * Math.atan(across / a)) / DEG, v, 80);
  }
  // a short, decaying jolt: amp in metres, dur in seconds. Ignored under reduced motion.
  shake(amp, dur = 0.35) {
    if (this.g.settings?.reducedMotion) return;
    if (amp < this.shakeAmp * (this.shakeT / (this.shakeDur || 1))) return; // a bigger one is still running
    this.shakeAmp = amp; this.shakeDur = dur; this.shakeT = dur;
  }

  set(pos, look, k) { this.tPos.copy(pos); this.tLook.copy(look); if (k != null) this.k = k; }
  snap() { this.pos.copy(this.tPos); this.look.copy(this.tLook); }
  resetOrbit() { this.orbit = { yaw: 0, pitch: 0, zoom: 1 }; }

  // ------------------------------------------------------------------ flyover
  startFlyover() {
    const h = this.g.hole;
    this.flyT = 0;
    this.fov = 50;
    this.par3 = h.par === 3;
    this.flyDur = this.par3 ? 6 : clamp(3.5 + (h.length - h.teeS) / 110, 4, 8.5);
  }
  // returns true when finished
  flyover(dt) {
    const h = this.g.hole;
    this.flyT += dt;
    if (this.par3) return this.par3Flyover(dt);
    const k = clamp(this.flyT / this.flyDur, 0, 1);
    const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
    const s = h.teeS + e * (h.length - h.teeS);
    const p = h.pointAt(Math.max(h.teeS, s - 40));
    const ahead = h.pointAt(Math.min(h.length, s + 80));
    const look = { x: lerp(ahead.x, h.cup.x, e), z: lerp(ahead.z, h.cup.z, e) };
    const alt = 38 + 20 * Math.sin(k * Math.PI);
    this.tPos.set(p.x, h.height(p.x, p.z) + alt, p.z);
    this.tLook.set(look.x, h.height(look.x, look.z), look.z);
    this.k = 2.5;
    if (this.flyT === dt) this.snap();
    return k >= 1;
  }

  // Par 3s open on the green (an orbit round the target – the island, the postage
  // stamp), then pull back down the line to the tee.
  par3Flyover(dt) {
    const h = this.g.hole;
    const k = clamp(this.flyT / this.flyDur, 0, 1);
    const cx = h.cup.x, cz = h.cup.z, gy = h.height(cx, cz);
    const f = dirOf(this.g.aim);
    const base = Math.atan2(-f.x, -f.z); // angle of the tee side of the green
    if (k < 0.55) {
      const a = base + 0.9 - (k / 0.55) * 1.6;
      this.tPos.set(cx + Math.sin(a) * 38, gy + 14, cz + Math.cos(a) * 38);
      this.tLook.set(cx, gy, cz);
      this.k = 3;
      if (this.flyT === dt) this.snap();
    } else {
      const c = this.address();
      this.tPos.copy(c.pos); this.tLook.copy(c.look);
      this.k = 1.6;
    }
    return k >= 1;
  }

  // ------------------------------------------------------------------ address
  address() {
    const g = this.g, b = g.ball, h = g.hole;
    const putt = g.club.putter;
    const f = dirOf(g.aim + this.orbit.yaw);
    const z = this.orbit.zoom;
    // a tap-in is framed from close behind the ball so the cup stays in view and the ball is not a speck
    const toCup = putt ? Math.hypot(h.cup.x - b.p[0], h.cup.z - b.p[2]) : 99;
    // a portrait phone sees a narrow slice either side: stand further back, nearer the line,
    // and keep the ball above the middle (the meter, buttons and caddie fill the lower half)
    const wide = this.camera.aspect > 0 ? clamp((this.camera.aspect - 0.5) / 0.8, 0, 1) : 1;
    let back = (putt ? clamp(1.5 + toCup * 0.9, 1.9, 3.3) : 3.9) * z * (1.35 - 0.35 * wide), up = (putt && toCup < 2.5 ? 0.9 : 1.35) * z + this.orbit.pitch * 4;
    // shift right of the line, away from the golfer; on a narrow screen full swings stand left of it
    // instead so the golfer, who is left of the ball, is not cut off by the screen edge
    const side = putt ? 0.55 * (0.5 + 0.5 * wide) : lerp(-0.5, 0.3, wide);
    if (!putt) { this.sightLift(f, back, up, side); const e = this.sightE; up += e; back += e * 2.2; }
    const px = b.p[0] - f.x * back - f.z * side, pz = b.p[2] - f.z * back + f.x * side;
    const py = Math.max(h.height(px, pz) + 0.6, b.p[1] + up);
    // tilt the view so the ball sits below the screen centre (above the swing meter)
    const dep = Math.atan2(py - b.p[1], back) - lerp(-15.5, 11.5, wide) * DEG;
    const lx = px + f.x * 20 * Math.cos(dep), lz = pz + f.z * 20 * Math.cos(dep);
    const ly = py - 20 * Math.sin(dep);
    return { pos: new THREE.Vector3(px, py, pz), look: new THREE.Vector3(lx, ly, lz) };
  }
  // A rise between the ball and where the shot is going (a par 3 across a dip, a green
  // beyond a crest) can hide the green, the creek in front of it and the base of the flag
  // from 1.35 m. Returns how much higher (m, up to 2) the camera has to be to see that
  // ground; address() also moves back about twice that so the ball keeps its place on
  // screen. Cached, because address() runs every frame.
  sightLift(f, back, up, side) {
    const g = this.g, b = g.ball, h = g.hole;
    const T = g.previewLand || [h.cup.x, 0, h.cup.z];
    const key = `${b.p[0]},${b.p[2]},${f.x.toFixed(4)},${f.z.toFixed(4)},${Math.round(T[0])},${Math.round(T[2])},${back.toFixed(2)},${up.toFixed(2)}`;
    if (key === this.liftKey) return this.sightM;
    const tx = T[0], tz = T[2], ty = h.height(tx, tz) + 0.3;
    const sees = (e) => {
      const bk = back + e * 2.2;
      const ex = b.p[0] - f.x * bk - f.z * side, ez = b.p[2] - f.z * bk + f.x * side;
      const ey = Math.max(h.height(ex, ez) + 0.6, b.p[1] + up + e);
      const D = Math.hypot(tx - ex, tz - ez);
      for (let s = 4; s < D - 3; s += 2) {
        const t = s / D;
        if (h.height(ex + (tx - ex) * t, ez + (tz - ez) * t) > ey + (ty - ey) * t) return false;
      }
      return true;
    };
    let lift = 0;
    while (lift < 2 && !sees(lift)) lift += 0.25;
    this.liftKey = key;
    this.sightM = lift;
    return lift;
  }
  snapAddress() {
    this.address();
    this.sightE = this.sightM;
    const c = this.address();
    this.set(c.pos, c.look);
  }
  target() {
    const g = this.g, h = g.hole;
    if (g.club.putter) return this.targetPutt();
    const land = g.previewLand || g.ball.p;
    const f = dirOf(g.aim);
    const y = h.height(land[0], land[2]);
    return { pos: new THREE.Vector3(land[0] - f.x * 30, y + 70, land[2] - f.z * 30), look: new THREE.Vector3(land[0], y, land[2]) };
  }

  // Putting target view: look almost straight down on the whole putt, the ball at the bottom and the cup toward the
  // top, pulled back just far enough to hold both (and some room for the break) whatever the length and screen shape.
  targetPutt() {
    const g = this.g, h = g.hole, b = g.ball.p, cup = h.cup;
    let dx = cup.x - b[0], dz = cup.z - b[2];
    const d = Math.hypot(dx, dz);
    if (d > 0.05) { dx /= d; dz /= d; } else { const f = dirOf(g.aim); dx = f.x; dz = f.z; }
    const a = this.camera.aspect > 0 ? this.camera.aspect : 1;
    const th = Math.tan((this.fitFov(50) / 2) * DEG);
    const along = d * 1.7 + 3, across = Math.max(3.2, d * 0.5 + 2);
    const dist = clamp(Math.max(along / (2 * th), across / (2 * th * a)), 3.5, 60);
    const mx = (b[0] + cup.x) / 2, mz = (b[2] + cup.z) / 2, my = h.height(mx, mz);
    const el = 72 * DEG;
    return {
      pos: new THREE.Vector3(mx - dx * dist * Math.cos(el), my + dist * Math.sin(el), mz - dz * dist * Math.cos(el)),
      look: new THREE.Vector3(mx, my, mz),
    };
  }

  // ------------------------------------------------------------------ flight
  startFlight(shot, forecast) {
    this.flightMode = 'behind';
    this.landCam = null;
    this.fov = 50;
    // approach that finishes on the green: the landing camera sits beyond the green looking back
    const fc = forecast, b0 = shot.p;
    const total = fc ? Math.hypot(fc.rest[0] - b0[0], fc.rest[2] - b0[2]) : 0;
    this.reverse = !!fc && !shot.club.putter && total > 45 && (fc.restSurface === 'green' || fc.restSurface === 'fringe');
  }

  flight(sim, shot, forecast, flightT) {
    const g = this.g, h = g.hole, p = sim.p;
    const b0 = shot.p;
    const dir = dirOf(shot.aim);
    const putt = shot.club.putter;
    const fc = forecast;
    const totalD = Math.hypot(fc.rest[0] - b0[0], fc.rest[2] - b0[2]);
    const pv = new THREE.Vector3(p[0], p[1], p[2]);
    if (putt && totalD > 3) {
      // ball-cam: ride low behind the putt, looking down the line it is rolling on
      const hv = Math.hypot(sim.v[0], sim.v[2]);
      const moving = hv > 0.05 && sim.state === 'roll';
      const fx = moving ? sim.v[0] / hv : dir.x, fz = moving ? sim.v[2] / hv : dir.z;
      const cx = p[0] - fx * 1.5, cz = p[2] - fz * 1.5;
      this.tPos.set(cx, h.height(cx, cz) + 0.42, cz);
      this.tLook.set(p[0] + fx * 2.5, h.height(p[0] + fx * 2.5, p[2] + fz * 2.5) + 0.05, p[2] + fz * 2.5);
      this.k = 4;
      this.fov = 46;
      return;
    }
    if (putt || totalD < 45) {
      // low follow camera
      // a putt is framed from further back, higher and off to the right (away from the golfer,
      // who stands left of the ball) so the golfer does not fill the screen
      const back = putt ? clamp(2.8 + totalD * 0.9, 3.2, 4.4) : 8, side = putt ? 1.1 : 0;
      this.tPos.set(b0[0] - dir.x * back - dir.z * side + (p[0] - b0[0]) * 0.55, Math.max(p[1], h.height(p[0], p[2])) + (putt ? 1.8 : 3), b0[2] - dir.z * back + dir.x * side + (p[2] - b0[2]) * 0.55);
      this.tLook.copy(pv);
      this.k = 3;
      return;
    }
    const toLand = fc.landT - sim.t;
    if (this.flightMode === 'behind' && flightT > 0.5) this.flightMode = 'chase';
    if (this.flightMode === 'chase' && sim.state === 'flight' && toLand < 2.0 && fc.land) {
      this.flightMode = 'landing';
      // broadcast camera near the landing area, off to the side the ball will roll away from
      const L = fc.land, R = fc.rest;
      const side = dir.x * (R[2] - b0[2]) - dir.z * (R[0] - b0[0]) > 0 ? -1 : 1;
      const r = { x: -dir.z * side, z: dir.x * side };
      if (this.reverse) {
        // green-side reverse angle: beyond the pin, low, looking back at the incoming ball
        const cx = h.cup.x + dir.x * 24 + r.x * 7, cz = h.cup.z + dir.z * 24 + r.z * 7;
        this.landCam = new THREE.Vector3(cx, h.height(cx, cz) + 3.5, cz);
        this.fov = 38;
      } else {
        const cx = L[0] + r.x * 26 + dir.x * 18, cz = L[2] + r.z * 26 + dir.z * 18;
        this.landCam = new THREE.Vector3(cx, Math.max(h.height(cx, cz), L[1]) + 7, cz);
        this.fov = 44;
      }
    }
    if (this.flightMode === 'behind') {
      this.tPos.set(b0[0] - dir.x * 7, b0[1] + 2.4, b0[2] - dir.z * 7);
      this.k = 4;
    } else if (this.flightMode === 'chase') {
      const hv = Math.hypot(sim.v[0], sim.v[2]) || 1;
      const fx = sim.state === 'flight' ? sim.v[0] / hv : dir.x, fz = sim.state === 'flight' ? sim.v[2] / hv : dir.z;
      this.tPos.set(p[0] - fx * 22, Math.max(p[1] + 5, h.height(p[0] - fx * 22, p[2] - fz * 22) + 3), p[2] - fz * 22);
      this.k = 2.2;
    } else {
      this.tPos.copy(this.landCam);
      this.k = 1.6;
    }
    this.tLook.copy(pv);
  }

  // after a skipped flight: a view of where the ball finished
  snapToRest(sim, shot) {
    const h = this.g.hole, p = sim.p, dir = dirOf(shot.aim);
    const back = shot.club.putter ? clamp(2.8 + Math.hypot(p[0] - shot.p[0], p[2] - shot.p[2]) * 0.9, 3.2, 4.2) : 14;
    const side = shot.club.putter ? 1.1 : 0; // clear of the golfer, as in flight()
    const cx = p[0] - dir.x * back - dir.z * side, cz = p[2] - dir.z * back + dir.x * side;
    this.tPos.set(cx, h.height(cx, cz) + (shot.club.putter ? 1.7 : 5), cz);
    this.tLook.set(p[0], p[1], p[2]);
    this.k = 3;
    this.fov = 50;
  }

  // ------------------------------------------------------------------ replay
  // A different angle from the live shot: down the line from beyond the finish,
  // looking back at the ball as it comes in (low and close for putts).
  startReplay(shot, rec) {
    const h = this.g.hole, dir = dirOf(shot.aim);
    const end = rec[rec.length - 1], b0 = shot.p;
    const putt = shot.club.putter;
    const total = Math.hypot(end[0] - b0[0], end[2] - b0[2]);
    const r = { x: -dir.z, z: dir.x };
    let cx, cz, up;
    if (putt) { cx = end[0] + dir.x * 2.2 + r.x * 0.6; cz = end[2] + dir.z * 2.2 + r.z * 0.6; up = 0.35; }
    else if (total < 45) { cx = end[0] + dir.x * 10 + r.x * 4; cz = end[2] + dir.z * 10 + r.z * 4; up = 2.5; }
    else { cx = end[0] + dir.x * 30 + r.x * 12; cz = end[2] + dir.z * 30 + r.z * 12; up = 7; }
    this.tPos.set(cx, h.height(cx, cz) + up, cz);
    this.tLook.set(b0[0], b0[1], b0[2]);
    this.fov = putt ? 50 : 36;
    this.snap();
  }
  replay(p) {
    this.tLook.set(p[0], p[1], p[2]);
    this.k = 6;
  }

  // ------------------------------------------------------------------ menu
  // the scorecard and round summary sit over the same slow orbit of the green, picked up
  // from where the camera is so it glides out instead of jumping
  orbitGreen() {
    const h = this.g.hole;
    if (!h) return;
    this.menuT = Math.atan2(this.pos.x - h.gf.x, this.pos.z - h.gf.z) / 0.06;
    this.menuInit = true;
  }

  menu(dt) {
    const h = this.g.hole;
    if (!h) return;
    this.menuT += dt;
    const a = this.menuT * 0.06;
    const cx = h.gf.x, cz = h.gf.z;
    const R = 95;
    this.tPos.set(cx + Math.sin(a) * R, h.height(cx, cz) + 32, cz + Math.cos(a) * R);
    this.tLook.set(cx, h.height(cx, cz) + 2, cz);
    this.k = 1;
    if (!this.menuInit) { this.snap(); this.menuInit = true; }
  }

  // ------------------------------------------------------------------ per-frame
  apply(dt) {
    const k = 1 - Math.exp(-this.k * dt);
    this.pos.lerp(this.tPos, k);
    this.look.lerp(this.tLook, k);
    const h = this.g.hole;
    if (h) {
      const gh = h.height(this.pos.x, this.pos.z);
      if (this.pos.y < gh + 0.5) this.pos.y = gh + 0.5;
    }
    this.camera.position.copy(this.pos);
    this.camera.lookAt(this.look);
    if (this.shakeT > 0) {
      // three incommensurate sines per axis read as a jolt rather than a wobble; the envelope is quadratic
      this.shakeT = Math.max(0, this.shakeT - dt);
      this.shakeClock += dt;
      const e = (this.shakeT / this.shakeDur) ** 2 * this.shakeAmp, t = this.shakeClock;
      const ox = e * (Math.sin(t * 61) * 0.6 + Math.sin(t * 97 + 1.3) * 0.4);
      const oy = e * (Math.sin(t * 83 + 0.7) * 0.7 + Math.sin(t * 131 + 2.1) * 0.3);
      const oz = e * (Math.sin(t * 71 + 2.4) * 0.5);
      this.camera.position.x += ox; this.camera.position.y += oy; this.camera.position.z += oz;
      if (this.shakeT === 0) this.shakeAmp = 0;
    }
    // portrait phone, shot result showing: the result card fills the lower half, so slide the
    // picture up (a view offset, not a camera move) until the ball and flag sit above it
    const a = this.camera.aspect;
    let wantLift = 0;
    if (a > 0 && a < 0.8 && this.g.state === 'result' && this.g.ui.shotPanelShown()) {
      // a tall card (a phone) needs the full lift, a short one (putt, narrow window) far less
      this.liftClock = (this.liftClock || 0) - dt;
      if (this.liftClock <= 0) { this.liftClock = 0.25; this.liftWant = clamp((0.85 - this.g.ui.shotPanelTop()) * 0.7, 0, 0.2); }
      wantLift = this.liftWant;
    }
    this.sightE += (this.sightM - this.sightE) * (1 - Math.exp(-dt * 4));
    if (Math.abs(this.sightE - this.sightM) < 0.005) this.sightE = this.sightM;
    this.lift += (wantLift - this.lift) * (1 - Math.exp(-dt * 6));
    if (Math.abs(this.lift - wantLift) < 0.002) this.lift = wantLift;
    // portrait phone, lining up a shot: the golfer stands left of the ball and would hug the left edge,
    // so slide the picture right (a putt, framed tighter, needs more) to bring the golfer toward the middle
    const lining = this.g.state === 'address' || this.g.state === 'swing' || this.g.state === 'backswing';
    // (the ramp runs on into a squarish window, where the golfer is just as tall and hugs the top)
    const tall = clamp((1.05 - a) / 0.55, 0, 1);
    const wantShift = a > 0 && a < 1.05 && lining && !this.targetView ? (this.g.club?.putter ? 0.19 : 0.09) * tall : 0;
    this.shiftX += (wantShift - this.shiftX) * (1 - Math.exp(-dt * 6));
    if (Math.abs(this.shiftX - wantShift) < 0.001) this.shiftX = wantShift;
    // ...and the ball is held so high (clear of the HUD) that the golfer hugs the top, so slide the picture down toward the middle
    let wantY = a > 0 && a < 1.05 && lining && !this.targetView ? (this.g.club?.putter ? 0.33 : 0.3) * tall : 0;
    // a short landscape window: the swing meter's cue line would run across the golfer's feet, so lift the picture a little
    if (a >= 1 && innerHeight < 500 && lining && !this.targetView) wantY = this.g.club?.putter ? -0.035 : -0.08;
    // target view on a portrait phone: the cards and meter fill the bottom third, so frame the picture in the clear band above them
    if (this.targetView && a > 0 && a < 0.8 && lining) wantY = -0.155 * clamp((0.8 - a) / 0.3, 0, 1);
    this.shiftY += (wantY - this.shiftY) * (1 - Math.exp(-dt * 6));
    if (Math.abs(this.shiftY - wantY) < 0.001) this.shiftY = wantY;
    const up = this.lift - this.shiftY;
    if (up !== this.liftApplied || this.shiftX !== this.shiftApplied) {
      this.liftApplied = up; this.shiftApplied = this.shiftX;
      if (up !== 0 || this.shiftX > 0) this.camera.setViewOffset(1000 * a, 1000, -1000 * a * this.shiftX, 1000 * up, 1000 * a, 1000);
      else this.camera.clearViewOffset();
      this.camera.updateProjectionMatrix();
    }
    // field of view eases to its target; the impact kick decays quickly
    this.fovKick *= Math.exp(-dt * 5);
    if (Math.abs(this.fovKick) < 0.02) this.fovKick = 0;
    const want = this.fitFov(this.fov) + this.fovKick;
    if (Math.abs(this.camera.fov - want) > 0.01) {
      this.camera.fov += (want - this.camera.fov) * (1 - Math.exp(-dt * 4));
      this.camera.updateProjectionMatrix();
    }
  }
}
