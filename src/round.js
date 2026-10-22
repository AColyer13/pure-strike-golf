// Round setup: which holes, seeds and game mode. Everything random in a
// round flows from its seed, so a seed (plus course and holes) reproduces the same
// pins and wind – used for the daily challenge and for shareable challenge links.
import { COURSES, courseById } from './courses/index.js';
import { mulberry32, cleanTees } from './hole.js';
import { RoundStats } from './stats.js';
import { MPH, DEG } from './util.js';

export const MODES = {
  '18': { name: '18 holes' },
  front: { name: 'Front 9' },
  back: { name: 'Back 9' },
  single: { name: 'Single hole' },
  daily: { name: 'Daily challenge', desc: 'Three holes, same pins and wind for everyone today.' },
  random: { name: 'Random holes', desc: 'Procedurally generated holes – a new course every time.' },
};

// the player's local calendar day, so "today" rolls over at their midnight, not UTC's
export const dateKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export function seedFrom(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// Daily challenge: course and three consecutive holes picked from the date.
export function dailySpec(date = new Date()) {
  const key = dateKey(date);
  const seed = seedFrom('psg-daily-' + key);
  const rnd = mulberry32(seed);
  const course = COURSES[Math.floor(rnd() * COURSES.length)];
  const start = Math.floor(rnd() * 16);
  return { courseId: course.id, holes: [start, start + 1, start + 2], seed, key };
}

export function holesFor(mode, courseId, single = 1) {
  if (mode === '18') return [...Array(18).keys()];
  if (mode === 'random') return [...Array(9).keys()];
  if (mode === 'front') return [...Array(9).keys()];
  if (mode === 'back') return [...Array(9).keys()].map((i) => i + 9);
  return [(+single || 1) - 1];
}

// Challenge links: #c=<course>.<mode>.<holes>.<seed>[.<tees>][.<score>]
// <tees> is m (middle) or f (forward); the back tees are the default and leave it out.
// The optional score is the sender's total strokes. Links without it still work.
export function challengeScore(r) {
  return r.scores && r.scores.length === r.holes.length ? r.scores.reduce((t, x) => t + x.strokes, 0) : null;
}
export function challengeHash(r) {
  const sc = challengeScore(r);
  const tees = { middle: '.m', forward: '.f' }[r.tees] || '';
  return `#c=${r.course.id}.${r.mode}.${r.holes.join('-')}.${r.seed}${tees}${sc == null ? '' : `.${sc}`}`;
}
export function parseChallenge(hash) {
  const m = /#c=([a-z]+)\.([a-z0-9]+)\.([0-9-]+)\.(\d+)(?:\.([mf]))?(?:\.(\d{1,5}))?(?![\w.])/.exec(hash || '');
  if (!m || !courseById(m[1], +m[4]) || !MODES[m[2]]) return null;
  const course = courseById(m[1], +m[4]);
  const holes = m[3].split('-').map(Number);
  // every hole must exist on that course (the random course has nine), else the link is damaged
  if (!holes.length || holes.some((i) => !(i >= 0 && i < course.holes.length))) return null;
  const c = { courseId: m[1], mode: m[2], holes, seed: +m[4] };
  if (m[5]) c.tees = m[5] === 'm' ? 'middle' : 'forward';
  if (m[6] != null) c.score = +m[6];
  return c;
}

// Each course's signature hole (0-based): the menu backdrop and "Play a hole now".
export const SIGNATURE = { augusta: 11, standrews: 17, pebble: 6, sawgrass: 16 };

// A round: course, hole list, per-hole pins and wind (all drawn from the seed up
// front so a seed always reproduces the same round) and one entry per player.
// opts: { courseId, holes, mode, seed?, daily?: dateKey }
export function createRound(opts) {
  const seed = opts.seed ?? ((Math.random() * 2 ** 32) >>> 0);
  const course = courseById(opts.courseId, seed);
  const rng = mulberry32(seed);
  const windDir = rng() * Math.PI * 2;
  const setup = {};
  for (const idx of opts.holes) {
    const [wmin, wmax] = course.wind;
    // the wind blows from one quarter all round, so it swings round as the holes change direction
    setup[idx] = { pinIndex: Math.floor(rng() * 4), mph: wmin + (wmax - wmin) * Math.pow(rng(), 1.3), ang: windDir - holeHeading(course, idx) + (rng() - 0.5) * 1.4 };
  }
  const tees = opts.daily ? 'back' : cleanTees(opts.tees); // the daily is one course for everyone
  return {
    course, holes: opts.holes, i: 0, seed, mode: opts.mode, daily: opts.daily || null, tees, setup, target: opts.target ?? null,
    opts: { courseId: opts.courseId, holes: opts.holes, mode: opts.mode, seed, daily: opts.daily || null, solo: !!opts.solo, target: opts.target ?? null, tees },
    scores: [],
    stats: new RoundStats(),
  };
}

// A round in progress as plain JSON, so a closed tab, a phone that drops the page in
// the background or lost graphics don't cost the round. `mid` is the place on the
// current hole ({ ball: { p, isTee }, strokes, penalties, ballNo }), null
// before they have teed off; `done` marks a round whose last hole is finished.
export const RESUME_KEY = 'psg-resume';
// only rounds of several holes are saved: a quick single hole never replaces an unfinished 18
export const resumable = (opts) => opts.holes.length > 1;

export function roundSnapshot(round, { mid = null, done = false, i = round.i } = {}) {
  const r = round;
  return {
    v: 2, t: Date.now(), opts: r.opts, i, mid, done,
    scores: r.scores, stats: { holes: r.stats.holes, cur: mid ? r.stats.cur || null : null },
  };
}

// The round a snapshot describes (same course, pins and wind from its seed), or null
// if it is unreadable or its course no longer exists.
export function restoreRound(snap) {
  const s = snap;
  if (!s || s.v !== 2 || !s.opts) return null;
  let r;
  try { r = createRound(s.opts); } catch (e) { return null; }
  if (!r.course) return null;
  if (!(s.i >= 0 && s.i < r.holes.length)) return null;
  r.scores = Array.isArray(s.scores) ? s.scores : [];
  r.stats.holes = Array.isArray(s.stats?.holes) ? s.stats.holes : [];
  r.stats.cur = s.stats?.cur || null;
  r.i = s.i;
  return r;
}

// Compass heading (radians, clockwise) from tee to green. Every hole is built facing the
// same way, so without this the round's wind came from the same side on all 18 holes. A
// course can list its own headings (degrees); otherwise a routing is made up from the
// course seed: each hole turns a right angle or more from the last, as real routings do.
const TURNS = [Math.PI / 2, -Math.PI / 2, Math.PI, 0.75 * Math.PI, -0.75 * Math.PI];
export function holeHeading(course, idx) {
  if (course.headings) return course.headings[idx] * DEG;
  const rng = mulberry32(((course.seed ?? 1) * 7919) >>> 0);
  let h = rng() * Math.PI * 2;
  for (let i = 0; i < idx; i++) h += TURNS[Math.floor(rng() * TURNS.length)] + (rng() - 0.5) * 0.6;
  return h;
}

// Physics environment for a hole from its round setup (wind blows TOWARD setup.ang)
export function holeEnv(course, hole, setup) {
  return { rho: course.rho, wind: [Math.sin(setup.ang) * setup.mph * MPH, 0, -Math.cos(setup.ang) * setup.mph * MPH], firmness: course.firmness, stimp: hole.stimp };
}
