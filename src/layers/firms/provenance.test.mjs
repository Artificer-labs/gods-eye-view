// Provenance adapter (graft task 8): FIRMS analyst records are stamped at
// the getAnalystRecords seam — source_ts is the VIIRS detection (overpass)
// time the record carries (acq date+time UTC → acqTime), never ingest time,
// so latency_ms states the detection's true age. The feed provides no
// per-record publication time, so published_ts stays UNKNOWN.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createModel } from './model.js';
import { createQueries } from './queries.js';
import { isProvenanced, UNKNOWN } from '../../data/provenance.js';

// A detection ~16 h before the task's run date (2026-10-26) — inherently
// hours old at ingest, and only ever older when this test runs later.
const ACQ_MS = Date.parse('2026-10-25T20:00:00.000Z');

function analystRecords() {
  const fire = {
    index: 0,
    lat: 30.51,
    lon: -98.21,
    frp: 1520.4,
    confidence: 0.9,
    satellite: 'N21',
    sensor: 'VIIRS',
    acqMs: ACQ_MS,
  };
  const layerState = { _enabled: true, _firesByFrp: [fire] };
  const services = { anchors: { fireAnchorHeight: () => 0 } };
  const config = { id: 'local-firms', name: 'Fires', icon: '🔥', source: 'FIRMS' };
  const components = {};
  const context = { layerState, services, components, config, feed: {} };
  components.model = createModel(context);
  return createQueries(context).methods.getAnalystRecords();
}

test('firms analyst record is stamped with the detection time as source_ts', () => {
  const [record] = analystRecords();
  assert.ok(isProvenanced(record), 'record passes the gate');
  assert.equal(record.provenance.source_id, 'firms-viirs-nrt');
  assert.equal(record.provenance.observation_kind, 'OBSERVED');
  assert.equal(record.provenance.source_ts, new Date(ACQ_MS).toISOString());
  // No publication time exists in the feed — stated, not invented.
  assert.equal(record.provenance.published_ts, UNKNOWN);
});

test('firms latency_ms is the detection age at ingest, not zero', () => {
  const [record] = analystRecords();
  assert.notEqual(record.provenance.ingest_ts, record.provenance.source_ts);
  assert.ok(
    record.provenance.latency_ms > 3_600_000,
    `latency ${record.provenance.latency_ms} ms exceeds one hour`,
  );
  assert.equal(
    record.provenance.latency_ms,
    Date.parse(record.provenance.ingest_ts) - ACQ_MS,
  );
});
