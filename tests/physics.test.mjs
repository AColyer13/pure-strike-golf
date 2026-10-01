// Ball-flight regression tests: the simulator must reproduce TrackMan PGA Tour
// averages within tolerance. If a physics change breaks these, re-run
// `node tools/calibrate.mjs --fit` or fix the change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeLaunch, simulateCarry, BallSim, stimpToRoll, puttSpeedFor } from '../src/physics.js';
import { buildBag } from '../src/clubs.js';

const YD = 1.09361; // yards per metre
const env = { rho: 1.18, wind: [0, 0, 0] };
const bag = buildBag('tour');
const club = (k) => bag.find((c) => c.key === k);
const full = (c, o = {}) => computeLaunch(c, { power: 1, face: 0, path: 0, strike: 1, traj: 0, lie: 'fairway', ...o });

// carry yd, apex yd, landing angle deg
const TARGET = {
  DR: [275, 32, 37], '3W': [243, 30, 43], '5W': [230, 31, 47], '3H': [225, 29, 47],
  '4I': [203, 28, 48], '5I': [194, 31, 49], '6I': [183, 30, 50], '7I': [172, 32, 50],
  '8I': [160, 31, 50], '9I': [148, 30, 51], PW: [136, 29, 52],
};

for (const [key, [carry, apex, land]] of Object.entries(TARGET)) {
  test(`${key} matches tour carry / apex / landing angle`, () => {
    const r = simulateCarry(full(club(key)), env);
    assert.ok(Math.abs(r.carry * YD - carry) <= 4.5, `carry ${(r.carry * YD).toFixed(1)} vs ${carry}`);
    assert.ok(Math.abs(r.apex * YD - apex) <= 3.5, `apex ${(r.apex * YD).toFixed(1)} vs ${apex}`);
    assert.ok(Math.abs(r.landAngle - land) <= 3.5, `land ${r.landAngle.toFixed(1)} vs ${land}`);
  });
}

test('bag gaps are monotonic', () => {
  let prev = Infinity;
  for (const c of bag) {
    if (c.putter) continue;
    const carry = simulateCarry(full(c), env).carry;
    assert.ok(carry < prev, `${c.key} carries further than the longer club`);
    prev = carry;
  }
});

test('face-to-path curve is in the TrackMan range', () => {
  // driver: ~4-8 yd of curve per degree of face-to-path (curve = offline minus start line)
  const c = club('DR');
  const ld = full(c, { face: 3, path: 0 });
  const r = simulateCarry(ld, env);
  const startOffset = Math.tan((ld.hLaunch * Math.PI) / 180) * r.carry;
  const curvePerDeg = ((r.lateral - startOffset) * YD) / 3;
  assert.ok(curvePerDeg > 4 && curvePerDeg < 8, `curve ${curvePerDeg.toFixed(1)} yd/deg`);
  // mirror symmetry
  const l = simulateCarry(full(c, { face: -3, path: 0 }), env);
  assert.ok(Math.abs(l.lateral + r.lateral) < 0.05);
});

test('wind: headwind hurts more than tailwind helps', () => {
  const ld = full(club('7I'));
  const base = simulateCarry(ld, env).carry;
  const into = simulateCarry(ld, { rho: 1.18, wind: [0, 0, -4.47] }).carry; // default fwd is +z
  const down = simulateCarry(ld, { rho: 1.18, wind: [0, 0, 4.47] }).carry;
  const hurt = base - into, help = down - base;
  assert.ok(hurt > help && help > 0, `hurt ${hurt.toFixed(1)} help ${help.toFixed(1)}`);
  // rule of thumb: ~1%/mph into, ~0.5%/mph down for a 10 mph wind
  assert.ok(hurt / base > 0.06 && hurt / base < 0.13);
});

test('thin air flies further (Denver vs sea level)', () => {
  const ld = full(club('7I'));
  const sea = simulateCarry(ld, env).carry;
  const mile = simulateCarry(ld, { rho: 0.98, wind: [0, 0, 0] }).carry;
  assert.ok(mile / sea > 1.04 && mile / sea < 1.12);
});

function flat(surface) {
  return { height: () => 0, normal: () => [0, 1, 0], surface: () => surface, inBounds: () => true, cup: { x: 999, z: 999 }, pinIn: false };
}
function runToRest(key, surface, envX = {}) {
  const sim = new BallSim(flat(surface), { rho: 1.18, wind: [0, 0, 0], firmness: 1, stimp: 12, ...envX });
  sim.launch([0, 0.021, 0], full(club(key)), [0, 0, -1]);
  let n = 0;
  while (sim.state !== 'rest' && n++ < 30000) sim.step(1 / 240);
  const carry = Math.hypot(sim.landed[0], sim.landed[2]) * YD;
  return { carry, roll: -sim.p[2] * YD - carry, t: sim.t };
}

test('full wedges check up on a firm green instead of spinning back', () => {
  for (const k of ['PW', 'SW']) {
    const r = runToRest(k, 'green');
    assert.ok(r.roll > -1.5 && r.roll < 4, `${k} roll ${r.roll.toFixed(1)} yd`);
  }
});

test('long irons release more than short irons on the green', () => {
  const r4 = runToRest('4I', 'green'), r9 = runToRest('9I', 'green');
  assert.ok(r4.roll > r9.roll + 2);
});

test('driver rolls out on the fairway, much less in the rough', () => {
  const fw = runToRest('DR', 'fairway'), rough = runToRest('DR', 'rough');
  assert.ok(fw.roll > 12 && fw.roll < 40, `fairway roll ${fw.roll.toFixed(1)}`);
  assert.ok(rough.roll < fw.roll * 0.75);
});

test('putts roll the intended distance on a flat Stimp 12 green', () => {
  for (const ft of [5, 10, 20, 40]) {
    const sim = new BallSim(flat('green'), { rho: 1.18, wind: [0, 0, 0], stimp: 12 });
    sim.putt([0, 0.021, 0], [0, 0, -1], puttSpeedFor(ft * 0.3048, stimpToRoll(12)));
    let n = 0;
    while (sim.state !== 'rest' && n++ < 20000) sim.step(1 / 240);
    assert.ok(Math.abs(-sim.p[2] / 0.3048 - ft) < 0.3, `${ft} ft putt`);
  }
});

test('cup capture: firm centred putts drop, too-fast putts lip or skip', () => {
  const putt = (speed, offset) => {
    const w = { ...flat('green'), cup: { x: offset, z: -2 } };
    const sim = new BallSim(w, { rho: 1.18, wind: [0, 0, 0], stimp: 12 });
    sim.putt([0, 0.021, 0], [0, 0, -1], speed);
    let n = 0;
    while (sim.state === 'roll' && n++ < 20000) sim.step(1 / 240);
    return sim.state;
  };
  assert.equal(putt(1.8, 0), 'holed');  // ~0.9 m/s at the cup
  assert.notEqual(putt(4.0, 0.045), 'holed');
});
