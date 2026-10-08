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
import { PostPipeline } from './post.js';
import { Golfer } from './golfer.js';
import { BallSim, LIES, SURFACES, puttSpeedFor, BALL } from './physics.js';
import { buildBag } from './clubs.js';
import { YD, FT, mulberry32 } from './hole.js';
import { scoreName } from './stats.js';
import { SwingMeter, MouseSwing, meterToStrike } from './meter.js';
import { SoundEngine } from './audio.js';
import { coachShot, resetCoach } from './coach.js';
import { COURSES, courseById } from './courses/index.js';
import { DIFFICULTY, SHAPES, TRAJ, MAX_STROKES, MIN_SWING } from './config.js';
import { clamp, dirOf, angOf } from './util.js';
import { Caddie, canPutt } from './caddie.js';
import { CameraDirector } from './camera.js';
import { Input } from './input.js';
import { reliefOptions } from './rules.js';
import { fmtWind } from './units.js';
import { loadHistory, saveRound, roundEntry, bestFor } from './history.js';
import { SIGNATURE, createRound, holeEnv, introExtra } from './round.js';
import {
  STEP, distToPin, teeBall, groundBall, ballLiftFor, lieKeyFor, slopeAt, lieZoneFor, shotSeedFor, windRelOf,
  computeBagDistances, normalizeSwing, shotStartOf, launchShot, forecastShot, shotInfoFor,
} from './shot.js';
import { settleShot, settleRelief, pickedUp, finishHoleScore, nextTurn, nextHole } from './scoring.js';

const $ = (id) => document.getElementById(id);

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
    this.world.fx.setViewport(this.renderer.getDrawingBufferSize(new THREE.Vector2()).y, this.camera.fov);
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
    this.post = new PostPipeline(this.renderer, this.scene, this.camera);
    this.post.onTier = (t) => this.ui.toast(`Graphics set to ${t} for smoother frames`);
    this.post.setQuality(this.settings.quality);
    this.audio = new SoundEngine();
    this.meter = new SwingMeter($('meter'));
    this.mouseSwing = new MouseSwing($('swingOverlay'));
    this.mouseSwing.resize();
    this.meter.cueFn = (putt) => this.swingCue(putt);
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
      reducedMotion: reduce, oneButton: false, captions: false, uiScale: 1, keys: {}, ffSeen: 0, hudDetail: 'essential', quality: 'auto', ...s,
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
    document.body.classList.toggle('hud-essential', s.hudDetail !== 'full');
  }
  toggleHudDetail() {
    this.settings.hudDetail = this.settings.hudDetail === 'full' ? 'essential' : 'full';
    this.saveSettings();
    this.ui.helpBar();
    this.ui.toast(this.settings.hudDetail === 'full' ? 'Full HUD' : 'Essential HUD');
    this.updateHUD(true);
  }
  get diff() { return DIFFICULTY[this.settings.difficulty] || DIFFICULTY.standard; }

  resize() {
    this.renderer.setSize(innerWidth, innerHeight);
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
    this.post.resize(innerWidth, innerHeight);
    // (portrait screens widen the field of view: see CameraDirector.fitFov)
    this.world.fx.setViewport(this.renderer.getDrawingBufferSize(new THREE.Vector2()).y, this.cam ? this.cam.fitFov(50) : this.camera.fov);
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
    this.round = createRound(opts);
    const course = this.round.course;
    this.course = course;
    this.bag = buildBag(this.settings.profile);
    resetCoach();
    this.world.setCourse(course);
    computeBagDistances(this.bag, course);
    this.ui.showHUD(true);
    this.meter.resize();
    this.clearGhosts();
    this.loadHole();
  }

  get challenge() { return this.round && this.round.balls > 0; }

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
      this.env = holeEnv(course, this.hole, S);
      this.audio.setWind(S.mph, course.id === 'pebble' || course.id === 'standrews');
      this.golfer.root.visible = true;
      this.ballMesh.visible = true;
      this.ui.loading(false);
      this.resetPlayerOnHole();
      this.ui.holeIntro(this.hole, course, this.fmtDist(this.hole.length), this.windText(), introExtra(this.round));
      this.startFlyover();
    }, 30);
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
    this.ball = teeBall(this.hole);
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
    const h = this.hole;
    const b = this.ball = groundBall(h, this.ball.p, this.ball.isTee);
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
    this.addressAt = performance.now();
    this.cam.resetOrbit();
    this.cam.targetView = false;
    document.body.classList.remove('target-view');
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

  distToPin() { return distToPin(this.hole, this.ball); }
  lieKey() { return lieKeyFor(this.ball, this.hole, this.club); }
  slope() { return slopeAt(this.hole, this.ball.p, this.aim); }

  setClub(i, user = false) {
    i = clamp(i, 0, this.bag.length - 1);
    // the putter only comes out near the green – no 465 ft "putts" from the tee
    if (user && this.bag[i].putter && !canPutt(this.hole, this.ball)) { this.ui.toast('Too far to putt – get it near the green first'); return; }
    this.clubIdx = i;
    this.club = this.bag[this.clubIdx];
    if (user) this.userClub = true;
    this.golfer.setClub(this.club);
    if (user) this.caddie.clubChanged();
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
    this.golfer.setOutfit(this.round?.p || 0);
    this.golfer.place({ x: b.p[0], z: b.p[2] }, f, this.hole.height(b.p[0], b.p[2]), (x, z) => this.hole.height(x, z));
    const lift = ballLiftFor(b, this.club);
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
  // With the putter out the key flips between the caddie's read and the cup itself.
  aimAtPin() {
    const rd = this.club?.putter && this.puttRead;
    if (rd && Math.abs(rd.brk) >= 0.02 && Math.abs(this.aim - rd.aim) > 1e-4) {
      this.setAim(rd.aim);
      this.ui.toast('Aimed on the caddie’s read');
      return;
    }
    this.aimAtWorld(this.hole.cup.x, this.hole.cup.z);
    if (rd && Math.abs(rd.brk) >= 0.02) this.ui.toast('Aimed straight at the cup');
  }
  cycleShape(d, wrap = false) {
    const order = ['draw', 'straight', 'fade'];
    const i = order.indexOf(this.shape) + d;
    this.shape = order[wrap ? (i + 3) % 3 : clamp(i, 0, 2)];
    this.previewDirty = true;
    this.audio.ui('tick');
    this.flashShapeRow();
  }
  setTraj(t) {
    this.traj = clamp(t, -1, 1);
    this.previewDirty = true;
    this.audio.ui('tick');
    this.flashShapeRow();
  }
  // essential HUD hides the shape/flight row; show it for a moment when either changes
  flashShapeRow() {
    const box = document.getElementById('clubBox');
    box.classList.add('show-row');
    clearTimeout(this.rowT);
    this.rowT = setTimeout(() => box.classList.remove('show-row'), 3000);
  }
  toggleTargetView() {
    this.cam.targetView = !this.cam.targetView;
    document.body.classList.toggle('target-view', this.cam.targetView);
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
  caddieNote() { this.ui.caddie([this.caddie.msg, this.caddie.lieNote()].filter(Boolean).join(' ')); }

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
    const land = out.land;
    if (land) {
      const n = h.normal(land[0], land[2]);
      w.reticle.position.set(land[0], h.height(land[0], land[2]) + 0.06, land[2]);
      w.reticle.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(...n));
      const carry = Math.hypot(land[0] - b.p[0], land[2] - b.p[2]);
      w.reticle.scale.setScalar(clamp(carry / 55, 0.6, 6));
      w.reticle.visible = true;
      w.setArc(out.path.concat([land]));
      w.arc.visible = this.settings.difficulty !== 'pro';
      this.previewCarry = carry;
    } else {
      // a full swing would fly out of bounds before landing (a wedge next to the boundary):
      // no landing marker, but the power suggestion below still has to be for this shot
      w.reticle.visible = false;
      w.arc.visible = false;
      this.previewCarry = null;
    }
    this.previewLand = land || null;
    this.previewRest = land ? out.rest : null;
    // suggested power: what carries the plays-like distance to the pin (full swing if out of range)
    const need = this.pl ? this.pl.plays : this.distToPin();
    const flatCarry = this.club.carry || this.previewCarry || need;
    this.suggestedPower = need < flatCarry * 1.12 && !(this.challenge && this.round.mode === 'drive') ? this.caddie.powerForFinish(need) : 1;
    // never below the shortest real swing: under it every swing is a chunk (normalizeSwing)
    this.suggestedPower = Math.max(this.suggestedPower, MIN_SWING + 0.01);
    this.meter.configure({ marker: assist.marker && this.suggestedPower < 1 ? this.suggestedPower : null });
    this.meter.configure({ labels: null, rangeLabel: `${this.club.name} · carry ${this.fmtDist(this.club.carry)}` });
    this.configureAuto();
  }
  // one-button swing: the meter sets power itself at the caddie's number
  configureAuto() {
    this.meter.configure({ autoPower: this.settings.oneButton ? clamp(this.suggestedPower ?? 1, 0.02, 1) : null });
  }

  // ------------------------------------------------------------------ swing
  get addressSettling() { return performance.now() - (this.addressAt || 0) < 350; }

  // the meter's "how do I start" prompt follows the control scheme and input device
  swingCue(putt) {
    const touch = document.body.classList.contains('touch');
    if (this.settings.control === 'mouse') return touch ? 'Drag down, then up, to swing' : 'Hold LMB: pull back, push up to swing';
    return `${touch ? 'Tap SWING' : `${this.ui.key('swing')} / click`} to start the ${putt ? 'stroke' : 'swing'}`;
  }

  meterClick() {
    if (this.state !== 'address' && this.state !== 'swing') return;
    if (this.settings.control === 'mouse') return;
    // the press that skipped the flyover or dismissed the last result must not also start a swing
    if (this.state === 'address' && this.addressSettling) return;
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
  lieZone() { return lieZoneFor(this.ball, this.hole, this.club, this.aim); }

  // every input path (meter, mouse swing, gamepad stick) ends up here
  executeSwing(sw) {
    sw = normalizeSwing(sw, !!this.club.putter);
    this.state = 'backswing';
    this.caddie.analysis = null;
    this.caddie.reading = null;
    this.pendingSwing = sw;
    this.golfer.startSwing(this.club.putter ? sw.power : clamp(sw.power, 0.35, 1.05), () => this.impact());
    if (this.settings.control === 'mouse' || this.golfer.phase === 'manual') { this.golfer.phase = 'down'; this.golfer.t = 0; }
    this.world.reticle.visible = false;
    this.world.arc.visible = false;
    this.world.puttLine.visible = false;
    this.ui.caddie('');
  }

  shotSeed() { return shotSeedFor(this.round, this.strokes, this.ballNo); }

  impact() {
    const sw = this.pendingSwing;
    const h = this.hole, b = this.ball;
    const seed = this.shotSeed();
    this.shotStart = shotStartOf({ hole: h, ball: b, club: this.club, aim: this.aim, pl: this.pl, strokes: this.strokes, lie: this.lieKey(), duffed: sw.duffed });
    this.tee.visible = false;
    const shot = launchShot({ hole: h, env: this.env, ball: b, club: this.club, swing: sw, aim: this.aim, shape: this.shape, traj: this.traj, puttRange: this.puttRange, ballLift: this.ballLift, seed });
    const { sim, start, putt } = shot;
    this.shotLD = shot.ld;
    this.audio.hit(shot.kind, sw.strike, sw.power);
    this.impactFx(shot, sw);
    // forecast: the identical sim run to completion, for the broadcast camera and slow-mo
    this.forecast = forecastShot({ hole: h, env: this.env, shot, seed });
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
      if (shot.kind === 'driver' || shot.kind === 'wood') this.cam.shake(0.08, 0.35);
    } else this.hang = 0;
    // flushed: dead-centre strike at (near) full power
    if (!putt && sw.strike > 0.97 && sw.power > 0.95 && !sw.duffed) {
      this.ui.banner('PURE', 'pure', 1100);
      this.sfx('chime', '[pure strike chime]');
    }
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
  // Slow motion for the moments worth savouring: putts and chips dying at the
  // hole, approaches finishing stiff, and any full shot that goes in (slowed from
  // the landing bounce). The forecast already knows how the shot ends.
  slowMoTarget() {
    if (this.settings.reducedMotion) return 1;
    const sim = this.sim, fc = this.forecast, h = this.hole;
    const putt = !!this.club.putter;
    const d = Math.hypot(h.cup.x - sim.p[0], h.cup.z - sim.p[2]);
    // bounces count as flight, so the hole-out check comes first: slow from the first touch down
    if (!putt && fc.holed && sim.landed && d < 8) return 0.4;
    if (sim.state === 'flight') return 1;
    const sp = Math.hypot(...sim.v);
    if (!(fc.holed || fc.lip || fc.restDist < (putt ? 0.5 : 1.5))) return 1;
    return d < (putt ? 1.4 : 3) && sp < (putt ? 3 : 4.5) ? 0.35 : 1;
  }

  updateFlight(dt) {
    const sim = this.sim;
    if (this.hang > 0) { this.hang -= dt; this.positionBall(sim.p); return; }
    const ff = this.input.fastForward;
    if (ff && !this.ffUsed) { this.ffUsed = true; this.settings.ffSeen++; this.saveSettings(); this.ui.ffHint(false); }
    const target = this.slowMoTarget();
    if (target < 1 && this.timeScale === 1) {
      // the crowd leans in
      if (this.forecast.lip || this.forecast.restDist < 0.5 || (this.forecast.holed && !this.club.putter)) this.sfx('crowd', '[crowd: “oooh…”]', 0.2, 1.5);
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
    for (const e of quiet) if (e !== lastLoud) this.eventFx(e, false); // marks stay, particles don't
    if (lastLoud) this.onEvent(lastLoud);
    this.positionBall(sim.p);
    if (this.world.tracer.visible) this.world.setTracer(sim.trail.concat([sim.p]));
    this.hang = 0;
    this.cam.snapToRest(sim, this.shotStart);
    this.onBallStop();
  }

  onEvent(e) {
    const putt = !!this.club.putter;
    this.eventFx(e, true);
    if (e.type === 'land') {
      this.audio.land(e.surface, e.speed);
      if (!putt) this.ui.toast(SURFACES[e.surface]?.name || e.surface, 'land');
    } else if (e.type === 'bounce') { if (e.speed > 3) this.audio.land(e.surface, e.speed * 0.6); }
    else if (e.type === 'tree') { this.sfx('tree', '[branches crack]'); this.ui.toast(e.kind === 'trunk' ? 'Hit the trunk!' : 'Into the branches', 'bad'); this.cam.shake(e.kind === 'trunk' ? 0.12 : 0.06, 0.4); }
    else if (e.type === 'pin') { this.sfx('pin', '[clang off the flagstick]'); this.ui.toast('Off the flagstick!', 'good'); }
    else if (e.type === 'lip') { this.sfx('groan', '[crowd groans]'); this.ui.toast('Lipped out!', 'bad'); }
    else if (e.type === 'holed') { this.sfx('cup', '[ball rattles into the cup]'); }
    else if (e.type === 'water') { this.audio.splash(1); this.sfx('groan', '[splash – crowd groans]'); }
    else if (e.type === 'ob') { this.sfx('groan', '[crowd groans]'); }
  }

  // ------------------------------------------------------------------ impact effects
  // Ground contact at impact: a divot from grass, a plume from sand, dust from hardpan.
  impactFx(shot, sw) {
    if (shot.putt) return;
    const fx = this.world.fx, p = shot.start, fwd = shot.fwd;
    const lie = this.lieKey(), st = this.hole.style, pal = st.palette;
    const strength = clamp(sw.power, 0.3, 1);
    const grass = (s) => { const c = pal[s] ?? pal.fairway; return Array.isArray(c) ? c[0] : c; };
    if (lie === 'splash' || lie === 'bunker') fx.sand(p, fwd, { strength, color: st.sand || pal.bunker });
    else if (lie === 'tee') {
      // off a peg only an iron brushes the turf
      if (this.club.loft > 20) fx.burst(p, [fwd[0] * 0.6, 0.7, fwd[2] * 0.6], { count: 10, speed: 2.5, spread: 0.4, life: 0.8, color: grass('tee'), size: 0.04, bounce: 1 });
    } else if (['fairway', 'cut', 'second', 'rough', 'deep', 'fringe', 'green'].includes(lie)) {
      const s = lie === 'green' ? strength * 0.4 : lie === 'fringe' ? strength * 0.6 : strength;
      fx.divot(p, fwd, { strength: s, surface: lie, dirt: pal.dirt, grass: grass(lie) });
    } else if (lie === 'waste' || lie === 'straw' || lie === 'path') fx.dust(p, 10 + 20 * strength);
  }

  // Flight events: pitch marks on greens, splash rings on water, dust off the path.
  // `live` is false when skipping ahead: lasting marks are placed, particles are not.
  eventFx(e, live) {
    const fx = this.world.fx;
    if (e.type === 'land' || e.type === 'bounce') {
      if (e.surface === 'green' && e.type === 'land' && e.speed > 12) fx.pitchMark(e.p, e.speed);
      else if (e.surface === 'path' && live && e.speed > 3) fx.dust(e.p, e.speed);
      else if (e.surface === 'bunker' && live && e.type === 'land' && e.speed > 8) fx.burst(e.p, [0, 1, 0], { count: 25, speed: 1.8, spread: 0.8, life: 1.0, color: this.hole.style.sand || this.hole.style.palette.bunker, size: 0.1, grav: 0.4, bounce: 1, tint: 0.08 });
    } else if (e.type === 'water') {
      const lvl = this.hole.waterLevel(e.p[0], e.p[2]);
      fx.splash([e.p[0], lvl ?? e.p[1], e.p[2]], { particles: live });
    }
  }

  // ------------------------------------------------------------------ shot result
  shotInfo() {
    return shotInfoFor({ sim: this.sim, hole: this.hole, shotStart: this.shotStart, club: this.club, ld: this.shotLD, landV: this.landV, puttElevIn: this.puttElevIn });
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
    const putt = info.putt;
    const r = settleShot({ hole: this.hole, shotStart: S, sim, info, stats: this.round.stats, strokes: this.strokes });
    if (r.next === 'water') {
      // stats are recorded once the drop is chosen
      this.pendingWater = { entry: r.entry, info };
      this.resultNext = 'water';
      this.showResult(info, null);
      return;
    }
    this.strokes = r.strokes;
    this.penalties += r.penalty;
    this.ball = r.ball;
    this.lastSg = r.sg;
    this.resultNext = r.next;
    this.showResult(info, r.sg);
    if (r.result === 'holed') this.onHoled();
    else if (!putt && info.onGreen && this.distToPin() < 3) this.sfx('crowd', '[crowd applauds]', 0.6);
    else if (!putt && info.onGreen) this.sfx('crowd', '[polite applause]', 0.25, 1.6);
    else if (putt && info.startFt > 10 && info.afterFt < 1) this.sfx('crowd', '[crowd: “ooh!”]', 0.25, 1.4);
  }

  chooseRelief(o) {
    const r = settleRelief({ shotStart: this.shotStart, option: o, stats: this.round.stats, strokes: this.strokes });
    this.strokes = r.strokes;
    this.penalties += r.penalty;
    this.ball = r.ball;
    this.pendingWater = null;
    this.ui.relief(null);
    this.nextShot();
  }

  showResult(info, sg, extra) {
    this.ui.showShotPanel({ info, sg, fmt: (m) => this.fmtDist(m), tips: coachShot(info, this.settings.units), extra, canReplay: !!this.rec?.length });
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
    if (pickedUp(this.strokes)) { this.ui.toast(`Picked up (maximum ${MAX_STROKES})`, 'bad'); this.finishHole(true); return; }
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
    this.resultNext = 'attempt';
    this.showResult(info, null, this.lastExtra);
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
  finishHole(pickedUp = false) {
    const r = this.round, h = this.hole, strokes = this.strokes;
    const who = r.player.name;
    finishHoleScore(r, h, strokes, { pickedUp });
    this.ui.showShotPanel(null);
    const turn = nextTurn(r);
    // hot seat: everyone plays the hole (same pin and wind) before moving on
    if (turn === 'player') {
      const d = strokes - h.par;
      this.ui.toast(`${who}: ${strokes} (${scoreName(strokes, h.par)})`, d < 0 ? 'good' : '');
      this.nextPlayerSameHole();
      return;
    }
    this.state = 'scorecard';
    this.cam.orbitGreen();
    const last = turn === 'end';
    this.ui.scorecard(this.course, r, true, () => {
      if (last) this.endRound();
      else { nextHole(r); this.loadHole(); }
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
    this.cam.orbitGreen();
    this.meter.hide();
    this.tutorial?.end();
    if (this.challenge) { this.ui.challengeSummary(this.course, r, (m) => this.fmtDist(m)); return; }
    const history = loadHistory();
    const prevBest = r.players.length === 1 && !this.course.generated ? bestFor(history, this.course.id, r.mode) : null;
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
    this.tutorial?.end();
    this.showcase(this.course?.id || 'augusta');
    this.ui.mainMenu();
    const menu = document.getElementById('menu'); if (menu) menu.scrollTop = 0;
  }

  // ------------------------------------------------------------------ HUD
  fmtDist(m) {
    if (this.settings.units === 'm') return `${Math.round(m)} m`;
    return `${Math.round(m / YD)} yds`;
  }
  windText() { return fmtWind(this.windMph, this.settings.units); }
  windRel() { return windRelOf(this.windAng, this.windMph, this.aim); }

  updateHUD(force) {
    if (!this.round || !this.hole || !this.club) return;
    const h = this.hole, r = this.round;
    const toPar = r.scores.reduce((s, x) => s + x.strokes - x.par, 0);
    // After the ball stops the club, plays-like and putt-speed numbers describe the shot just played,
    // so the HUD shows only where the ball finished (and "Holed" once it drops) until the next address.
    const resting = this.state === 'result' || this.state === 'replay';
    const holed = resting && this.resultNext === 'holed';
    const fromSim = resting && this.sim && (this.challenge || this.resultNext === 'water');
    const b = fromSim ? { p: this.sim.p, surface: this.lastInfo?.after || this.ball.surface } : this.ball;
    const d = holed ? 0 : distToPin(h, b);
    const feet = this.club.putter || (resting ? b.surface === 'green' : this.onGreen);
    const lk = this.lieKey();
    const lie = LIES[lk] || LIES.rough;
    this.ui.hud({
      hole: h.number, name: h.name, par: h.par, yards: this.course.holes[h.index].yds,
      shot: this.challenge ? `Ball ${this.ballNo + 1}/${r.balls}` : holed ? `Holed in ${this.strokes}` : `Shot ${this.strokes + (this.state === 'flight' ? 0 : 1)}`, toPar,
      player: r.players.length > 1 ? r.player.name : null, challenge: this.challenge,
      dist: holed ? 'Holed' : feet ? `${(d / FT).toFixed(d / FT < 10 ? 1 : 0)} ft` : this.fmtDist(d),
      plays: this.pl && !this.club.putter && !resting ? this.fmtDist(this.pl.plays) : null,
      elev: holed ? 0 : (h.height(h.cup.x, h.cup.z) - (b.p[1] - BALL.radius)) / FT,
      puttEq: this.club.putter && !resting ? this.puttEqFt : null,
      wind: this.windRel(), windMph: this.windMph,
      club: this.club, clubCarry: this.club.putter ? `${this.puttRange} ft range` : `Carry ${this.fmtDist(this.club.carry)} · Total ${this.fmtDist(this.club.total)}`,
      lie: b.isTee ? SURFACES.tee.name : b.surface === 'tee' ? 'Tee box · fairway lie' : SURFACES[b.surface]?.name || b.surface,
      lieKey: lk, lieRange: lk === 'splash' ? 'Explosion shot' : `${lie.dist[0]}–${lie.dist[1]}%`, slope: resting ? { up: 0, side: 0 } : this.slope(),
      shape: SHAPES[this.shape].name, traj: TRAJ[this.traj], putter: !!this.club.putter,
      stimp: h.stimp, state: this.state,
    });
    if (force) this.ui.minimap(this);
  }

  // ------------------------------------------------------------------ main loop
  loop(t) {
    requestAnimationFrame((tt) => this.loop(tt));
    this.post.sample(t - this.last);
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
        if (this.caddie.reading) this.caddie.stepReading();
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
      } else if (st === 'menu' || st === 'scorecard' || st === 'summary') this.cam.menu(dt);
      this.cam.apply(dt);
      if (st === 'address' && this.meter.state !== 'hidden') this.meter.draw();
    }
    // ball visibility scale with distance
    const dCam = this.camera.position.distanceTo(this.ballMesh.position);
    this.ballMesh.scale.setScalar(clamp(dCam / 7, 1.3, 14));
    if (this.hole) this.world.update(dt, this.env ? this.env.wind : [0, 0, 0], this.ballMesh.visible ? this.ballMesh.position : this.cam.look);
    this.hudTimer += dt;
    if (this.hudTimer > 0.25 && (st === 'address' || st === 'flight')) { this.hudTimer = 0; this.updateHUD(st === 'flight'); }
    this.tutorial?.update(dt);
    this.post.render();
  }
}
