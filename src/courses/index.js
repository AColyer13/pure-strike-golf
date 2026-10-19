import augusta from './augusta.js';
import standrews from './standrews.js';
import pebble from './pebble.js';
import sawgrass from './sawgrass.js';
import { generateCourse } from './procedural.js';

// flag colours / tee marker colours per course
augusta.flag = '#f4d31f'; augusta.teeColor = '#2a5fbf';
standrews.flag = '#d8342c'; standrews.teeColor = '#f2f2f2';
pebble.flag = '#f2f2f2'; pebble.teeColor = '#1d3f7a';
sawgrass.flag = '#e23b2f'; sawgrass.teeColor = '#222222';

export const COURSES = [augusta, standrews, pebble, sawgrass];
// Course-editor edits are kept per base course, so working on a second course never loses the first:
// { last: <base id edited most recently>, courses: { <base id>: { holes: { index: def } } } }.
// The 'custom' course played from the menu is the most recently edited one. An older save, a single
// { base, holes } object, is read as that one course.
const CUSTOM_KEY = 'psg-custom-course';
function readCustomStore() {
  let raw = null;
  try { raw = JSON.parse(globalThis.localStorage?.getItem(CUSTOM_KEY) || 'null'); } catch (e) { /* damaged or blocked */ }
  if (raw?.base && raw.holes) return { last: raw.base, courses: { [raw.base]: { holes: raw.holes } } };
  return raw?.courses ? raw : { last: null, courses: {} };
}
// the edits for one base course (default: the one edited last) as { base, holes }, or null
export function loadCustom(baseId) {
  const s = readCustomStore();
  const id = baseId || s.last;
  const c = id && s.courses[id];
  return c?.holes ? { base: id, holes: c.holes } : null;
}
export function saveCustom(c) {
  const s = readCustomStore();
  s.courses[c.base] = { holes: c.holes };
  s.last = c.base;
  try { globalThis.localStorage?.setItem(CUSTOM_KEY, JSON.stringify(s)); } catch (e) { /* storage blocked */ }
}
function customCourse() {
  const c = loadCustom();
  const base = COURSES.find((x) => x.id === c?.base);
  if (!base) return null;
  return { ...base, id: 'custom', name: `${base.name} (custom)`, holes: base.holes.map((h, i) => c.holes[i] || h), custom: true };
}

// 'gen' is a procedurally generated course (its seed picks the layout); 'custom' is the editor's copy
export const courseById = (id, seed = 1) => {
  if (id === 'gen') return generateCourse(seed, COURSES);
  if (id === 'custom') return customCourse();
  return COURSES.find((c) => c.id === id);
};
