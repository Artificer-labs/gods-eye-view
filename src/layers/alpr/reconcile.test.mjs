import test from 'node:test';
import assert from 'node:assert/strict';
import {
  reconcileAlprSnapshots,
  createReconciledAlprSource,
  distanceMeters,
} from './reconcile.js';

const rec = (id, fields = {}) => ({
  id: `alpr:${id}`,
  osmId: id,
  latitude: 30,
  longitude: -97,
  operator: null,
  manufacturer: null,
  cameraType: null,
  zone: null,
  directionDeg: null,
  ref: null,
  lastVerified: null,
  source: null,
  ...fields,
});

test('distance helper is sane', () => {
  // 0.001 degrees of latitude is about 111 m; 0.0001 about 11 m.
  const d1 = distanceMeters({ latitude: 30, longitude: -97 }, { latitude: 30.001, longitude: -97 });
  assert.ok(d1 > 100 && d1 < 125);
  const d2 = distanceMeters({ latitude: 30, longitude: -97 }, { latitude: 30.0001, longitude: -97 });
  assert.ok(d2 > 5 && d2 < 25);
});

test('Overpass wins per node; a >25 m disagreement is flagged, never averaged', () => {
  const { records, stats } = reconcileAlprSnapshots({
    tileRecords: [rec(1, { operator: 'Tile Operator' })],
    overpassRecords: [
      rec(1, { operator: 'Live Operator', latitude: 30.001 }),
    ],
    overpassQuery: { completed: true, saturated: false, at: 1760000000000 },
    now: 1760000000000,
  });
  assert.equal(records.length, 1);
  const [merged] = records;
  assert.equal(merged.operator, 'Live Operator');
  assert.equal(merged.latitude, 30.001);
  assert.deepEqual(merged.witnesses, ['tiles', 'overpass']);
  assert.equal(merged.positionConflict, true);
  assert.deepEqual(merged.provenance.witnesses, ['tiles', 'overpass']);
  assert.equal(stats.merged, 1);
  assert.equal(stats.positionConflicts, 1);
});

test('a sub-25 m disagreement merges without a conflict flag', () => {
  const { records } = reconcileAlprSnapshots({
    tileRecords: [rec(1, {})],
    overpassRecords: [rec(1, { latitude: 30.0001 })],
    overpassQuery: { completed: true, saturated: false },
    now: 1760000000000,
  });
  assert.equal(records[0].positionConflict, false);
  assert.equal(records[0].latitude, 30.0001);
});

test('Overpass-only nodes enter at once, flagged since_extract', () => {
  const { records, stats } = reconcileAlprSnapshots({
    tileRecords: [],
    overpassRecords: [rec(5, { operator: 'Fresh' })],
    overpassQuery: { completed: true, saturated: false },
    now: 1760000000000,
  });
  assert.equal(records[0].sinceExtract, true);
  assert.deepEqual(records[0].witnesses, ['overpass']);
  assert.equal(stats.overpassOnly, 1);
});

test('tile-only absence is noted only under a clean query; a repeat promotes', () => {
  const clean = { completed: true, saturated: false, at: 1760000000000 };
  const first = reconcileAlprSnapshots({
    tileRecords: [rec(3, {})],
    overpassRecords: [],
    overpassQuery: clean,
    now: 1760000000000,
  });
  assert.equal(first.records[0].absenceNoted, true);
  assert.equal(first.records[0].removedCandidate, false);
  const second = reconcileAlprSnapshots({
    tileRecords: [rec(3, {})],
    overpassRecords: [],
    overpassQuery: clean,
    previouslyAbsentIds: ['alpr:3'],
    now: 1760000000000,
  });
  assert.equal(second.records[0].removedCandidate, true);
  assert.equal(second.stats.removedCandidates, 1);
});

test('a saturated or failed query records NO absence', () => {
  for (const overpassQuery of [
    { completed: true, saturated: true },
    { completed: false, saturated: false },
    null,
  ]) {
    const { records, stats } = reconcileAlprSnapshots({
      tileRecords: [rec(4, {})],
      overpassRecords: [],
      overpassQuery,
      previouslyAbsentIds: ['alpr:4'],
      now: 1760000000000,
    });
    assert.equal(records[0].absenceNoted, false);
    assert.equal(records[0].removedCandidate, false);
    assert.equal(stats.absencesNoted, 0);
  }
});

test('the composed source degrades to tiles when the overlay fails', async () => {
  const tileSource = {
    label: 'tiles',
    attribution: { name: 'OSM' },
    detailZoom: () => 12,
    async fetch() {
      return {
        records: [rec(1, {})],
        stale: false,
        saturated: false,
        coverage: { south: 29, west: -98, north: 31, east: -96 },
        zoom: 12,
      };
    },
  };
  const failingOverlay = {
    async fetch() {
      throw new Error('Overpass timed out');
    },
  };
  const source = createReconciledAlprSource({
    tileSource,
    overpassSource: failingOverlay,
  });
  const snapshot = await source.fetch({ south: 30, west: -97.1, north: 30.1, east: -96.9 });
  assert.equal(snapshot.records.length, 1);
  assert.equal(snapshot.overlayError, 'Overpass timed out');
  assert.equal(snapshot.records[0].absenceNoted, false);
});

test('the composed source merges a live overlay when it answers', async () => {
  const tileSource = {
    label: 'tiles',
    attribution: { name: 'OSM' },
    async fetch() {
      return {
        records: [rec(1, { operator: 'Old' })],
        stale: false,
        saturated: false,
        zoom: 12,
      };
    },
  };
  const overlay = {
    async fetch() {
      return {
        records: [rec(1, { operator: 'New' }), rec(2, {})],
        stale: false,
        saturated: false,
      };
    },
  };
  const source = createReconciledAlprSource({ tileSource, overpassSource: overlay });
  const snapshot = await source.fetch({ south: 30, west: -97.1, north: 30.1, east: -96.9 });
  assert.equal(snapshot.records.length, 2);
  assert.equal(snapshot.records.find((r) => r.id === 'alpr:1').operator, 'New');
  assert.equal(snapshot.records.find((r) => r.id === 'alpr:2').sinceExtract, true);
  assert.equal(snapshot.reconciliation.merged, 1);
  assert.equal(snapshot.reconciliation.overpassOnly, 1);
});
