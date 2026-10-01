// Synthesized sound effects (no audio files): club strikes, ball landings,
// the cup rattle, crowd reactions, birds and wind ambience.

export class Audio {
  constructor() {
    this.ctx = null;
    this.enabled = true;
    this.volume = 0.7;
  }

  init() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(this.ctx.destination);
    // shared noise buffer
    const len = this.ctx.sampleRate * 2;
    this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.startAmbience();
  }

  setVolume(v) { this.volume = v; if (this.master) this.master.gain.value = v; }

  noiseSrc() {
    const s = this.ctx.createBufferSource();
    s.buffer = this.noise;
    s.loop = true;
    return s;
  }

  env(g, t, a, peak, dcy) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + dcy);
  }

  // Club strike. kind: 'driver' | 'wood' | 'iron' | 'wedge' | 'putt' | 'sand'. quality 0..1
  hit(kind, quality = 1, power = 1) {
    if (!this.ctx || !this.enabled) return;
    const c = this.ctx, t = c.currentTime;
    const out = c.createGain(); out.connect(this.master);
    out.gain.value = kind === 'putt' ? 0.35 : 0.9 * (0.5 + 0.5 * power);
    // noisy transient
    const n = this.noiseSrc();
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = { driver: 3200, wood: 2800, iron: 2200, wedge: 2600, putt: 1800, sand: 700 }[kind] || 2400;
    bp.Q.value = kind === 'sand' ? 0.5 : 1.2;
    const ng = c.createGain();
    this.env(ng, t, 0.001, kind === 'sand' ? 0.9 : 0.8, kind === 'sand' ? 0.35 : 0.07);
    n.connect(bp).connect(ng).connect(out);
    n.start(t); n.stop(t + 0.5);
    // tonal "ping" of the head (driver titanium ring / iron click)
    if (kind !== 'sand') {
      const o = c.createOscillator();
      o.type = kind === 'driver' || kind === 'wood' ? 'triangle' : 'sine';
      const f = { driver: 1650, wood: 1400, iron: 950, wedge: 1100, putt: 1900 }[kind] || 1000;
      o.frequency.setValueAtTime(f * (0.96 + 0.08 * quality), t);
      o.frequency.exponentialRampToValueAtTime(f * 0.7, t + 0.12);
      const og = c.createGain();
      const lvl = kind === 'putt' ? 0.25 : (0.15 + 0.35 * quality);
      this.env(og, t, 0.001, lvl, kind === 'driver' ? 0.22 : 0.08);
      o.connect(og).connect(out);
      o.start(t); o.stop(t + 0.4);
    }
    // thud for mishits
    if (quality < 0.7 && kind !== 'putt') {
      const o2 = c.createOscillator();
      o2.type = 'sine';
      o2.frequency.setValueAtTime(180, t);
      o2.frequency.exponentialRampToValueAtTime(70, t + 0.15);
      const g2 = c.createGain();
      this.env(g2, t, 0.002, 0.5 * (1 - quality), 0.15);
      o2.connect(g2).connect(out);
      o2.start(t); o2.stop(t + 0.3);
    }
    // whoosh (swing)
    this.whoosh(t - 0.12, power);
  }

  whoosh(t, power = 1) {
    if (!this.ctx) return;
    const c = this.ctx;
    t = Math.max(t, c.currentTime);
    const n = this.noiseSrc();
    const f = c.createBiquadFilter();
    f.type = 'bandpass'; f.Q.value = 2;
    f.frequency.setValueAtTime(300, t);
    f.frequency.exponentialRampToValueAtTime(1600, t + 0.14);
    const g = c.createGain();
    this.env(g, t, 0.1, 0.12 * power, 0.12);
    n.connect(f).connect(g).connect(this.master);
    n.start(t); n.stop(t + 0.4);
  }

  land(surface, speed = 10) {
    if (!this.ctx || !this.enabled) return;
    const c = this.ctx, t = c.currentTime;
    const v = Math.min(1, speed / 25);
    if (surface === 'water') return this.splash(v);
    const n = this.noiseSrc();
    const f = c.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = surface === 'bunker' ? 900 : surface === 'path' ? 3000 : 500;
    const g = c.createGain();
    this.env(g, t, 0.002, 0.25 + 0.5 * v, surface === 'bunker' ? 0.18 : 0.08);
    n.connect(f).connect(g).connect(this.master);
    n.start(t); n.stop(t + 0.3);
    if (surface === 'path') {
      const o = c.createOscillator();
      o.frequency.value = 2400;
      const og = c.createGain();
      this.env(og, t, 0.001, 0.2, 0.05);
      o.connect(og).connect(this.master); o.start(t); o.stop(t + 0.1);
    }
  }

  splash(v = 1) {
    const c = this.ctx, t = c.currentTime;
    const n = this.noiseSrc();
    const f = c.createBiquadFilter();
    f.type = 'bandpass'; f.Q.value = 0.7;
    f.frequency.setValueAtTime(1800, t);
    f.frequency.exponentialRampToValueAtTime(400, t + 0.5);
    const g = c.createGain();
    this.env(g, t, 0.005, 0.7 * (0.4 + v), 0.55);
    n.connect(f).connect(g).connect(this.master);
    n.start(t); n.stop(t + 0.8);
  }

  tree() {
    if (!this.ctx || !this.enabled) return;
    const c = this.ctx, t = c.currentTime;
    const n = this.noiseSrc();
    const f = c.createBiquadFilter();
    f.type = 'highpass'; f.frequency.value = 2500;
    const g = c.createGain();
    this.env(g, t, 0.005, 0.4, 0.4);
    n.connect(f).connect(g).connect(this.master);
    n.start(t); n.stop(t + 0.6);
    const o = c.createOscillator();
    o.frequency.value = 420;
    const og = c.createGain();
    this.env(og, t, 0.001, 0.25, 0.08);
    o.connect(og).connect(this.master); o.start(t); o.stop(t + 0.2);
  }

  pin() {
    if (!this.ctx || !this.enabled) return;
    const c = this.ctx, t = c.currentTime;
    for (const f of [2100, 3350]) {
      const o = c.createOscillator();
      o.frequency.value = f;
      const g = c.createGain();
      this.env(g, t, 0.001, 0.3, 0.5);
      o.connect(g).connect(this.master); o.start(t); o.stop(t + 0.6);
    }
  }

  cup() {
    if (!this.ctx || !this.enabled) return;
    const c = this.ctx, t0 = c.currentTime;
    // rattle: a few decaying plastic clicks
    for (let i = 0; i < 4; i++) {
      const t = t0 + i * (0.07 - i * 0.012);
      const o = c.createOscillator();
      o.type = 'square';
      o.frequency.value = 900 + Math.random() * 300;
      const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1200; bp.Q.value = 3;
      const g = c.createGain();
      this.env(g, t, 0.001, 0.35 / (i + 1), 0.05);
      o.connect(bp).connect(g).connect(this.master); o.start(t); o.stop(t + 0.1);
    }
  }

  // Crowd: level 0..1 (polite golf clap .. roar)
  crowd(level = 0.5, dur = 2.5) {
    if (!this.ctx || !this.enabled) return;
    const c = this.ctx, t = c.currentTime;
    const out = c.createGain();
    out.connect(this.master);
    out.gain.setValueAtTime(0.0001, t);
    out.gain.exponentialRampToValueAtTime(0.18 + 0.35 * level, t + 0.25);
    out.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    // applause: many short noise bursts
    const clapN = Math.floor(30 + 90 * level);
    for (let i = 0; i < clapN; i++) {
      const tt = t + Math.random() * dur * 0.85;
      const n = this.noiseSrc();
      const f = c.createBiquadFilter();
      f.type = 'bandpass'; f.frequency.value = 1200 + Math.random() * 1800; f.Q.value = 1.5;
      const g = c.createGain();
      this.env(g, tt, 0.001, 0.25 + Math.random() * 0.2, 0.04);
      n.connect(f).connect(g).connect(out);
      n.start(tt, Math.random()); n.stop(tt + 0.08);
    }
    if (level > 0.6) {
      // cheer: low rumble of voices
      const n = this.noiseSrc();
      const f = c.createBiquadFilter();
      f.type = 'bandpass'; f.frequency.value = 500; f.Q.value = 0.8;
      const g = c.createGain();
      this.env(g, t, 0.3, 0.5 * level, dur);
      n.connect(f).connect(g).connect(out);
      n.start(t); n.stop(t + dur + 0.5);
    }
  }

  groan() {
    if (!this.ctx || !this.enabled) return;
    const c = this.ctx, t = c.currentTime;
    const n = this.noiseSrc();
    const f = c.createBiquadFilter();
    f.type = 'bandpass'; f.Q.value = 2;
    f.frequency.setValueAtTime(600, t);
    f.frequency.exponentialRampToValueAtTime(260, t + 1.2);
    const g = c.createGain();
    this.env(g, t, 0.2, 0.18, 1.1);
    n.connect(f).connect(g).connect(this.master);
    n.start(t); n.stop(t + 1.6);
  }

  ui(kind = 'tick') {
    if (!this.ctx || !this.enabled) return;
    const c = this.ctx, t = c.currentTime;
    const o = c.createOscillator();
    o.type = 'sine';
    o.frequency.value = kind === 'tick' ? 1400 : kind === 'set' ? 880 : kind === 'good' ? 1320 : 520;
    const g = c.createGain();
    this.env(g, t, 0.002, 0.08, 0.07);
    o.connect(g).connect(this.master); o.start(t); o.stop(t + 0.12);
  }

  startAmbience() {
    const c = this.ctx;
    // wind bed
    const n = this.noiseSrc();
    const f = c.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = 400;
    this.windGain = c.createGain();
    this.windGain.gain.value = 0.0;
    n.connect(f).connect(this.windGain).connect(this.master);
    n.start();
    this.windFilter = f;
    // birds
    const chirp = () => {
      if (!this.ctx) return;
      if (this.enabled && this.birds) {
        const t = c.currentTime;
        const base = 2500 + Math.random() * 2500;
        const count = 2 + Math.floor(Math.random() * 4);
        for (let i = 0; i < count; i++) {
          const tt = t + i * (0.09 + Math.random() * 0.05);
          const o = c.createOscillator();
          o.frequency.setValueAtTime(base, tt);
          o.frequency.exponentialRampToValueAtTime(base * (0.7 + Math.random() * 0.6), tt + 0.07);
          const g = c.createGain();
          this.env(g, tt, 0.005, 0.025 * this.birds, 0.06);
          o.connect(g).connect(this.master); o.start(tt); o.stop(tt + 0.1);
        }
      }
      setTimeout(chirp, 1500 + Math.random() * 5000);
    };
    this.birds = 1;
    setTimeout(chirp, 2000);
  }

  setWind(mph, gulls = false) {
    if (!this.windGain) return;
    const t = this.ctx.currentTime;
    this.windGain.gain.setTargetAtTime(this.enabled ? Math.min(0.25, 0.012 * mph) : 0, t, 0.5);
    this.windFilter.frequency.setTargetAtTime(250 + mph * 25, t, 0.5);
    this.birds = gulls ? 0.5 : 1;
  }
}
