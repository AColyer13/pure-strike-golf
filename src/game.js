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
import { MouseSwing, meterToStrike, tempoToMeterError, tempo, setTempo, setCounts, countsFor, tempoNote, DEFAULT_TEMPO } from './swing.js';
import { say, hush } from './voice.js';
import { CADDIES, advice, greeting, tempoLine, judgeShot, situationOf, reaction } from './caddies.js';
import { SoundEngine } from './audio.js';
import { coachShot, resetCoach } from './coach.js';
import { COURSES, courseById } from './courses/index.js';
import { DIFFICULTY, SHAPES, TRAJ, MAX_STROKES, MIN_SWING } from './config.js';
import { clamp, dirOf, angOf } from './util.js';
import { Caddie, canPutt, SLICE_MS } from './caddie.js';
import { CameraDirector } from './camera.js';
import { Input } from './input.js';
import { reliefOptions } from './rules.js';
import { fmtWind, fmtFt, fmtElev } from './units.js';
import { loadHistory, saveRound, roundEntry, bestFor } from './history.js';
import { SIGNATURE, createRound, holeEnv, RESUME_KEY, resumable, roundSnapshot, restoreRound } from './round.js';
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

    this.settings = this.loadSettings();
    this.post = new PostPipeline(this.renderer, this.scene, this.camera);
    this.post.onTier = (t) => this.ui.toast(`Graphics set to ${t} for smoother frames`);
    // below the low tier (no effects) the only thing left to give is resolution
    this.post.onLowest = () => {
      const pr = this.renderer.getPixelRatio();
      if (pr <= 1) return false;
      this.renderer.setPixelRatio(pr > 1.5 ? 1.5 : 1);
      this.resize();
      this.ui.toast('Resolution lowered for smoother frames');
      return true;
    };
    this.post.setQuality(this.settings.quality);
    this.audio = new SoundEngine();
    this.mouseSwing = new MouseSwing($('swingOverlay'));
    this.mouseSwing.resize();
    this.mouseSwing.onBack = (b) => { this.golfer.phase = 'manual'; this.golfer.apply(-b); };
    this.mouseSwing.onDone = (r) => this.mouseDone(r);
    this.mouseSwing.onBeat = () => this.audio.ui('tick');
    this.mouseSwing.onCancel = () => {
      this.golfer.phase = 'idle';
      if (this.state === 'swing') this.state = 'address';
    };

    this.cam = new CameraDirector(this, this.camera);
    this.caddie = new Caddie(this);
    this.input = new Input(this);
    this.state = 'menu';
    this.timeScale = 1;
    this.last = performance.now();
    this.hudTimer = 0;
    this.applyAccessibility();
    // the browser can take the graphics away (a phone backgrounding the tab, a GPU reset);
    // three.js rebuilds everything when they come back, so pause until then
    canvas.addEventListener('webglcontextlost', () => this.graphicsLost());
    canvas.addEventListener('webglcontextrestored', () => this.graphicsRestored());
    requestAnimationFrame((t) => this.loop(t));
    addEventListener('resize', () => this.resize());
  }

  graphicsLost() {
    this.gfxLost = true;
    $('gfxLostMsg').textContent = 'The graphics card was reset. Restoring…';
    $('gfxReload').classList.add('hidden');
    $('gfxReload').onclick = () => location.reload();
    $('gfxLost').classList.remove('hidden');
    clearTimeout(this.gfxT);
    this.gfxT = setTimeout(() => {
      if (!this.gfxLost) return;
      $('gfxLostMsg').textContent = `The graphics haven’t come back. Reload to carry on${this.round && resumable(this.round.opts) ? ' – your round is saved and picks up from your last shot' : ''}.`;
      $('gfxReload').classList.remove('hidden');
    }, 5000);
  }
  graphicsRestored() {
    this.gfxLost = false;
    clearTimeout(this.gfxT);
    $('gfxLost').classList.add('hidden');
    this.last = performance.now();
  }

  // ------------------------------------------------------------------ settings
  loadSettings() {
    let s = {};
    try { s = JSON.parse(localStorage.getItem('psg-settings') || '{}'); } catch (e) { /* ignore */ }
    const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    return {
      // a first visit starts a typical golfer on the middle tees; saved settings from before tee sets keep the back tees
      profile: 'mid', difficulty: 'standard', tees: Object.keys(s).length ? 'back' : 'middle', units: 'yd', volume: 0.7, tracer: true, caddyVoice: true, caddie: 'tech', tempo: DEFAULT_TEMPO,
      reducedMotion: reduce, captions: false, uiScale: 1, keys: {}, ffSeen: 0, quality: 'auto', ...s,
    };
  }
  saveSettings() {
    // the guided hole forces Beginner assists; a refresh mid-lesson must not make that the player's saved choice
    const s = this.tutorial?.saved ? { ...this.settings, ...this.tutorial.saved } : this.settings;
    try { localStorage.setItem('psg-settings', JSON.stringify(s)); } catch (e) { /* ignore */ }
    this.applyAccessibility();
  }
  applyAccessibility() {
    const s = this.settings;
    document.documentElement.style.setProperty('--ui-scale', String(s.uiScale || 1));
    document.body.classList.toggle('reduced-motion', !!s.reducedMotion);
  }
  get diff() { return DIFFICULTY[this.settings.difficulty] || DIFFICULTY.standard; }

  resize() {
    if (!(innerWidth > 0 && innerHeight > 0)) return; // minimised or hidden: nothing to size to
    this.renderer.setSize(innerWidth, innerHeight);
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
    this.post.resize(innerWidth, innerHeight);
    // (portrait screens widen the field of view: see CameraDirector.fitFov)
    this.world.fx.setViewport(this.renderer.getDrawingBufferSize(new THREE.Vector2()).y, this.cam ? this.cam.fitFov(50) : this.camera.fov);
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
  }

  // ------------------------------------------------------------------ round
  // opts: { courseId, holes, mode, seed?, daily?: dateKey }
  // snap: a saved round (roundSnapshot) to carry on instead of starting afresh
  startRound(opts, snap = null) {
    this.ui.hideAll();
    this.audio.init();
    this.audio.setVolume(this.settings.volume);
    this.round = snap ? restoreRound(snap) : createRound(opts);
    this.greeted = false;
    if (!this.round) { this.quitToMenu(); return; }
    // what this round is played with, for its summary and history (the lesson swaps in beginner assists)
    this.round.played = { profile: this.settings.profile, difficulty: this.settings.difficulty };
    const course = this.round.course;
    this.course = course;
    this.bag = buildBag(this.settings.profile);
    resetCoach();
    this.world.setCourse(course);
    computeBagDistances(this.bag, course);
    this.ui.showHUD(true);
    this.loadHole(snap);
  }

  loadHole(snap = null) {
    const r = this.round;
    const idx = r.holes[r.i];
    const course = this.course;
    this.ui.loading(true, `Hole ${idx + 1} – ${course.holes[idx].name}`);
    setTimeout(() => {
      const S = r.setup[idx];
      this.hole = this.world.buildHole(course, idx, { pinIndex: S.pinIndex, tees: r.tees });
      this.windMph = S.mph;
      this.windAng = S.ang; // direction the wind blows TOWARD
      this.env = holeEnv(course, this.hole, S);
      this.audio.setWind(S.mph, course.id === 'pebble' || course.id === 'standrews');
      this.golfer.root.visible = true;
      this.ballMesh.visible = true;
      this.ui.loading(false);
      const cur = r.stats.cur;
      this.resetPlayerOnHole();
      if (snap?.done) { this.endRound(); return; }
      this.ui.holeIntro(this.hole, course, this.fmtDist(this.hole.yards * YD), this.windText());
      if (snap?.mid) {
        // back where the player left off: same ball, strokes and hole stats, no flyover
        const m = snap.mid;
        this.strokes = m.strokes; this.penalties = m.penalties;
        if (cur) { r.stats.cur = cur; this.holeStats = cur; }
        this.ball = { ...this.ball, p: m.ball.p.slice(), isTee: m.ball.isTee };
        this.startFlyover();
        this.endFlyover();
        this.ui.toast('Round resumed');
        return;
      }
      this.startFlyover();
    }, 30);
  }

  // put the current player on the tee of the current hole
  resetPlayerOnHole() {
    const r = this.round, h = this.hole;
    this.strokes = 0;
    this.penalties = 0;
    this.holeStats = r.stats.startHole(h.number, h.par, h.yards);
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
    this.placeGolfer();
    this.previewDirty = true;
  }

  enterAddress() {
    this.state = 'address';
    this.addressAt = performance.now();
    this.saveProgress({ mid: { ball: { p: this.ball.p.slice(), isTee: !!this.ball.isTee }, strokes: this.strokes, penalties: this.penalties } });
    this.cam.resetOrbit();
    this.cam.targetView = false;
    document.body.classList.remove('target-view');
    this.mouseSwing.enabled = true;
    this.mouseSwing.putt = !!this.club.putter;
    this.mouseSwing.result = null;
    this.mouseSwing.target = null; this.powerReady = false; this.adviceErr = 0;
    this.swingTempo = null;
    setTempo(this.settings.tempo);
    setCounts(countsFor(this.club, this.suggestedPower));
    // only Beginner assists show the timing bar and the caddie's blue mark; Standard and Pro swing to the
    // caddie's spoken percentage alone; the guided hole is always Beginner
    const pro = this.settings.difficulty !== 'beginner' && !this.tutorial;
    this.mouseSwing.count = !pro;
    this.mouseSwing.bar = !pro;
    this.mouseSwing.pro = pro;
    this.mouseSwing.draw();
    this.world.showGreenGrid(this.onGreen ? !this.gridHide : this.nearGreen() && this.gridOn);
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
  // close enough to the green for its grid to mean something
  nearGreen() { return !!this.hole && !!this.ball && (!!this.onGreen || this.distToPin() < 25); }
  lieKey() { return lieKeyFor(this.ball, this.hole, this.club); }
  slope() { return slopeAt(this.hole, this.ball.p, this.aim); }

  setClub(i, user = false) {
    i = clamp(i, 0, this.bag.length - 1);
    // the putter only comes out near the green – no 465 ft "putts" from the tee
    if (user && this.bag[i].putter && !canPutt(this.hole, this.ball)) { this.ui.toast('Too far to putt – get it near the green first'); return; }
    // ...and once it is out on the green it stays out
    if (user && this.onGreen && this.club?.putter && !this.bag[i].putter) { this.ui.toast('On the green – putter only'); return; }
    this.clubIdx = i;
    this.club = this.bag[this.clubIdx];
    if (user) this.userClub = true;
    this.golfer.setClub(this.club);
    if (user) this.caddie.clubChanged();
    this.placeGolfer();
    this.hole.pinIn = !this.club.putter;
    if (this.club.putter) this.caddie.setupPutt();
    this.mouseSwing.putt = !!this.club.putter;
    this.world.reticle.visible = !this.club.putter && this.state !== 'flyover';
    this.world.puttLine.visible = false;
    this.previewDirty = true;
  }

  placeGolfer() {
    const b = this.ball;
    if (!this.club) return;
    const f = dirOf(this.aim);
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
    this.cam.resetOrbit(); // a drag in target view must not leave the address camera tilted
    document.body.classList.toggle('target-view', this.cam.targetView);
    this.ui.toast(this.cam.targetView ? 'Target view – click the ground to aim' : 'Address view');
  }
  toggleGrid() {
    if (!this.nearGreen()) { this.ui.toast('The green grid is for when you are near the green'); return; }
    const on = !this.world.gridGroup?.visible;
    // on the green the grid is the default, so G there records a choice to hide it; elsewhere it records a choice to show it
    if (this.onGreen) this.gridHide = !on; else this.gridOn = on;
    this.world.showGreenGrid(on);
    this.ui.toast(on ? 'Green grid on' : 'Green grid off');
  }
  toggleMute() {
    this.audio.setEnabled(!this.audio.enabled);
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
  caddieNote() {
    // a tree in the line is the one thing to say: it replaces the usual club and line advice
    const blocked = this.caddie.blockedNote();
    this.ui.caddie([this.analogAdvice()?.text, blocked || this.caddie.msg, this.caddie.lieNote(), this.ui.tipNow].filter(Boolean).join(' '));
  }

  // Analog swing: how far back to take it, as the caddie would say it. Null until the power
  // for this shot is worked out.
  analogAdvice() {
    const c = this.club;
    if (this.state !== 'address' || !c || !this.powerReady || this.suggestedPower == null) return null;
    const sp = this.suggestedPower, full = sp >= 0.97;
    const pct = full ? 100 : Math.max(5, Math.round(sp * 20) * 5);
    const where = c.putter ? this.fmtPutt(this.puttEqFt) : full ? '' : this.fmtDist(this.pl ? this.pl.plays : this.distToPin());
    const words = (t) => t.replace(/(\d+)%/, '$1 percent').replace(/\b(\d+) yds\b/g, '$1 yards').replace(/\b(\d+(?:\.\d)?) m\b/g, '$1 metres').replace(/\b(\d+) ft\b/g, '$1 feet');
    const id = this.settings.caddie;
    const cnt = tempo.counts === 3 ? '' : ` ${tempo.counts === 2 ? 'Two' : tempo.counts} counts back, one through.`;
    if (!CADDIES[id]) {
      const head = `${c.name}${where ? `, ${where}` : ''}.`;
      const how = full ? 'Go all out.' : `Hit this about ${pct}%.`;
      return { text: `${head} ${how}${cnt}`, say: words(`${head} ${how}${cnt}`), pct, err: 0 };
    }
    // what Angus knows about the course: the caddie's aim and lie notes, the trees, the break
    const m = this.caddie.msg || '';
    const tip = this.caddie.blockedNote() || (/^(Aim|Favour|Greenside|Heavy lie)/.test(m) ? m : '')
      || (c.putter && this.puttRead && Math.abs(this.puttRead.brk) > 0.05 ? `Breaks ${this.puttRead.brk > 0 ? 'right to left' : 'left to right'}.` : '');
    // the first club of a shot gets the full word; changing club just gets the new number
    const shotKey = `${this.round?.i}|${this.strokes}`;
    if (this.fullShot !== shotKey) { this.fullShot = shotKey; this.fullClub = c.key; }
    const lie = this.lieKey();
    const color = this.strokes === 0 && !c.putter ? 'tee' : lie === 'bunker' ? 'bunker' : ['rough', 'deep', 'straw'].includes(lie) && !c.putter ? 'rough'
      : c.putter && this.puttEqFt <= 6 ? 'shortPutt' : this.lastKind === 'miss' ? 'afterMiss' : this.lastKind === 'great' ? 'afterGreat' : '';
    const out = advice(id, {
      short: c.key !== this.fullClub, color,
      club: c.name, dist: where, pct, full, putt: !!c.putter,
      wind: this.pl ? this.pl.windAdj / YD : 0, elev: this.pl ? this.pl.elevAdj / YD : 0, tip,
      seed: `${this.round?.i}|${this.strokes}|${c.key}`, greet: !this.greeted,
    });
    return { ...out, text: out.text + cnt, say: words(out.say + cnt) };
  }
  // the blue mark on the swing follows what the caddie says (Nigel is sometimes a tad out)
  syncTarget() {
    setCounts(countsFor(this.club, this.suggestedPower)); // (the count depends on the club and how hard it is to be hit)
    const a = this.analogAdvice();
    this.mouseSwing.target = a ? a.pct / 100 : this.suggestedPower;
    this.adviceErr = a?.err || 0;
  }
  fmtPutt(eqFt) { return fmtFt(eqFt, this.settings.units); }

  // say it once per club and number at an address, a moment after the number settles
  sayAdvice() {
    clearTimeout(this.adviceT);
    const a = this.analogAdvice();
    if (!a || !this.settings.caddyVoice) return;
    const key = `${this.settings.caddie}|${this.round?.i}|${this.strokes}|${this.club.key}|${a.pct}`;
    if (key === this.spokenKey) return;
    this.adviceT = setTimeout(() => {
      if (this.state !== 'address' || this.ui.paused) return;
      this.spokenKey = key; this.greeted = true;
      say(a.say, this.settings.volume, CADDIES[this.settings.caddie]?.voice);
    }, 900);
  }

  // picking a caddie in the menu: he says hello, so you can hear who you're getting
  auditionCaddie(id) {
    if (this.settings.caddyVoice) say(greeting(id).replace(/\*hic\*/g, 'hic'), this.settings.volume, CADDIES[id].voice);
  }

  // the caddie's word on a shot that went very well or very badly (Angus blames you)
  caddieReact(info, sg) {
    // one note in the result card: how the shot went, then (analog swing) a word on the tempo
    const p = CADDIES[this.settings.caddie], kind = judgeShot(info, sg), tempoText = this.tempoNote;
    const tempoSpoken = this.tempoKind !== 'pure';
    this.tempoNote = null;
    if (!p || this.tutorial) return;
    this.missStreak = kind === 'miss' ? (this.missStreak || 0) + 1 : 0;
    this.lastKind = kind;
    const situation = situationOf(info, { tee: this.shotStart?.isTee, par: this.hole.par, strokes: this.strokes });
    this.recent = this.recent || [];
    const line = reaction(p.id, kind || 'ok', { err: this.adviceErr, situation, streak: this.missStreak, avoid: this.recent });
    this.recent = [...this.recent, line, tempoText].filter(Boolean).slice(-8);
    const plain = (t) => t.replace(/\*hic\*\s?/g, '');
    this.ui.caddieNotes([{ title: p.name, text: [line, tempoText].filter(Boolean).map(plain).join(' ') }]);
    // only the big moments are spoken (a swing's tempo was spoken at the swing)
    const moment = kind || situation;
    const spoken = [moment && !(kind === 'great' && !situation && Math.random() > 0.7) ? line : '', tempoText && (tempoSpoken || !moment) ? tempoText : ''].filter(Boolean).map(plain).join(' ');
    if (spoken && this.settings.caddyVoice) say(spoken, this.settings.volume, p.voice);
  }

  // Shift + swing: the same swing and the same feedback, but the ball stays put
  practiceSwing(r) {
    // the golfer swings through at the same power, and the ball stays where it is
    this.golfer.startSwing(this.club.putter ? r.power : clamp(r.power, 0.35, 1.05), () => {});
    this.golfer.phase = 'down'; this.golfer.t = 0;
    this.practicing = true; // (the frame loop ends it when the follow-through is done)
    const e = r.backTime - tempo.back;
    const kind = Math.abs(e) <= tempo.pure ? 'pure' : e < 0 ? 'quick' : 'slow';
    const p = CADDIES[this.settings.caddie];
    const line = (p ? tempoLine(p.id, kind) : { pure: 'Smooth tempo.', quick: 'Too quick.', slow: 'Too slow.' }[kind]);
    this.ui.toast(`Practice swing: ${line}`);
    this.practiceLine = this.settings.caddyVoice ? { line, voice: p?.voice } : null;
  }
  endPractice() {
    this.practicing = false;
    this.golfer.phase = 'idle';
    if (this.state === 'swing') this.state = 'address';
    if (this.practiceLine) say(this.practiceLine.line, this.settings.volume, this.practiceLine.voice);
    this.practiceLine = null;
  }

  // a backswing on the count (3 counts at the chosen tempo) is a pure strike; off it costs contact and turns the face
  mouseDone(r) {
    let tempoFace = 0;
    if (r.backTime != null) {
      const putt = !!this.club.putter;
      const zone = (putt ? this.diff.puttZone : this.diff.zone) * this.lieZone();
      const t = meterToStrike(tempoToMeterError(r.backTime, zone), zone, putt);
      tempoFace = t.face;
      r = { ...r, face: r.face + t.face, strike: r.strike * t.strike };
      if (this.mouseSwing.result) Object.assign(this.mouseSwing.result, { finalFace: r.face, tempoFace: t.face }); // (what the readout shows)
    }
    if (r.practice) { this.practiceSwing(r); return; }
    this.tempoNote = null;
    // what the backswing did to the face, so the shot tip can name it when it explains the curve
    const e = r.backTime != null ? r.backTime - tempo.back : 0;
    const kind = r.backTime == null ? null : Math.abs(e) <= tempo.pure ? 'pure' : e < 0 ? 'quick' : 'slow';
    this.swingTempo = kind && { kind, face: tempoFace, back: r.backTime, want: tempo.back };
    this.executeSwing(r);
    if (!kind) return;
    const p = CADDIES[this.settings.caddie];
    // shown in the result card, and spoken with the caddie's word on the shot (a pure swing is only mentioned there)
    this.tempoKind = kind;
    this.tempoNote = p ? tempoLine(p.id, kind, Math.random, this.recent) : null;
    if (!p && this.settings.caddyVoice) say({ pure: 'Smooth tempo.', quick: 'Too quick.', slow: 'Too slow.' }[kind], this.settings.volume);
  }

  // ------------------------------------------------------------------ previews
  updatePreview() {
    this.previewDirty = false;
    this.powerJob = null;
    this.powerReady = false; // (the caddie's number for this shot is not worked out yet)
    const h = this.hole, b = this.ball, w = this.world;
    const dir = dirOf(this.aim);
    const assist = this.diff;
    this.previewBlocked = null;
    if (this.club.putter) {
      w.reticle.visible = false;
      w.arc.visible = false;
      this.suggestedPower = clamp(this.puttEqFt / this.puttRange, 0.02, 1);
      this.powerReady = true; this.syncTarget();
      this.caddieNote(); this.sayAdvice();
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
      w.reticle.scale.setScalar(clamp(carry / 40, 0.8, 8));
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
    // the caddie's number takes a dozen full sims (~10 ms, more on a phone), so it is worked
    // out a few milliseconds a frame from the next one (stepPower) rather than in this one
    if (need < flatCarry * 1.12) this.powerJob = this.caddie.powerSteps(need);
    else this.setSuggestedPower(1);
  }
  stepPower(budget = SLICE_MS) {
    const t0 = performance.now();
    for (;;) {
      const r = this.powerJob.next();
      if (r.done) { this.powerJob = null; this.setSuggestedPower(r.value); return; }
      if (performance.now() - t0 >= budget) return;
    }
  }
  setSuggestedPower(p) {
    // never below the shortest real swing: under it every swing is a chunk (normalizeSwing)
    this.suggestedPower = Math.max(p, MIN_SWING + 0.01);
    this.powerReady = true; this.syncTarget();
    this.caddie.checkBlocked(this.suggestedPower);
    this.caddieNote();
    this.sayAdvice();
  }

  // ------------------------------------------------------------------ swing
  get addressSettling() { return performance.now() - (this.addressAt || 0) < 350; }

  lieZone() { return lieZoneFor(this.ball, this.hole, this.club, this.aim); }

  // every input path (mouse swing, touch drag, gamepad stick) ends up here
  executeSwing(sw) {
    sw = normalizeSwing(sw, !!this.club.putter);
    this.state = 'backswing';
    this.caddie.analysis = null;
    this.caddie.reading = null;
    this.pendingSwing = sw;
    clearTimeout(this.adviceT);
    this.golfer.startSwing(this.club.putter ? sw.power : clamp(sw.power, 0.35, 1.05), () => this.impact());
    this.golfer.phase = 'down'; this.golfer.t = 0;
    this.world.reticle.visible = false;
    this.world.arc.visible = false;
    this.world.puttLine.visible = false;
    this.ui.caddie('');
  }

  shotSeed() { return shotSeedFor(this.round, this.strokes); }

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
    const live = $('dPin'), ld = this.flightDist();
    if (live.textContent !== ld) live.textContent = ld;
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
    return shotInfoFor({ sim: this.sim, hole: this.hole, shotStart: this.shotStart, club: this.club, ld: this.shotLD, landV: this.landV, puttElevIn: this.puttElevIn, tempo: this.swingTempo });
  }

  onBallStop() {
    const sim = this.sim, S = this.shotStart;
    this.input.touchHeld.fastForward = false;
    this.ui.ffHint(false);
    this.ffUsed = false;
    this.timeScale = 1;
    const info = this.shotInfo();
    this.lastInfo = info;
    this.lastSg = null;
    this.state = 'result';
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
    this.caddieReact(r.result === 'holed' ? { ...info, holed: true } : info, r.sg);
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

  showResult(info, sg) {
    this.ui.showShotPanel({ info, sg, fmt: (m) => this.fmtDist(m), tips: coachShot(info, this.settings.units), canReplay: !!this.rec?.length });
    if (info.result === 'water') this.ui.banner('Penalty area', 'bad');
    else if (info.result === 'ob') this.ui.banner('Out of bounds', 'bad');
    this.updateHUD(true);
  }

  continueAfterResult() {
    if (this.state !== 'result') return;
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
    this.ui.toast(this.ui.touch ? 'Replay – tap to return' : `Replay – ${this.ui.key('swing')} to return`);
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
    this.showResult(this.lastInfo, this.lastSg);
  }

  // ------------------------------------------------------------------ hole / round end
  finishHole(pickedUp = false) {
    const r = this.round, h = this.hole, strokes = this.strokes;
    finishHoleScore(r, h, strokes, { pickedUp });
    this.ui.showShotPanel(null);
    const turn = nextTurn(r);
    this.state = 'scorecard';
    this.cam.orbitGreen();
    const last = turn === 'end';
    this.saveProgress(last ? { done: true } : { i: r.i + 1 });
    this.ui.scorecard(this.course, r, true, () => {
      if (last) this.endRound();
      else { nextHole(r); this.loadHole(); }
    }, last ? 'Finish round' : 'Next hole');
  }

  endRound() {
    const r = this.round;
    if (!this.tutorial && resumable(r.opts)) this.clearProgress();
    this.state = 'summary';
    this.cam.orbitGreen();
    this.tutorial?.end();
    const history = loadHistory();
    const prevBest = !this.course.generated ? bestFor(history, this.course.id, r.mode, r.tees) : null;
    const played = r.played ?? { profile: this.settings.profile, difficulty: this.settings.difficulty };
    if (r.scores.length) {
      saveRound(roundEntry({
        course: this.course, mode: r.mode, holes: r.scores, totals: r.stats.totals(), profile: played.profile,
        difficulty: played.difficulty, tees: r.tees, seed: r.seed,
      }));
    }
    if (r.daily) {
      try {
        const key = `psg-daily-${r.daily}`;
        const t = r.stats.totals();
        const old = JSON.parse(localStorage.getItem(key) || 'null');
        if (!old || t.strokes - t.par < old.toPar) localStorage.setItem(key, JSON.stringify({ toPar: t.strokes - t.par, strokes: t.strokes }));
      } catch (e) { /* ignore */ }
    }
    this.ui.summary(this.course, r, r.stats.totals(), prevBest, { ...this.settings, ...played });
  }

  // the round so far, for "Resume round" on the menu (not the guided first hole)
  saveProgress(at) {
    if (!this.round || this.tutorial || !resumable(this.round.opts)) return;
    try { localStorage.setItem(RESUME_KEY, JSON.stringify(roundSnapshot(this.round, at))); } catch (e) { /* ignore */ }
  }
  clearProgress() { try { localStorage.removeItem(RESUME_KEY); } catch (e) { /* ignore */ } }

  quitToMenu() {
    this.ui.showHUD(false);
    document.body.classList.remove('flyover');
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
    // After the ball stops the club, plays-like and putt-speed numbers describe the shot just played,
    // so the HUD shows only where the ball finished (and "Holed" once it drops) until the next address.
    const resting = this.state === 'result' || this.state === 'replay';
    const holed = resting && this.resultNext === 'holed';
    // a hole counts toward the running score the moment it drops, not only once the scorecard is shown
    const toPar = r.scores.reduce((s, x) => s + x.strokes - x.par, 0) + (holed ? this.strokes - h.par : 0);
    const flying = this.state === 'flight' && this.sim;
    const fromSim = flying || (resting && this.sim && this.resultNext === 'water');
    const b = fromSim ? { p: this.sim.p, surface: this.lastInfo?.after || this.ball.surface } : this.ball;
    const d = holed ? 0 : distToPin(h, b);
    const feet = this.club.putter || (resting ? b.surface === 'green' : this.onGreen);
    const lk = this.lieKey();
    const lie = LIES[lk] || LIES.rough;
    this.ui.hud({
      hole: h.number, name: h.name, par: h.par, yards: h.yards,
      shot: holed ? `Holed in ${this.strokes}` : `Shot ${this.strokes + (this.state === 'flight' ? 0 : 1)}`, toPar,
      dist: holed ? 'Holed' : flying ? this.flightDist() : feet ? (this.settings.units === 'm' ? fmtFt(d / FT, 'm') : `${(d / FT).toFixed(d / FT < 10 ? 1 : 0)} ft`) : this.fmtDist(d),
      plays: this.pl && !this.club.putter && !resting ? this.fmtDist(this.pl.plays) : null,
      elev: holed ? 0 : (h.height(h.cup.x, h.cup.z) - (b.p[1] - BALL.radius)) / FT,
      puttEq: this.club.putter && !resting ? this.puttEqFt : null,
      nearGreen: this.nearGreen(),
      wind: this.windRel(), windMph: this.windMph,
      tempoNote: tempoNote(this.club), tempoAlt: tempo.counts !== 3,
      club: this.club, clubCarry: this.club.putter ? `${fmtFt(this.puttRange, this.settings.units)} range` : `Carry ${this.fmtDist(this.club.carry)} · Total ${this.fmtDist(this.club.total)}`,
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
    if (this.gfxLost) { this.last = t; return; }
    this.post.sample(t - this.last);
    const dt = Math.min(0.05, (t - this.last) / 1000);
    this.last = t;
    this.frame(dt);
  }

  // advance the simulation n frames without requestAnimationFrame (testing/debugging)
  debugStep(n = 1, dt = 1 / 60) { for (let i = 0; i < n; i++) this.frame(dt); }

  // with the ball away the distance box is just a gauge: how far the ball still is from the pin, closing as it flies
  flightDist() {
    const d = distToPin(this.hole, { p: this.sim.p });
    return this.club.putter ? fmtFt(d / FT, this.settings.units) : this.fmtDist(d);
  }

  // A far flag is only a few pixels, and on a tee shot the green can be out of view or off
  // to one side: a tag over the flag (an arrow at the screen edge when it is off to the side)
  // says where the pin is and how far, whatever the HUD detail.
  updatePinTag(show) {
    const el = this.pinTagEl || (this.pinTagEl = document.getElementById('pinTag'));
    if (!el) return;
    const h = this.hole;
    if (!show || !h || !this.club || this.cam.targetView) {
      if (!el.classList.contains('hidden')) el.classList.add('hidden');
      document.body.classList.remove('pintag');
      return;
    }
    const c = h.cup, cam = this.camera;
    const v = (this.pinV = this.pinV || new THREE.Vector3()).set(c.x, h.height(c.x, c.z) + 2.6, c.z);
    const fwd = (this.pinF = this.pinF || new THREE.Vector3());
    cam.getWorldDirection(fwd);
    const behind = (v.x - cam.position.x) * fwd.x + (v.y - cam.position.y) * fwd.y + (v.z - cam.position.z) * fwd.z <= 0;
    v.project(cam);
    const W = innerWidth, H = innerHeight, m = Math.max(46, (el.offsetWidth || 0) / 2 + 8);
    if (!W || !H) return;
    let x = (v.x * 0.5 + 0.5) * W, y = (-v.y * 0.5 + 0.5) * H, side = 0;
    if (behind) { side = v.x > 0 ? -1 : 1; x = side < 0 ? m : W - m; y = H * 0.3; }
    else if (x < m) { side = -1; x = m; } else if (x > W - m) { side = 1; x = W - m; }
    if (side) y = clamp(y, 120, H * 0.5);
    else y = clamp(y - 20, 100, H * 0.55);
    // on a phone the top-right corner holds the wind, distance and lie boxes and the minimap: keep the tag between them
    if (W < 480 && x > W - 175) y = clamp(y, 150, 208);
    // keep the tag off the golfer's head when the flag lines up behind them
    if (this.golfer?.head) {
      const hv = (this.pinH = this.pinH || new THREE.Vector3());
      this.golfer.head.getWorldPosition(hv);
      hv.y += 0.12; // the cap
      hv.project(cam);
      const hx = (hv.x * 0.5 + 0.5) * W, hy = (-hv.y * 0.5 + 0.5) * H;
      if (Math.abs(x - hx) < el.offsetWidth / 2 + 28 && y > hy - 78 && y < hy + 44) y = Math.max(70, hy - 58);
    }
    // on a phone the tag carries the distance panel's numbers, so the panel steps aside
    const dist = this.distToPin(), plays = this.pl?.plays;
    const feet = this.club.putter || this.onGreen;
    const dtxt = feet ? (this.settings.units === 'm' ? fmtFt(dist / FT, 'm') : `${(dist / FT).toFixed(dist / FT < 10 ? 1 : 0)} ft`) : this.fmtDist(dist);
    const pl = this.club.putter ? ` · stroke ${this.fmtPutt(this.puttEqFt)}` : plays && Math.abs(plays - dist) >= 1.5 * YD ? ` · plays ${this.fmtDist(plays)}` : '';
    const e = Math.round((h.height(c.x, c.z) - (this.ball.p[1] - BALL.radius)) / FT);
    const up = Math.abs(e) >= 1 ? ` · ${e > 0 ? '▲' : '▼'} ${fmtElev(e, this.settings.units)}` : '';
    const mk = (a, b) => `${side < 0 ? '◀ ' : ''}⚑ ${dtxt}${a}${b}${side > 0 ? ' ▶' : ''}`;
    const text = mk(pl, up);
    if (el.textContent !== text) el.textContent = text;
    document.body.classList.add('pintag');
    el.classList.remove('hidden');
    // a narrow screen drops the elevation, then the plays-like, before the tag would run off the edge
    if (el.offsetWidth > W - 16 && up) el.textContent = mk(pl, '');
    if (el.offsetWidth > W - 16 && pl) el.textContent = mk('', '');
    // never sit on top of a card: slide to whichever side of it is nearest (it reads as a pill hanging off the card)
    const tw = el.offsetWidth, th = el.offsetHeight, pad = 8;
    this.pinAvoid = this.pinAvoid || ['holeCard', 'distBox', 'windBox', 'clubBox', 'minimap', 'caddie'].map((id) => document.getElementById(id));
    const rects = this.pinAvoid.filter(Boolean).map((n) => n.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0);
    for (let pass = 0; pass < 4; pass++) {
      const hit = rects.find((r) => x + tw / 2 > r.left - pad && x - tw / 2 < r.right + pad && y + th / 2 > r.top - pad && y - th / 2 < r.bottom + pad);
      if (!hit) break;
      const free = (nx, ny) => nx - tw / 2 >= 4 && nx + tw / 2 <= W - 4 && ny - th / 2 >= 4 && ny + th / 2 <= H - 4;
      const opts = [[x, hit.bottom + pad + th / 2], [x, hit.top - pad - th / 2], [hit.right + pad + tw / 2, y], [hit.left - pad - tw / 2, y]]
        .filter(([nx, ny]) => free(nx, ny)).sort((p, q) => Math.hypot(p[0] - x, p[1] - y) - Math.hypot(q[0] - x, q[1] - y));
      if (!opts.length) break;
      [x, y] = opts[0];
    }
    x = clamp(x, 8 + tw / 2, Math.max(8 + tw / 2, W - 8 - tw / 2));
    y = clamp(y, 8 + th / 2, Math.max(8 + th / 2, H - 8 - th / 2));
    el.style.transform = `translate(${x.toFixed(0)}px, ${y.toFixed(0)}px) translate(-50%, -50%)`;
  }

  frame(dt) {
    const st = this.state;
    if (!this.ui.paused) {
      this.input.update(dt);
      if (st === 'flyover') { if (this.cam.flyover(dt)) this.endFlyover(); }
      else if (st === 'address') {
        if (this.caddie.analysis) this.caddie.stepAnalysis();
        if (this.caddie.reading) this.caddie.stepReading();
        if (this.powerJob && !this.previewDirty) this.stepPower(); // (a new preview replaces it)
        if (this.previewDirty) {
          // rebuild the preview as often as the device can afford (a held aim key keeps it dirty), not on a fixed beat
          this.previewT = (this.previewT || 0) + dt;
          if (this.previewT > (this.previewGap ?? 0.04)) {
            this.previewT = 0;
            const t0 = performance.now();
            this.updatePreview(); this.updateHUD(true);
            this.previewGap = clamp((performance.now() - t0) * 0.004, 0.03, 0.12);
          }
        }
        this.caddieTick = (this.caddieTick || 0) + dt;
        if (this.caddieTick > 0.5) { this.caddieTick = 0; this.caddieNote(); }
      } else if (st === 'swing') hush();
      else if (st === 'flight') this.updateFlight(dt);
      else if (st === 'replay') this.updateReplay(dt);
      if (['backswing', 'flight', 'result', 'address', 'swing', 'flyover', 'replay'].includes(st) && !(st === 'flight' && this.hang > 0)) this.golfer.update(dt);
      if (this.practicing && this.golfer.phase === 'hold') this.endPractice();
      // camera targets
      if (st === 'address' || st === 'swing' || st === 'backswing') {
        const c = this.cam.targetView ? this.cam.target() : this.cam.address();
        this.cam.set(c.pos, c.look, this.cam.targetView ? 3 : 5);
        this.cam.fov = 50;
      } else if (st === 'menu' || st === 'scorecard' || st === 'summary') this.cam.menu(dt);
      this.cam.apply(dt);
      this.mouseSwing.update();
    }
    this.updatePinTag(st === 'address' || st === 'swing' || st === 'backswing');
    // ball visibility scale with distance
    const dCam = this.camera.position.distanceTo(this.ballMesh.position);
    this.ballMesh.scale.setScalar(clamp(dCam / 7, 1.3, 14));
    if (this.hole) this.world.update(dt, this.env ? this.env.wind : [0, 0, 0], this.ballMesh.visible ? this.ballMesh.position : this.cam.look);
    // the touch buttons and cards follow the game state, even mid-swing when the HUD numbers are not refreshed
    if (st !== this.hudState) { this.hudState = st; this.ui.setState(st); }
    this.hudTimer += dt;
    if (this.hudTimer > 0.25 && (st === 'address' || st === 'flight')) { this.hudTimer = 0; this.updateHUD(st === 'flight' || this.ui.mmDirty); }
    this.tutorial?.update(dt);
    this.post.render();
  }
}
