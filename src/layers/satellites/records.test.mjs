// Provenance adapter tests for satellite analyst records (graft task 7).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { twoline2satrec } from 'satellite.js';
import { createRecords } from './records.js';
import { isProvenanced } from '../../data/provenance.js';

const ISS_L1 =
  '1 25544U 98067A   08264.51782528 -.00002182  00000-0 -11606-4 0  2927';
const ISS_L2 =
  '2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.72125391563537';
// Element epoch of the fixture above (its own TLE epoch, 2008-09-20).
const ISS_EPOCH_ISO = '2008-09-20T12:25:40.104Z';

const jdFromMs = (ms) => ms / 86_400_000 + 2440587.5;

function fixture({ satrec, propagate, coreStale = false, denseStale = false }) {
  const state = {
    _enabled: true,
    _catalog: new Map([
      [25544, { name: 'ISS (ZARYA)', satrec, group: 'stations' }],
    ]),
    // A rendered point exists, so the pre-graft fallback had a position to
    // resurrect; the adapter must never use it.
    _points: new Map([
      [
        25544,
        { position: Cesium.Cartesian3.fromDegrees(-97.7, 30.2, 420_000) },
      ],
    ]),
    _coreStale: coreStale,
    _denseStale: denseStale,
  };
  const parts = { orbits: { propagatePosition: propagate } };
  return createRecords({ state, parts });
}

const goodPropagation = () => ({
  latitude: 51.64,
  longitude: -97.4,
  altitude: 410_000,
  speedMps: 7660,
});

test('analyst record is provenanced PROPAGATED with source_ts = element epoch', () => {
  const satrec = twoline2satrec(ISS_L1, ISS_L2);
  const { getAnalystRecords } = fixture({ satrec, propagate: goodPropagation });
  const [record] = getAnalystRecords();
  assert.ok(record);
  assert.equal(isProvenanced(record), true);
  assert.equal(record.provenance.source_id, 'celestrak-gp');
  assert.equal(record.provenance.observation_kind, 'PROPAGATED');
  assert.equal(record.provenance.source_ts, ISS_EPOCH_ISO);
  assert.equal(record.elementEpoch, ISS_EPOCH_ISO);
  assert.deepEqual(JSON.parse(JSON.stringify(record)), record);
});

test('elements older than 72 h carry ELEMENTS_AGED and a computed age', () => {
  const satrec = twoline2satrec(ISS_L1, ISS_L2);
  const { getAnalystRecords } = fixture({ satrec, propagate: goodPropagation });
  const [record] = getAnalystRecords();
  assert.ok(record.elementAgeS > 72 * 3600);
  assert.ok(record.provenance.quality_flags.includes('ELEMENTS_AGED'));
});

test('fresh elements carry no ELEMENTS_AGED flag', () => {
  const base = twoline2satrec(ISS_L1, ISS_L2);
  const epochMs = Date.now() - 3600_000;
  const satrec = { ...base, jdsatepoch: jdFromMs(epochMs) };
  const { getAnalystRecords } = fixture({ satrec, propagate: goodPropagation });
  const [record] = getAnalystRecords();
  assert.ok(record);
  assert.equal(record.provenance.source_ts, new Date(epochMs).toISOString());
  assert.ok(record.elementAgeS >= 3599 && record.elementAgeS <= 3605);
  assert.equal(
    record.provenance.quality_flags.includes('ELEMENTS_AGED'),
    false,
  );
});

test('proxy stale signal for the partition maps to ELEMENTS_AGED', () => {
  const base = twoline2satrec(ISS_L1, ISS_L2);
  const satrec = { ...base, jdsatepoch: jdFromMs(Date.now() - 60_000) };
  const { getAnalystRecords } = fixture({
    satrec,
    propagate: goodPropagation,
    coreStale: true,
  });
  const [record] = getAnalystRecords();
  assert.ok(record.provenance.quality_flags.includes('ELEMENTS_AGED'));
});

test('propagation failure yields no record — never a frozen point as current', () => {
  const satrec = twoline2satrec(ISS_L1, ISS_L2);
  const { getAnalystRecords } = fixture({
    satrec,
    propagate: () => null,
  });
  assert.deepEqual(getAnalystRecords(), []);
});
