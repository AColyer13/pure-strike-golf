// Fits the aerodynamic coefficients so the simulator reproduces TrackMan PGA Tour
// averages (carry, apex height, landing angle). Run: node tools/calibrate.mjs [--fit]
import { AERO, computeLaunch, simulateCarry } from '../src/physics.js';
import { buildBag } from '../src/clubs.js';

const TARGET = { // carry yd, apex yd, land deg
  DR: [275, 32, 37], '3W': [243, 30, 43], '5W': [230, 31, 47], '3H': [225, 29, 47],
  '4I': [203, 28, 48], '5I': [194, 31, 49], '6I': [183, 30, 50], '7I': [172, 32, 50],
  '8I': [160, 31, 50], '9I': [148, 30, 51], PW: [136, 29, 52],
};
const YD = 1.09361;
const env = { rho: 1.18, wind: [0, 0, 0] };
const bag = buildBag('tour');

function run(print) {
  let err = 0;
  for (const c of bag) {
    if (c.putter) continue;
    const ld = computeLaunch(c, { power: 1, face: 0, path: 0, strike: 1, traj: 0, lie: 'fairway' });
    const r = simulateCarry(ld, env);
    const carry = r.carry * YD, apex = r.apex * YD;
    const T = TARGET[c.key];
    if (T) err += ((carry - T[0]) / T[0]) ** 2 * (c.key === 'DR' ? 16 : 4) + ((apex - T[1]) / T[1]) ** 2 + ((r.landAngle - T[2]) / T[2]) ** 2 * 1.5;
    if (print) console.log(c.key.padEnd(3), `carry ${carry.toFixed(0).padStart(4)}${T ? ' (' + T[0] + ')' : ''}`.padEnd(18),
      `apex ${apex.toFixed(0)}${T ? ' (' + T[1] + ')' : ''}`.padEnd(14), `land ${r.landAngle.toFixed(0)}${T ? ' (' + T[2] + ')' : ''}`.padEnd(14),
      `time ${r.time.toFixed(1)}s landSpd ${r.landSpeed.toFixed(1)}`);
  }
  return err;
}

const BOUNDS = { cdHigh: [0.18, 0.3], cdSpin: [0, 0.4], clS0: [0.03, 0.3], clP: [0.5, 2], clMax: [0.2, 0.45], cdLow: [0.3, 0.6], spinTau: [15, 90], cdRe: [-0.03, 0.08] };
if (process.argv.includes('--fit')) {
  const keys = ['cdHigh', 'cdSpin', 'clS0', 'clP', 'clMax', 'cdLow', 'spinTau', 'cdRe'];
  let best = run(false);
  let step = { cdHigh: 0.01, cdSpin: 0.03, clS0: 0.01, clP: 0.05, clMax: 0.02, cdLow: 0.03, cr2: 1, spinTau: 3, cdRe: 0.01 };
  for (let it = 0; it < 250; it++) {
    let improved = false;
    for (const k of keys) {
      for (const s of [1, -1]) {
        const old = AERO[k];
        AERO[k] = Math.min(BOUNDS[k][1], Math.max(BOUNDS[k][0], old + s * step[k]));
        const e = run(false);
        if (e < best) { best = e; improved = true; } else AERO[k] = old;
      }
    }
    if (!improved) for (const k of keys) step[k] *= 0.6;
  }
  console.log('fitted', JSON.stringify(AERO), 'err', best.toFixed(4));
}
run(true);

// Shape checks: 2 degree face-to-path with a 7 iron and driver
for (const key of ['DR', '7I']) {
  const c = bag.find((b) => b.key === key);
  for (const [face, path] of [[0, 0], [2, 4], [-2, -4], [3, 0]]) {
    const ld = computeLaunch(c, { power: 1, face, path, strike: 1, traj: 0, lie: 'fairway' });
    const r = simulateCarry(ld, env);
    console.log(key, `face ${face} path ${path}: start ${ld.hLaunch.toFixed(1)} axis ${ld.axisTilt.toFixed(1)} lateral ${(r.lateral * YD).toFixed(1)} yd`);
  }
}
// Wind check: 7 iron into 10 mph headwind / downwind
for (const w of [-4.47, 4.47]) {
  const c = bag.find((b) => b.key === '7I');
  const ld = computeLaunch(c, { power: 1, face: 0, path: 0, strike: 1, traj: 0, lie: 'fairway' });
  const r = simulateCarry(ld, { rho: 1.18, wind: [0, 0, w] });
  console.log(`7I wind ${w > 0 ? 'down' : 'into'} 10mph: carry ${(r.carry * YD).toFixed(0)}`);
}
