// Pure scoring: what a finished stroke means for the ball, the stroke count,
// the Strokes Gained record and the hole/round flow. No DOM, no renderer.
import { YD } from './hole.js';
import { MAX_STROKES } from './config.js';
import { findEntry } from './rules.js';

const beforeOf = (S) => ({ surface: S.isTee ? 'tee' : S.surface, yards: S.yards, isTee: S.isTee });

// Settle a stroke once the ball has stopped. `strokes` already counts this stroke.
// stats may be null (challenge modes keep no Strokes Gained).
// Returns { result, next: 'holed'|'next'|'water', ball, after, penalty, strokes, sg, entry }.
export function settleShot({ hole, shotStart: S, sim, info, stats, strokes }) {
  const before = beforeOf(S);
  const result = info.result;
  if (result === 'water') {
    // the stroke is recorded once the drop is chosen (settleRelief)
    info.after = 'water';
    return { result, next: 'water', ball: null, after: null, penalty: 0, strokes, sg: null, entry: findEntry(hole, sim, S.p) };
  }
  let after, penalty = 0, ball;
  if (result === 'holed') {
    after = { surface: 'green', yards: 0 };
    ball = { p: sim.p.slice(), surface: 'green', isTee: false };
  } else if (result === 'ob') {
    penalty = 1;
    after = { surface: S.isTee ? 'fairway' : S.surface, yards: S.yards };
    ball = { p: S.p.slice(), surface: S.surface, isTee: S.isTee };
  } else {
    ball = { p: sim.p.slice(), surface: info.after, isTee: false };
    after = { surface: info.after, yards: Math.hypot(hole.cup.x - sim.p[0], hole.cup.z - sim.p[2]) / YD };
  }
  strokes += penalty;
  let sg = null;
  const cur = stats?.cur;
  if (cur) {
    cur.penalties += penalty;
    sg = stats.recordShot(before, after, result === 'holed', penalty);
    if (S.isTee && hole.par >= 4) cur.fir = info.after === 'fairway';
    if ((info.after === 'green' || result === 'holed') && strokes <= hole.par - 2) cur.gir = true;
  }
  return { result, next: result === 'holed' ? 'holed' : 'next', ball, after, penalty, strokes, sg, entry: null };
}

// Take a relief option (from rules.reliefOptions) after a penalty-area stroke.
export function settleRelief({ shotStart: S, option: o, stats, strokes }) {
  const penalty = 1;
  let sg = null;
  if (stats?.cur) {
    stats.cur.penalties += penalty;
    sg = stats.recordShot(beforeOf(S), { surface: o.surface, yards: o.dist / YD }, false, penalty);
  }
  return { ball: { p: o.p.slice(), surface: o.surface, isTee: !!o.isTee }, penalty, strokes: strokes + penalty, sg };
}

export const pickedUp = (strokes) => strokes >= MAX_STROKES;

// Close the hole for the current player: stats and the score record.
export function finishHoleScore(round, hole, strokes, { pickedUp = false } = {}) {
  const r = round;
  if (r.stats.cur) {
    if (pickedUp) r.stats.cur.pickedUp = true;
    r.stats.finishHole(strokes);
  }
  const score = { number: hole.number, par: hole.par, strokes, pickedUp };
  r.scores.push(score);
  return score;
}

// Who plays next after a hole: 'player' (hot seat, same hole), 'hole' or 'end'.
export function nextTurn(round) {
  const r = round;
  if (r.p < r.players.length - 1) { r.p++; return 'player'; }
  r.p = 0;
  return r.i >= r.holes.length - 1 ? 'end' : 'hole';
}
export function nextHole(round) { round.i++; return round.holes[round.i]; }
