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
// Course-editor edits live in a 'custom' copy of one base course: { base, holes: { index: def } }
const CUSTOM_KEY = 'psg-custom-course';
export function loadCustom() {
  try { return JSON.parse(globalThis.localStorage?.getItem(CUSTOM_KEY) || 'null'); } catch (e) { return null; }
}
export function saveCustom(c) {
  try { globalThis.localStorage?.setItem(CUSTOM_KEY, JSON.stringify(c)); } catch (e) { /* storage blocked */ }
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
