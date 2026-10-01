// Swing input.
//  SwingMeter – Mario Golf style 3-click meter: start, set power, hit the
//               impact zone. Missing the zone early/late rotates the face.
//  MouseSwing – Tiger Woods PGA Tour style analog swing: pull the mouse back
//               (backswing), push it forward (downswing). Tempo = power,
//               sideways drift = face angle, stroke direction = club path.

import { clamp } from './util.js';

export class SwingMeter {
  constructor(canvas) {
    this.cv = canvas;
    this.g = canvas.getContext('2d');
    this.state = 'hidden';
    this.v = 0;
    this.dir = 1;
    this.fullTime = 1.0;
    this.zone = 0.035;
    this.marker = null;
    this.putt = false;
    this.rangeLabel = '';
    this.onDone = null;
    this.onCancel = null;
    this.autoPower = null; // one-button swing: power is set automatically here
    this.onAuto = null;
    this.resize();
  }
  resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = this.cv.clientWidth || 560, h = this.cv.clientHeight || 70;
    this.cv.width = w * dpr; this.cv.height = h * dpr;
    this.g.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.w = w; this.h = h;
  }
  configure(o) { Object.assign(this, o); }
  show() { if (this.state === 'hidden') this.state = 'ready'; this.draw(); }
  hide() { this.state = 'hidden'; this.draw(); }
  get busy() { return this.state === 'power' || this.state === 'accuracy'; }

  click() {
    if (this.state === 'ready') { this.state = 'power'; this.v = 0; this.dir = 1; this.power = null; return 'start'; }
    if (this.state === 'power') { this.power = Math.max(0.02, this.v); this.state = 'accuracy'; return 'power'; }
    if (this.state === 'accuracy') { this.finish(this.v); return 'impact'; }
    return null;
  }
  finish(v) {
    this.state = 'done';
    this.error = v; // + early (closed face), - late (open face)
    this.draw();
    const r = { power: this.power, error: this.error, zone: this.zone };
    if (this.onDone) this.onDone(r);
  }
  update(dt) {
    if (this.state === 'power') {
      this.v += (this.dir * dt * 1.0) / this.fullTime;
      const max = this.putt ? 1.0 : 1.1;
      if (this.autoPower != null && this.dir > 0 && this.v >= this.autoPower) {
        this.v = this.autoPower; this.click();
        if (this.onAuto) this.onAuto();
        this.draw();
        return;
      }
      if (this.v >= max) { this.v = max; this.dir = -1; }
      if (this.v <= 0 && this.dir < 0) { this.state = 'ready'; this.v = 0; if (this.onCancel) this.onCancel(); }
    } else if (this.state === 'accuracy') {
      this.v -= (dt * 1.3) / this.fullTime;
      if (this.v < -0.12) this.finish(-0.12);
    }
    this.draw();
  }

  x(v) {
    const L = 34, R = this.w - 20;
    const z0 = L + (R - L) * 0.1; // impact point
    return z0 + (v / 1.1) * (R - z0);
  }

  draw() {
    const g = this.g, w = this.w, h = this.h;
    g.clearRect(0, 0, w, h);
    if (this.state === 'hidden') return;
    const y = 18, bh = 26;
    const x0 = this.x(-0.12), x1 = this.x(this.putt ? 1.0 : 1.1);
    // frame
    g.fillStyle = 'rgba(8,16,12,0.72)';
    roundRect(g, x0 - 8, y - 8, x1 - x0 + 16, bh + 16, 12); g.fill();
    // track
    const grd = g.createLinearGradient(this.x(0), 0, this.x(1), 0);
    grd.addColorStop(0, '#2c4a3a'); grd.addColorStop(1, '#3b5d48');
    g.fillStyle = grd;
    roundRect(g, x0, y, x1 - x0, bh, 6); g.fill();
    if (!this.putt) {
      g.fillStyle = '#6b2a2a';
      g.fillRect(this.x(1.0), y, x1 - this.x(1.0), bh);
    }
    // power fill
    const pv = this.state === 'power' ? this.v : this.power;
    if (pv != null && this.state !== 'ready') {
      const f = g.createLinearGradient(this.x(0), 0, this.x(1.1), 0);
      f.addColorStop(0, '#f7d64a'); f.addColorStop(0.85, '#ff9a2e'); f.addColorStop(1, '#ff4b3a');
      g.fillStyle = f;
      g.fillRect(this.x(0), y + 3, this.x(pv) - this.x(0), bh - 6);
    }
    // ticks
    g.fillStyle = 'rgba(255,255,255,0.55)';
    g.font = '600 10px Barlow, system-ui, sans-serif';
    g.textAlign = 'center';
    for (let i = 1; i <= 10; i++) {
      const xx = this.x(i / 10);
      g.fillRect(xx - 0.5, y + (i % 5 ? bh - 7 : bh - 12), 1, i % 5 ? 7 : 12);
    }
    if (this.labels) {
      for (const [v, txt] of this.labels) { g.fillText(txt, this.x(v), y + bh + 13); }
    }
    // impact zone
    const zw = Math.max(2, this.x(this.zone) - this.x(0));
    g.fillStyle = 'rgba(120,255,160,0.35)';
    g.fillRect(this.x(0) - zw, y - 3, zw * 2, bh + 6);
    g.fillStyle = '#9dffb8';
    g.fillRect(this.x(0) - 1, y - 5, 2, bh + 10);
    // caddie marker (power needed for the target)
    if (this.marker != null && this.marker > 0) {
      const mx = this.x(clamp(this.marker, 0, 1.1));
      g.fillStyle = '#5fd4ff';
      g.beginPath(); g.moveTo(mx, y - 1); g.lineTo(mx - 6, y - 10); g.lineTo(mx + 6, y - 10); g.closePath(); g.fill();
      g.fillRect(mx - 1, y, 2, bh);
    }
    // set power marker
    if (this.power != null && this.state !== 'power' && this.state !== 'ready') {
      g.fillStyle = '#fff';
      g.fillRect(this.x(this.power) - 1.5, y - 4, 3, bh + 8);
    }
    // cursor
    if (this.state === 'power' || this.state === 'accuracy' || this.state === 'done') {
      const cv = this.state === 'done' ? this.error : this.v;
      const cx = this.x(cv);
      g.fillStyle = '#ffffff';
      g.shadowColor = 'rgba(0,0,0,0.6)'; g.shadowBlur = 4;
      g.beginPath(); g.moveTo(cx, y + bh + 4); g.lineTo(cx - 7, y + bh + 13); g.lineTo(cx + 7, y + bh + 13); g.closePath(); g.fill();
      g.fillRect(cx - 1.5, y - 2, 3, bh + 4);
      g.shadowBlur = 0;
    }
    // status text
    g.textAlign = 'left';
    g.font = '700 12px Barlow, system-ui, sans-serif';
    g.fillStyle = '#e8f5ec';
    let msg = '';
    if (this.state === 'ready') msg = this.putt ? 'SPACE / click to start the stroke' : 'SPACE / click to start the swing';
    else if (this.state === 'power') msg = 'Set POWER';
    else if (this.state === 'accuracy') msg = 'Hit the IMPACT zone';
    else if (this.state === 'done') {
      const e = this.error, z = this.zone;
      msg = Math.abs(e) <= z * 0.35 ? 'PERFECT STRIKE' : Math.abs(e) <= z ? 'Good contact' : e > 0 ? 'Early – face closed (pull/hook)' : 'Late – face open (push/slice)';
    }
    g.fillText(msg, x0, 11);
    if (this.rangeLabel) { g.textAlign = 'right'; g.fillText(this.rangeLabel, x1, 11); }
  }
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}

// Convert a meter error to face angle (deg, + open) and strike quality 0..1
export function meterToStrike(err, zone, putt) {
  const k = Math.abs(err) / zone;
  const mag = putt ? 0.45 * Math.pow(k, 1.25) : 1.5 * Math.pow(k, 1.35);
  const face = -Math.sign(err) * Math.min(mag, putt ? 6 : 16);
  const strike = clamp(1 - Math.max(0, k - 0.5) * 0.22, 0.25, 1);
  return { face, strike };
}

export class MouseSwing {
  constructor(canvas) {
    this.cv = canvas;
    this.g = canvas.getContext('2d');
    this.active = false;
    this.enabled = false;
    this.onBack = null;   // (backFraction) while pulling back
    this.onDone = null;   // ({power, face, path, strike})
    this.onCancel = null;
    this.putt = false;
  }
  resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.cv.width = innerWidth * dpr; this.cv.height = innerHeight * dpr;
    this.g.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  down(e) {
    if (!this.enabled || e.button !== 0) return false;
    this.active = true;
    this.x0 = e.clientX; this.y0 = e.clientY;
    this.maxY = e.clientY;
    this.phase = 'back';
    this.pts = [[e.clientX, e.clientY, performance.now()]];
    this.draw();
    return true;
  }
  get range() { return Math.min(260, innerHeight * 0.3); }
  move(e) {
    if (!this.active) return;
    const now = performance.now();
    this.pts.push([e.clientX, e.clientY, now]);
    if (this.pts.length > 400) this.pts.shift();
    const y = e.clientY;
    if (this.phase === 'back') {
      if (y > this.maxY) { this.maxY = y; this.topX = e.clientX; }
      const back = clamp((this.maxY - this.y0) / this.range, 0, this.putt ? 1 : 1.1);
      if (this.onBack) this.onBack(back);
      if (this.maxY - this.y0 > 12 && y < this.maxY - 10) {
        this.phase = 'fwd';
        this.back = back;
        this.fwdStart = [e.clientX, this.maxY, now];
      }
    } else if (this.phase === 'fwd') {
      if (y <= this.y0) this.impact(e.clientX, now);
    }
    this.draw();
  }
  impact(x, now) {
    this.active = false;
    const [fx, fy, ft] = this.fwdStart;
    const dt = Math.max(0.03, (now - ft) / 1000);
    const dy = fy - this.y0;
    const speed = dy / dt; // px/s
    const ideal = this.range * (this.putt ? 1.6 : 3.2) * Math.max(0.35, this.back);
    const ratio = speed / ideal;
    const tempo = clamp(0.8 + 0.2 * ratio, 0.72, 1.04);
    const power = clamp(this.back * tempo, 0.03, this.putt ? 1 : 1.1);
    const drift = x - this.x0;
    const face = clamp(drift * (this.putt ? 0.035 : 0.09), -15, 15);
    const path = clamp((Math.atan2(x - fx, dy) * 180) / Math.PI * (this.putt ? 0 : 0.45), -12, 12);
    const strike = clamp(1 - Math.abs(drift) / 180 - Math.max(0, ratio - 1.5) * 0.1, 0.4, 1);
    this.result = { power, face, path, strike, tempo: ratio };
    this.fadeT = performance.now();
    this.draw();
    if (this.onDone) this.onDone(this.result);
  }
  up() {
    if (!this.active) return;
    this.active = false;
    this.pts = [];
    this.draw();
    if (this.onCancel) this.onCancel();
  }
  draw() {
    const g = this.g;
    g.clearRect(0, 0, innerWidth, innerHeight);
    if (!this.enabled) return;
    if (!this.active && !this.result) {
      return;
    }
    if (this.active) {
      g.strokeStyle = 'rgba(255,255,255,0.35)';
      g.setLineDash([6, 6]);
      g.beginPath(); g.moveTo(this.x0, this.y0 - 60); g.lineTo(this.x0, this.y0 + this.range); g.stroke();
      g.setLineDash([]);
      g.fillStyle = 'rgba(255,255,255,0.8)';
      g.beginPath(); g.arc(this.x0, this.y0, 6, 0, Math.PI * 2); g.fill();
      // backswing depth scale
      g.fillStyle = 'rgba(255,220,80,0.7)';
      g.fillRect(this.x0 + 18, this.y0, 5, this.maxY - this.y0);
      g.strokeStyle = 'rgba(255,255,255,0.5)';
      g.strokeRect(this.x0 + 18, this.y0, 5, this.range);
      // trail
      g.strokeStyle = '#ffe14d'; g.lineWidth = 3;
      g.beginPath();
      this.pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
      g.stroke();
      g.lineWidth = 1;
    }
  }
}
