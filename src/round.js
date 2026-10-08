// Round setup: which holes, seeds, players and game mode. Everything random in a
// round flows from its seed, so a seed (plus course and holes) reproduces the same
// pins and wind – used for the daily challenge and for shareable challenge links.
import { COURSES, courseById } from './courses/index.js';
import { mulberry32 } from './hole.js';
import { RoundStats } from './stats.js';
import { MPH, DEG } from './util.js';

export const MODES = {
  '18': { name: '18 holes' },
  front: { name: 'Front 9' },
  back: { name: 'Back 9' },
  single: { name: 'Single hole' },
  daily: { name: 'Daily challenge', desc: 'Three holes, same pins and wind for everyone today.' },
  ctp: { name: 'Closest to the pin', desc: 'Five balls at a par 3. Best distance counts.', balls: 5 },
  drive: { name: 'Long drive', desc: 'Five drives. Longest in the fairway (or first cut) counts.', balls: 5 },
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
  const course = courseById(courseId);
  if (mode === '18') return [...Array(18).keys()];
  if (mode === 'random') return [...Array(9).keys()];
  if (mode === 'front') return [...Array(9).keys()];
  if (mode === 'back') return [...Array(9).keys()].map((i) => i + 9);
  if (mode === 'ctp') {
    // the chosen hole if it is a par 3, else the course's first par 3
    const i = single - 1;
    if (course.holes[i]?.par === 3) return [i];
    return [course.holes.findIndex((h) => h.par === 3)];
  }
  if (mode === 'drive') {
    const i = single - 1;
    if (course.holes[i]?.par >= 4) return [i];
    return [course.holes.findIndex((h) => h.par === 5)];
  }
  return [(+single || 1) - 1];
}

// Challenge links: #c=<course>.<mode>.<holes>.<seed>
export function challengeHash(r) {
  return `#c=${r.course.id}.${r.mode}.${r.holes.join('-')}.${r.seed}`;
}
export function parseChallenge(hash) {
  const m = /#c=([a-z]+)\.([a-z0-9]+)\.([0-9-]+)\.(\d+)/.exec(hash || '');
  if (!m || !courseById(m[1], +m[4]) || !MODES[m[2]]) return null;
  const holes = m[3].split('-').map(Number).filter((i) => i >= 0 && i < 18);
  if (!holes.length) return null;
  return { courseId: m[1], mode: m[2], holes, seed: +m[4] };
}

// Each course's signature hole (0-based): the menu backdrop and "Play a hole now".
export const SIGNATURE = { augusta: 11, standrews: 17, pebble: 6, sawgrass: 16 };

// A round: course, hole list, per-hole pins and wind (all drawn from the seed up
// front so a seed always reproduces the same round) and one entry per player.
// opts: { courseId, holes, mode, seed?, players?: [names], daily?: dateKey }
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
  const names = opts.players?.length ? opts.players : [null];
  const balls = MODES[opts.mode]?.balls || 0;
  return {
    course, holes: opts.holes, i: 0, seed, mode: opts.mode, daily: opts.daily || null, setup, balls,
    players: names.map((name) => ({ name, scores: [], stats: new RoundStats(), attempts: [] })),
    p: 0,
    get player() { return this.players[this.p]; },
    get scores() { return this.player.scores; },
    get stats() { return this.player.stats; },
  };
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

// extra line on the hole intro card
export function introExtra(round) {
  const r = round;
  if (r.balls) return `${MODES[r.mode].name}: ${MODES[r.mode].desc}`;
  if (r.players.length > 1) return `${r.player.name} to play`;
  return '';
}
