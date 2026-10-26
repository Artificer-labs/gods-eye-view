// src/data/aisProvenance.test.mjs
// Graft task 10 (vessels half): AIS provenance adapter + F-14 store honesty.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aisStreamRows,
  ingestAisStreamEnvelope,
  newestAisPositionAt,
  readAisTrack,
} from '../../server/providers/vessels/ais-store.js';
import { normalizeVesselObservation } from '../sources/live/vessels.js';
import { createIngestion } from '../layers/vessels/ingestion.js';
import { normalizeVessel } from '../layers/vessels/records.js';
import { isProvenanced, UNKNOWN } from './provenance.js';
import aisLiveVesselsLayer, {
  _setVesselStateForTest,
} from './aisLiveVessels.js';

const AIS_TS = '2026-09-17 20:00:00.000000000 +0000 UTC';
const AIS_ISO = '2026-09-17T20:00:00.000Z';

const positionReport = (mmsi, timeUtc) => ({
  MessageType: 'PositionReport',
  Message: { PositionReport: { UserID: Number(mmsi), Sog: 10, Cog: 90 } },
  MetaData: {
    MMSI: mmsi,
    latitude: 53.4,
    longitude: 6.19,
    ...(timeUtc === undefined ? {} : { time_utc: timeUtc }),
  },
});
const rowFor = (mmsi) => aisStreamRows(50000).find((row) => row.mmsi === mmsi);

// The client chain: server row -> source observation -> display row ->
// internal vessel record, exactly as ingestion assembles it.
const { vesselDisplayRow } = createIngestion({
  feed: {},
  readSource: () => null,
  readViewer: () => null,
  getRowLimit: () => 0,
  readCount: () => 0,
  applyRows: () => {},
  classifySnapshot: () => ({}),
  isDefinitiveTransportFailure: () => false,
  isGraceEligibleTransport: () => false,
  markUnavailable: () => {},
  settleFirstConnect: () => {},
  now: () => 0,
  setSourceLabel: () => {},
});
const toInternalRecord = (serverRow) =>
  normalizeVessel(vesselDisplayRow(normalizeVesselObservation(serverRow)));

const internalRecord = (fields = {}) => ({
  mmsi: '353136001',
  name: 'PROVENANCE TEST',
  lat: 29.55,
  lon: -94.98,
  speed: 12.3,
  course: 214,
  type: 'Cargo',
  destination: 'OAKLAND',
  lastPositionUtc: AIS_ISO,
  lastPositionEpoch: Date.parse(AIS_ISO) / 1000,
  timestampEstimated: false,
  ...fields,
});

test('store: a real AIS timestamp is not marked estimated', () => {
  assert.equal(ingestAisStreamEnvelope(positionReport('911000001', AIS_TS)), true);
  const row = rowFor('911000001');
  assert.equal(row.timestampEstimated, false);
  assert.equal(row.last_position_UTC, AIS_ISO);
});

test('store: a missing AIS timestamp carries the estimated marker, not a silent now', () => {
  assert.equal(ingestAisStreamEnvelope(positionReport('911000002')), true);
  const row = rowFor('911000002');
  assert.equal(row.timestampEstimated, true);
  // Fallback time value is still present for consumers that need a number.
  assert.ok(Number.isFinite(row.last_position_epoch));
  // ...but it must not space the trail or pose as the newest real fix.
  assert.deepEqual(readAisTrack('911000002'), []);
  assert.equal(newestAisPositionAt([row]), null);
});

test('store: an unparseable AIS timestamp carries the estimated marker', () => {
  assert.equal(
    ingestAisStreamEnvelope(positionReport('911000003', 'not-a-time')),
    true,
  );
  assert.equal(rowFor('911000003').timestampEstimated, true);
});

test('adapter: a normal AIS record is provenanced with source_ts = its AIS timestamp', () => {
  ingestAisStreamEnvelope(positionReport('911000004', AIS_TS));
  const record = toInternalRecord(rowFor('911000004'));
  assert.equal(record.timestampEstimated, false);
  _setVesselStateForTest({ records: [record], transportStatus: 'live' });
  const [analyst] = aisLiveVesselsLayer.getAnalystRecords();
  assert.equal(isProvenanced(analyst), true);
  assert.equal(analyst.provenance.source_id, 'aisstream');
  assert.equal(analyst.provenance.observation_kind, 'OBSERVED');
  assert.equal(analyst.provenance.source_ts, AIS_ISO);
  assert.deepEqual(analyst.provenance.quality_flags, []);
});

test('adapter: an estimated-timestamp position is withheld, never stamped with receipt time', () => {
  ingestAisStreamEnvelope(positionReport('911000005'));
  const record = toInternalRecord(rowFor('911000005'));
  assert.equal(record.timestampEstimated, true);
  assert.equal(record.lastPositionUtc, '');
  assert.equal(record.lastPositionEpoch, null);
  _setVesselStateForTest({ records: [record], transportStatus: 'live' });
  const [analyst] = aisLiveVesselsLayer.getAnalystRecords();
  assert.equal(analyst.provenance.source_ts, UNKNOWN);
  assert.ok(analyst.provenance.quality_flags.includes('TIMESTAMP_ESTIMATED'));
  assert.equal(isProvenanced(analyst), false);
});

test('adapter: a record with no AIS timestamp at all is likewise withheld', () => {
  _setVesselStateForTest({
    records: [internalRecord({ lastPositionUtc: '', lastPositionEpoch: null })],
    transportStatus: 'live',
  });
  const [analyst] = aisLiveVesselsLayer.getAnalystRecords();
  assert.equal(analyst.provenance.source_ts, UNKNOWN);
  assert.ok(analyst.provenance.quality_flags.includes('TIMESTAMP_ESTIMATED'));
  assert.equal(isProvenanced(analyst), false);
});

test('adapter: watchdog-stale feed flags stamped records FEED_STALE', () => {
  _setVesselStateForTest({
    records: [internalRecord()],
    transportStatus: 'stale',
  });
  const [analyst] = aisLiveVesselsLayer.getAnalystRecords();
  assert.equal(isProvenanced(analyst), true);
  assert.equal(analyst.provenance.source_ts, AIS_ISO);
  assert.ok(analyst.provenance.quality_flags.includes('FEED_STALE'));
});
