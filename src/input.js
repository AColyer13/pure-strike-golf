// Input: keyboard (rebindable), mouse, touch buttons and gamepads all map to the
// same named actions, so every control scheme drives the game the same way.
import * as THREE from 'three';
import { DEFAULT_KEYS } from './config.js';
import { clamp, DEG } from './util.js';

const $ = (id) => document.getElementById(id);
const norm = (k) => (k.length === 1 ? k.toLowerCase() : k);

export class Input {
  constructor(game) {
    this.g = game;
    this.keys = {};          // physical keys currently held
    this.touchHeld = {};     // touch-button actions currently held
    this.pad = { prev: {}, stick: null };
    this.raycaster = new THREE.Raycaster();
    this.drag = null;
    this.bindKeyboard();
    this.bindPointer();
    this.bindTouch();
  }

  // ------------------------------------------------------------------ bindings
  get bindings() { return { ...DEFAULT_KEYS, ...(this.g.settings.keys || {}) }; }
  actionsFor(key) {
    const out = [];
    for (const [a, ks] of Object.entries(this.bindings)) if (ks.includes(key)) out.push(a);
    return out;
  }
  // is an action held on any device?
  held(action) {
    if (this.touchHeld[action]) return true;
    if (this.pad.held?.[action]) return true;
    return this.bindings[action].some((k) => this.keys[k]);
  }

  // ------------------------------------------------------------------ keyboard
  bindKeyboard() {
    addEventListener('keydown', (e) => {
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA')) return;
      if (this.capture) { e.preventDefault(); this.capture(e); return; }
      const k = norm(e.key);
      this.keys[k] = true;
      this.g.audio.init();
      for (const a of this.actionsFor(k)) if (this.dispatch(a, e.repeat)) break;
      if ([' ', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(e.key)) e.preventDefault();
    });
    addEventListener('keyup', (e) => {
      const k = norm(e.key);
      this.keys[k] = false;
      if (this.bindings.scorecard.includes(k)) this.g.closeScorecardPeek();
    });
    addEventListener('blur', () => { this.keys = {}; });
  }

  // Run a named action. Returns true if it was consumed (so a key bound to two
  // actions – e.g. Space = swing and fast-forward – only triggers one).
  dispatch(a, repeat = false) {
    const g = this.g, st = g.state;
    if (a === 'pause') { if (g.round && st !== 'menu' && st !== 'summary') g.ui.togglePause(); return true; }
    if (g.ui.paused || g.ui.modalOpen()) return false;
    if (a === 'mute') { g.toggleMute(); return true; }
    if (a === 'scorecard') { if (!repeat) g.peekScorecard(); return true; }
    if (repeat) return a !== 'swing' && a !== 'skip' && a !== 'replay' ? this.dispatchAddress(a) : true;
    if (st === 'flyover' && (a === 'swing' || a === 'skip')) { g.endFlyover(); return true; }
    if (st === 'result' && (a === 'swing' || a === 'skip')) { g.continueAfterResult(); return true; }
    if (st === 'result' && a === 'replay') { g.startReplay(); return true; }
    if (st === 'replay' && (a === 'swing' || a === 'skip' || a === 'replay')) { g.endReplay(); return true; }
    if (st === 'flight' && a === 'skip') { g.skipFlight(); return true; }
    if (st === 'swing' && a === 'swing') { g.meterClick(); return true; }
    if (st !== 'address') return false;
    if (a === 'swing') {
      if (g.settings.control === 'mouse') g.ui.toast('Mouse swing: hold the left button, pull back, push through');
      else g.meterClick();
      return true;
    }
    return this.dispatchAddress(a);
  }

  dispatchAddress(a) {
    const g = this.g;
    if (g.state !== 'address') return false;
    switch (a) {
      case 'clubUp': g.setClub(g.clubIdx - 1, true); break;
      case 'clubDown': g.setClub(g.clubIdx + 1, true); break;
      case 'shapeLeft': g.cycleShape(-1); break;
      case 'shapeRight': g.cycleShape(1); break;
      case 'trajUp': g.setTraj(g.traj + 1); break;
      case 'trajDown': g.setTraj(g.traj - 1); break;
      case 'targetView': g.toggleTargetView(); break;
      case 'grid': g.toggleGrid(); break;
      case 'caddie': g.caddieNote(); break;
      case 'aimPin': g.aimAtPin(); break;
      default: return false;
    }
    g.updateHUD(true);
    return true;
  }

  // ------------------------------------------------------------------ mouse / pointer
  bindPointer() {
    const g = this.g;
    const cv = $('c'), ov = $('swingOverlay');
    const onDown = (e) => {
      g.audio.init();
      if (e.pointerType === 'touch') { this.touchDown(e); return; }
      if (e.button === 2) { this.drag = { x: e.clientX, y: e.clientY, yaw: g.cam.orbit.yaw, pitch: g.cam.orbit.pitch }; return; }
      if (e.button !== 0) return;
      this.primary(e.clientX, e.clientY, e);
    };
    ov.addEventListener('pointerdown', onDown);
    cv.addEventListener('pointerdown', onDown);
    addEventListener('pointermove', (e) => {
      if (this.drag) {
        g.cam.orbit.yaw = this.drag.yaw - (e.clientX - this.drag.x) * 0.005;
        g.cam.orbit.pitch = clamp(this.drag.pitch - (e.clientY - this.drag.y) * 0.004, -0.3, 2.5);
      }
      if (g.mouseSwing.active) g.mouseSwing.move(e);
    });
    addEventListener('pointerup', (e) => {
      if (this.drag && (e.button === 2 || e.pointerType === 'touch')) { this.drag = null; return; }
      if (g.mouseSwing.active) g.mouseSwing.up(e);
    });
    addEventListener('contextmenu', (e) => e.preventDefault());
    addEventListener('wheel', (e) => {
      if (g.state === 'address') g.cam.orbit.zoom = clamp(g.cam.orbit.zoom * (e.deltaY > 0 ? 1.1 : 0.9), 0.5, 4);
    }, { passive: true });
  }

  // primary click / tap on the 3D view
  primary(x, y, e) {
    const g = this.g;
    if (g.ui.paused || g.ui.modalOpen()) return;
    if (g.state === 'flyover') { g.endFlyover(); return; }
    if (g.state === 'result') { g.continueAfterResult(); return; }
    if (g.state === 'replay') { g.endReplay(); return; }
    if (g.cam.targetView && g.state === 'address') { this.aimAtScreen(x, y); return; }
    if (g.settings.control === 'mouse' && g.state === 'address' && e) {
      if (g.mouseSwing.down(e)) { g.state = 'swing'; g.caddie.analysis = null; }
      return;
    }
    if (g.state === 'address' || g.state === 'swing') g.meterClick();
  }

  aimAtScreen(x, y) {
    const g = this.g;
    const ndc = new THREE.Vector2((x / innerWidth) * 2 - 1, -(y / innerHeight) * 2 + 1);
    this.raycaster.setFromCamera(ndc, g.camera);
    const hit = this.raycaster.intersectObject(g.world.terrain, false)[0];
    if (!hit) return;
    g.aimAtWorld(hit.point.x, hit.point.z);
    g.audio.ui('tick');
  }

  // ------------------------------------------------------------------ touch
  // One finger on the 3D view orbits the camera (drag) or acts as a click (tap);
  // the on-screen buttons cover aim, clubs, shape and the swing itself.
  touchDown(e) {
    const g = this.g;
    this.showTouch(true);
    const t0 = { x: e.clientX, y: e.clientY, time: performance.now(), yaw: g.cam.orbit.yaw, pitch: g.cam.orbit.pitch };
    const move = (ev) => {
      if (ev.pointerId !== e.pointerId) return;
      if (Math.hypot(ev.clientX - t0.x, ev.clientY - t0.y) > 12 && g.state === 'address') {
        g.cam.orbit.yaw = t0.yaw - (ev.clientX - t0.x) * 0.006;
        g.cam.orbit.pitch = clamp(t0.pitch - (ev.clientY - t0.y) * 0.005, -0.3, 2.5);
        t0.dragged = true;
      }
    };
    const up = (ev) => {
      if (ev.pointerId !== e.pointerId) return;
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      if (!t0.dragged && performance.now() - t0.time < 400) this.primary(ev.clientX, ev.clientY, null);
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  }

  bindTouch() {
    const box = $('touchControls');
    if (!box) return;
    if (matchMedia('(pointer: coarse)').matches) this.showTouch(true);
    for (const b of box.querySelectorAll('[data-act]')) {
      const a = b.dataset.act;
      const hold = b.hasAttribute('data-hold');
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault(); e.stopPropagation();
        this.g.audio.init();
        b.setPointerCapture(e.pointerId);
        b.classList.add('down');
        if (hold) this.touchHeld[a] = true;
        if (a === 'swing') this.touchHeld.fastForward = true;
        if (a === 'menu') this.g.ui.togglePause();
        else if (!hold || a === 'swing') this.dispatch(a);
      });
      const release = () => { b.classList.remove('down'); this.touchHeld[a] = false; if (a === 'swing') this.touchHeld.fastForward = false; };
      b.addEventListener('pointerup', release);
      b.addEventListener('pointercancel', release);
    }
  }
  showTouch(on) {
    document.body.classList.toggle('touch', on);
  }

  // ------------------------------------------------------------------ gamepad
  // A swing/continue · B skip · X shape · Y target view (replay on the result screen)
  // LB/RB club · D-pad ←→ / left stick aim · D-pad ↑↓ trajectory · LT/RT fine aim
  // Right stick: analog swing – pull back (down), then push forward (up) smoothly.
  pollGamepad(dt) {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const gp = [...pads].find((p) => p && p.connected);
    if (!gp) { this.pad.held = null; return; }
    const btn = (i) => !!gp.buttons[i]?.pressed;
    const now = {
      swing: btn(0), skip: btn(1), shapeRight: btn(2), targetView: btn(3),
      clubUp: btn(5), clubDown: btn(4), trajUp: btn(12), trajDown: btn(13), pause: btn(9), scorecard: btn(8),
      replay: btn(3), grid: btn(10), aimPin: btn(11),
    };
    const ax = Math.abs(gp.axes[0]) > 0.2 ? gp.axes[0] : 0;
    this.pad.held = {
      aimLeft: btn(14) || ax < 0, aimRight: btn(15) || ax > 0, aimFine: btn(6) || btn(7),
      fastForward: btn(0), scorecard: btn(8),
    };
    this.pad.aimAxis = ax || (btn(14) ? -1 : btn(15) ? 1 : 0);
    if (!this.pad.connected) { this.pad.connected = true; this.g.ui.toast(`Controller connected`); }
    for (const [a, v] of Object.entries(now)) {
      if (v && !this.pad.prev[a]) {
        this.g.audio.init();
        if (a === 'swing' && this.g.state === 'address' && this.g.settings.control === 'mouse') continue;
        this.dispatch(a);
      }
      if (!v && this.pad.prev[a] && a === 'scorecard') this.g.closeScorecardPeek();
    }
    this.pad.prev = now;
    this.stickSwing(gp.axes[2] ?? 0, gp.axes[3] ?? 0, dt);
  }

  stickSwing(sx, sy, dt) {
    const g = this.g;
    const S = this.pad.stick || (this.pad.stick = { phase: 'idle' });
    if (g.state !== 'address' && g.state !== 'swing') { S.phase = 'idle'; return; }
    const putt = !!g.club?.putter;
    if (S.phase === 'idle') {
      if (sy > 0.25 && g.state === 'address') { S.phase = 'back'; S.max = sy; S.t = 0; g.state = 'swing'; g.caddie.analysis = null; }
      return;
    }
    S.t += dt;
    if (S.phase === 'back') {
      S.max = Math.max(S.max, sy);
      g.golfer.phase = 'manual'; g.golfer.apply(-clamp(S.max, 0, 1));
      if (sy < S.max - 0.25) { S.phase = 'fwd'; S.fwdT = 0; S.x0 = sx; }
      if (sy < 0.1 && S.max < 0.35) { S.phase = 'idle'; g.golfer.phase = 'idle'; g.state = 'address'; }
      return;
    }
    S.fwdT += dt;
    if (sy < -0.6) {
      // tempo: a ~0.12 s transition from the top to impact is ideal
      const ratio = 0.12 / Math.max(0.04, S.fwdT);
      const tempo = clamp(0.8 + 0.2 * Math.min(ratio, 1.2), 0.72, 1.04);
      const back = clamp(S.max, 0, 1) * (putt ? 1 : 1.05);
      const face = clamp(sx * (putt ? 4 : 10), -15, 15);
      const path = clamp((sx - S.x0) * (putt ? 0 : 8), -10, 10);
      const strike = clamp(1 - Math.abs(sx) * 0.5 - Math.max(0, ratio - 1.6) * 0.1, 0.4, 1);
      S.phase = 'idle';
      g.executeSwing({ power: clamp(back * tempo, 0.03, putt ? 1 : 1.1), face, path, strike });
    } else if (S.fwdT > 1.2) { S.phase = 'idle'; g.golfer.phase = 'idle'; g.state = 'address'; }
  }

  // ------------------------------------------------------------------ continuous (per frame)
  update(dt) {
    this.pollGamepad(dt);
    const g = this.g;
    if (g.state !== 'address') { this.aimHold = 0; return; }
    const fine = this.held('aimFine');
    const rate = (g.club.putter ? 4 : 14) * (fine ? 0.2 : 1) * DEG;
    let d = 0;
    if (this.held('aimLeft')) d -= 1;
    if (this.held('aimRight')) d += 1;
    if (this.pad.aimAxis) d = this.pad.aimAxis;
    if (d) {
      this.aimHold = (this.aimHold || 0) + dt;
      g.setAim(g.aim + d * rate * dt * (1 + Math.min(2, this.aimHold)));
    } else this.aimHold = 0;
  }
  get fastForward() { return this.held('fastForward'); }
}

