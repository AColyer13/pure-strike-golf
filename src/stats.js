// Strokes Gained (Mark Broadie, "Every Shot Counts"): the PGA Tour average
// number of strokes to hole out from a given distance and lie. A shot's
// strokes gained = E(before) - E(after) - 1. Positive = better than a tour pro.
// Tables are approximations of Broadie's published PGA Tour baselines.

const TEE = [[100, 2.92], [120, 2.99], [140, 2.97], [160, 2.99], [180, 3.05], [200, 3.12], [220, 3.17], [240, 3.25], [260, 3.45], [280, 3.65], [300, 3.71], [320, 3.79], [340, 3.86], [360, 3.92], [380, 3.96], [400, 3.99], [420, 4.02], [440, 4.08], [460, 4.17], [480, 4.28], [500, 4.41], [520, 4.54], [540, 4.65], [560, 4.74], [580, 4.79], [600, 4.82], [650, 4.95]];
const FAIRWAY = [[0, 1.0], [5, 2.1], [10, 2.18], [20, 2.40], [40, 2.60], [60, 2.70], [80, 2.75], [100, 2.80], [120, 2.85], [140, 2.91], [160, 2.98], [180, 3.08], [200, 3.19], [220, 3.32], [240, 3.45], [260, 3.58], [280, 3.69], [300, 3.78], [350, 3.95], [400, 4.10], [500, 4.40], [600, 4.75]];
const ROUGH = [[0, 1.0], [5, 2.25], [10, 2.35], [20, 2.59], [40, 2.78], [60, 2.91], [80, 2.96], [100, 3.02], [120, 3.08], [140, 3.15], [160, 3.23], [180, 3.31], [200, 3.42], [220, 3.53], [240, 3.64], [260, 3.74], [280, 3.83], [300, 3.90], [400, 4.20], [600, 4.85]];
const SAND = [[0, 1.0], [5, 2.3], [10, 2.43], [20, 2.53], [40, 2.82], [60, 3.15], [80, 3.24], [100, 3.23], [120, 3.21], [140, 3.22], [160, 3.28], [180, 3.40], [200, 3.55], [220, 3.70], [240, 3.84], [260, 3.93], [280, 4.00], [300, 4.04], [400, 4.30], [600, 4.95]];
const RECOVERY = [[0, 1.0], [20, 3.0], [100, 3.80], [200, 3.87], [300, 4.15], [600, 5.1]];
// green: distance in feet
const GREEN = [[0, 1.0], [1, 1.0], [2, 1.01], [3, 1.04], [4, 1.13], [5, 1.23], [6, 1.34], [7, 1.42], [8, 1.50], [9, 1.56], [10, 1.61], [15, 1.78], [20, 1.87], [30, 1.98], [40, 2.06], [50, 2.14], [60, 2.21], [90, 2.40], [150, 2.65]];

function interp(tab, x) {
  if (x <= tab[0][0]) return tab[0][1];
  for (let i = 1; i < tab.length; i++) {
    if (x <= tab[i][0]) {
      const t = (x - tab[i - 1][0]) / (tab[i][0] - tab[i - 1][0]);
      return tab[i - 1][1] + (tab[i][1] - tab[i - 1][1]) * t;
    }
  }
  const a = tab[tab.length - 2], b = tab[tab.length - 1];
  return b[1] + ((b[1] - a[1]) / (b[0] - a[0])) * (x - b[0]);
}

// lie: surface key, yards (or feet on green), tee flag
export function expectedStrokes(surface, yards, isTee = false) {
  if (isTee) return interp(TEE, yards);
  switch (surface) {
    case 'green': return interp(GREEN, yards * 3);
    case 'fringe': return Math.min(interp(GREEN, yards * 3) + 0.08, interp(FAIRWAY, yards));
    case 'fairway': case 'tee': case 'cut': case 'path': return interp(FAIRWAY, yards) + (surface === 'cut' ? 0.03 : 0);
    case 'bunker': return interp(SAND, yards);
    case 'waste': return (interp(SAND, yards) + interp(FAIRWAY, yards)) / 2;
    case 'straw': return interp(ROUGH, yards) + 0.05;
    case 'second': return (interp(ROUGH, yards) + interp(FAIRWAY, yards)) / 2;
    case 'deep': return (interp(ROUGH, yards) + interp(RECOVERY, yards)) / 2;
    case 'recovery': return interp(RECOVERY, yards);
    default: return interp(ROUGH, yards);
  }
}

// Category for a shot (Broadie): OTT = tee shot on par 4/5, APP = approach
// (>30 yd, incl. par-3 tee shots), ARG = around the green (<=30 yd, off green), PUTT.
export function sgCategory(shot, par) {
  if (shot.surface === 'green') return 'PUTT';
  if (shot.isTee && par >= 4) return 'OTT';
  if (shot.yards > 30) return 'APP';
  return 'ARG';
}

export const SCORE_NAMES = { '-4': 'Condor', '-3': 'Albatross', '-2': 'Eagle', '-1': 'Birdie', '0': 'Par', '1': 'Bogey', '2': 'Double Bogey', '3': 'Triple Bogey' };
export function scoreName(strokes, par) {
  if (strokes === 1) return 'Hole in One!';
  const d = strokes - par;
  return SCORE_NAMES[d] || `+${d}`;
}

export class RoundStats {
  constructor() {
    this.holes = []; // {number, par, strokes, putts, fir, gir, penalties, sg:{OTT,APP,ARG,PUTT}, shots:[]}
  }
  startHole(number, par, yards) {
    this.cur = { number, par, yards, strokes: 0, putts: 0, fir: null, gir: false, penalties: 0, sg: { OTT: 0, APP: 0, ARG: 0, PUTT: 0 }, shots: [] };
    return this.cur;
  }
  // before/after: { surface, yards, isTee }, holed: bool, penalty: strokes added
  recordShot(before, after, holed, penalty = 0) {
    const h = this.cur;
    const eb = expectedStrokes(before.surface, before.yards, before.isTee);
    const ea = holed ? 0 : expectedStrokes(after.surface, after.yards, false);
    const sg = eb - ea - 1 - penalty;
    const cat = sgCategory(before, h.par);
    h.sg[cat] += sg;
    h.shots.push({ ...before, after, sg, cat, penalty });
    if (cat === 'PUTT') h.putts++;
    return { sg, cat, eb, ea };
  }
  finishHole(strokes) {
    const h = this.cur;
    h.strokes = strokes;
    this.holes.push(h);
    this.cur = null;
    return h;
  }
  totals() {
    const t = { strokes: 0, par: 0, putts: 0, fir: 0, firN: 0, gir: 0, penalties: 0, sg: { OTT: 0, APP: 0, ARG: 0, PUTT: 0 } };
    for (const h of this.holes) {
      t.strokes += h.strokes; t.par += h.par; t.putts += h.putts; t.penalties += h.penalties;
      if (h.fir !== null) { t.firN++; if (h.fir) t.fir++; }
      if (h.gir) t.gir++;
      for (const k in t.sg) t.sg[k] += h.sg[k];
    }
    t.sgTotal = t.sg.OTT + t.sg.APP + t.sg.ARG + t.sg.PUTT;
    return t;
  }
}
