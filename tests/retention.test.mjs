// Round setup, challenge links, history/handicap maths and procedural courses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hole } from '../src/hole.js';
import { courseById, COURSES } from '../src/courses/index.js';
import { MODES, dailySpec, holesFor, challengeHash, challengeScore, parseChallenge, seedFrom } from '../src/round.js';
import { coachShot, resetCoach } from '../src/coach.js';
import { roundEntry, bestFor, handicapIndex, sgTrend, loadHistory } from '../src/history.js';

// minimal in-memory localStorage so history.js can be exercised
const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };

const totals = (strokes, par, sgTotal = 0) => ({ strokes, par, putts: 30, penalties: 0, fir: 7, firN: 14, gir: 9, sg: { OTT: sgTotal / 4, APP: sgTotal / 4, ARG: sgTotal / 4, PUTT: sgTotal / 4 }, sgTotal });
const entry = (course, holes, strokes, par, extra = {}) => roundEntry({ course: courseById(course), mode: '18', holes: Array(holes).fill({}), totals: totals(strokes, par), profile: 'scratch', difficulty: 'standard', ...extra });

test('seedFrom is stable and spreads', () => {
  assert.equal(seedFrom('abc'), seedFrom('abc'));
  assert.notEqual(seedFrom('abc'), seedFrom('abd'));
});

test('daily challenge is fixed for a date and varies across dates', () => {
  const a = dailySpec(new Date('2026-10-01T12:00:00Z'));
  const b = dailySpec(new Date('2026-10-01T12:00:00Z'));
  assert.deepEqual(a, b);
  assert.equal(a.holes.length, 3);
  assert.ok(a.holes.every((i) => i >= 0 && i < 18));
  const keys = new Set();
  for (let d = 1; d <= 20; d++) keys.add(JSON.stringify(dailySpec(new Date(Date.UTC(2026, 9, d))).holes));
  assert.ok(keys.size > 5, 'different holes on different days');
});

test('holesFor picks sensible holes per mode', () => {
  assert.equal(holesFor('18', 'augusta').length, 18);
  assert.deepEqual(holesFor('back', 'augusta')[0], 9);
  for (const c of COURSES) {
    assert.equal(c.holes[holesFor('ctp', c.id, 1)[0]].par, 3, `${c.id} ctp is a par 3`);
    assert.ok(c.holes[holesFor('drive', c.id, 1)[0]].par >= 4, `${c.id} drive is a par 4/5`);
  }
  assert.equal(holesFor('random').length, 9);
});

test('challenge links round-trip', () => {
  const r = { course: { id: 'sawgrass' }, mode: 'single', holes: [16], seed: 123456 };
  assert.deepEqual(parseChallenge(challengeHash(r)), { courseId: 'sawgrass', mode: 'single', holes: [16], seed: 123456 });
  const g = { course: { id: 'gen' }, mode: 'random', holes: [0, 1, 2, 3, 4, 5, 6, 7, 8], seed: 99 };
  assert.equal(parseChallenge(challengeHash(g)).courseId, 'gen');
  // a finished round puts its score in the link: strokes, tenths of a foot or yards
  const played = { course: { id: 'sawgrass' }, mode: 'front', holes: [0, 1], seed: 77, balls: 0, players: [{ scores: [{ strokes: 4 }, { strokes: 5 }], attempts: [] }] };
  assert.equal(challengeHash(played), '#c=sawgrass.front.0-1.77.9');
  assert.deepEqual(parseChallenge(challengeHash(played)), { courseId: 'sawgrass', mode: 'front', holes: [0, 1], seed: 77, score: 9 });
  assert.equal(challengeScore({ mode: 'ctp', balls: 3, holes: [0], players: [{ scores: [], attempts: [null, 12.34, 20] }] }), 123);
  assert.equal(challengeScore({ mode: 'drive', balls: 3, holes: [0], players: [{ scores: [], attempts: [240.4, null, 262.6] }] }), 263);
  assert.equal(challengeScore({ mode: 'front', balls: 0, holes: [0, 1], players: [{ scores: [{ strokes: 4 }], attempts: [] }] }), null);
  assert.equal(parseChallenge('#c=sawgrass.front.0-1.77.x'), null);
  assert.equal(parseChallenge('#c=nowhere.18.1.5'), null);
  assert.equal(parseChallenge('#c=augusta.bogus.1.5'), null);
  assert.equal(parseChallenge(''), null);
  for (const m of Object.keys(MODES)) assert.ok(MODES[m].name, `${m} has a name`);
});

test('bestFor ignores other courses, modes and hot-seat players', () => {
  const h = [entry('augusta', 18, 80, 72), entry('augusta', 18, 75, 72), entry('pebble', 18, 70, 72), entry('augusta', 18, 70, 72, { player: 'Sam' })];
  assert.equal(bestFor(h, 'augusta', '18').toPar, 3);
  assert.equal(bestFor(h, 'augusta', 'front'), null);
});

test('handicap index follows the WHS small-sample table', () => {
  const [rating, slope] = [76.2, 148];
  assert.equal(handicapIndex([entry('augusta', 18, 90, 72), entry('augusta', 18, 92, 72)]), null, 'needs 3 rounds');
  // three rounds: lowest differential minus 2
  const h3 = [90, 85, 95].map((s) => entry('augusta', 18, s, 72));
  const best = (113 / slope) * (85 - rating);
  assert.equal(handicapIndex(h3), Math.round((best - 2) * 10) / 10);
  // two 9-hole rounds combine into one 18-hole differential
  const nine = [entry('augusta', 9, 45, 36), entry('augusta', 9, 45, 36)];
  assert.equal(handicapIndex([...h3.slice(0, 2), ...nine]), Math.round(((113 / slope) * (85 - rating) - 2) * 10) / 10);
  // more rounds -> average of the best 8 of the last 20
  const many = Array.from({ length: 25 }, (_, i) => entry('augusta', 18, 80 + (i % 10), 72));
  const diffs = many.slice(-20).map((r) => (113 / slope) * (r.strokes - rating)).sort((a, b) => a - b).slice(0, 8);
  assert.equal(handicapIndex(many), Math.round((diffs.reduce((a, b) => a + b) / 8) * 10) / 10);
});

test('sgTrend scales to 18 holes and skips short rounds', () => {
  const h = [
    roundEntry({ course: courseById('augusta'), mode: 'front', holes: Array(9).fill({}), totals: totals(40, 36, -2), profile: 'scratch', difficulty: 'standard' }),
    roundEntry({ course: courseById('augusta'), mode: 'single', holes: [{}], totals: totals(4, 3, -1), profile: 'scratch', difficulty: 'standard' }),
  ];
  const t = sgTrend(h);
  assert.equal(t.length, 1);
  assert.equal(t[0].total, -4);
});

test('procedural courses are deterministic and playable', () => {
  assert.strictEqual(courseById('gen', 7), courseById('gen', 7), 'cached by seed');
  assert.notDeepEqual(courseById('gen', 7).holes, courseById('gen', 8).holes);
  for (let seed = 1; seed <= 25; seed++) {
    const c = courseById('gen', seed);
    assert.equal(c.holes.length, 9);
    assert.equal(c.holes.reduce((s, h) => s + h.par, 0), 36);
    c.holes.forEach((def, i) => {
      for (let pin = 0; pin < def.green.pins.length; pin++) {
        const h = new Hole(def, c, i, { pinIndex: pin });
        const where = `gen ${seed} #${i + 1} pin ${pin}`;
        assert.equal(h.surface(h.tee.x, h.tee.z), 'tee', `${where}: tee`);
        assert.equal(h.surface(h.cup.x, h.cup.z), 'green', `${where}: cup on green`);
        assert.ok(Number.isFinite(h.height(h.cup.x, h.cup.z)), `${where}: finite terrain`);
      }
    });
  }
});

test('coach: a clean short swing is a partial swing, a bad strike is a mishit', () => {
  const base = { club: { name: '7 Iron' }, result: 'ok', lie: 'fairway', carryFrac: 0.2, duffed: false, par: 4 };
  const title = (s) => { resetCoach(); return coachShot(s)[0]?.title; };
  assert.equal(title({ ...base, strikeQ: 1 }), 'Partial swing');
  assert.equal(title({ ...base, strikeQ: 0.9 }), 'Mishit');
  assert.equal(title({ ...base, duffed: true, strikeQ: 0.9 }), 'Chunked it');
});

test('damaged saved history never breaks loading: junk entries are dropped, gaps are filled', () => {
  store.set('psg-history', '[null, 5, "x", {"x":1}, {"course":"augusta","strokes":80,"par":72,"holes":18}]');
  const h = loadHistory();
  assert.equal(h.length, 1);
  assert.equal(h[0].sgTotal, 0);
  assert.deepEqual(h[0].sg, { OTT: 0, APP: 0, ARG: 0, PUTT: 0 });
  assert.doesNotThrow(() => { sgTrend(h); handicapIndex(h); bestFor(h, 'augusta', '18'); });
  for (const bad of ['{"a":1}', 'null', 'not json', '"str"']) { store.set('psg-history', bad); assert.deepEqual(loadHistory(), []); }
  store.delete('psg-history');
});

test('crafted challenge links must describe a playable round', () => {
  const par3 = courseById('augusta').holes.findIndex((h) => h.par === 3);
  const par4 = courseById('augusta').holes.findIndex((h) => h.par === 4);
  assert.ok(parseChallenge(`#c=augusta.ctp.${par3}.5`));
  assert.equal(parseChallenge(`#c=augusta.ctp.${par4}.5`), null, 'closest to the pin on a par 4');
  assert.ok(parseChallenge(`#c=augusta.drive.${par4}.5`));
  assert.equal(parseChallenge(`#c=augusta.drive.${par3}.5`), null, 'long drive on a par 3');
});

test('closest-to-the-pin falls back to the shortest par 3, and a damaged challenge link is rejected', () => {
  for (const c of COURSES) {
    const par3 = c.holes.filter((h) => h.par === 3);
    const shortest = Math.min(...par3.map((h) => h.yds));
    // hole 1 is not a par 3 on any course here, so the fallback applies
    const i = c.holes[0].par === 3 ? 1 : 0;
    if (c.holes[i].par !== 3) assert.equal(c.holes[holesFor('ctp', c.id, i + 1)[0]].yds, shortest, c.id);
  }
  assert.equal(parseChallenge('#c=garbage'), null);
});
