// Checks bounce + roll-out on flat fairway / green, and putting distances.
import { BallSim, computeLaunch, stimpToRoll, puttSpeedFor } from '../src/physics.js';
import { buildBag } from '../src/clubs.js';

const YD = 1.09361;
function flatWorld(surface) {
  return {
    height: () => 0, normal: () => [0, 1, 0], surface: () => surface,
    inBounds: () => true, cup: { x: 999, z: 999 }, pinIn: false,
  };
}
const bag = buildBag('tour');
for (const [key, surf] of [['3H', 'green'], ['4I', 'green'], ['DR', 'fairway'], ['3W', 'fairway'], ['5I', 'green'], ['7I', 'green'], ['PW', 'green'], ['SW', 'green'], ['7I', 'rough'], ['DR', 'rough']]) {
  const c = bag.find((b) => b.key === key);
  const sim = new BallSim(flatWorld(surf), { rho: 1.18, wind: [0, 0, 0], firmness: 1, stimp: 12 });
  const ld = computeLaunch(c, { power: 1, face: 0, path: 0, strike: 1, traj: 0, lie: 'fairway' });
  sim.launch([0, 0.021, 0], ld, [0, 0, -1]);
  let n = 0;
  while (sim.state !== 'rest' && n++ < 20000) sim.step(1 / 240);
  const carry = Math.hypot(sim.landed[0], sim.landed[2]) * YD;
  const total = -sim.p[2] * YD;
  console.log(key, surf.padEnd(8), `carry ${carry.toFixed(0)} total ${total.toFixed(0)} roll ${(total - carry).toFixed(1)} yd, bounces ${sim.bounces}, t ${sim.t.toFixed(1)}s`);
}
// putts
for (const ft of [5, 10, 20, 40]) {
  const roll = stimpToRoll(12);
  const v = puttSpeedFor(ft * 0.3048, roll);
  const sim = new BallSim(flatWorld('green'), { rho: 1.18, wind: [0, 0, 0], stimp: 12 });
  sim.putt([0, 0.021, 0], [0, 0, -1], v);
  let n = 0;
  while (sim.state !== 'rest' && n++ < 20000) sim.step(1 / 240);
  console.log(`putt aimed ${ft} ft: rolled ${(-sim.p[2] / 0.3048).toFixed(1)} ft (v0 ${v.toFixed(2)} m/s)`);
}
