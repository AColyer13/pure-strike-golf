// Procedural courses: a whole 9-hole course built from a seed. The same seed always
// gives the same holes, so a "Random holes" round can still be shared as a challenge.
// Style, palette and sky come from one of the tribute courses, lightly varied.
import { mulberry32 } from '../hole.js';

const NAMES_A = ['Lone', 'Hidden', 'Whispering', 'Long', 'Broken', 'Heron', 'Fox', 'Cedar', 'Quarry', 'Mill', 'Kestrel', 'Devil’s', 'Saddle', 'Shepherd’s', 'Copper', 'Cliff'];
const NAMES_B = ['Pines', 'Hollow', 'Ridge', 'Run', 'Bend', 'Bowl', 'Point', 'Gully', 'Knoll', 'Brook', 'Corner', 'Dell', 'Lookout', 'Gate', 'Shelf', 'Spur'];
const COURSE_A = ['Kestrel', 'Silver', 'Highland', 'Wolf', 'Briar', 'Marsh', 'Hawk', 'Granite', 'Willow', 'Thistle'];
const COURSE_B = ['Links', 'National', 'Dunes', 'Heath', 'Park', 'Valley', 'Downs', 'Commons'];

const cache = new Map();

export function generateCourse(seed, templates) {
  const key = `${seed}`;
  if (cache.has(key)) return cache.get(key);
  const rnd = mulberry32((seed ^ 0x9e3779b9) >>> 0);
  const r = (a, b) => a + (b - a) * rnd();
  const ri = (a, b) => Math.floor(r(a, b + 1));
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const sgn = () => (rnd() < 0.5 ? -1 : 1);

  const base = pick(templates.filter((t) => t.id !== 'pebble')); // no cliffs: ocean needs hand placement
  const style = structuredClone(base.style);
  style.fairwayWidth = Math.round((style.fairwayWidth || 34) * r(0.9, 1.15));
  style.hills = (style.hills ?? 1) * r(0.6, 1.4);
  if (style.trees) style.trees.density = (style.trees.density ?? 1) * r(0.7, 1.2);

  // par sequence: a balanced 9 (two 3s, two 5s) in random order, never opening on a 3
  let pars;
  do { pars = shuffle([4, 4, 4, 4, 4, 3, 3, 5, 5], rnd); } while (pars[0] === 3);
  const used = new Set();
  const holeName = () => {
    let n;
    do { n = `${pick(NAMES_A)} ${pick(NAMES_B)}`; } while (used.has(n));
    used.add(n);
    return n;
  };

  const holes = pars.map((par) => {
    const h = { name: holeName(), par };
    const tips = [];
    if (par === 3) {
      h.yds = ri(135, 215);
      h.path = [[0, 0], [r(-12, 12), h.yds]];
    } else if (par === 4) {
      h.yds = ri(345, 465);
      const corner = r(230, 275), bend = r(0, 38) * sgn();
      h.path = [[0, 0], [0, corner], [bend, h.yds]];
      if (Math.abs(bend) > 18) tips.push(`A dogleg ${bend > 0 ? 'right' : 'left'} – a ${bend > 0 ? 'fade' : 'draw'} fits the tee shot, or take less club to the corner.`);
    } else {
      h.yds = ri(495, 585);
      const b1 = r(0, 30) * sgn(), b2 = b1 + r(0, 34) * sgn();
      h.path = [[0, 0], [0, r(260, 300)], [b1, h.yds - r(90, 130)], [b2, h.yds]];
      tips.push('Reachable in two only with a big drive. If not, lay up to your favourite full-wedge number.');
    }
    // fairway bunkers around the driving zone
    if (par > 3) {
      h.fb = [];
      const nb = ri(1, 2);
      for (let i = 0; i < nb; i++) h.fb.push([ri(225, 285), sgn() * r(17, 24), r(8, 11), r(5, 7), ri(-20, 20)]);
    }
    // green and its bunkers
    const gw = ri(22, 32), gd = ri(24, 34);
    h.green = {
      w: gw, d: gd, tilt: [+r(-1.6, 1.6).toFixed(1), +r(1, 3).toFixed(1)],
      pins: [[0, Math.round(gd * 0.15)], [-Math.round(gw * 0.18), -Math.round(gd * 0.12)], [Math.round(gw * 0.18), Math.round(gd * 0.05)], [0, -Math.round(gd * 0.2)]],
    };
    if (rnd() < 0.25) h.green.raise = ri(2, 5);
    const slots = shuffle([[-gw / 2 - 3, -gd / 4], [gw / 2 + 3, -gd / 4], [-gw / 2 - 4, gd / 5], [gw / 2 + 4, gd / 5], [0, gd / 2 + 5]], rnd);
    h.gb = slots.slice(0, ri(1, 3)).map(([x, y]) => [Math.round(x), Math.round(y), ri(5, 7), ri(4, 5), ri(-25, 25)]);
    // water: a pond fronting a par 3, or alongside the landing zone on a long hole
    if (rnd() < (par === 3 ? 0.45 : 0.3)) {
      if (par === 3) {
        h.water = [{ k: 'pond', g: [0, -(gd / 2 + 12)], r: [gw / 2 + 8, 10] }];
        tips.push('Water short of the green – take enough club to carry the front edge; long is far better than wet.');
      } else {
        const side = sgn();
        h.water = [{ k: 'pond', s: ri(200, 280), o: side * r(36, 44), r: [r(12, 16), r(40, 60)] }];
        tips.push(`Water lurks ${side > 0 ? 'right' : 'left'} of the landing zone – favour the ${side > 0 ? 'left' : 'right'} half of the fairway.`);
      }
    }
    // elevation change, tee to green (feet)
    const rise = Math.round(r(-18, 18));
    h.elev = [[0, 0], [h.yds, rise]];
    if (Math.abs(rise) >= 10) tips.push(`The green sits ${Math.abs(rise)} ft ${rise > 0 ? 'above' : 'below'} the tee – trust the plays-like number.`);
    h.tip = tips[0] || (par === 3 ? 'Aim for the middle of the green: from 150+ yards even tour players miss most pins by 30 feet.' : 'Find the fairway – from the short grass you can control the spin into the green.');
    return h;
  });

  const course = {
    id: 'gen',
    name: `${pick(COURSE_A)} ${pick(COURSE_B)}`,
    location: `Procedurally generated · #${seed % 100000}`,
    blurb: `A brand-new 9 in the style of ${base.name}. Nobody has played these holes before – read every one fresh.`,
    teaches: ['Reading unfamiliar holes from the flyover', 'Club selection without local knowledge', 'Course management on the fly'],
    seed: (seed % 997) + 1,
    stimp: +r(10, 12.5).toFixed(1),
    firmness: base.firmness,
    rho: base.rho,
    wind: [ri(2, 6), ri(10, 18)],
    sky: base.sky,
    style,
    flag: pick(['#f4d31f', '#d8342c', '#f2f2f2', '#ff8a1f', '#3fa7ff']),
    teeColor: base.teeColor,
    holes,
    generated: true,
  };
  cache.set(key, course);
  return course;
}

function shuffle(a, rnd) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
