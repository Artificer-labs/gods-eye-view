import test from 'node:test';
import assert from 'node:assert/strict';
import { createQueries } from './queries.js';
import { isProvenanced, UNKNOWN } from '../../data/provenance.js';

const EPOCH_MS = 1700000000000;

const INFO = {
  callsign: 'MIL1',
  rawLat: 39,
  rawLon: -77,
  altitudeFt: 3280.84,
  speedMps: 100,
  track: 90,
  verticalRateMps: 1,
  onGround: false,
  klass: 'tanker',
  operator: 'USAF',
  positionEpochMs: EPOCH_MS,
};

function queries({ info = INFO } = {}) {
  const flightState = {
    feed: { _lastSource: 'adsb.lol' },
    _billboardCollection: { show: true },
    _billboards: new Map([['aaa001', { show: true }]]),
    _models: new Map(),
    _detectionObjects: new Map(),
    records: {
      data: new Map([['aaa001', info]]),
      missingPolls: new Map(),
    },
  };
  const services = {
    aircraftPresentation: {
      tr3bTypeLabel: (_icao24, value) => value,
      tr3bAircraftClass: (_icao24, value) => value,
    },
    labels: { formatFlightLevel: (altitude) => String(altitude) },
    camera: { applyTrackedCameraFrame: () => null },
  };
  const parts = { tracking: {}, motion: {}, rendering: {} };
  return createQueries({ flightState, services, parts });
}

test('military analyst record with a position epoch is provenanced OBSERVED at the fix epoch', () => {
  const { mapAnalystRecord } = queries();
  const record = mapAnalystRecord('aaa001', INFO);
  assert.equal(isProvenanced(record), true);
  assert.equal(record.provenance.observation_kind, 'OBSERVED');
  assert.equal(record.provenance.source_ts, new Date(EPOCH_MS).toISOString());
  assert.equal(record.provenance.source_id, 'adsb-lol');
  assert.ok(
    record.provenance.quality_flags.includes('CLASSIFICATION_DERIVED'),
  );
});

test('military analyst record without a position epoch is NOT provenanced (gate withholds)', () => {
  const { mapAnalystRecord } = queries();
  const record = mapAnalystRecord('aaa001', {
    ...INFO,
    positionEpochMs: null,
  });
  assert.equal(isProvenanced(record), false);
  assert.equal(record.provenance.source_ts, UNKNOWN);
  assert.ok(record.provenance.quality_flags.includes('UNKNOWN_FIELD'));
  assert.ok(
    record.provenance.quality_flags.includes('CLASSIFICATION_DERIVED'),
  );
});

test('military getAnalystRecords emits the stamped record', () => {
  const { methods } = queries();
  const [record] = methods.getAnalystRecords();
  assert.equal(isProvenanced(record), true);
  assert.equal(record.provenance.source_id, 'adsb-lol');
  assert.equal(record.provenance.source_ts, new Date(EPOCH_MS).toISOString());
});
