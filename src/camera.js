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
  }

  set(pos, look, k) { this.tPos.copy(pos); this.tLook.copy(look); if (k != null) this.k = k; }
  snap() { this.pos.copy(this.tPos); this.look.copy(this.tLook); }
  resetOrbit() { this.orbit = { yaw: 0, pitch: 0, zoom: 1 }; }

  // ------------------------------------------------------------------ flyover
  startFlyover() {
    const h = this.g.hole;
    this.flyT = 0;
    this.flyDur = clamp(3.5 + h.length / 110, 4, 8.5);
  }
  // returns true when finished
  flyover(dt) {
    const h = this.g.hole;
    this.flyT += dt;
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

  // ------------------------------------------------------------------ address
  address() {
    const g = this.g, b = g.ball, h = g.hole;
    const putt = g.club.putter;
    const f = dirOf(g.aim + this.orbit.yaw);
    const z = this.orbit.zoom;
    const back = (putt ? 3.3 : 3.9) * z, up = 1.35 * z + this.orbit.pitch * 4;
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
  startFlight() { this.flightMode = 'behind'; this.landCam = null; }

  flight(sim, shot, forecast, flightT) {
    const g = this.g, h = g.hole, p = sim.p;
    const b0 = shot.p;
    const dir = dirOf(shot.aim);
    const putt = shot.club.putter;
    const fc = forecast;
    const totalD = Math.hypot(fc.rest[0] - b0[0], fc.rest[2] - b0[2]);
    const pv = new THREE.Vector3(p[0], p[1], p[2]);
    if (putt || totalD < 45) {
      // low follow camera
      const back = putt ? 3.2 : 8;
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
      const cx = L[0] + r.x * 26 + dir.x * 18, cz = L[2] + r.z * 26 + dir.z * 18;
      this.landCam = new THREE.Vector3(cx, Math.max(h.height(cx, cz), L[1]) + 7, cz);
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
  }
}
