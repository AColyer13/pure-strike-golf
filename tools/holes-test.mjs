// Builds every hole of every course, checks the tee/green/pin, and times the terrain functions.
import { Hole, YD } from '../src/hole.js';
import augusta from '../src/courses/augusta.js';
import standrews from '../src/courses/standrews.js';
import pebble from '../src/courses/pebble.js';
import sawgrass from '../src/courses/sawgrass.js';

for (const c of [augusta, standrews, pebble, sawgrass]) {
  let par = 0, yds = 0;
  const t0 = performance.now();
  let calls = 0;
  for (let i = 0; i < c.holes.length; i++) {
    const h = new Hole(c.holes[i], c, i);
    par += h.par; yds += c.holes[i].yds;
    const teeS = h.surface(h.tee.x, h.tee.z), cupS = h.surface(h.cup.x, h.cup.z);
    const B = h.bounds;
    const counts = {};
    for (let k = 0; k < 4000; k++) {
      const x = B.minX + Math.random() * (B.maxX - B.minX), z = B.minZ + Math.random() * (B.maxZ - B.minZ);
      h.height(x, z); calls++;
      const s = h.surface(x, z); counts[s] = (counts[s] || 0) + 1;
    }
    const warn = [];
    if (teeS !== 'tee') warn.push('tee surface=' + teeS);
    if (cupS !== 'green') warn.push('cup surface=' + cupS);
    const cupH = h.height(h.cup.x, h.cup.z), teeH = h.height(h.tee.x, h.tee.z);
    const dist = Math.hypot(h.cup.x - h.tee.x, h.cup.z - h.tee.z) / YD;
    console.log(`${c.id} ${String(i + 1).padStart(2)} par${h.par} ${String(c.holes[i].yds).padStart(3)}y straight ${dist.toFixed(0)} dz ${(cupH - teeH).toFixed(1)}m water ${counts.water || 0} bunker ${counts.bunker || 0} fw ${counts.fairway || 0} ${warn.join(' ')}`);
  }
  const ms = performance.now() - t0;
  console.log(`== ${c.name}: par ${par}, ${yds} yds, ${(ms * 1000 / calls / 2).toFixed(1)} us/call\n`);
}
