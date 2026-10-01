// Round setup: which holes, seeds, players and game mode. Everything random in a
// round flows from its seed, so a seed (plus course and holes) reproduces the same
// pins and wind – used for the daily challenge and for shareable challenge links.
import { COURSES, courseById } from './courses/index.js';
import { mulberry32 } from './hole.js';

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

export const dateKey = (d = new Date()) => d.toISOString().slice(0, 10);
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
  if (!m || !courseById(m[1]) || !MODES[m[2]]) return null;
  const holes = m[3].split('-').map(Number).filter((i) => i >= 0 && i < 18);
  if (!holes.length) return null;
  return { courseId: m[1], mode: m[2], holes, seed: +m[4] };
}

// Each course's signature hole (0-based): the menu backdrop and "Play a hole now".
export const SIGNATURE = { augusta: 11, standrews: 17, pebble: 6, sawgrass: 16 };
