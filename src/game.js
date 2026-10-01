// Core game: round flow and the shot state machine.
//   caddie.js – club choice, plays-like numbers, putt reads
//   camera.js – flyover / address / flight / replay cameras
//   input.js  – keyboard, mouse, touch and gamepad → named actions
//   rules.js  – penalty-area relief
//   round.js  – modes, seeds, daily challenge, challenge links
// States: menu → flyover → address → swing → backswing → flight → result
//         (→ replay | relief) → … → scorecard → summary
import * as THREE from 'three';
import { World } from './world.js';
import { Golfer } from './golfer.js';
import { BallSim, computeLaunch, LIES, SURFACES, puttSpeedFor, BALL } from './physics.js';
import { buildBag } from './clubs.js';
import { YD, FT, mulberry32 } from './hole.js';
import { RoundStats, scoreName } from './stats.js';
import { SwingMeter, MouseSwing, meterToStrike } from './meter.js';
import { SoundEngine } from './audio.js';
import { coachShot, resetCoach } from './coach.js';
import { COURSES, courseById } from './courses/index.js';
import { DIFFICULTY, SHAPES, TRAJ, MAX_STROKES } from './config.js';
import { clamp, DEG, MPH, dirOf, angOf } from './util.js';
import { Caddie } from './caddie.js';
import { CameraDirector } from './camera.js';
import { Input } from './input.js';
import { findEntry, reliefOptions } from './rules.js';
import { loadHistory, saveRound, roundEntry, bestFor } from './history.js';
import { MODES, SIGNATURE, seedFrom } from './round.js';

const $ = (id) => document.getElementById(id);
const STEP = 1 / 240; // physics step during play

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
    // faint tracers of earlier attempts (closest-to-pin / long drive)
    this.ghosts = new THREE.Group();
    this.scene.add(this.ghosts);

    this.settings = this.loadSettings();
    this.audio = new SoundEngine();
    this.meter = new SwingMeter($('meter'));
    this.mouseSwing = new MouseSwing($('swingOverlay'));
    this.mouseSwing.resize();
    this.meter.onDone = (r) => this.meterDone(r);
    this.meter.onCancel = () => { if (this.state === 'swing') this.state = 'address'; };
    this.meter.onAuto = () => this.audio.ui('set');
    this.mouseSwing.onBack = (b) => { this.golfer.phase = 'manual'; this.golfer.apply(-b); };
    this.mouseSwing.onDone = (r) => this.executeSwing(r);
    this.mouseSwing.onCancel = () => { this.golfer.phase = 'idle'; if (this.state === 'swing') this.state = 'address'; };

    this.cam = new CameraDirector(this, this.camera);
    this.caddie = new Caddie(this);
    this.input = new Input(this);
    this.state = 'menu';
    this.timeScale = 1;
    this.last = performance.now();
    this.hudTimer = 0;
    this.applyAccessibility();
    requestAnimationFrame((t) => this.loop(t));
    addEventListener('resize', () => this.resize());
  }

  // ------------------------------------------------------------------ settings
  loadSettings() {
    let s = {};
    try { s = JSON.parse(localStorage.getItem('psg-settings') || '{}'); } catch (e) { /* ignore */ }
    const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    return {
      profile: 'scratch', difficulty: 'standard', control: 'meter', units: 'yd', volume: 0.7, tracer: true,
      reducedMotion: reduce, oneButton: false, captions: false, uiScale: 1, keys: {}, ffSeen: 0, ...s,
    };
  }
  saveSettings() {
    try { localStorage.setItem('psg-settings', JSON.stringify(this.settings)); } catch (e) { /* ignore */ }
    this.applyAccessibility();
  }
  applyAccessibility() {
    const s = this.settings;
    document.documentElement.style.setProperty('--ui-scale', String(s.uiScale || 1));
    document.body.classList.toggle('reduced-motion', !!s.reducedMotion);
  }
  get diff() { return DIFFICULTY[this.settings.difficulty] || DIFFICULTY.standard; }

  resize() {
    this.renderer.setSize(innerWidth, innerHeight);
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
    this.meter.resize(); this.meter.draw();
    this.mouseSwing.resize();
  }

  // a sound plus (optionally) an on-screen caption for players who can't hear it
  sfx(fn, caption, ...args) {
    this.audio[fn]?.(...args);
    if (caption && this.settings.captions) this.ui.caption(caption);
  }

  // ------------------------------------------------------------------ menu backdrop
  showcase(courseId) {
    const course = courseById(courseId) || COURSES[0];
    this.world.setCourse(course);
    this.hole = this.world.buildHole(course, SIGNATURE[course.id] ?? 0, {});
    this.env = { rho: course.rho, wind: [2, 0, -1], firmness: course.firmness, stimp: this.hole.stimp };
    this.state = 'menu';
    this.cam.menuInit = false;
    this.golfer.root.visible = false;
    this.ballMesh.visible = false; this.tee.visible = false; this.ballShadow.visible = false;
    this.world.reticle.visible = false; this.world.arc.visible = false; this.world.tracer.visible = false;
    this.clearGhosts();
  }

  // ------------------------------------------------------------------ round
  // opts: { courseId, holes, mode, seed?, players?: [names], daily?: dateKey }
  startRound(opts) {
    this.ui.hideAll();
    this.audio.init();
    this.audio.setVolume(this.settings.volume);
    const course = courseById(opts.courseId);
    this.course = course;
    this.bag = buildBag(this.settings.profile);
    const seed = opts.seed ?? ((Math.random() * 2 ** 32) >>> 0);
    const rng = mulberry32(seed);
    const windDir = rng() * Math.PI * 2;
    // pins and wind for every hole up front, so a seed always reproduces the same round
    const setup = {};
    for (const idx of opts.holes) {
      const [wmin, wmax] = course.wind;
      setup[idx] = { pinIndex: Math.floor(rng() * 4), mph: wmin + (wmax - wmin) * Math.pow(rng(), 1.3), ang: windDir + (rng() - 0.5) * 1.4 };
    }
    const names = opts.players?.length ? opts.players : [null];
    const balls = MODES[opts.mode]?.balls || 0;
    this.round = {
      course, holes: opts.holes, i: 0, seed, mode: opts.mode, daily: opts.daily || null, setup, balls,
      players: names.map((name) => ({ name, scores: [], stats: new RoundStats(), attempts: [] })),
      p: 0,
      get player() { return this.players[this.p]; },
      get scores() { return this.player.scores; },
      get stats() { return this.player.stats; },
    };
    resetCoach();
    this.world.setCourse(course);
    this.computeBagDistances();
    this.ui.showHUD(true);
    this.meter.resize();
    this.clearGhosts();
    this.loadHole();
  }

  get challenge() { return this.round && this.round.balls > 0; }

  computeBagDistances() {
    // full-swing carry/total on flat fairway, no wind (the "yardage book")
    const c = this.course;
    const flat = { height: () => 0, normal: () => [0, 1, 0], surface: () => 'fairway', inBounds: () => true, cup: { x: 1e5, z: 1e5 }, pinIn: false };
    for (const club of this.bag) {
      if (club.putter) continue;
      const ld = computeLaunch(club, { power: 1, face: 0, path: 0, strike: 1, traj: 0, lie: 'fairway' });
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
      const S = r.setup[idx];
      this.hole = this.world.buildHole(course, idx, { pinIndex: S.pinIndex });
      this.windMph = S.mph;
      this.windAng = S.ang; // direction the wind blows TOWARD
      this.env = { rho: course.rho, wind: [Math.sin(S.ang) * S.mph * MPH, 0, -Math.cos(S.ang) * S.mph * MPH], firmness: course.firmness, stimp: this.hole.stimp };
      this.audio.setWind(S.mph, course.id === 'pebble' || course.id === 'standrews');
      this.golfer.root.visible = true;
      this.ballMesh.visible = true;
      this.ui.loading(false);
      this.resetPlayerOnHole();
      this.ui.holeIntro(this.hole, course, this.fmtDist(this.hole.length), this.windText(), this.introExtra());
      this.startFlyover();
    }, 30);
  }

  introExtra() {
    const r = this.round;
    if (r.balls) return `${MODES[r.mode].name}: ${MODES[r.mode].desc}`;
    if (r.players.length > 1) return `${r.player.name} to play`;
    return '';
  }

  // put the current player on the tee of the current hole
  resetPlayerOnHole() {
    const r = this.round, h = this.hole;
    this.strokes = 0;
    this.penalties = 0;
    this.ballNo = 0;
    if (!this.challenge) this.holeStats = r.stats.startHole(h.number, h.par, this.course.holes[h.index].yds);
    this.teeUp();
  }
  teeUp() {
    const h = this.hole;
    this.ball = { p: [h.tee.x, h.height(h.tee.x, h.tee.z) + BALL.radius, h.tee.z], surface: 'tee', isTee: true };
    this.world.setTracer([]);
    this.world.tracer.visible = false;
    this.rec = null;
  }

  // ------------------------------------------------------------------ flyover
  startFlyover() {
    this.state = 'flyover';
    document.body.classList.add('flyover');
    this.meter.hide();
    this.world.reticle.visible = false;
    this.world.arc.visible = false;
    this.world.showGreenGrid(false);
    this.prepareAddress();
    this.golfer.phase = 'idle';
    this.cam.startFlyover();
    if (this.settings.reducedMotion) {
      // no camera flight: keep the hole card up briefly, then go straight to the ball
      this.endFlyover(true);
      clearTimeout(this.introT);
      this.introT = setTimeout(() => this.ui.hideIntro(), 2600);
    }
  }
  endFlyover(keepIntro = false) {
    document.body.classList.remove('flyover');
    if (!keepIntro) this.ui.hideIntro();
    this.enterAddress();
    this.cam.snapAddress();
    if (this.settings.reducedMotion) this.cam.snap();
  }

  // ------------------------------------------------------------------ address
  prepareAddress() {
    const h = this.hole, b = this.ball;
    b.surface = b.isTee ? 'tee' : h.surface(b.p[0], b.p[2]);
    b.p[1] = h.height(b.p[0], b.p[2]) + BALL.radius;
    this.onGreen = b.surface === 'green';
    h.pinIn = !this.onGreen;
    this.aim = angOf(h.cup.x - b.p[0], h.cup.z - b.p[2]);
    this.shape = 'straight';
    this.traj = 0;
    this.userClub = false;
    this.club = null;
    this.caddie.chooseClub();
    if (this.challenge && this.round.mode === 'drive') {
      // long drive: always the driver, aimed down the centre line
      this.setClub(0);
      this.caddie.analysis = null;
      this.caddie.msg = 'Long drive: biggest one in the fairway or first cut wins.';
      this.caddie.aimForClub(this.club);
    }
    this.placeGolfer();
    this.previewDirty = true;
  }

  enterAddress() {
    this.state = 'address';
    this.cam.resetOrbit();
    this.cam.targetView = false;
    const d = this.diff;
    this.meter.configure({ fullTime: d.meterTime * (this.club.putter ? 1.25 : 1), marker: null, autoPower: null });
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
    this.ui.ffHint(false);
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
    if (this.club.putter) this.caddie.setupPutt();
    this.meter.configure({ putt: !!this.club.putter, fullTime: this.diff.meterTime * (this.club.putter ? 1.25 : 1) });
    this.mouseSwing.putt = !!this.club.putter;
    this.world.reticle.visible = !this.club.putter && this.state !== 'flyover';
    this.world.puttLine.visible = false;
    this.previewDirty = true;
  }

  placeGolfer() {
    const b = this.ball;
    if (!this.club) return;
    const f = dirOf(this.aim);
    this.golfer.place({ x: b.p[0], z: b.p[2] }, f, this.hole.height(b.p[0], b.p[2]));
    const teed = b.isTee && !this.club.putter && this.club.loft < 30;
    const lift = b.isTee ? (teed ? (this.club.loft < 13 ? 0.035 : 0.012) : 0.005) : 0;
    this.ballLift = lift;
    this.tee.visible = b.isTee;
    this.tee.position.set(b.p[0], this.hole.height(b.p[0], b.p[2]) + lift - 0.005, b.p[2]);
    this.ballMesh.position.set(b.p[0], b.p[1] + lift, b.p[2]);
  }

  // ------------------------------------------------------------------ address actions
  setAim(a) {
    if (this.state !== 'address') return;
    this.aim = a;
    this.placeGolfer();
    this.previewDirty = true;
  }
  aimAtWorld(x, z) { this.setAim(angOf(x - this.ball.p[0], z - this.ball.p[2])); }
  aimAtPin() { this.aimAtWorld(this.hole.cup.x, this.hole.cup.z); }
  cycleShape(d) {
    const order = ['draw', 'straight', 'fade'];
    this.shape = order[clamp(order.indexOf(this.shape) + d, 0, 2)];
    this.previewDirty = true;
    this.audio.ui('tick');
  }
  setTraj(t) {
    this.traj = clamp(t, -1, 1);
    this.previewDirty = true;
    this.audio.ui('tick');
  }
  toggleTargetView() {
    this.cam.targetView = !this.cam.targetView;
    this.ui.toast(this.cam.targetView ? 'Target view – click the ground to aim' : 'Address view');
  }
  toggleGrid() {
    this.gridOn = !this.world.gridGroup?.visible;
    this.world.showGreenGrid(this.gridOn);
  }
  toggleMute() {
    this.audio.enabled = !this.audio.enabled;
    this.ui.toast(this.audio.enabled ? 'Sound on' : 'Sound off');
  }
  peekScorecard() {
    const st = this.state;
    if (!this.round || st === 'scorecard' || st === 'summary' || st === 'menu') return;
    this.ui.scorecard(this.course, this.round, false);
  }
  closeScorecardPeek() {
    if (this.round && this.state !== 'scorecard' && !this.ui.scModal) this.ui.scorecard(null);
  }
  caddieNote() { this.ui.caddie(this.caddie.msg || ''); }

  // ------------------------------------------------------------------ previews
  updatePreview() {
    this.previewDirty = false;
    const h = this.hole, b = this.ball, w = this.world;
    const dir = dirOf(this.aim);
    const assist = this.diff;
    if (this.club.putter) {
      w.reticle.visible = false;
      w.arc.visible = false;
      this.suggestedPower = clamp(this.puttEqFt / this.puttRange, 0.02, 1);
      this.meter.configure({ marker: assist.marker ? this.suggestedPower : null });
      this.configureAuto();
      if (assist.putt <= 0) { w.puttLine.visible = false; return; }
      // read: roll the marker-speed putt along the current aim
      const v = puttSpeedFor(this.puttEqFt * FT, h.greenRoll);
      const sim = new BallSim(h, this.env, mulberry32(3));
      sim.putt(b.p.slice(), [dir.x, 0, dir.z], v);
      const pts = [b.p.slice()];
      let n = 0, dist = 0;
      const maxDist = Math.max(1.5, this.distToPin() * assist.putt);
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
    const out = this.caddie.simOutcome(this.club, this.aim, { power: 1, withWind: assist.wind, path: true, stopAtLand: !assist.roll });
    if (!out.land) return;
    const land = out.land;
    const n = h.normal(land[0], land[2]);
    w.reticle.position.set(land[0], h.height(land[0], land[2]) + 0.06, land[2]);
    w.reticle.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(...n));
    const carry = Math.hypot(land[0] - b.p[0], land[2] - b.p[2]);
    w.reticle.scale.setScalar(clamp(carry / 55, 0.6, 6));
    w.reticle.visible = true;
    w.setArc(out.path.concat([land]));
    w.arc.visible = this.settings.difficulty !== 'pro';
    this.previewLand = land;
    this.previewCarry = carry;
    this.previewRest = out.rest;
    // suggested power: what carries the plays-like distance to the pin (full swing if out of range)
    const need = this.pl ? this.pl.plays : this.distToPin();
    const flatCarry = this.club.carry || carry;
    this.suggestedPower = need < flatCarry * 1.12 && !(this.challenge && this.round.mode === 'drive') ? this.caddie.powerForFinish(need) : 1;
    this.meter.configure({ marker: assist.marker && this.suggestedPower < 1 ? this.suggestedPower : null });
    this.meter.configure({ labels: null, rangeLabel: `${this.club.name} · carry ${this.fmtDist(this.club.carry)}` });
    this.configureAuto();
  }
  // one-button swing: the meter sets power itself at the caddie's number
  configureAuto() {
    this.meter.configure({ autoPower: this.settings.oneButton ? clamp(this.suggestedPower ?? 1, 0.02, 1) : null });
  }

  // ------------------------------------------------------------------ swing
  meterClick() {
    if (this.state !== 'address' && this.state !== 'swing') return;
    if (this.settings.control === 'mouse') return;
    if (this.state === 'address') {
      if (this.previewDirty) this.updatePreview();
      this.state = 'swing';
      this.audio.ui('tick');
      this.caddie.analysis = null;
    }
    const r = this.meter.click();
    if (r === 'power') this.audio.ui('set');
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
    this.caddie.analysis = null;
    this.pendingSwing = sw;
    this.golfer.startSwing(this.club.putter ? sw.power : clamp(sw.power, 0.35, 1.05), () => this.impact());
    if (this.settings.control === 'mouse' || this.golfer.phase === 'manual') { this.golfer.phase = 'down'; this.golfer.t = 0; }
    this.world.reticle.visible = false;
    this.world.arc.visible = false;
    this.world.puttLine.visible = false;
    this.ui.caddie('');
  }

  // Shot seed: the same round seed, hole, stroke and ball always give the same
  // random lie/strike variation – so a shared challenge is fair to everyone.
  shotSeed() {
    const r = this.round;
    return seedFrom(`${r.seed}:${r.holes[r.i]}:${this.strokes}:${this.ballNo}`);
  }

  impact() {
    const sw = this.pendingSwing;
    const h = this.hole, b = this.ball;
    const dir = dirOf(this.aim);
    const seed = this.shotSeed();
    const sim = new BallSim(h, this.env, mulberry32(seed));
    const start = [b.p[0], b.p[1] + (this.ballLift || 0), b.p[2]];
    this.shotStart = { p: b.p.slice(), surface: b.surface, isTee: b.isTee, yards: this.distToPin() / YD, lie: this.lieKey(), dist: this.distToPin(), aim: this.aim, pl: this.pl, club: this.club, strokesBefore: this.strokes };
    this.tee.visible = false;
    const putt = !!this.club.putter;
    let kind = 'putt';
    if (putt) {
      const speed = puttSpeedFor(sw.power * this.puttRange * FT, h.greenRoll) * (0.97 + 0.03 * sw.strike);
      const d2 = dirOf(this.aim + sw.face * DEG);
      sim.putt(start, [d2.x, 0, d2.z], speed);
      this.shotLD = { putt: true, speed, face: sw.face, power: sw.power };
    } else {
      const sh = SHAPES[this.shape];
      const lie = this.lieKey();
      const ld = computeLaunch(this.club, { power: sw.power, face: sw.face + sh.face, path: sw.path + sh.path, strike: sw.strike, traj: this.traj, lie, slope: this.slope(), rng: mulberry32(seed + 1) });
      sim.launch(start, ld, [dir.x, 0, dir.z]);
      this.shotLD = ld;
      kind = lie === 'splash' || lie === 'bunker' ? 'sand' : this.club.key === 'DR' ? 'driver' : this.club.loft <= 20 ? 'wood' : this.club.loft >= 45 ? 'wedge' : 'iron';
    }
    this.audio.hit(kind, sw.strike, sw.power);
    // forecast: the identical sim run to completion, for the broadcast camera and slow-mo
    const fc = new BallSim(h, this.env, mulberry32(seed));
    if (putt) fc.putt(start, sim.v.map((x) => x / (Math.hypot(...sim.v) || 1)), Math.hypot(...sim.v));
    else fc.launch(start, this.shotLD, [dir.x, 0, dir.z]);
    let n = 0;
    while (fc.state !== 'rest' && fc.state !== 'holed' && n++ < 20000) fc.step(STEP);
    const fev = fc.events.map((e) => e.type);
    this.forecast = {
      land: fc.landed, rest: fc.p.slice(), t: fc.t, landT: fc.events.find((e) => e.type === 'land')?.t ?? 0,
      holed: fc.state === 'holed', lip: fev.includes('lip'), restSurface: h.surface(fc.p[0], fc.p[2]),
      restDist: Math.hypot(h.cup.x - fc.p[0], h.cup.z - fc.p[2]),
    };
    this.sim = sim;
    this.evIdx = 0;
    this.strokes++;
    this.state = 'flight';
    this.flightT = 0;
    this.simAcc = 0;
    this.timeScale = 1;
    this.landV = null;
    this.restT = 0;
    this.rec = [start.slice()];
    this.recN = 0;
    this.world.tracer.visible = this.settings.tracer && !putt;
    this.meter.hide();
    this.ballShadow.visible = !putt;
    this.cam.startFlight(this.shotStart, this.forecast);
    this.ui.showShotPanel(null);
    // impact hang: a flushed full swing freezes for a beat with a small zoom punch
    if (!putt && sw.strike > 0.9 && sw.power > 0.8 && !this.settings.reducedMotion) {
      this.hang = 0.1;
      this.cam.kick(-4);
    } else this.hang = 0;
    // fast-forward hint, shown until the player has used it a few times
    if (this.settings.ffSeen < 3 && !putt) this.ui.ffHint(true);
  }

  // ------------------------------------------------------------------ flight
  stepSim(sim) {
    const v = sim.v.slice();
    sim.step(STEP);
    if (!this.landV && sim.landed) this.landV = v;
    if ((this.recN++ & 1) === 1) this.rec.push(sim.p.slice());
  }

  // slow motion when the ball is dying near the cup (holed, lip-out or near miss)
  slowMoTarget() {
    if (this.settings.reducedMotion) return 1;
    const sim = this.sim, fc = this.forecast, h = this.hole;
    if (!(fc.holed || fc.lip || fc.restDist < 0.5)) return 1;
    if (sim.state === 'flight') return 1;
    const d = Math.hypot(h.cup.x - sim.p[0], h.cup.z - sim.p[2]);
    const sp = Math.hypot(...sim.v);
    return d < 1.4 && sp < 3 ? 0.35 : 1;
  }

  updateFlight(dt) {
    const sim = this.sim;
    if (this.hang > 0) { this.hang -= dt; this.positionBall(sim.p); return; }
    const ff = this.input.fastForward;
    if (ff && !this.ffUsed) { this.ffUsed = true; this.settings.ffSeen++; this.saveSettings(); this.ui.ffHint(false); }
    const target = this.slowMoTarget();
    if (target < 1 && this.timeScale === 1) {
      // the crowd leans in
      if (this.forecast.lip || this.forecast.restDist < 0.5) this.sfx('crowd', '[crowd: “oooh…”]', 0.2, 1.5);
    }
    this.timeScale += (target - this.timeScale) * (1 - Math.exp(-dt * 8));
    if (target === 1 && this.timeScale > 0.97) this.timeScale = 1;
    const scale = ff ? 3 : this.timeScale;
    this.simAcc += dt * 240 * scale;
    const steps = Math.floor(this.simAcc);
    this.simAcc -= steps;
    for (let i = 0; i < steps; i++) {
      if (sim.state === 'rest' || sim.state === 'holed') break;
      this.stepSim(sim);
    }
    this.flightT += dt * scale;
    while (this.evIdx < sim.events.length) this.onEvent(sim.events[this.evIdx++]);
    this.positionBall(sim.p);
    if (this.world.tracer.visible) this.world.setTracer(sim.trail.concat([sim.p]));
    this.cam.flight(sim, this.shotStart, this.forecast, this.flightT);
    if (sim.state === 'rest' || sim.state === 'holed') {
      this.restT += dt;
      if (this.restT > (sim.state === 'holed' ? 0.2 : 0.6)) this.onBallStop();
    }
  }

  positionBall(p) {
    this.ballMesh.position.set(p[0], p[1], p[2]);
    const gh = this.hole.height(p[0], p[2]);
    this.ballShadow.position.set(p[0], gh + 0.02, p[2]);
    this.ballShadow.material.opacity = clamp(0.4 - (p[1] - gh) * 0.004, 0.08, 0.4);
    this.ballShadow.scale.setScalar(clamp(1 + (p[1] - gh) * 0.03, 1, 4));
  }

  // jump straight to where the ball finishes (events are applied silently, except the last)
  skipFlight() {
    const sim = this.sim;
    if (!sim || this.state !== 'flight') return;
    let n = 0;
    while (sim.state !== 'rest' && sim.state !== 'holed' && n++ < 40000) this.stepSim(sim);
    const quiet = sim.events.slice(this.evIdx);
    this.evIdx = sim.events.length;
    const lastLoud = quiet.filter((e) => ['holed', 'water', 'ob', 'lip', 'pin'].includes(e.type)).pop();
    if (lastLoud) this.onEvent(lastLoud);
    this.positionBall(sim.p);
    if (this.world.tracer.visible) this.world.setTracer(sim.trail.concat([sim.p]));
    this.hang = 0;
    this.cam.snapToRest(sim, this.shotStart);
    this.onBallStop();
  }

  onEvent(e) {
    const putt = !!this.club.putter;
    if (e.type === 'land') {
      this.audio.land(e.surface, e.speed);
      if (!putt) this.ui.toast(SURFACES[e.surface]?.name || e.surface, 'land');
    } else if (e.type === 'bounce') { if (e.speed > 3) this.audio.land(e.surface, e.speed * 0.6); }
    else if (e.type === 'tree') { this.sfx('tree', '[branches crack]'); this.ui.toast(e.kind === 'trunk' ? 'Hit the trunk!' : 'Into the branches', 'bad'); }
    else if (e.type === 'pin') { this.sfx('pin', '[clang off the flagstick]'); this.ui.toast('Off the flagstick!', 'good'); }
    else if (e.type === 'lip') { this.sfx('groan', '[crowd groans]'); this.ui.toast('Lipped out!', 'bad'); }
    else if (e.type === 'holed') { this.sfx('cup', '[ball rattles into the cup]'); }
    else if (e.type === 'water') { this.audio.splash(1); this.sfx('groan', '[splash – crowd groans]'); }
    else if (e.type === 'ob') { this.sfx('groan', '[crowd groans]'); }
  }

  // ------------------------------------------------------------------ shot result
  shotInfo() {
    const sim = this.sim, h = this.hole, S = this.shotStart;
    const ev = sim.events.map((e) => e.type);
    const putt = !!this.club.putter;
    let result = 'ok';
    if (sim.state === 'holed') result = 'holed';
    else if (ev.includes('water')) result = 'water';
    else if (ev.includes('ob')) result = 'ob';
    const p = sim.p, cup = h.cup;
    const dir = dirOf(S.aim);
    const info = {
      putt, club: this.club, ld: this.shotLD, result, lie: S.lie, isTee: S.isTee, par: h.par,
      carryYd: sim.landed ? Math.hypot(sim.landed[0] - S.p[0], sim.landed[2] - S.p[2]) / YD : 0,
      totalYd: Math.hypot(p[0] - S.p[0], p[2] - S.p[2]) / YD,
      offlineYd: ((p[0] - S.p[0]) * -dir.z + (p[2] - S.p[2]) * dir.x) / YD,
      apexFt: (sim.apex - S.p[1]) / FT,
      descent: this.landV ? Math.atan2(-this.landV[1], Math.hypot(this.landV[0], this.landV[2])) / DEG : null,
      stimp: h.stimp,
      pinFt: Math.hypot(cup.x - p[0], cup.z - p[2]) / FT,
    };
    const toCup = { x: cup.x - S.p[0], z: cup.z - S.p[2] };
    const dC = Math.hypot(toCup.x, toCup.z) || 1;
    const along = ((p[0] - S.p[0]) * toCup.x + (p[2] - S.p[2]) * toCup.z) / dC;
    info.shortYd = (dC - along) / YD; info.longYd = (along - dC) / YD;
    info.approach = !putt && S.dist / YD > 40 && S.dist / YD < 240 && !(S.isTee && h.par > 3);
    if (S.pl && info.approach) { info.windAdj = S.pl.windAdj / YD; info.elevAdj = S.pl.elevAdj / YD; info.elevFt = (h.height(cup.x, cup.z) - S.p[1]) / FT; }
    if (putt) {
      info.startFt = S.dist / FT;
      info.afterFt = info.pinFt;
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
    if (result === 'ok') { info.after = h.surface(p[0], p[2]); info.onGreen = info.after === 'green'; }
    return info;
  }

  onBallStop() {
    const sim = this.sim, S = this.shotStart;
    this.ui.ffHint(false);
    this.ffUsed = false;
    this.timeScale = 1;
    const info = this.shotInfo();
    this.lastInfo = info;
    this.lastSg = null;
    this.state = 'result';
    if (this.challenge) { this.challengeResult(info); return; }
    const result = info.result, putt = info.putt;
    if (result === 'water') {
      // stats are recorded once the drop is chosen
      this.pendingWater = { entry: findEntry(this.hole, sim, S.p), info };
      info.after = 'water';
      this.showResult(info, null);
      this.resultNext = 'water';
      return;
    }
    let after, penalty = 0;
    if (result === 'holed') after = { surface: 'green', yards: 0 };
    else if (result === 'ob') {
      penalty = 1;
      after = { surface: S.isTee ? 'fairway' : S.surface, yards: S.yards };
      this.ball = { p: S.p.slice(), surface: S.surface, isTee: S.isTee };
    } else {
      this.ball = { p: sim.p.slice(), surface: info.after, isTee: false };
      after = { surface: info.after, yards: this.distToPin() / YD };
    }
    if (penalty) this.addPenalty(penalty);
    const sg = this.round.stats.recordShot({ surface: S.isTee ? 'tee' : S.surface, yards: S.yards, isTee: S.isTee }, after, result === 'holed', penalty);
    this.lastSg = sg;
    this.trackFirGir(info, S);
    this.showResult(info, sg);
    this.resultNext = result === 'holed' ? 'holed' : 'next';
    if (result === 'holed') this.onHoled();
    else if (!putt && info.onGreen && this.distToPin() < 3) this.sfx('crowd', '[crowd applauds]', 0.6);
    else if (!putt && info.onGreen) this.sfx('crowd', '[polite applause]', 0.25, 1.6);
    else if (putt && info.startFt > 10 && info.afterFt < 1) this.sfx('crowd', '[crowd: “ooh!”]', 0.25, 1.4);
  }

  addPenalty(n) { this.strokes += n; this.penalties += n; this.holeStats.penalties += n; }

  trackFirGir(info, S) {
    const h = this.hole, st = this.holeStats;
    if (S.isTee && h.par >= 4) st.fir = info.after === 'fairway';
    if ((info.after === 'green' || info.result === 'holed') && this.strokes <= h.par - 2) st.gir = true;
  }

  chooseRelief(o) {
    const S = this.shotStart;
    this.addPenalty(1);
    this.round.stats.recordShot({ surface: S.isTee ? 'tee' : S.surface, yards: S.yards, isTee: S.isTee }, { surface: o.surface, yards: o.dist / YD }, false, 1);
    this.ball = { p: o.p.slice(), surface: o.surface, isTee: !!o.isTee };
    this.pendingWater = null;
    this.ui.relief(null);
    this.nextShot();
  }

  showResult(info, sg, extra) {
    this.ui.showShotPanel({ info, sg, fmt: (m) => this.fmtDist(m), tips: coachShot(info), extra, canReplay: !!this.rec?.length });
    if (info.result === 'water') this.ui.banner('Penalty area', 'bad');
    else if (info.result === 'ob') this.ui.banner('Out of bounds', 'bad');
    this.updateHUD(true);
  }

  continueAfterResult() {
    if (this.state !== 'result') return;
    if (this.resultNext === 'attempt') { this.nextAttempt(); return; }
    if (this.resultNext === 'water') {
      this.state = 'relief';
      this.ui.showShotPanel(null);
      this.ui.relief(reliefOptions(this.hole, this.pendingWater.entry, this.shotStart), (o) => this.chooseRelief(o), (m) => this.fmtDist(m));
      return;
    }
    if (this.resultNext === 'holed') { this.finishHole(); return; }
    this.nextShot();
  }

  nextShot() {
    this.ui.showShotPanel(null);
    if (this.strokes >= MAX_STROKES) { this.ui.toast(`Picked up (maximum ${MAX_STROKES})`, 'bad'); this.finishHole(); return; }
    this.prepareAddress();
    this.enterAddress();
    this.cam.snapAddress();
  }

  onHoled() {
    const h = this.hole;
    const d = this.strokes - h.par;
    this.ui.banner(scoreName(this.strokes, h.par), d < 0 ? 'great' : d === 0 ? 'good' : 'bad');
    this.sfx('crowd', d < 0 ? '[crowd roars]' : '[applause]', d < 0 ? 1 : d === 0 ? 0.55 : 0.2, d < 0 ? 4 : 2.5);
  }

  // ------------------------------------------------------------------ replay
  startReplay() {
    if (this.state !== 'result' || !this.rec?.length) return;
    this.state = 'replay';
    this.replayT = 0;
    this.replayHold = 0;
    this.ui.showShotPanel(null);
    this.ui.toast('Replay – Space to return');
    this.cam.startReplay(this.shotStart, this.rec);
    this.ballShadow.visible = !this.shotStart.club.putter;
  }
  updateReplay(dt) {
    const rec = this.rec;
    // slow enough to watch, but never longer than ~7 s however far the ball rolled
    this.replayT += dt * 120 * Math.max(this.settings.reducedMotion ? 1 : 0.6, rec.length / 120 / 7);
    const i = Math.min(rec.length - 1, Math.floor(this.replayT));
    const p = rec[i];
    this.positionBall(p);
    if (this.world.tracer.visible) this.world.setTracer(rec.slice(0, i + 1));
    this.cam.replay(p);
    if (i >= rec.length - 1) { this.replayHold += dt; if (this.replayHold > 1) this.endReplay(); }
  }
  endReplay() {
    if (this.state !== 'replay') return;
    this.state = 'result';
    const rec = this.rec;
    this.positionBall(rec[rec.length - 1]);
    if (this.world.tracer.visible) this.world.setTracer(rec);
    this.showResult(this.lastInfo, this.lastSg, this.lastExtra);
  }

  // ------------------------------------------------------------------ challenge modes
  // Closest to the pin / long drive: a fixed number of balls from the tee, best one counts.
  challengeResult(info) {
    const r = this.round, mode = r.mode;
    let value = null, label;
    if (mode === 'ctp') {
      if (info.result === 'ok' || info.result === 'holed') value = info.result === 'holed' ? 0 : info.pinFt;
      label = value == null ? (info.result === 'water' ? 'Wet – no score' : 'Out of bounds – no score') : value === 0 ? 'HOLE IN ONE!' : `${value < 10 ? value.toFixed(1) : value.toFixed(0)} ft from the pin`;
    } else {
      const ok = info.result === 'ok' && ['fairway', 'cut', 'fringe', 'green'].includes(info.after);
      if (ok) value = info.totalYd;
      label = ok ? `${this.fmtDist(info.totalYd * YD)} – in play` : `${this.fmtDist(info.totalYd * YD)} – ${info.result === 'ok' ? SURFACES[info.after]?.name || 'missed' : 'penalty'}, doesn't count`;
    }
    r.player.attempts.push(value);
    const vals = r.player.attempts.filter((v) => v != null);
    const best = vals.length ? (mode === 'ctp' ? Math.min(...vals) : Math.max(...vals)) : null;
    const isBest = value != null && value === best;
    this.lastExtra = { title: `Ball ${this.ballNo + 1} of ${r.balls}`, label, best: best == null ? '—' : mode === 'ctp' ? `${best.toFixed(1)} ft` : this.fmtDist(best * YD), isBest };
    if (value === 0) { this.ui.banner('Hole in one!', 'great'); this.sfx('crowd', '[crowd goes wild]', 1, 5); }
    else if (isBest && vals.length > 1) { this.ui.banner('New best', 'good'); this.sfx('crowd', '[applause]', 0.5, 2); }
    else if (value == null) this.sfx('groan', '[crowd groans]');
    this.addGhost(this.sim.trail.concat([this.sim.p]));
    this.showResult(info, null, this.lastExtra);
    this.resultNext = 'attempt';
  }
  nextAttempt() {
    const r = this.round;
    this.ui.showShotPanel(null);
    this.ballNo++;
    if (this.ballNo < r.balls) {
      this.strokes = 0;
      this.teeUp();
      this.prepareAddress();
      this.enterAddress();
      this.cam.snapAddress();
      return;
    }
    // this player's balls are done
    if (r.p < r.players.length - 1) { r.p++; this.nextPlayerSameHole(); return; }
    this.endRound();
  }

  addGhost(points) {
    if (points.length < 2) return;
    const geo = new THREE.BufferGeometry().setFromPoints(points.map((p) => new THREE.Vector3(p[0], p[1], p[2])));
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.28, depthWrite: false }));
    this.ghosts.add(line);
  }
  clearGhosts() {
    for (const c of [...this.ghosts.children]) { c.geometry.dispose(); c.material.dispose(); this.ghosts.remove(c); }
  }

  // ------------------------------------------------------------------ hole / round end
  finishHole() {
    const r = this.round;
    r.stats.finishHole(this.strokes);
    r.scores.push({ number: this.hole.number, par: this.hole.par, strokes: this.strokes });
    this.ui.showShotPanel(null);
    // hot seat: everyone plays the hole (same pin and wind) before moving on
    if (r.p < r.players.length - 1) {
      const d = this.strokes - this.hole.par;
      this.ui.toast(`${r.player.name}: ${this.strokes} (${scoreName(this.strokes, this.hole.par)})`, d < 0 ? 'good' : '');
      r.p++;
      this.nextPlayerSameHole();
      return;
    }
    r.p = 0;
    this.state = 'scorecard';
    const last = r.i >= r.holes.length - 1;
    this.ui.scorecard(this.course, r, true, () => {
      if (last) this.endRound();
      else { r.i++; this.loadHole(); }
    }, last ? 'Finish round' : 'Next hole');
  }

  nextPlayerSameHole() {
    const r = this.round;
    this.clearGhosts();
    this.resetPlayerOnHole();
    this.prepareAddress();
    this.enterAddress();
    this.cam.snapAddress();
    this.ui.banner(`${r.player.name} to play`, 'good');
  }

  endRound() {
    const r = this.round;
    this.state = 'summary';
    this.meter.hide();
    if (this.challenge) { this.ui.challengeSummary(this.course, r, (m) => this.fmtDist(m)); return; }
    const history = loadHistory();
    const prevBest = r.players.length === 1 ? bestFor(history, this.course.id, r.mode) : null;
    for (const pl of r.players) {
      if (!pl.scores.length) continue;
      saveRound(roundEntry({
        course: this.course, mode: r.mode, holes: pl.scores, totals: pl.stats.totals(), profile: this.settings.profile,
        difficulty: this.settings.difficulty, player: r.players.length > 1 ? pl.name : null, seed: r.seed,
      }));
    }
    if (r.daily) {
      try {
        const key = `psg-daily-${r.daily}`;
        const t = r.players[0].stats.totals();
        const old = JSON.parse(localStorage.getItem(key) || 'null');
        if (!old || t.strokes - t.par < old.toPar) localStorage.setItem(key, JSON.stringify({ toPar: t.strokes - t.par, strokes: t.strokes }));
      } catch (e) { /* ignore */ }
    }
    this.ui.summary(this.course, r, r.players[0].stats.totals(), prevBest, this.settings);
  }

  quitToMenu() {
    this.ui.showHUD(false);
    document.body.classList.remove('flyover');
    this.meter.hide();
    this.mouseSwing.enabled = false; this.mouseSwing.draw();
    this.round = null;
    this.showcase(this.course?.id || 'augusta');
    this.ui.mainMenu();
  }

  // ------------------------------------------------------------------ HUD
  fmtDist(m) {
    if (this.settings.units === 'm') return `${Math.round(m)} m`;
    return `${Math.round(m / YD)} yds`;
  }
  windText() { return `${Math.round(this.windMph)} mph`; }
  windRel() {
    // wind relative to the aim line: + = helping (downwind), side + = left-to-right
    const a = this.windAng - this.aim;
    return { along: Math.cos(a) * this.windMph, side: Math.sin(a) * this.windMph, ang: a };
  }

  updateHUD(force) {
    if (!this.round || !this.hole || !this.club) return;
    const h = this.hole, b = this.ball, r = this.round;
    const toPar = r.scores.reduce((s, x) => s + x.strokes - x.par, 0);
    const d = this.distToPin();
    const lk = this.lieKey();
    const lie = LIES[lk] || LIES.rough;
    this.ui.hud({
      hole: h.number, name: h.name, par: h.par, yards: this.course.holes[h.index].yds,
      shot: this.challenge ? `Ball ${this.ballNo + 1}/${r.balls}` : `Shot ${this.strokes + 1}`, toPar,
      player: r.players.length > 1 ? r.player.name : null, challenge: this.challenge,
      dist: this.onGreen || this.club.putter ? `${(d / FT).toFixed(d / FT < 10 ? 1 : 0)} ft` : this.fmtDist(d),
      plays: this.pl && !this.club.putter ? this.fmtDist(this.pl.plays) : null,
      elev: (h.height(h.cup.x, h.cup.z) - (b.p[1] - BALL.radius)) / FT,
      puttEq: this.club.putter ? this.puttEqFt : null,
      wind: this.windRel(), windMph: this.windMph,
      club: this.club, clubCarry: this.club.putter ? `${this.puttRange} ft range` : `Carry ${this.fmtDist(this.club.carry)} · Total ${this.fmtDist(this.club.total)}`,
      lie: SURFACES[b.isTee ? 'tee' : b.surface]?.name || b.surface, lieKey: lk, lieRange: lk === 'splash' ? 'Explosion shot' : `${lie.dist[0]}–${lie.dist[1]}%`, slope: this.slope(),
      shape: SHAPES[this.shape].name, traj: TRAJ[this.traj], putter: !!this.club.putter,
      stimp: h.stimp, state: this.state,
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
      this.input.update(dt);
      if (st === 'flyover') { if (this.cam.flyover(dt)) this.endFlyover(); }
      else if (st === 'address') {
        if (this.caddie.analysis) this.caddie.stepAnalysis();
        if (this.previewDirty) { this.previewT = (this.previewT || 0) + dt; if (this.previewT > 0.06) { this.previewT = 0; this.updatePreview(); this.updateHUD(true); } }
        this.caddieTick = (this.caddieTick || 0) + dt;
        if (this.caddieTick > 0.5) { this.caddieTick = 0; this.caddieNote(); }
      } else if (st === 'swing') this.meter.update(dt);
      else if (st === 'flight') this.updateFlight(dt);
      else if (st === 'replay') this.updateReplay(dt);
      if (['backswing', 'flight', 'result', 'address', 'swing', 'flyover', 'replay'].includes(st) && !(st === 'flight' && this.hang > 0)) this.golfer.update(dt);
      // camera targets
      if (st === 'address' || st === 'swing' || st === 'backswing') {
        const c = this.cam.targetView ? this.cam.target() : this.cam.address();
        this.cam.set(c.pos, c.look, this.cam.targetView ? 3 : 5);
        this.cam.fov = 50;
      } else if (st === 'menu') this.cam.menu(dt);
      this.cam.apply(dt);
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
