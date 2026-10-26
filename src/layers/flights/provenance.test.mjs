import test from 'node:test';
import assert from 'node:assert/strict';
import { createQueries } from './queries.js';
import { isProvenanced, UNKNOWN } from '../../data/provenance.js';

const EPOCH_MS = 1700000000000;

const INFO = {
  callsign: 'TEST1',
  rawLat: 39,
  rawLon: -77,
  altitude: 1000,
  velocity: 120,
  true_track: 90,
  verticalRate: 0,
  onGround: false,
  klass: 'airliner',
  originCountry: 'United States',
  positionEpochMs: EPOCH_MS,
};

function queries({ lastSource = 'OpenSky Network', info = INFO } = {}) {
  const flightState = {
    feed: { _lastSource: lastSource },
    _billboardCollection: { show: true },
    _billboards: new Map([['abc123', { show: true }]]),
    _models: new Map(),
    _detectionObjects: new Map(),
    records: {
      data: new Map([['abc123', info]]),
      missingPolls: new Map(),
    },
  };
  const services = {
    aircraftPresentation: {
      tr3bTypeLabel: (_icao24, value) => value,
      tr3bAircraftClass: (_icao24, value) => value,
    },
    labels: { formatFlightLevel: (altitude) => String(altitude) },
    militaryRegistry: { isMilitaryIcao: () => false },
    camera: { applyTrackedCameraFrame: () => null },
    focus: {},
    recession: {},
  };
  const parts = {
    testing: {},
    tracking: { _routeIsPlausible: () => false },
    motion: {},
    rendering: {},
  };
  return createQueries({ flightState, services, parts });
}

test('flights analyst record with a position epoch is provenanced OBSERVED at the fix epoch', () => {
  const { mapAnalystRecord } = queries();
  const record = mapAnalystRecord('abc123', INFO, {
    military: false,
    routeOk: false,
  });
  assert.equal(isProvenanced(record), true);
  assert.equal(record.provenance.observation_kind, 'OBSERVED');
  assert.equal(record.provenance.source_ts, new Date(EPOCH_MS).toISOString());
  assert.equal(record.provenance.source_id, 'opensky');
  assert.ok(
    record.provenance.quality_flags.includes('CLASSIFICATION_DERIVED'),
  );
});

test('flights analyst record from the adsb.lol fallback stamps the adsb-lol source', () => {
  const { mapAnalystRecord } = queries({ lastSource: 'adsb.lol' });
  const record = mapAnalystRecord('abc123', INFO, {
    military: false,
    routeOk: false,
  });
  assert.equal(isProvenanced(record), true);
  assert.equal(record.provenance.source_id, 'adsb-lol');
  assert.equal(record.provenance.source_ts, new Date(EPOCH_MS).toISOString());
});

test('flights analyst record without a position epoch is NOT provenanced (gate withholds)', () => {
  const { mapAnalystRecord } = queries();
  const record = mapAnalystRecord(
    'abc123',
    { ...INFO, positionEpochMs: null },
    { military: false, routeOk: false },
  );
  assert.equal(isProvenanced(record), false);
  assert.equal(record.provenance.source_ts, UNKNOWN);
  assert.ok(record.provenance.quality_flags.includes('UNKNOWN_FIELD'));
  assert.ok(
    record.provenance.quality_flags.includes('CLASSIFICATION_DERIVED'),
  );
});

test('flights getAnalystRecords emits the stamped record', () => {
  const { methods } = queries();
  const [record] = methods.getAnalystRecords();
  assert.equal(isProvenanced(record), true);
  assert.equal(record.provenance.source_ts, new Date(EPOCH_MS).toISOString());
});
