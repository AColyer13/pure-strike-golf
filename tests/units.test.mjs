import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtWind, fmtYd, fmtElev, localizeText, windUnit } from '../src/units.js';

test('yards mode leaves values alone', () => {
  assert.equal(fmtWind(8, 'yd'), '8 mph');
  assert.equal(fmtYd(150, 'yd'), '150 yds');
  assert.equal(fmtElev(-22, 'yd'), '22 ft');
  assert.equal(localizeText('a 300-yard carry', 'yd'), 'a 300-yard carry');
});

test('metres mode converts wind, distance, elevation and prose', () => {
  assert.equal(fmtWind(10, 'm'), '16 km/h');
  assert.equal(windUnit('m'), 'km/h');
  assert.equal(fmtYd(100, 'm'), '91 m');
  assert.equal(fmtElev(22, 'm'), '7 m');
  assert.equal(fmtElev(1, 'm'), '1 m');
  assert.equal(localizeText('a 300-yard carry', 'm'), 'a 274 m carry');
  assert.equal(localizeText('only ~10 yards deep', 'm'), 'only ~9 m deep');
  assert.equal(localizeText('run 50–60 yards.', 'm'), 'run 46–55 m.');
  assert.equal(localizeText('a 40-foot putt, 100 yds', 'm'), 'a 12 m putt, 91 m');
});
