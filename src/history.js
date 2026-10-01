// Round history, personal bests and a handicap-index estimate, kept in
// localStorage. Pure data – no DOM – so it can be unit tested in Node.

const KEY = 'psg-history';
const MAX_ROUNDS = 300;

// Approximate championship-tee ratings for the tribute courses (course rating, slope).
export const RATINGS = {
  augusta: [76.2, 148],
  standrews: [73.1, 132],
  pebble: [75.5, 145],
  sawgrass: [76.4, 155],
};

function storage() {
  try { return globalThis.localStorage || null; } catch (e) { return null; }
}

export function loadHistory() {
  const ls = storage();
  if (!ls) return [];
  try { return JSON.parse(ls.getItem(KEY) || '[]'); } catch (e) { return []; }
}

export function saveRound(entry) {
  const ls = storage();
  const all = loadHistory();
  all.push(entry);
  while (all.length > MAX_ROUNDS) all.shift();
  try { ls?.setItem(KEY, JSON.stringify(all)); } catch (e) { /* storage full / blocked */ }
  return all;
}

export function clearHistory() {
  try { storage()?.removeItem(KEY); } catch (e) { /* ignore */ }
}

// Summarise a finished round (RoundStats totals + context) for storage.
export function roundEntry({ course, mode, holes, totals, profile, difficulty, player, seed, date = new Date() }) {
  return {
    date: date.toISOString(),
    course: course.id, mode, holes: holes.length, player: player || null, seed: seed ?? null,
    strokes: totals.strokes, par: totals.par, putts: totals.putts, penalties: totals.penalties,
    fir: totals.fir, firN: totals.firN, gir: totals.gir,
    sg: { ...totals.sg }, sgTotal: totals.sgTotal,
    profile, difficulty,
  };
}

// Best (lowest to par) completed round per course + mode.
export function bestFor(history, courseId, mode) {
  let best = null;
  for (const r of history) {
    if (r.course !== courseId || r.mode !== mode || r.player) continue;
    const toPar = r.strokes - r.par;
    if (!best || toPar < best.toPar) best = { toPar, strokes: r.strokes, date: r.date.slice(0, 10) };
  }
  return best;
}

// World Handicap System style estimate: score differential = (113 / slope) x
// (gross - rating). A 9-hole score is doubled to an 18-hole equivalent and two of
// them make one round. Index = average of the best N of the last 20 differentials, using the
// WHS table for fewer than 20 rounds. Returns null until 3 rounds (54 holes) exist.
export function handicapIndex(history) {
  const diffs = [];
  for (const r of history) {
    const R = RATINGS[r.course];
    if (!R || r.player || (r.holes !== 18 && r.holes !== 9)) continue;
    const [rating, slope] = R;
    const gross = r.holes === 18 ? r.strokes : r.strokes * 2;
    diffs.push({ d: (113 / slope) * (gross - rating), w: r.holes === 18 ? 1 : 0.5 });
  }
  // combine 9-hole rounds in pairs
  const rounds = [];
  let half = null;
  for (const x of diffs) {
    if (x.w === 1) rounds.push(x.d);
    else if (half == null) half = x.d;
    else { rounds.push((half + x.d) / 2); half = null; }
  }
  const last = rounds.slice(-20);
  const n = last.length;
  if (n < 3) return null;
  // WHS: number of differentials used and adjustment for small samples
  const table = { 3: [1, -2], 4: [1, -1], 5: [1, 0], 6: [2, -1], 7: [2, 0], 8: [2, 0], 9: [3, 0], 10: [3, 0], 11: [3, 0], 12: [4, 0], 13: [4, 0], 14: [4, 0], 15: [5, 0], 16: [5, 0], 17: [6, 0], 18: [6, 0], 19: [7, 0] };
  const [use, adj] = table[n] || [8, 0];
  const best = last.slice().sort((a, b) => a - b).slice(0, use);
  const idx = best.reduce((s, x) => s + x, 0) / use + adj;
  return Math.max(-10, Math.min(54, Math.round(idx * 10) / 10));
}

// Per-category strokes gained per 18 holes over the most recent rounds.
export function sgTrend(history, last = 20) {
  return history.filter((r) => !r.player && r.holes > 0).slice(-last).map((r) => {
    const k = 18 / r.holes;
    return { date: r.date.slice(0, 10), course: r.course, OTT: r.sg.OTT * k, APP: r.sg.APP * k, ARG: r.sg.ARG * k, PUTT: r.sg.PUTT * k, total: r.sgTotal * k, toPar: r.strokes - r.par, holes: r.holes };
  });
}
