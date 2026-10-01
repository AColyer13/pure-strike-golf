// Core game: state machine, shot execution, cameras, caddie, HUD updates.
import * as THREE from 'three';
import { World } from './world.js';
import { Golfer } from './golfer.js';
import { BallSim, computeLaunch, simulateCarry, LIES, SURFACES, puttSpeedFor, BALL, G } from './physics.js';
import { buildBag, PROFILES } from './clubs.js';
import { YD, FT, mulberry32 } from './hole.js';
import { RoundStats, expectedStrokes, scoreName } from './stats.js';
import { SwingMeter, MouseSwing, meterToStrike } from './meter.js';
import { Audio } from './audio.js';
import { coachShot, resetCoach } from './coach.js';
import { COURSES, courseById } from './courses/index.js';

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const lerp = (a, b, t) => a + (b - a) * t;
const DEG = Math.PI / 180;
const MPH = 0.44704;
const $ = (id) => document.getElementById(id);
const dirOf = (a) => ({ x: Math.sin(a), z: -Math.cos(a) });
const angOf = (dx, dz) => Math.atan2(dx, -dz);

const DIFFICULTY = {
  beginner: { name: 'Beginner', meterTime: 1.35, zone: 0.055, wind: true, roll: true, putt: 1.0, marker: true },
  standard: { name: 'Standard', meterTime: 1.05, zone: 0.036, wind: false, roll: false, putt: 0.35, marker: true },
  pro: { name: 'Pro', meterTime: 0.85, zone: 0.024, wind: false, roll: false, putt: 0, marker: false },
};
const SHAPES = {
  draw: { name: 'Draw', path: 4.5, face: 1.5 },
  straight: { name: 'Straight', path: 0, face: 0 },
  fade: { name: 'Fade', path: -4.5, face: -1.5 },
};
const TRAJ = { '-1': 'Low', '0': 'Standard', '1': 'High' };

export class Game {
  constructor(ui) {
    this.ui = ui;
    const canvas = $('c');
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.98;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.05, 8000);
    this.world = new World(this.renderer);
    this.scene = this.world.scene;
    this.golfer = new Golfer();
    this.scene.add(this.golfer.root);
    // ball + tee peg + shadow
    this.ballMesh = new THREE.Mesh(new THREE.SphereGeometry(BALL.radius, 20, 14), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.35, emissive: 0x222222 }));
    this.ballMesh.castShadow = true;
    this.scene.add(this.ballMesh);
    this.tee = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.0025, 0.05, 6), new THREE.MeshStandardMaterial({ color: 0xffffff }));
    this.scene.add(this.tee);
    this.ballShadow = new THREE.Mesh(new THREE.CircleGeometry(0.03, 16).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35, depthWrite: false }));
    this.scene.add(this.ballShadow);

    this.audio = new Audio();
    this.meter = new SwingMeter($('meter'));
    this.mouseSwing = new MouseSwing($('swingOverlay'));
    this.mouseSwing.resize();

    this.cam = { pos: new THREE.Vector3(0, 50, 50), look: new THREE.Vector3(), tPos: new THREE.Vector3(0, 50, 50), tLook: new THREE.Vector3(), k: 3 };
    this.orbit = { yaw: 0, pitch: 0, zoom: 1 };
    this.keys = {};
    this.state = 'menu';
    this.timeScale = 1;
    this.settings = this.loadSettings();
    this.raycaster = new THREE.Raycaster();
    this.bindInput();
    this.last = performance.now();
    this.hudTimer = 0;
    requestAnimationFrame((t) => this.loop(t));
    addEventListener('resize', () => this.resize());
  }

  // ------------------------------------------------------------------ settings
  loadSettings() {
    let s = {};
    try { s = JSON.parse(localStorage.getItem('psg-settings') || '{}'); } catch (e) { /* ignore */ }
    return { profile: 'scratch', difficulty: 'standard', control: 'meter', units: 'yd', volume: 0.7, tracer: true, ...s };
  }
  saveSettings() {
    try { localStorage.setItem('psg-settings', JSON.stringify(this.settings)); } catch (e) { /* ignore */ }
  }
  get diff() { return DIFFICULTY[this.settings.difficulty] || DIFFICULTY.standard; }

  resize() {
    this.renderer.setSize(innerWidth, innerHeight);
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
    this.meter.resize(); this.meter.draw();
    this.mouseSwing.resize();
  }

  // ------------------------------------------------------------------ menu backdrop
  showcase(courseId) {
    const course = courseById(courseId) || COURSES[0];
    const sig = { augusta: 11, standrews: 17, pebble: 6, sawgrass: 16 }[course.id] ?? 0;
    this.world.setCourse(course);
    this.hole = this.world.buildHole(course, sig, {});
    this.env = { rho: course.rho, wind: [2, 0, -1], firmness: course.firmness, stimp: this.hole.stimp };
    this.state = 'menu';
    this.showcaseT = 0;
    this.golfer.root.visible = false;
    this.ballMesh.visible = false; this.tee.visible = false; this.ballShadow.visible = false;
    this.world.reticle.visible = false; this.world.arc.visible = false; this.world.tracer.visible = false;
  }

  // ------------------------------------------------------------------ round
  startRound(opts) {
    this.ui.hideAll();
    this.audio.init();
    this.audio.setVolume(this.settings.volume);
    const course = courseById(opts.courseId);
    this.course = course;
    this.bag = buildBag(this.settings.profile);
    const seed = (Math.random() * 1e9) | 0;
    this.round = {
      course, holes: opts.holes, i: 0, seed, rng: mulberry32(seed),
      scores: [], stats: new RoundStats(), windDir: Math.random() * Math.PI * 2, mode: opts.mode,
    };
    resetCoach();
    this.world.setCourse(course);
    this.computeBagDistances();
    this.ui.showHUD(true);
    this.meter.resize();
    this.loadHole();
  }

  computeBagDistances() {
    // full-swing carry/total on flat fairway, no wind (the "yardage book")
    const c = this.course;
    for (const club of this.bag) {
      if (club.putter) continue;
      const ld = computeLaunch(club, { power: 1, face: 0, path: 0, strike: 1, traj: 0, lie: 'fairway' });
      const flat = { height: () => 0, normal: () => [0, 1, 0], surface: () => 'fairway', inBounds: () => true, cup: { x: 1e5, z: 1e5 }, pinIn: false };
      const sim = new BallSim(flat, { rho: c.rho, wind: [0, 0, 0], firmness: c.firmness, stimp: c.stimp });
      sim.launch([0, BALL.radius, 0], ld, [0, 0, -1]);
      let n = 0;
      while (sim.state !== 'rest' && n++ < 8000) sim.step(1 / 120);
      club.carry = Math.hypot(sim.landed[0], sim.landed[2]);
      club.total = Math.hypot(sim.p[0], sim.p[2]);
    }
  }

  loadHole() {
    const r = this.round;
    const idx = r.holes[r.i];
    const course = this.course;
    this.ui.loading(true, `Hole ${idx + 1} – ${course.holes[idx].name}`);
    setTimeout(() => {
      const pinIndex = Math.floor(r.rng() * 4);
      this.hole = this.world.buildHole(course, idx, { pinIndex });
      const hole = this.hole;
      // wind for this hole
      const [wmin, wmax] = course.wind;
      const mph = wmin + (wmax - wmin) * Math.pow(r.rng(), 1.3);
      const a = r.windDir + (r.rng() - 0.5) * 1.4;
      this.windMph = mph;
      this.windAng = a; // direction the wind blows TOWARD
      this.env = { rho: course.rho, wind: [Math.sin(a) * mph * MPH, 0, -Math.cos(a) * mph * MPH], firmness: course.firmness, stimp: hole.stimp };
      this.audio.setWind(mph, course.id === 'pebble' || course.id === 'standrews');
      this.strokes = 0;
      this.penalties = 0;
      this.holeStats = r.stats.startHole(hole.number, hole.par, course.holes[idx].yds);
      this.ball = { p: [hole.tee.x, hole.height(hole.tee.x, hole.tee.z) + BALL.radius, hole.tee.z], surface: 'tee', isTee: true };
      this.lastSpot = this.ball.p.slice();
      this.world.gridGroup = null; this.world.flow = null;
      this.world.tracer.visible = false;
      this.world.setTracer([]);
      this.golfer.root.visible = true;
      this.ballMesh.visible = true;
      this.ui.loading(false);
      this.ui.holeIntro(hole, course, this.fmtDist(hole.length), this.windText());
      this.startFlyover();
    }, 30);
  }

  // ------------------------------------------------------------------ flyover
  startFlyover() {
    this.state = 'flyover';
    document.body.classList.add('flyover');
    this.flyT = 0;
    const h = this.hole;
    this.flyDur = clamp(3.5 + h.length / 110, 4, 8.5);
    this.meter.hide();
    this.world.reticle.visible = false;
    this.world.arc.visible = false;
    this.world.showGreenGrid(false);
    this.prepareAddress(true);
    this.golfer.phase = 'idle';
  }
  updateFlyover(dt) {
    this.flyT += dt;
    const h = this.hole;
    const k = clamp(this.flyT / this.flyDur, 0, 1);
    const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
    const s = e * h.length;
    const p = h.pointAt(Math.max(0, s - 40));
    const ahead = h.pointAt(Math.min(h.length, s + 80));
    const g = { x: h.cup.x, z: h.cup.z };
    const look = { x: lerp(ahead.x, g.x, e), z: lerp(ahead.z, g.z, e) };
    const alt = 38 + 20 * Math.sin(k * Math.PI);
    this.cam.tPos.set(p.x, h.height(p.x, p.z) + alt, p.z);
    this.cam.tLook.set(look.x, h.height(look.x, look.z), look.z);
    this.cam.k = 2.5;
    if (this.flyT === dt) { this.cam.pos.copy(this.cam.tPos); this.cam.look.copy(this.cam.tLook); }
    if (k >= 1) this.endFlyover();
  }
  endFlyover() {
    document.body.classList.remove('flyover');
    this.ui.hideIntro();
    this.enterAddress();
  }

  // ------------------------------------------------------------------ address
  prepareAddress(first = false) {
    const h = this.hole;
    const b = this.ball;
    b.surface = b.isTee ? 'tee' : h.surface(b.p[0], b.p[2]);
    b.p[1] = h.height(b.p[0], b.p[2]) + BALL.radius;
    this.onGreen = b.surface === 'green';
    h.pinIn = !this.onGreen;
    // default aim at the pin
    this.aim = angOf(h.cup.x - b.p[0], h.cup.z - b.p[2]);
    this.shape = 'straight';
    this.traj = 0;
    this.userClub = false;
    this.chooseClub();
    this.placeGolfer();
    this.previewDirty = true;
  }

  enterAddress() {
    this.state = 'address';
    this.orbit = { yaw: 0, pitch: 0, zoom: 1 };
    const d = this.diff;
    this.meter.configure({ fullTime: d.meterTime * (this.club.putter ? 1.25 : 1), marker: null });
    this.meter.show();
    this.meter.state = 'ready';
    this.meter.power = null;
    this.mouseSwing.enabled = this.settings.control === 'mouse';
    this.mouseSwing.putt = !!this.club.putter;
    this.mouseSwing.result = null;
    this.mouseSwing.draw();
    this.world.showGreenGrid(this.onGreen || (this.distToPin() < 25 && this.gridOn));
    this.world.arc.visible = true;
    this.world.reticle.visible = !this.club.putter;
    this.world.tracer.visible = false;
    this.previewDirty = true;
    this.caddieNote();
    this.ui.showShotPanel(null);
    this.updateHUD(true);
  }

  distToPin() { return Math.hypot(this.hole.cup.x - this.ball.p[0], this.hole.cup.z - this.ball.p[2]); }

  lieKey() {
    const s = this.ball.surface;
    if (this.ball.isTee) return 'tee';
    if (s === 'bunker') {
      const nearGreen = this.hole.greenSdf(this.ball.p[0], this.ball.p[2]) < 30;
      return nearGreen && this.club && this.club.loft >= 50 ? 'splash' : 'bunker';
    }
    return LIES[s] ? s : 'rough';
  }

  slope() {
    const h = this.hole, b = this.ball;
    const n = h.normal(b.p[0], b.p[2]);
    const f = dirOf(this.aim);
    const r = { x: -f.z, z: f.x };
    const up = Math.atan(-(n[0] * f.x + n[2] * f.z) / n[1]) / DEG;
    const side = Math.atan(-(n[0] * r.x + n[2] * r.z) / n[1]) / DEG; // + ball above feet
    return { up, side };
  }

  setClub(i, user = false) {
    this.clubIdx = clamp(i, 0, this.bag.length - 1);
    this.club = this.bag[this.clubIdx];
    if (user) this.userClub = true;
    this.golfer.setClub(this.club);
    this.placeGolfer();
    this.hole.pinIn = !this.club.putter;
    if (this.club.putter) this.setupPutt();
    this.meter.configure({ putt: !!this.club.putter, fullTime: this.diff.meterTime * (this.club.putter ? 1.25 : 1) });
    this.mouseSwing.putt = !!this.club.putter;
    this.world.reticle.visible = !this.club.putter && this.state !== 'flyover';
    this.world.puttLine.visible = false;
    this.previewDirty = true;
  }

  placeGolfer() {
    const b = this.ball;
    const f = dirOf(this.aim);
    this.golfer.place({ x: b.p[0], z: b.p[2] }, f, this.hole.height(b.p[0], b.p[2]));
    const teed = this.ball.isTee && this.club && !this.club.putter && this.club.loft < 30;
    const lift = this.ball.isTee ? (teed ? (this.club.loft < 13 ? 0.035 : 0.012) : 0.005) : 0;
    this.ballLift = lift;
    this.tee.visible = this.ball.isTee;
    this.tee.position.set(b.p[0], this.hole.height(b.p[0], b.p[2]) + lift - 0.005, b.p[2]);
    this.ballMesh.position.set(b.p[0], b.p[1] + lift, b.p[2]);
  }

  // ------------------------------------------------------------------ caddie / club choice
  // Plays-like distance: compares the club's carry on flat ground in still air
  // with its carry to the target's elevation in the current wind.
  playsLike(club, targetDist, dh, dir) {
    const ld = computeLaunch(club, { power: 1, face: 0, path: 0, strike: 1, traj: this.traj, lie: 'fairway' });
    const fwd = [dir.x, 0, dir.z];
    const flat = simulateCarry(ld, { rho: this.env.rho, wind: [0, 0, 0] }, { fwd });
    const elev = simulateCarry(ld, { rho: this.env.rho, wind: [0, 0, 0] }, { fwd, landY: dh });
    const both = simulateCarry(ld, { rho: this.env.rho, wind: this.env.wind }, { fwd, landY: dh });
    const fe = flat.carry / Math.max(1, elev.carry), fb = flat.carry / Math.max(1, both.carry);
    return { plays: targetDist * fb, elevAdj: targetDist * (fe - 1), windAdj: targetDist * (fb - fe) };
  }

  chooseClub() {
    const h = this.hole, b = this.ball;
    const d = this.distToPin();
    const dir = dirOf(this.aim);
    const dh = h.height(h.cup.x, h.cup.z) - (b.p[1] - BALL.radius);
    this.pl = null;
    this.caddieMsg = '';
    if (b.surface === 'green' || (b.surface === 'fringe' && d < 18) || (b.surface === 'cut' && d < 12 && h.greenSdf(b.p[0], b.p[2]) < 4)) {
      this.setClub(this.bag.length - 1);
      if (b.surface !== 'green') this.caddieMsg = 'Putt it from here. A poor putt usually finishes closer than a poor chip.';
      return;
    }
    const usable = this.bag.filter((c) => !c.putter && (c.key !== 'DR' || b.isTee));
    // plays-like distance using a mid iron as the reference, then refine with the chosen club
    let club = usable.find((c) => c.carry <= d * 1.02) || usable[usable.length - 1];
    let pl = this.playsLike(club, d, dh, dir);
    const pick = (need) => {
      let best = null;
      for (const c of usable) if (c.carry >= need * 0.985) best = c; // smallest club that carries
      return best;
    };
    let target = pick(pl.plays);
    if (target) { pl = this.playsLike(target, d, dh, dir); target = pick(pl.plays) || target; }
    this.pl = pl;
    const lie = this.lieKey();
    if (lie === 'splash' || (b.surface === 'bunker' && h.greenSdf(b.p[0], b.p[2]) < 30)) {
      target = this.bag.find((c) => c.key === 'SW');
      this.caddieMsg = 'Greenside bunker: open the face, splash the sand – the ball rides out on it.';
    }
    if (target && !(h.par >= 4 && b.isTee && pl.plays > target.carry + 30)) {
      this.setClub(this.bag.indexOf(target));
      return;
    }
    // pin out of range (tee shots / lay-ups): evaluate options by expected strokes
    const longest = usable[0];
    this.setClub(this.bag.indexOf(longest));
    this.aimForClub(longest);
    this.startCaddieAnalysis(usable);
  }

  // aim along the centre line at the club's typical total distance
  aimForClub(club) {
    const h = this.hole, b = this.ball;
    const pr = h.project(b.p[0], b.p[2]);
    const want = club.total * (this.ball.surface === 'fairway' || this.ball.isTee ? 1 : 0.9);
    let best = null;
    for (let s = pr.s; s <= h.length; s += 2) {
      const q = h.pointAt(s);
      const dd = Math.hypot(q.x - b.p[0], q.z - b.p[2]);
      if (dd >= want) { best = q; break; }
    }
    if (!best) best = { x: h.cup.x, z: h.cup.z };
    this.aim = angOf(best.x - b.p[0], best.z - b.p[2]);
    this.placeGolfer();
  }

  startCaddieAnalysis(clubs) {
    const cands = clubs.slice(0, 9).filter((c) => c.total * 0.8 < this.distToPin());
    this.analysis = { cands, i: 0, results: [], id: Math.random() };
    this.caddieMsg = 'Caddie is checking the landing areas…';
  }
  stepCaddieAnalysis() {
    const A = this.analysis;
    if (!A || this.state !== 'address') return;
    if (A.i >= A.cands.length) { this.finishAnalysis(); return; }
    const club = A.cands[A.i++];
    const h = this.hole, b = this.ball;
    const pr = h.project(b.p[0], b.p[2]);
    let tgt = null;
    for (let s = pr.s; s <= h.length; s += 2) {
      const q = h.pointAt(s);
      if (Math.hypot(q.x - b.p[0], q.z - b.p[2]) >= club.total) { tgt = q; break; }
    }
    if (!tgt) return;
    const aim = angOf(tgt.x - b.p[0], tgt.z - b.p[2]);
    const spread = club.loft < 20 ? 3.2 : club.loft < 30 ? 2.4 : 1.8;
    let es = 0; const notes = [];
    for (const face of [-spread, 0, spread]) {
      const out = this.simOutcome(club, aim, { face, power: 1, dt: 1 / 90, withWind: true });
      let e;
      if (out.result === 'water') { e = 1 + expectedStrokes('rough', out.entryDist / YD); notes.push('water'); }
      else if (out.result === 'ob') { e = 1 + expectedStrokes(b.isTee ? 'fairway' : b.surface, this.distToPin() / YD, b.isTee); notes.push('out of bounds'); }
      else {
        e = expectedStrokes(out.surface, out.dist / YD);
        if (out.surface === 'bunker') notes.push('bunkers');
        if (out.surface === 'deep' || out.surface === 'straw') notes.push('trees');
      }
      es += e / 3;
    }
    A.results.push({ club, aim, es: es + 1, notes: [...new Set(notes)] });
  }
  finishAnalysis() {
    const A = this.analysis;
    this.analysis = null;
    if (!A.results.length) { this.caddieMsg = ''; return; }
    A.results.sort((a, b) => a.es - b.es);
    const best = A.results[0];
    const longest = A.results.find((r) => r.club === A.cands[0]);
    if (!this.userClub) {
      this.setClub(this.bag.indexOf(best.club));
      this.aim = best.aim;
      this.placeGolfer();
      this.previewDirty = true;
    }
    const fmt = (r) => `${r.club.name} ${r.es.toFixed(2)}`;
    let msg = `Caddie: ${best.club.name} – expected score from here ${best.es.toFixed(2)}.`;
    if (longest && longest !== best) {
      msg += ` ${fmt(longest)}${longest.notes.length ? ` (brings ${longest.notes.join(' & ')} into play)` : ''}.`;
    }
    this.caddieMsg = msg;
    this.updateHUD(true);
  }

  // Deterministic outcome of a shot (used by the caddie and previews)
  simOutcome(club, aim, o = {}) {
    const h = this.hole, b = this.ball;
    const dir = dirOf(aim);
    const sh = SHAPES[this.shape];
    const ld = computeLaunch(club, { power: o.power ?? 1, face: (o.face || 0) + sh.face, path: sh.path, strike: 1, traj: this.traj, lie: this.lieKey(), slope: this.slope() });
    const env = { ...this.env, wind: o.withWind ? this.env.wind : [0, 0, 0] };
    const sim = new BallSim(h, env, mulberry32(7));
    const start = [b.p[0], b.p[1] + (this.ballLift || 0), b.p[2]];
    sim.launch(start, ld, [dir.x, 0, dir.z]);
    const dt = o.dt || 1 / 120;
    const pts = o.path ? [start.slice()] : null;
    let n = 0, land = null;
    while (sim.state !== 'rest' && sim.state !== 'holed' && n++ < 9000) {
      sim.step(dt);
      if (pts && n % 3 === 0 && !land) pts.push(sim.p.slice());
      if (!land && sim.landed) { land = sim.landed.slice(); if (o.stopAtLand) break; }
    }
    const ev = sim.events.map((e) => e.type);
    let result = 'ok';
    if (ev.includes('water')) result = 'water';
    if (ev.includes('ob')) result = 'ob';
    if (sim.state === 'holed') result = 'holed';
    const p = sim.p;
    const out = { result, land, rest: p.slice(), path: pts, ld, surface: h.surface(p[0], p[2]), dist: Math.hypot(h.cup.x - p[0], h.cup.z - p[2]) };
    if (result === 'water') {
      const e = this.findEntry(sim);
      out.entryDist = Math.hypot(h.cup.x - e.x, h.cup.z - e.z);
    }
    return out;
  }

  caddieNote() {
    this.ui.caddie(this.caddieMsg || '');
  }

  // ------------------------------------------------------------------ putting setup
  setupPutt() {
    const h = this.hole, b = this.ball;
    const d = this.distToPin();
    const ft = d / FT;
    // effective (flat-equivalent) distance: the speed that would finish ~17 in (43 cm) past the
    // hole if it missed – Pelz's optimum, and what the meter marker teaches
    const dir = { x: (h.cup.x - b.p[0]) / d, z: (h.cup.z - b.p[2]) / d };
    const v = this.puttSpeedToReach(dir, d + 0.43);
    const eqFt = (v * v) / (2 * h.greenRoll * G) / FT;
    this.puttEqFt = eqFt;
    const ranges = [10, 20, 40, 70, 120];
    this.puttRange = ranges.find((r) => r >= eqFt * 1.15) || 150;
    this.puttElevIn = (h.height(h.cup.x, h.cup.z) - h.height(b.p[0], b.p[2])) / 0.0254;
    this.meter.configure({ labels: [[0.25, `${Math.round(this.puttRange * 0.25)}ft`], [0.5, `${Math.round(this.puttRange * 0.5)}ft`], [0.75, `${Math.round(this.puttRange * 0.75)}ft`], [1, `${this.puttRange}ft`]], rangeLabel: `Putter range ${this.puttRange} ft` });
    this.aim = angOf(dir.x, dir.z);
  }
  puttSpeedToReach(dir, d) {
    const h = this.hole, b = this.ball;
    let lo = 0.2, hi = 14;
    const flat = puttSpeedFor(d, h.greenRoll);
    for (let it = 0; it < 12; it++) {
      const v = it === 0 ? flat : (lo + hi) / 2;
      const sim = new BallSim(h, this.env, mulberry32(3));
      const oldPin = h.pinIn, cup = h.cup; h.pinIn = false;
      h.cup = { ...cup, x: 1e6, z: 1e6 }; // measure the roll with the hole covered
      sim.putt(b.p.slice(), [dir.x, 0, dir.z], v);
      let n = 0;
      while (sim.state === 'roll' && n++ < 3000) sim.step(1 / 120);
      h.pinIn = oldPin; h.cup = cup;
      const along = (sim.p[0] - b.p[0]) * dir.x + (sim.p[2] - b.p[2]) * dir.z;
      if (it === 0) { if (along < d && sim.state !== 'holed') lo = v; else hi = v; continue; }
      if (sim.state === 'holed' || along >= d) hi = v; else lo = v;
    }
    return (lo + hi) / 2;
  }

  // ------------------------------------------------------------------ previews
  updatePreview() {
    this.previewDirty = false;
    const h = this.hole, b = this.ball, w = this.world;
    const dir = dirOf(this.aim);
    if (this.club.putter) {
      w.reticle.visible = false;
      w.arc.visible = false;
      const frac = this.diff.putt;
      this.meter.configure({ marker: this.diff.marker ? this.puttEqFt / this.puttRange : null });
      if (frac <= 0) { w.puttLine.visible = false; return; }
      // read: roll the marker-speed putt along the current aim
      const v = puttSpeedFor(this.puttEqFt * FT, h.greenRoll);
      const sim = new BallSim(h, this.env, mulberry32(3));
      sim.putt(b.p.slice(), [dir.x, 0, dir.z], v);
      const pts = [b.p.slice()];
      let n = 0, dist = 0;
      const maxDist = Math.max(1.5, this.distToPin() * frac);
      while (sim.state === 'roll' && n++ < 3000) {
        const q = sim.p.slice();
        sim.step(1 / 120);
        dist += Math.hypot(sim.p[0] - q[0], sim.p[2] - q[2]);
        if (n % 2 === 0) pts.push(sim.p.slice());
        if (dist > maxDist) break;
      }
      pts.push(sim.p.slice());
      w.setPuttLine(pts);
      return;
    }
    w.puttLine.visible = false;
    const assist = this.diff;
    const out = this.simOutcome(this.club, this.aim, { power: 1, withWind: assist.wind, path: true, stopAtLand: !assist.roll });
    if (!out.land) return;
    const land = out.land;
    const n = h.normal(land[0], land[2]);
    w.reticle.position.set(land[0], h.height(land[0], land[2]) + 0.06, land[2]);
    w.reticle.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(...n));
    const carry = Math.hypot(land[0] - b.p[0], land[2] - b.p[2]);
    const sc = clamp(carry / 55, 0.6, 6);
    w.reticle.scale.setScalar(sc);
    w.reticle.visible = true;
    const arc = out.path.concat([land]);
    w.setArc(arc);
    w.arc.visible = this.settings.difficulty !== 'pro';
    this.previewLand = land;
    this.previewCarry = carry;
    this.previewRest = out.rest;
    // meter marker: power that carries the plays-like distance to the pin
    if (assist.marker) {
      const d = this.distToPin();
      const need = this.pl ? this.pl.plays : d;
      const flatCarry = this.club.carry || carry;
      let m = null;
      if (need < flatCarry * 1.12) m = this.powerForFinish(need);
      this.meter.configure({ marker: m });
    } else this.meter.configure({ marker: null });
    this.meter.configure({ labels: null, rangeLabel: `${this.club.name} · carry ${this.fmtDist(this.club.carry)}` });
  }

  // Like a real caddie: the number that matters is where the ball FINISHES. Start from the
  // plays-like carry, then bisect on full terrain sims so the release (bounce + roll) is included.
  powerForFinish(need) {
    const h = this.hole, b = this.ball;
    const p0 = this.powerForCarry(need);
    if (this.club.putter) return p0;
    const dir = dirOf(this.aim);
    const toCup = (h.cup.x - b.p[0]) * dir.x + (h.cup.z - b.p[2]) * dir.z;
    const along = (pw) => {
      const o = this.simOutcome(this.club, this.aim, { power: pw, withWind: true, dt: 1 / 90 });
      return (o.rest[0] - b.p[0]) * dir.x + (o.rest[2] - b.p[2]) * dir.z - toCup;
    };
    const a0 = along(p0);
    if (Math.abs(a0) <= 1.5) return p0;
    // released past the pin → less power; spun back short → more power (capped at a full swing)
    let lo = a0 > 0 ? Math.max(0.1, p0 - 0.35) : p0, hi = a0 > 0 ? p0 : Math.min(1, p0 + 0.2);
    if (a0 > 0 && along(lo) > 0) return lo;
    if (a0 < 0 && along(hi) < 0) return hi;
    for (let i = 0; i < 8; i++) {
      const m = (lo + hi) / 2;
      if (along(m) > 0.3) hi = m; else lo = m;
    }
    return (lo + hi) / 2;
  }

  powerForCarry(need) {
    const club = this.club;
    let lo = 0.1, hi = 1.1;
    for (let i = 0; i < 12; i++) {
      const p = (lo + hi) / 2;
      const ld = computeLaunch(club, { power: p, face: 0, path: 0, strike: 1, traj: this.traj, lie: this.lieKey() });
      const c = simulateCarry(ld, { rho: this.env.rho, wind: [0, 0, 0] }, { fwd: [0, 0, -1], dt: 1 / 120 }).carry;
      if (c < need) lo = p; else hi = p;
    }
    return (lo + hi) / 2;
  }

  // ------------------------------------------------------------------ swing
  beginSwing() {
    if (this.state !== 'address') return;
    this.state = 'swing';
    this.audio.ui('tick');
    this.analysis = null;
  }

  meterDone(r) {
    const putt = !!this.club.putter;
    const { face, strike } = meterToStrike(r.error, r.zone * this.lieZone(), putt);
    this.executeSwing({ power: r.power, face, path: 0, strike });
  }
  lieZone() {
    const k = { tee: 1, fairway: 1, green: 1, fringe: 1, cut: 0.95, second: 0.85, rough: 0.75, deep: 0.55, bunker: 0.8, splash: 0.85, straw: 0.8, waste: 0.85, path: 0.9 }[this.lieKey()] ?? 0.8;
    const sl = this.slope();
    return k * clamp(1 - (Math.abs(sl.side) + Math.abs(sl.up) * 0.5) * 0.025, 0.6, 1);
  }

  executeSwing(sw) {
    this.state = 'backswing';
    this.pendingSwing = sw;
    this.golfer.startSwing(this.club.putter ? sw.power : clamp(sw.power, 0.35, 1.05), () => this.impact());
    if (this.settings.control === 'mouse') { this.golfer.phase = 'down'; this.golfer.t = 0; }
    this.world.reticle.visible = false;
    this.world.arc.visible = false;
    this.world.puttLine.visible = false;
    this.ui.caddie('');
  }

  impact() {
    const sw = this.pendingSwing;
    const h = this.hole, b = this.ball;
    const dir = dirOf(this.aim);
    const seed = (Math.random() * 1e9) | 0;
    const sim = new BallSim(h, this.env, mulberry32(seed));
    const start = [b.p[0], b.p[1] + (this.ballLift || 0), b.p[2]];
    this.shotStart = { p: b.p.slice(), surface: b.surface, isTee: b.isTee, yards: this.distToPin() / YD, lie: this.lieKey(), dist: this.distToPin(), aim: this.aim, pl: this.pl, club: this.club, strokesBefore: this.strokes };
    this.lastSpot = b.p.slice();
    this.tee.visible = false;
    if (this.club.putter) {
      const speed = puttSpeedFor(sw.power * this.puttRange * FT, h.greenRoll) * (0.97 + 0.03 * sw.strike);
      const a = this.aim + sw.face * DEG;
      const d2 = dirOf(a);
      sim.putt(start, [d2.x, 0, d2.z], speed);
      this.shotLD = { putt: true, speed, face: sw.face, power: sw.power };
      this.audio.hit('putt', sw.strike, sw.power);
    } else {
      const sh = SHAPES[this.shape];
      const lie = this.lieKey();
      const ld = computeLaunch(this.club, { power: sw.power, face: sw.face + sh.face, path: sw.path + sh.path, strike: sw.strike, traj: this.traj, lie, slope: this.slope(), rng: mulberry32(seed + 1) });
      sim.launch(start, ld, [dir.x, 0, dir.z]);
      this.shotLD = ld;
      const kind = lie === 'splash' || lie === 'bunker' ? 'sand' : this.club.key === 'DR' ? 'driver' : this.club.loft <= 20 ? 'wood' : this.club.loft >= 45 ? 'wedge' : 'iron';
      this.audio.hit(kind, sw.strike, sw.power);
    }
    // forecast (identical sim run to completion) for the broadcast camera
    const fc = new BallSim(h, this.env, mulberry32(seed));
    if (this.club.putter) fc.putt(start, sim.v.map((x) => x / (Math.hypot(...sim.v) || 1)), Math.hypot(...sim.v));
    else { fc.launch(start, this.shotLD, [dir.x, 0, dir.z]); }
    let n = 0;
    while (fc.state !== 'rest' && fc.state !== 'holed' && n++ < 20000) fc.step(1 / 240);
    this.forecast = { land: fc.landed, rest: fc.p.slice(), t: fc.t, landT: fc.events.find((e) => e.type === 'land')?.t ?? 0 };
    this.sim = sim;
    this.evIdx = 0;
    this.strokes++;
    this.state = 'flight';
    this.flightT = 0;
    this.landV = null;
    this.world.tracer.visible = this.settings.tracer && !this.club.putter;
    this.meter.hide();
    this.ballShadow.visible = !this.club.putter;
    this.flightCamMode = 'behind';
    this.ui.showShotPanel(null);
  }

  // ------------------------------------------------------------------ flight
  updateFlight(dt) {
    const sim = this.sim;
    const fast = this.keys[' '] || this.keys['f'] ? 3 : 1;
    const steps = Math.max(1, Math.round(dt * 240 * fast));
    for (let i = 0; i < steps; i++) {
      if (sim.state === 'rest' || sim.state === 'holed') break;
      const v = sim.v.slice();
      sim.step(1 / 240);
      if (!this.landV && sim.landed) this.landV = v;
    }
    this.flightT += dt * fast;
    // events
    while (this.evIdx < sim.events.length) this.onEvent(sim.events[this.evIdx++]);
    // visuals
    const p = sim.p;
    this.ballMesh.position.set(p[0], p[1], p[2]);
    const gh = this.hole.height(p[0], p[2]);
    this.ballShadow.position.set(p[0], gh + 0.02, p[2]);
    this.ballShadow.material.opacity = clamp(0.4 - (p[1] - gh) * 0.004, 0.08, 0.4);
    const sc = clamp(1 + (p[1] - gh) * 0.03, 1, 4);
    this.ballShadow.scale.setScalar(sc);
    if (this.world.tracer.visible) this.world.setTracer(sim.trail.concat([p]));
    this.updateFlightCamera(dt);
    if (sim.state === 'rest' || sim.state === 'holed') {
      if (!this.restT) this.restT = 0;
      this.restT += dt;
      if (this.restT > (sim.state === 'holed' ? 0.2 : 0.6)) { this.restT = 0; this.onBallStop(); }
    }
  }

  onEvent(e) {
    const a = this.audio;
    if (e.type === 'land') {
      a.land(e.surface, e.speed);
      if (!this.club.putter) this.ui.toast(SURFACES[e.surface]?.name || e.surface, 'land');
    } else if (e.type === 'bounce') { if (e.speed > 3) a.land(e.surface, e.speed * 0.6); }
    else if (e.type === 'tree') { a.tree(); this.ui.toast(e.kind === 'trunk' ? 'Hit the trunk!' : 'Into the branches', 'bad'); }
    else if (e.type === 'pin') { a.pin(); this.ui.toast('Off the flagstick!', 'good'); }
    else if (e.type === 'lip') { a.groan(); this.ui.toast('Lipped out!', 'bad'); }
    else if (e.type === 'holed') { a.cup(); }
    else if (e.type === 'water') { a.splash(1); a.groan(); }
    else if (e.type === 'ob') { a.groan(); }
  }

  updateFlightCamera(dt) {
    const sim = this.sim, p = sim.p;
    const b0 = this.shotStart.p;
    const dir = dirOf(this.shotStart.aim);
    const cam = this.cam;
    const h = this.hole;
    const putt = this.club.putter;
    const fc = this.forecast;
    const totalD = Math.hypot(fc.rest[0] - b0[0], fc.rest[2] - b0[2]);
    const pv = new THREE.Vector3(p[0], p[1], p[2]);
    if (putt || totalD < 45) {
      // low follow camera
      const back = putt ? 3.2 : 8;
      cam.tPos.set(b0[0] - dir.x * back + (p[0] - b0[0]) * 0.55, Math.max(p[1], h.height(p[0], p[2])) + (putt ? 1.3 : 3), b0[2] - dir.z * back + (p[2] - b0[2]) * 0.55);
      cam.tLook.copy(pv);
      cam.k = 3;
      return;
    }
    const t = this.flightT;
    const toLand = fc.landT - sim.t;
    if (this.flightCamMode === 'behind' && t > 0.5) this.flightCamMode = 'chase';
    if (this.flightCamMode === 'chase' && sim.state === 'flight' && toLand < 2.0 && fc.land) {
      this.flightCamMode = 'landing';
      // broadcast camera near the landing area, off to the side
      const L = fc.land, R = fc.rest;
      const side = dir.x * (R[2] - b0[2]) - dir.z * (R[0] - b0[0]) > 0 ? -1 : 1;
      const r = { x: -dir.z * side, z: dir.x * side };
      const cx = L[0] + r.x * 26 + dir.x * 18, cz = L[2] + r.z * 26 + dir.z * 18;
      this.landCam = new THREE.Vector3(cx, Math.max(h.height(cx, cz), L[1]) + 7, cz);
    }
    if (this.flightCamMode === 'behind') {
      cam.tPos.set(b0[0] - dir.x * 7, b0[1] + 2.4, b0[2] - dir.z * 7);
      cam.tLook.copy(pv);
      cam.k = 4;
    } else if (this.flightCamMode === 'chase') {
      const hv = Math.hypot(sim.v[0], sim.v[2]) || 1;
      const fx = sim.state === 'flight' ? sim.v[0] / hv : dir.x, fz = sim.state === 'flight' ? sim.v[2] / hv : dir.z;
      cam.tPos.set(p[0] - fx * 22, Math.max(p[1] + 5, h.height(p[0] - fx * 22, p[2] - fz * 22) + 3), p[2] - fz * 22);
      cam.tLook.copy(pv);
      cam.k = 2.2;
    } else {
      cam.tPos.copy(this.landCam);
      cam.tLook.copy(pv);
      cam.k = 1.6;
    }
  }

  // ------------------------------------------------------------------ shot result
  onBallStop() {
    const sim = this.sim, h = this.hole;
    const S = this.shotStart;
    const ev = sim.events.map((e) => e.type);
    const putt = !!this.club.putter;
    let result = 'ok';
    if (sim.state === 'holed') result = 'holed';
    else if (ev.includes('water')) result = 'water';
    else if (ev.includes('ob')) result = 'ob';
    const p = sim.p;
    const cup = h.cup;
    const dir = dirOf(S.aim);
    const info = {
      putt, club: this.club, ld: this.shotLD, result, lie: S.lie, isTee: S.isTee, par: h.par,
      carryYd: sim.landed ? Math.hypot(sim.landed[0] - S.p[0], sim.landed[2] - S.p[2]) / YD : 0,
      totalYd: Math.hypot(p[0] - S.p[0], p[2] - S.p[2]) / YD,
      offlineYd: ((p[0] - S.p[0]) * -dir.z + (p[2] - S.p[2]) * dir.x) / YD,
      apexFt: (sim.apex - S.p[1]) / FT,
      descent: this.landV ? Math.atan2(-this.landV[1], Math.hypot(this.landV[0], this.landV[2])) / DEG : null,
      stimp: h.stimp,
    };

    // distance to pin relative to shot line
    const toCup = { x: cup.x - S.p[0], z: cup.z - S.p[2] };
    const dC = Math.hypot(toCup.x, toCup.z) || 1;
    const along = ((p[0] - S.p[0]) * toCup.x + (p[2] - S.p[2]) * toCup.z) / dC;
    info.shortYd = (dC - along) / YD; info.longYd = (along - dC) / YD;
    info.approach = !putt && S.dist / YD > 40 && S.dist / YD < 240 && !(S.isTee && h.par > 3);
    if (S.pl && info.approach) { info.windAdj = S.pl.windAdj / YD; info.elevAdj = S.pl.elevAdj / YD; info.elevFt = (h.height(cup.x, cup.z) - S.p[1]) / FT; }
    if (putt) {
      info.startFt = S.dist / FT;
      info.afterFt = Math.hypot(cup.x - p[0], cup.z - p[2]) / FT;
      info.shortFt = (dC - along) / FT;
      const lat = ((p[0] - S.p[0]) * -toCup.z + (p[2] - S.p[2]) * toCup.x) / dC;
      info.lateralFt = lat / FT;
      // was the miss on the low side? compare with the slope direction at the cup
      const n = h.normal(cup.x, cup.z);
      const downhillLat = (n[0] * -toCup.z + n[2] * toCup.x) / dC; // + when the slope falls to the right
      info.missLow = Math.sign(lat) === Math.sign(downhillLat) && Math.abs(downhillLat) > 0.004;
      info.holed = result === 'holed';
      info.uphillIn = this.puttElevIn;
    }

    // outcome → stats, next ball position
    let after, penalty = 0;
    if (result === 'holed') {
      after = { surface: 'green', yards: 0 };
    } else if (result === 'water') {
      penalty = 1;
      this.pendingWater = { entry: this.findEntry(sim), info };
      info.after = 'water';
    } else if (result === 'ob') {
      penalty = 1;
      after = { surface: S.isTee ? 'fairway' : S.surface, yards: S.yards };
      this.ball = { p: S.p.slice(), surface: S.surface, isTee: S.isTee };
    } else {
      const surf = h.surface(p[0], p[2]);
      this.ball = { p: p.slice(), surface: surf, isTee: false };
      after = { surface: surf, yards: this.distToPin() / YD };
      info.after = surf;
      info.onGreen = surf === 'green';
    }
    this.lastInfo = info;
    if (result === 'water') {
      // stats recorded after the drop is chosen
      this.showResult(info, null);
      this.state = 'result';
      this.resultNext = 'water';
      return;
    }
    if (penalty) { this.strokes += penalty; this.penalties += penalty; this.holeStats.penalties += penalty; }
    const sg = this.round.stats.recordShot({ surface: S.isTee ? 'tee' : S.surface, yards: S.yards, isTee: S.isTee }, after, result === 'holed', penalty);
    this.trackFirGir(info, S);
    this.showResult(info, sg);
    this.state = 'result';
    this.resultNext = result === 'holed' ? 'holed' : 'next';
    if (result === 'holed') this.onHoled();
    else if (!putt && info.onGreen && this.distToPin() < 3) this.audio.crowd(0.6);
    else if (!putt && info.onGreen) this.audio.crowd(0.25, 1.6);
  }

  trackFirGir(info, S) {
    const h = this.hole, st = this.holeStats;
    if (S.isTee && h.par >= 4) st.fir = info.after === 'fairway';
    if ((info.after === 'green' || info.result === 'holed') && this.strokes <= h.par - 2) st.gir = true;
  }

  // point where the ball last crossed into the penalty area (projected path)
  findEntry(sim) {
    const h = this.hole;
    const tr = sim.trail.concat([sim.p]);
    for (let i = tr.length - 1; i > 0; i--) {
      const a = tr[i - 1];
      if (h.surface(a[0], a[2]) !== 'water') {
        let lo = a, hi = tr[i];
        for (let k = 0; k < 12; k++) {
          const m = [(lo[0] + hi[0]) / 2, 0, (lo[2] + hi[2]) / 2];
          if (h.surface(m[0], m[2]) === 'water') hi = m; else lo = m;
        }
        return { x: lo[0], z: lo[2] };
      }
    }
    return { x: this.shotStart.p[0], z: this.shotStart.p[2] };
  }

  reliefOptions() {
    const h = this.hole, e = this.pendingWater.entry, cup = h.cup;
    const S = this.shotStart;
    const dryOK = (x, z, margin = 1) => { const s = h.surface(x, z); return s !== 'water' && s !== 'ob' && h.waterSdf(x, z).d > margin && s !== 'green'; };
    const opts = [];
    opts.push({ id: 'replay', title: 'Stroke and distance', desc: 'Replay from where you last played.', p: S.p.slice(), surface: S.surface, isTee: S.isTee });
    // back on the line
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
    for (let r = 0.5; r <= 12 && !best; r += 0.5) {
      for (let a = 0; a < 32; a++) {
        const x = e.x + Math.cos((a / 32) * Math.PI * 2) * r, z = e.z + Math.sin((a / 32) * Math.PI * 2) * r;
        if (Math.hypot(x - cup.x, z - cup.z) < eD) continue;
        if (!dryOK(x, z, 0.6) || !h.inBounds(x, z)) continue;
        const d = Math.hypot(x - cup.x, z - cup.z);
        if (!best || d < best.d) best = { x, z, d };
      }
      if (r >= 2.2 && best) break;
    }
    if (best) opts.push({ id: 'lateral', title: 'Lateral relief', desc: 'Drop within two club-lengths of where the ball crossed the edge, no nearer the hole.', p: [best.x, 0, best.z] });
    for (const o of opts) {
      o.p[1] = h.height(o.p[0], o.p[2]) + BALL.radius;
      o.dist = Math.hypot(cup.x - o.p[0], cup.z - o.p[2]);
      o.surface = o.surface || h.surface(o.p[0], o.p[2]);
      o.es = expectedStrokes(o.isTee ? 'tee' : o.surface, o.dist / YD, !!o.isTee);
    }
    return opts;
  }

  chooseRelief(o) {
    const S = this.shotStart;
    this.strokes += 1; this.penalties += 1; this.holeStats.penalties += 1;
    this.round.stats.recordShot({ surface: S.isTee ? 'tee' : S.surface, yards: S.yards, isTee: S.isTee }, { surface: o.surface, yards: o.dist / YD }, false, 1);
    this.ball = { p: o.p.slice(), surface: o.surface, isTee: !!o.isTee };
    this.pendingWater = null;
    this.ui.relief(null);
    this.nextShot();
  }

  showResult(info, sg) {
    this.ui.showShotPanel({ info, sg, fmt: (m) => this.fmtDist(m), tips: coachShot(info) });
    let banner = '';
    if (info.result === 'water') banner = 'Penalty area';
    else if (info.result === 'ob') banner = 'Out of bounds';
    if (banner) this.ui.banner(banner, 'bad');
    this.updateHUD(true);
  }

  continueAfterResult() {
    if (this.state !== 'result') return;
    if (this.resultNext === 'water') {
      this.state = 'relief';
      this.ui.showShotPanel(null);
      this.ui.relief(this.reliefOptions(), (o) => this.chooseRelief(o), (m) => this.fmtDist(m));
      return;
    }
    if (this.resultNext === 'holed') { this.finishHole(); return; }
    this.nextShot();
  }

  nextShot() {
    this.ui.showShotPanel(null);
    if (this.strokes >= 12) { this.ui.toast('Picked up (maximum 12)', 'bad'); this.finishHole(); return; }
    this.prepareAddress();
    this.enterAddress();
    // place the camera right away behind the ball
    this.snapAddressCamera();
  }

  onHoled() {
    const h = this.hole;
    const name = scoreName(this.strokes, h.par);
    const d = this.strokes - h.par;
    this.ui.banner(name, d < 0 ? 'great' : d === 0 ? 'good' : 'bad');
    this.audio.crowd(d < 0 ? 1 : d === 0 ? 0.55 : 0.2, d < 0 ? 4 : 2.5);
  }

  finishHole() {
    const r = this.round;
    const st = r.stats.finishHole(this.strokes);
    r.scores.push({ number: this.hole.number, par: this.hole.par, strokes: this.strokes });
    this.state = 'scorecard';
    this.ui.showShotPanel(null);
    const last = r.i >= r.holes.length - 1;
    this.ui.scorecard(this.course, r, true, () => {
      if (last) this.endRound();
      else { r.i++; this.loadHole(); }
    }, last ? 'Finish round' : 'Next hole');
    void st;
  }

  endRound() {
    const r = this.round;
    const t = r.stats.totals();
    // best score per course/mode
    let best = null;
    try {
      const key = `psg-best-${this.course.id}-${r.mode}`;
      best = JSON.parse(localStorage.getItem(key) || 'null');
      if (r.holes.length === (r.mode === '18' ? 18 : r.mode === 'front' || r.mode === 'back' ? 9 : 1) && (!best || t.strokes - t.par < best.toPar)) {
        localStorage.setItem(key, JSON.stringify({ toPar: t.strokes - t.par, strokes: t.strokes, date: new Date().toISOString().slice(0, 10) }));
      }
    } catch (e) { /* ignore */ }
    this.state = 'summary';
    this.ui.summary(this.course, r, t, best, this.settings);
  }

  quitToMenu() {
    this.ui.showHUD(false);
    document.body.classList.remove('flyover');
    this.meter.hide();
    this.mouseSwing.enabled = false; this.mouseSwing.draw();
    this.showcase(this.course?.id || 'augusta');
    this.ui.mainMenu();
  }

  // ------------------------------------------------------------------ camera
  addressCamera() {
    const b = this.ball, h = this.hole;
    const putt = this.club.putter;
    const a = this.aim + this.orbit.yaw;
    const f = dirOf(a);
    const z = this.orbit.zoom;
    const back = (putt ? 3.3 : 3.9) * z, up = (putt ? 1.35 : 1.35) * z + this.orbit.pitch * 4;
    const side = putt ? 0.55 : 0.3; // shift right of the line, away from the golfer
    const px = b.p[0] - f.x * back - f.z * side, pz = b.p[2] - f.z * back + f.x * side;
    const py = Math.max(h.height(px, pz) + 0.6, b.p[1] + up);
    // tilt the view so the ball sits ~11° below the screen centre (above the swing meter)
    const dep = Math.atan2(py - b.p[1], back) - 11.5 * DEG;
    const lx = px + f.x * 20 * Math.cos(dep), lz = pz + f.z * 20 * Math.cos(dep);
    const ly = py - 20 * Math.sin(dep);
    return { pos: new THREE.Vector3(px, py, pz), look: new THREE.Vector3(lx, ly, lz) };
  }
  snapAddressCamera() {
    const c = this.addressCamera();
    this.cam.tPos.copy(c.pos); this.cam.tLook.copy(c.look);
  }
  targetCamera() {
    const land = this.club.putter ? [this.hole.cup.x, 0, this.hole.cup.z] : (this.previewLand || this.ball.p);
    const f = dirOf(this.aim);
    const h = this.hole;
    const y = h.height(land[0], land[2]);
    return { pos: new THREE.Vector3(land[0] - f.x * 30, y + 70, land[2] - f.z * 30), look: new THREE.Vector3(land[0], y, land[2]) };
  }

  updateCamera(dt) {
    const c = this.cam;
    if (this.state === 'address' || this.state === 'swing' || this.state === 'backswing') {
      const t = this.targetView ? this.targetCamera() : this.addressCamera();
      c.tPos.copy(t.pos); c.tLook.copy(t.look); c.k = this.targetView ? 3 : 5;
    } else if (this.state === 'menu') {
      this.showcaseT += dt;
      const h = this.hole;
      if (h) {
        const a = this.showcaseT * 0.06;
        const cx = h.gf.x, cz = h.gf.z;
        const R = 95;
        c.tPos.set(cx + Math.sin(a) * R, h.height(cx, cz) + 32, cz + Math.cos(a) * R);
        c.tLook.set(cx, h.height(cx, cz) + 2, cz);
        c.k = 1;
        if (!this.menuInit) { c.pos.copy(c.tPos); c.look.copy(c.tLook); this.menuInit = true; }
      }
    }
    const k = 1 - Math.exp(-c.k * dt);
    c.pos.lerp(c.tPos, k);
    c.look.lerp(c.tLook, k);
    // keep the camera above the ground
    if (this.hole) {
      const gh = this.hole.height(c.pos.x, c.pos.z);
      if (c.pos.y < gh + 0.5) c.pos.y = gh + 0.5;
    }
    this.camera.position.copy(c.pos);
    this.camera.lookAt(c.look);
  }

  // ------------------------------------------------------------------ input
  bindInput() {
    addEventListener('keydown', (e) => {
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT')) return;
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (this.keys[k] && k !== ' ') { /* repeat */ }
      this.keys[k] = true;
      this.onKey(k, e);
      if ([' ', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(e.key)) e.preventDefault();
    });
    addEventListener('keyup', (e) => {
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      this.keys[k] = false;
      if (k === 'Tab' && this.state !== 'scorecard' && this.round) this.ui.scorecard(null);
    });
    const cv = $('c');
    const ov = $('swingOverlay');
    const onDown = (e) => {
      this.audio.init();
      if (e.button === 2) { this.drag = { x: e.clientX, y: e.clientY, yaw: this.orbit.yaw, pitch: this.orbit.pitch }; return; }
      if (e.button !== 0) return;
      if (this.state === 'flyover') { this.endFlyover(); return; }
      if (this.state === 'result') { this.continueAfterResult(); return; }
      if (this.targetView && this.state === 'address') { this.aimAtScreen(e.clientX, e.clientY); return; }
      if (this.settings.control === 'mouse' && this.state === 'address') {
        if (this.mouseSwing.down(e)) { this.state = 'swing'; this.analysis = null; }
        return;
      }
      if (this.state === 'address' || this.state === 'swing') this.meterClick();
    };
    ov.addEventListener('pointerdown', onDown);
    cv.addEventListener('pointerdown', onDown);
    addEventListener('pointermove', (e) => {
      if (this.drag) {
        this.orbit.yaw = this.drag.yaw - (e.clientX - this.drag.x) * 0.005;
        this.orbit.pitch = clamp(this.drag.pitch - (e.clientY - this.drag.y) * 0.004, -0.3, 2.5);
      }
      if (this.mouseSwing.active) this.mouseSwing.move(e);
    });
    addEventListener('pointerup', (e) => {
      if (e.button === 2) { this.drag = null; return; }
      if (this.mouseSwing.active) this.mouseSwing.up(e);
    });
    addEventListener('contextmenu', (e) => e.preventDefault());
    addEventListener('wheel', (e) => {
      if (this.state === 'address') this.orbit.zoom = clamp(this.orbit.zoom * (e.deltaY > 0 ? 1.1 : 0.9), 0.5, 4);
    }, { passive: true });

    this.meter.onDone = (r) => this.meterDone(r);
    this.meter.onCancel = () => { if (this.state === 'swing') this.state = 'address'; };
    this.mouseSwing.onBack = (b) => { this.golfer.phase = 'manual'; this.golfer.apply(-b); };
    this.mouseSwing.onDone = (r) => this.executeSwing(r);
    this.mouseSwing.onCancel = () => { this.golfer.phase = 'idle'; if (this.state === 'swing') this.state = 'address'; };
  }

  meterClick() {
    if (this.state !== 'address' && this.state !== 'swing') return;
    if (this.settings.control === 'mouse') return;
    if (this.state === 'address') this.beginSwing();
    const r = this.meter.click();
    if (r === 'power') this.audio.ui('set');
  }

  onKey(k, e) {
    const st = this.state;
    if (k === 'Escape') { if (this.round && st !== 'menu' && st !== 'summary') this.ui.togglePause(); return; }
    if (this.ui.paused) return;
    if (k === 'm') { this.audio.enabled = !this.audio.enabled; this.ui.toast(this.audio.enabled ? 'Sound on' : 'Sound off'); return; }
    if (k === 'Tab' && this.round && st !== 'scorecard' && st !== 'summary' && st !== 'menu') { this.ui.scorecard(this.course, this.round, false); return; }
    if (st === 'flyover' && (k === ' ' || k === 'Enter')) { this.endFlyover(); return; }
    if (st === 'result' && (k === ' ' || k === 'Enter')) { this.continueAfterResult(); return; }
    if (st === 'swing' && k === ' ' && !e.repeat) { this.meterClick(); return; }
    if (st !== 'address') return;
    if (k === ' ' && !e.repeat) { if (this.settings.control === 'meter') this.meterClick(); else this.ui.toast('Mouse swing: hold the left button, pull back, push through'); return; }
    if (k === 'ArrowUp' || k === 'w') this.setClub(this.clubIdx - 1, true);
    else if (k === 'ArrowDown' || k === 's') this.setClub(this.clubIdx + 1, true);
    else if (k === 'q') this.cycleShape(-1);
    else if (k === 'e') this.cycleShape(1);
    else if (k === 'r') this.setTraj(this.traj + 1);
    else if (k === 'f') this.setTraj(this.traj - 1);
    else if (k === 'v') { this.targetView = !this.targetView; this.ui.toast(this.targetView ? 'Target view – click the ground to aim' : 'Address view'); }
    else if (k === 'g') { this.gridOn = !this.world.gridGroup?.visible; this.world.showGreenGrid(this.gridOn); }
    else if (k === 'c') { this.caddieNote(); }
    else if (k === 'p') { this.aim = angOf(this.hole.cup.x - this.ball.p[0], this.hole.cup.z - this.ball.p[2]); this.placeGolfer(); this.previewDirty = true; }
    this.updateHUD(true);
  }

  cycleShape(d) {
    const order = ['draw', 'straight', 'fade'];
    const i = clamp(order.indexOf(this.shape) + d, 0, 2);
    this.shape = order[i];
    this.previewDirty = true;
    this.audio.ui('tick');
  }
  setTraj(t) {
    this.traj = clamp(t, -1, 1);
    this.previewDirty = true;
    this.audio.ui('tick');
  }

  aimAtScreen(x, y) {
    const ndc = new THREE.Vector2((x / innerWidth) * 2 - 1, -(y / innerHeight) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster.intersectObject(this.world.terrain, false)[0];
    if (!hit) return;
    this.aim = angOf(hit.point.x - this.ball.p[0], hit.point.z - this.ball.p[2]);
    this.placeGolfer();
    this.previewDirty = true;
    this.audio.ui('tick');
  }
  aimAtWorld(x, z) {
    if (this.state !== 'address') return;
    this.aim = angOf(x - this.ball.p[0], z - this.ball.p[2]);
    this.placeGolfer();
    this.previewDirty = true;
  }

  handleHeldKeys(dt) {
    if (this.state !== 'address') return;
    const fine = this.keys['Shift'];
    const rate = (this.club.putter ? 4 : 14) * (fine ? 0.2 : 1) * DEG;
    let d = 0;
    if (this.keys['ArrowLeft'] || this.keys['a']) d -= 1;
    if (this.keys['ArrowRight'] || this.keys['d']) d += 1;
    if (d) {
      this.aimHold = (this.aimHold || 0) + dt;
      this.aim += d * rate * dt * (1 + Math.min(2, this.aimHold));
      this.placeGolfer();
      this.previewDirty = true;
    } else this.aimHold = 0;
  }

  // ------------------------------------------------------------------ HUD
  fmtDist(m) {
    if (this.settings.units === 'm') return `${Math.round(m)} m`;
    return `${Math.round(m / YD)} yds`;
  }
  windText() {
    return `${Math.round(this.windMph)} mph`;
  }
  windRel() {
    // wind relative to the aim line: + = helping (downwind), side + = left-to-right
    const a = this.windAng - this.aim;
    return { along: Math.cos(a) * this.windMph, side: Math.sin(a) * this.windMph, ang: a };
  }

  updateHUD(force) {
    if (!this.round || !this.hole || !this.club) return;
    const h = this.hole, b = this.ball;
    const toPar = this.round.scores.reduce((s, x) => s + x.strokes - x.par, 0);
    const d = this.distToPin();
    const lk = this.lieKey();
    const lie = LIES[lk] || LIES.rough;
    const sl = this.slope();
    this.ui.hud({
      hole: h.number, name: h.name, par: h.par, yards: this.course.holes[h.index].yds,
      shot: this.strokes + 1, toPar, holeToPar: null,
      dist: this.onGreen || this.club.putter ? `${(d / FT).toFixed(d / FT < 10 ? 1 : 0)} ft` : this.fmtDist(d),
      plays: this.pl && !this.club.putter ? this.fmtDist(this.pl.plays) : null,
      elev: (h.height(h.cup.x, h.cup.z) - (b.p[1] - BALL.radius)) / FT,
      puttEq: this.club.putter ? this.puttEqFt : null,
      wind: this.windRel(), windMph: this.windMph,
      club: this.club, clubCarry: this.club.putter ? `${this.puttRange} ft range` : `Carry ${this.fmtDist(this.club.carry)} · Total ${this.fmtDist(this.club.total)}`,
      lie: SURFACES[b.isTee ? 'tee' : b.surface]?.name || b.surface, lieKey: lk, lieRange: lk === 'splash' ? 'Explosion shot' : `${lie.dist[0]}–${lie.dist[1]}%`, slope: sl,
      shape: SHAPES[this.shape].name, traj: TRAJ[this.traj], putter: !!this.club.putter,
      stimp: h.stimp,
      state: this.state,
    });
    if (force) this.ui.minimap(this);
  }

  // ------------------------------------------------------------------ main loop
  loop(t) {
    requestAnimationFrame((tt) => this.loop(tt));
    const dt = Math.min(0.05, (t - this.last) / 1000);
    this.last = t;
    this.frame(dt);
  }

  // advance the simulation n frames without requestAnimationFrame (testing/debugging)
  debugStep(n = 1, dt = 1 / 60) { for (let i = 0; i < n; i++) this.frame(dt); }

  frame(dt) {
    const st = this.state;
    if (!this.ui.paused) {
      if (st === 'flyover') this.updateFlyover(dt);
      else if (st === 'address') {
        this.handleHeldKeys(dt);
        if (this.analysis) this.stepCaddieAnalysis();
        if (this.previewDirty) { this.previewT = (this.previewT || 0) + dt; if (this.previewT > 0.06) { this.previewT = 0; this.updatePreview(); this.updateHUD(true); } }
        this.caddieTick = (this.caddieTick || 0) + dt;
        if (this.caddieTick > 0.5) { this.caddieTick = 0; this.caddieNote(); }
      } else if (st === 'swing') {
        this.meter.update(dt);
      } else if (st === 'flight') this.updateFlight(dt);
      if (st === 'backswing' || st === 'flight' || st === 'result' || st === 'address' || st === 'swing' || st === 'flyover') this.golfer.update(dt);
      if (st === 'flight' || st === 'result' || st === 'holed') { /* camera handled in flight */ }
      if (st !== 'flight' && st !== 'result' && st !== 'relief' && st !== 'scorecard') this.updateCamera(dt);
      else {
        const c = this.cam; const k = 1 - Math.exp(-c.k * dt);
        c.pos.lerp(c.tPos, k); c.look.lerp(c.tLook, k);
        if (this.hole) { const gh = this.hole.height(c.pos.x, c.pos.z); if (c.pos.y < gh + 0.5) c.pos.y = gh + 0.5; }
        this.camera.position.copy(c.pos); this.camera.lookAt(c.look);
      }
      if (st === 'address' && this.meter.state !== 'hidden') this.meter.draw();
    }
    // ball visibility scale with distance
    const dCam = this.camera.position.distanceTo(this.ballMesh.position);
    this.ballMesh.scale.setScalar(clamp(dCam / 7, 1.3, 14));
    if (this.hole) this.world.update(dt, this.env ? this.env.wind : [0, 0, 0], this.ballMesh.visible ? this.ballMesh.position : this.cam.look);
    this.hudTimer += dt;
    if (this.hudTimer > 0.25 && (st === 'address' || st === 'flight')) { this.hudTimer = 0; this.updateHUD(st === 'flight'); }
    this.renderer.render(this.scene, this.camera);
  }
}
