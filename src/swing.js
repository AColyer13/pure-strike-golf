// Swing input.
//  MouseSwing – Tiger Woods PGA Tour style analog swing: pull the mouse back
//               (backswing), push it forward (downswing). Backswing depth = power,
//               a backswing on the count (0.8 s at the default tempo) = a pure strike, sideways drift = face
//               angle, stroke direction = club path.

import { clamp } from './util.js';

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

// The swing is counted the way tour tempo is taught: three counts back, one count through
// (3:1). A count is a few frames of video, so the pros' tempos are named by their frames back/down
// (24/8 = the most common tour tempo, a 0.8 s backswing). Depth is the power, the time is the tempo.
export const TEMPOS = {
  '18': { name: '18/6', frames: 18, blurb: 'Fastest tour tempo: a 0.6 s backswing' },
  '21': { name: '21/7', frames: 21, blurb: 'Quick and compact (Nicklaus, Player): 0.7 s back' },
  '24': { name: '24/8', frames: 24, blurb: 'The most common tour tempo (Woods, Watson): 0.8 s back' },
  '27': { name: '27/9', frames: 27, blurb: 'Smooth and unhurried (Bobby Jones): 0.9 s back' },
  '30': { name: '30/10', frames: 30, blurb: 'The slowest classic tempo: 1.0 s back' },
  relaxed: { name: 'Relaxed', secs: 1.5, blurb: 'A slow 1.5 s backswing: the easiest with a mouse' },
};
export const TEMPO_IDS = Object.keys(TEMPOS);
export const DEFAULT_TEMPO = '24';
export const FULL_COUNTS = 3; // a full swing: three counts back, one through
const FADE_MS = 2800;

// the live tempo, in seconds: back / down for the swing, count = one count, pure / good = the
// margin (a few percent of the backswing, never under 50 ms: that is a frame and a half).
// counts = the counts back for this club: the putter and the short wedge shots take two (2:1),
// the rest three (3:1); the push through is always one.
export const tempo = { id: DEFAULT_TEMPO, unit: 0.8 / 3, counts: FULL_COUNTS, back: 0.8, down: 0.8 / 3, count: 0.8 / 3, pure: 0.05, good: 0.12 };
export function setCounts(n = FULL_COUNTS) {
  tempo.counts = n;
  tempo.count = tempo.down = tempo.unit;
  tempo.back = tempo.unit * n;
  tempo.pure = Math.max(0.05, tempo.back * 0.06);
  tempo.good = Math.max(0.12, tempo.back * 0.15);
}
export function setTempo(id) {
  const t = TEMPOS[id] || TEMPOS[DEFAULT_TEMPO];
  tempo.id = TEMPOS[id] ? id : DEFAULT_TEMPO;
  tempo.unit = (t.secs || t.frames / 30) / FULL_COUNTS;
  setCounts(tempo.counts);
}
// how many counts back for this club and shot (power = the caddie's number, 0..1)
export function countsFor(club, power) {
  if (club?.putter) return 2;
  return club && club.loft >= 45 && power != null && power < 0.5 ? 2 : FULL_COUNTS;
}
// what to tell the player before the swing
export function tempoNote(club) {
  const n = tempo.counts;
  if (n === FULL_COUNTS) return 'Tempo: 3 counts back, 1 through';
  return `${club?.putter ? 'Putting' : 'Short shot'}: ${n} counts back, 1 through`;
}

// a backswing time → the swing meter's early/late error for the same strike maths: ±pure
// is the middle of the impact zone, ±good its edge (+ rushed = early = closed face)
export function tempoToMeterError(backTime, zone) {
  return (tempo.back - backTime) * (zone / tempo.good);
}

// the push through should take one count: a little either way is free, then it costs contact
function pushPenalty(downTime) {
  if (downTime == null) return 0;
  return Math.max(0, Math.abs(downTime - tempo.down) / tempo.down - 0.3) * 0.4;
}

export class MouseSwing {
  constructor(canvas) {
    this.cv = canvas;
    this.g = canvas.getContext('2d');
    this.active = false;
    this.enabled = false;
    this.onBack = null;   // (backFraction) while pulling back
    this.onDone = null;   // ({power, face, path, strike, backTime})
    this.onCancel = null;
    this.onBeat = null;   // (n) as the count of the backswing passes 1, 2, 3
    this.putt = false;
    this.target = null;   // the caddie's power, drawn on the depth scale
    this.practice = false; // Shift held on the press: a practice swing, timed and shown but not struck
    this.bar = false;     // the timing bar while pulling back (Beginner assists, or training)
    this.pro = false;     // Pro: no blue mark for the caddie's number, no timing bar
    this.count = false;   // training: show the timing count (bar and ticks) while pulling back
  }
  resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.cv.width = innerWidth * dpr; this.cv.height = innerHeight * dpr;
    this.g.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  down(e) {
    if (!this.enabled || e.button !== 0) return false;
    this.active = true;
    this.practice = !!e.shiftKey || !!this.armed;
    if (this.armed) { this.armed = false; document.querySelector('.tc-prac')?.classList.remove('set'); } // a touch practice swing is one-shot
    this.x0 = e.clientX; this.y0 = e.clientY;
    this.maxY = e.clientY;
    this.startT = performance.now(); this.topT = null; this.turnT = null; this.turnAt = null; this.beat = 0; this.backTime = null;
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
      if (y > this.maxY) { this.maxY = y; this.topX = e.clientX; this.topT = now; this.turnT = null; }
      // the turn: the moment the hand first heads back up, however long it hung at the top
      else if (this.turnT == null && y < this.maxY - 1) this.turnT = now;
      const back = clamp((this.maxY - this.y0) / this.range, 0, this.putt ? 1 : 1.1);
      if (this.onBack) this.onBack(back);
      if (this.maxY - this.y0 > 12 && y < this.maxY - 10) {
        this.phase = 'fwd';
        this.back = back;
        const turn = this.turnT ?? now;
        this.backTime = (turn - this.startT) / 1000; // start of the backswing to the start of the push
        this.fwdStart = [e.clientX, this.maxY, now];
        this.turnAt = turn;
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
    // the depth of the backswing is the power; the push through only has to be committed (a
    // crawl or a lash costs contact) and straight
    const power = clamp(this.back, 0.03, this.putt ? 1 : 1.1);
    const drift = x - this.x0;
    const face = clamp(drift * (this.putt ? 0.035 : 0.09), -15, 15);
    const path = clamp((Math.atan2(x - fx, dy) * 180) / Math.PI * (this.putt ? 0 : 0.45), -12, 12);
    const strike = clamp(1 - Math.abs(drift) / 180 - pushPenalty(this.turnAt != null ? (now - this.turnAt) / 1000 : null), 0.4, 1);
    this.result = { power, face, path, strike, tempo: ratio, backTime: this.backTime, practice: this.practice, downTime: this.turnAt != null ? (now - this.turnAt) / 1000 : null };
    this.fadeT = performance.now();
    this.draw();
    if (this.onDone) this.onDone(this.result);
  }
  // each frame of the swing: the count (a tick on 1, 2, 3) and the timing bar
  update() {
    if (this.active && this.phase === 'back' && this.startT != null) {
      const n = Math.min(tempo.counts, Math.floor((performance.now() - this.startT) / (tempo.count * 1000)));
      if ((this.count || this.practice) && n > this.beat) { this.beat = n; if (this.onBeat) this.onBeat(n); }
    }
    if (this.active || this.fading()) this.draw();
  }
  fading() { return !!this.result && this.result.backTime != null && performance.now() - this.fadeT < FADE_MS; }
  up() {
    if (!this.active) return;
    this.active = false;
    this.pts = [];
    this.draw();
    if (this.onCancel) this.onCancel();
  }
  // training aid: the bar fills as the club goes back and should reach the mark with the top of the swing
  drawCount() {
    const g = this.g;
    const bw = 130, bx = clamp(this.flip ? this.x0 - 70 - bw : this.x0 + 70, 10, innerWidth - bw - 10), bh = 10, by = this.y0 + 1, secs = tempo.back * 1.7;
    const el = this.startT == null ? 0 : ((this.phase === 'back' ? performance.now() : this.turnAt) - this.startT) / 1000;
    const at = (s) => bx + (s / secs) * bw; // (s in seconds)
    const inZone = Math.abs(el - tempo.back) <= tempo.pure;
    g.save();
    // the track, with a soft shadow
    g.shadowColor = 'rgba(0,0,0,0.45)'; g.shadowBlur = 6;
    g.fillStyle = 'rgba(10,20,15,0.72)'; roundRect(g, bx - 3, by - 3, bw + 6, bh + 6, 8); g.fill();
    g.shadowBlur = 0;
    g.strokeStyle = 'rgba(255,255,255,0.22)'; g.lineWidth = 1; roundRect(g, bx - 3, by - 3, bw + 6, bh + 6, 8); g.stroke();
    // the mark to hit: a glowing green window
    const z0 = at(tempo.back - tempo.pure), z1 = at(tempo.back + tempo.pure);
    g.shadowColor = 'rgba(120,255,160,0.7)'; g.shadowBlur = inZone ? 10 : 4;
    g.fillStyle = 'rgba(120,255,160,0.38)'; roundRect(g, z0, by, z1 - z0, bh, 4); g.fill();
    g.shadowBlur = 0;
    // the fill, in a gradient: amber on the way, green once it is in the window
    const w = Math.max(0, Math.min(el, secs) / secs * bw);
    if (w > 1) {
      const gr = g.createLinearGradient(bx, 0, bx + bw, 0);
      if (inZone) { gr.addColorStop(0, '#5dd67f'); gr.addColorStop(1, '#b6ffca'); } else { gr.addColorStop(0, '#ffb02e'); gr.addColorStop(1, '#ffe566'); }
      g.fillStyle = gr; roundRect(g, bx, by + 2, w, bh - 4, 3); g.fill();
      g.fillStyle = 'rgba(255,255,255,0.35)'; roundRect(g, bx + 1, by + 2.5, Math.max(0, w - 2), 1.5, 1); g.fill();
    }
    // the counts, as small notches under the track
    g.fillStyle = 'rgba(255,255,255,0.75)';
    for (let k = 1; k <= tempo.counts; k++) g.fillRect(at(k * tempo.count) - 0.75, by + bh + 1, 1.5, 3);
    g.font = '700 12px Barlow, system-ui, sans-serif'; g.textAlign = 'left';
    g.shadowColor = 'rgba(0,0,0,0.8)'; g.shadowBlur = 3;
    g.fillStyle = inZone ? '#b6ffca' : '#fff'; g.fillText(`${(el / tempo.count).toFixed(1)}`, bx, by + bh + 17);
    g.restore();
  }
  // on release the swing is spelled out, part by part, so a shot can be understood: the long bar
  // is the backswing, the short one under it the push through; then a line naming each part's
  // number in its own colour (green on the mark, orange a little off, red well off)
  drawTempo() {
    const g = this.g, r = this.result, e = Math.abs(r.backTime - tempo.back);
    const age = (performance.now() - this.fadeT) / FADE_MS;
    g.globalAlpha = Math.max(0, Math.min(1, (1 - age) * 2));
    const col = (x, pure, good) => (x <= pure ? '#4bd66b' : x <= good ? '#ffa62e' : '#ff4b3a');
    const pe = r.downTime == null ? 0 : Math.abs(r.downTime - tempo.down) / tempo.down;
    const face = r.finalFace ?? r.face, fa = Math.abs(face), fs = this.putt ? 0.5 : 1.5;
    // each bar is as long as its part of the swing took (the same scale for both); one that ran long has a blue line
    // where it should have ended
    const pps = 120 / tempo.back, BH = 8;
    let bx = this.x0 + 18;
    const bar = (secs, target, y, c) => {
      const w = Math.max(4, Math.min(secs, target * 1.6) * pps);
      g.fillStyle = c; roundRect(g, bx, y, w, BH, 4); g.fill();
      if (secs > target) { g.fillStyle = '#4aa8ff'; g.fillRect(bx + target * pps - 1, y - 3, 2, BH + 6); }
    };
    g.font = '700 14px Barlow, system-ui, sans-serif'; g.textAlign = 'left';
    g.shadowColor = 'rgba(0,0,0,0.8)'; g.shadowBlur = 4;
    const bt = r.backTime / tempo.count, dt = r.downTime == null ? null : r.downTime / tempo.count;
    // the backswing line says what the tempo did to the face, when it did anything
    const tf = r.tempoFace || 0, tfa = Math.abs(tf);
    const backWord = e > tempo.pure ? (bt < tempo.counts ? 'quick' : 'slow') : '';
    const backFx = backWord && tfa >= 0.3 ? ` – ${backWord}: face ${tfa.toFixed(0)}° ${tf > 0 ? 'open' : 'closed'}` : backWord ? ` – ${backWord}` : '';
    const rows = [[[`Back ${bt.toFixed(1)}/${tempo.counts}${backFx}`, col(e, tempo.pure, tempo.good)]], [
      dt == null ? null : [`Through ${dt.toFixed(1)}/1${pe > 0.3 ? (dt < 1 ? ' quick' : ' slow') : ''}`, col(pe, 0.3, 0.6)],
      [fa < 0.3 ? 'Face square' : `Face ${fa.toFixed(0)}° ${face > 0 ? 'open' : 'closed'}`, col(fa, fs, fs * 2.7)],
    ].filter(Boolean)];
    // keep the whole readout on screen, however far right (or left) the finger went down
    const tw = Math.max(120, ...rows.map((row) => row.reduce((a, [t]) => a + g.measureText(t).width + 12, -12)));
    bx = Math.max(8, Math.min(this.x0 + 18, innerWidth - tw - 8));
    bar(r.backTime, tempo.back, this.y0 - 4, col(e, tempo.pure, tempo.good));
    if (r.downTime != null) bar(r.downTime, tempo.down, this.y0 + 8, col(pe, 0.3, 0.6));
    rows.forEach((row, i) => {
      let x = bx;
      for (const [t, c] of row) { g.fillStyle = c; g.fillText(t, x, this.y0 + 32 + i * 18); x += g.measureText(t).width + 12; }
    });
    g.shadowBlur = 0;
    g.globalAlpha = 1;
  }
  draw() {
    const g = this.g;
    g.clearRect(0, 0, innerWidth, innerHeight);
    if (!this.enabled) return;
    if (!this.active) { if (this.fading()) this.drawTempo(); return; }
    if (this.active) {
      // a finger far right of centre puts the depth scale and its labels on the finger's left instead
      this.flip = this.x0 + ((this.bar || this.practice) ? 210 : 80) > innerWidth - 8;
      const sd = this.flip ? -1 : 1, bxs = this.flip ? this.x0 - 23 : this.x0 + 18;
      g.strokeStyle = 'rgba(255,255,255,0.35)';
      g.setLineDash([6, 6]);
      g.beginPath(); g.moveTo(this.x0, this.y0 - 60); g.lineTo(this.x0, this.y0 + this.range); g.stroke();
      g.setLineDash([]);
      g.fillStyle = 'rgba(255,255,255,0.8)';
      g.beginPath(); g.arc(this.x0, this.y0, 6, 0, Math.PI * 2); g.fill();
      // backswing depth scale
      g.fillStyle = 'rgba(255,220,80,0.7)';
      g.fillRect(bxs, this.y0, 5, this.maxY - this.y0);
      g.strokeStyle = 'rgba(255,255,255,0.5)';
      g.strokeRect(bxs, this.y0, 5, this.range);
      g.font = '700 12px Barlow, system-ui, sans-serif';
      g.textAlign = 'left';
      // the caddie's number, and where the swing is now
      if (this.target != null && !this.pro) {
        const ty = this.y0 + clamp(this.target, 0, 1.1) * this.range;
        g.fillStyle = '#5fd4ff';
        g.fillRect(this.flip ? this.x0 - 29 : this.x0 + 12, ty - 1.5, 17, 3);
        g.textAlign = this.flip ? 'right' : 'left';
        g.fillText(`${Math.round(this.target * 100)}%`, this.x0 + 32 * sd, ty + 4);
        g.textAlign = 'left';
      }
      const deep = (this.maxY - this.y0) / this.range;
      if (deep > 0.04) { g.fillStyle = '#fff'; g.fillText(`${Math.round(deep * 100)}%`, this.flip ? this.x0 + 12 : Math.max(4, this.x0 - 40), this.maxY + 4); }
      if (this.bar || this.practice) this.drawCount();
      // trail
      g.strokeStyle = '#ffe14d'; g.lineWidth = 3;
      g.beginPath();
      this.pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
      g.stroke();
      g.lineWidth = 1;
    }
  }
}
