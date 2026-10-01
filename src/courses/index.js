import augusta from './augusta.js';
import standrews from './standrews.js';
import pebble from './pebble.js';
import sawgrass from './sawgrass.js';

// flag colours / tee marker colours per course
augusta.flag = '#f4d31f'; augusta.teeColor = '#2a5fbf';
standrews.flag = '#d8342c'; standrews.teeColor = '#f2f2f2';
pebble.flag = '#f2f2f2'; pebble.teeColor = '#1d3f7a';
sawgrass.flag = '#e23b2f'; sawgrass.teeColor = '#222222';

export const COURSES = [augusta, standrews, pebble, sawgrass];
export const courseById = (id) => COURSES.find((c) => c.id === id);
