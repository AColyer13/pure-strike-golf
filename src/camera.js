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
  }

  kick(deg) { this.fovKick = deg; }
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
    this.flyDur = this.par3 ? 6 : clamp(3.5 + h.length / 110, 4, 8.5);
  }
  // returns true when finished
  flyover(dt) {
    const h = this.g.hole;
    this.flyT += dt;
    if (this.par3) return this.par3Flyover(dt);
    const k = clamp(this.flyT / this.flyDur, 0, 1);
    const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
    const s = e * h.length;
    const p = h.pointAt(Math.max(0, s - 40));
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
    const back = (putt ? clamp(1.5 + toCup * 0.9, 1.9, 3.3) : 3.9) * z, up = (putt && toCup < 2.5 ? 0.9 : 1.35) * z + this.orbit.pitch * 4;
    const side = putt ? 0.55 : 0.3; // shift right of the line, away from the golfer
    const px = b.p[0] - f.x * back - f.z * side, pz = b.p[2] - f.z * back + f.x * side;
    const py = Math.max(h.height(px, pz) + 0.6, b.p[1] + up);
    // tilt the view so the ball sits ~11° below the screen centre (above the swing meter)
    const dep = Math.atan2(py - b.p[1], back) - 11.5 * DEG;
    const lx = px + f.x * 20 * Math.cos(dep), lz = pz + f.z * 20 * Math.cos(dep);
    const ly = py - 20 * Math.sin(dep);
    return { pos: new THREE.Vector3(px, py, pz), look: new THREE.Vector3(lx, ly, lz) };
  }
  snapAddress() {
    const c = this.address();
    this.set(c.pos, c.look);
  }
  target() {
    const g = this.g, h = g.hole;
    const land = g.club.putter ? [h.cup.x, 0, h.cup.z] : (g.previewLand || g.ball.p);
    const f = dirOf(g.aim);
    const y = h.height(land[0], land[2]);
    return { pos: new THREE.Vector3(land[0] - f.x * 30, y + 70, land[2] - f.z * 30), look: new THREE.Vector3(land[0], y, land[2]) };
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
      const back = putt ? clamp(1.4 + totalD * 0.9, 1.9, 3.2) : 8;
      this.tPos.set(b0[0] - dir.x * back + (p[0] - b0[0]) * 0.55, Math.max(p[1], h.height(p[0], p[2])) + (putt ? 1.3 : 3), b0[2] - dir.z * back + (p[2] - b0[2]) * 0.55);
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
    const back = shot.club.putter ? clamp(1.4 + Math.hypot(p[0] - shot.p[0], p[2] - shot.p[2]) * 0.9, 1.9, 3) : 14;
    const cx = p[0] - dir.x * back, cz = p[2] - dir.z * back;
    this.tPos.set(cx, h.height(cx, cz) + (shot.club.putter ? 1.2 : 5), cz);
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
    // field of view eases to its target; the impact kick decays quickly
    this.fovKick *= Math.exp(-dt * 5);
    if (Math.abs(this.fovKick) < 0.02) this.fovKick = 0;
    const want = this.fov + this.fovKick;
    if (Math.abs(this.camera.fov - want) > 0.01) {
      this.camera.fov += (want - this.camera.fov) * (1 - Math.exp(-dt * 4));
      this.camera.updateProjectionMatrix();
    }
  }
}
