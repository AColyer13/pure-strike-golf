import test from 'node:test';
import assert from 'node:assert/strict';
import { advice, judgeShot, reaction, rngFor, CADDIE_IDS } from '../src/caddies.js';

const base = { club: '7 Iron', dist: '150 yds', pct: 75, full: false, putt: false, wind: 0, elev: 0, tip: '' };

test('a caddie repeats himself for the same shot', () => {
  for (const id of CADDIE_IDS) assert.deepEqual(advice(id, { ...base, seed: 'a' }), advice(id, { ...base, seed: 'a' }));
});

test('every caddie names the club and the number', () => {
  for (const id of ['tech', 'south', 'scot']) {
    const a = advice(id, { ...base, seed: 's1' });
    assert.match(a.text, /7 Iron/);
    assert.match(a.text, /\d+%/);
  }
  assert.match(advice('south', { ...base, seed: 'x' }).text, /around 75%/);
});

test('Nigel is sometimes a tad out, and never by more than 10 points; the others are exact', () => {
  let off = 0;
  for (let i = 0; i < 300; i++) {
    const a = advice('tech', { ...base, seed: i });
    assert.ok(Math.abs(a.pct - 75) <= 10);
    assert.equal(a.err, a.pct - 75);
    if (a.err) off++;
    assert.equal(advice('scot', { ...base, seed: i }).pct, 75);
    assert.equal(advice('south', { ...base, seed: i }).pct, 75);
  }
  assert.ok(off > 30 && off < 150, `${off} of 300 out`);
});

test('a full swing is "all out", not a number', () => {
  const o = { ...base, pct: 100, full: true, dist: '', seed: 'd' };
  assert.doesNotMatch(advice('south', o).text, /%/);
  assert.equal(advice('tech', o).pct, 100);
});

test('Angus slurs and the spoken text has no asterisks', () => {
  let hic = false;
  for (let i = 0; i < 40; i++) { const a = advice('scot', { ...base, seed: i }); if (/\*hic\*/.test(a.text)) hic = true; assert.doesNotMatch(a.say, /\*/); }
  assert.ok(hic);
});

test('judging a shot', () => {
  assert.equal(judgeShot({ result: 'water' }, null), 'miss');
  assert.equal(judgeShot({ result: 'ok', after: 'fairway' }, { sg: 0.6 }), 'great');
  assert.equal(judgeShot({ result: 'ok', after: 'fairway' }, { sg: 0 }), null);
  assert.equal(judgeShot({ result: 'ok', after: 'fairway' }, { sg: -0.8 }), 'miss');
  assert.equal(judgeShot({ holed: true }, null), 'great');
});

test('Angus blames you and Nigel owns up when his number was out', () => {
  const r = rngFor('blame');
  for (let i = 0; i < 20; i++) assert.match(reaction('scot', 'miss', {}, r), /you|number|told|granny|club/i);
  assert.match(reaction('tech', 'miss', { err: 5 }, rngFor('x')), /me|misjudged/);
});
