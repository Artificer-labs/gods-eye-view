import test from 'node:test';
import assert from 'node:assert/strict';
import {
  stampRecord,
  assertProvenanced,
  isProvenanced,
  provenanceGaps,
  freshnessOf,
  withProvenanceGate,
  UNKNOWN,
} from './provenance.js';
import {
  SOURCE_REGISTRY,
  LAYER_SOURCE_IDS,
  getSource,
  sourceIdForLayer,
} from './sourceRegistry.js';

// USGS feed in the registry: 60 s cadence, 3 600 s freshness budget.
const SOURCE_ID = 'usgs-quakes';
const T0 = Date.parse('2026-10-26T04:00:00.000Z');

const stamp = (record, fields = {}) =>
  stampRecord(record, {
    source_id: SOURCE_ID,
    source_ts: T0,
    observation_kind: 'OBSERVED',
    now: T0 + 90_000,
    ...fields,
  });

test('the registry names a registered source for every catalog layer', () => {
  for (const [layerId, sourceId] of Object.entries(LAYER_SOURCE_IDS)) {
    assert.ok(getSource(sourceId), `${layerId} → ${sourceId} is registered`);
    assert.equal(sourceIdForLayer(layerId), sourceId);
  }
  for (const entry of Object.values(SOURCE_REGISTRY)) {
    assert.ok(entry.declared_cadence_s > 0, `${entry.source_id} cadence`);
    assert.ok(
      entry.freshness_budget_s >= entry.declared_cadence_s,
      `${entry.source_id} budget covers at least one cadence`,
    );
  }
});

test('stampRecord computes latency and validity from the registry budget', () => {
  const record = stamp({ id: 'q1' });
  const envelope = record.provenance;
  assert.equal(envelope.source_id, SOURCE_ID);
  assert.equal(envelope.source_ts, '2026-10-26T04:00:00.000Z');
  assert.equal(envelope.ingest_ts, '2026-10-26T04:01:30.000Z');
  assert.equal(envelope.latency_ms, 90_000, 'latency is computed, not entered');
  assert.equal(envelope.valid_to, '2026-10-26T05:00:00.000Z');
  assert.equal(envelope.observation_kind, 'OBSERVED');
  assert.deepEqual(envelope.quality_flags, []);
  assert.equal(isProvenanced(record), true);
  assert.equal(assertProvenanced(record), record);
});

test('stampRecord refuses an unregistered source and an unknown kind', () => {
  assert.throws(
    () =>
      stampRecord(
        {},
        { source_id: 'no-such-source', source_ts: T0, observation_kind: 'OBSERVED' },
      ),
    /Unregistered source/,
  );
  assert.throws(
    () =>
      stampRecord(
        {},
        { source_id: SOURCE_ID, source_ts: T0, observation_kind: 'GUESSED' },
      ),
    /Invalid observation_kind/,
  );
});

test('an unknown source time is stated explicitly and fails the assertion', () => {
  const record = stampRecord(
    { id: 'q2' },
    { source_id: SOURCE_ID, observation_kind: 'OBSERVED', now: T0 },
  );
  assert.equal(record.provenance.source_ts, UNKNOWN);
  assert.ok(record.provenance.quality_flags.includes('UNKNOWN_FIELD'));
  assert.equal(record.provenance.latency_ms, null);
  assert.equal(record.provenance.valid_to, null);
  assert.deepEqual(provenanceGaps(record), ['source_ts']);
  assert.throws(() => assertProvenanced(record), /source_ts/);
});

test('assertProvenanced rejects bare and partial records, naming the gaps', () => {
  assert.throws(() => assertProvenanced({ id: 'bare' }), /provenance/);
  assert.throws(
    () => assertProvenanced({ provenance: { source_id: SOURCE_ID } }),
    /source_ts, observation_kind/,
  );
  assert.throws(
    () =>
      assertProvenanced({
        provenance: {
          source_id: 'unregistered',
          source_ts: T0,
          observation_kind: 'OBSERVED',
        },
      }),
    /source_id/,
  );
});

test('freshnessOf walks LIVE → AGING → STALE → EXPIRED across the boundaries', () => {
  const record = stamp({ id: 'q3' });
  // Cadence 60 s, slack 1.5×: LIVE to 150 s, AGING to 180 s,
  // STALE until valid_to at 3 600 s, EXPIRED beyond it.
  assert.equal(freshnessOf(record, T0 + 150_000), 'LIVE');
  assert.equal(freshnessOf(record, T0 + 151_000), 'AGING');
  assert.equal(freshnessOf(record, T0 + 180_000), 'AGING');
  assert.equal(freshnessOf(record, T0 + 181_000), 'STALE');
  assert.equal(freshnessOf(record, T0 + 3_600_000), 'STALE');
  assert.equal(freshnessOf(record, T0 + 3_601_000), 'EXPIRED');
});

test('freshnessOf fails closed: a bare record is never live', () => {
  assert.equal(freshnessOf({ id: 'bare' }, T0), 'EXPIRED');
  assert.equal(freshnessOf(stamp({ id: 'q4' }, { source_ts: UNKNOWN }), T0), 'EXPIRED');
});

test('the gate renders exactly the enveloped record of an enveloped/bare pair', () => {
  const enveloped = stamp({ id: 'kept' });
  const bare = { id: 'withheld' };
  const layer = {
    id: 'earthquakes',
    getAnalystRecords: () => [enveloped, bare],
    getStats: () => ({ count: 2 }),
  };
  const gated = withProvenanceGate(layer, { source_id: SOURCE_ID });
  assert.equal(gated, layer, 'the gate wraps in place');
  assert.deepEqual(gated.getAnalystRecords(), [enveloped]);
  assert.deepEqual(gated.getProvenanceGateStats(), {
    sourceId: SOURCE_ID,
    passed: 1,
    withheld: 1,
  });
  assert.equal(
    gated.getStats().provenanceWithheld,
    1,
    'the withheld count surfaces on the layer stats',
  );
  // The gate is cumulative and idempotent: a second wrap changes nothing.
  assert.equal(withProvenanceGate(layer, { source_id: SOURCE_ID }), layer);
  gated.getAnalystRecords();
  assert.equal(gated.getProvenanceGateStats().withheld, 2);
});

test('the gate throws in dev builds instead of dropping silently', () => {
  const layer = {
    id: 'earthquakes',
    getAnalystRecords: () => [{ id: 'bare' }],
  };
  withProvenanceGate(layer, { source_id: SOURCE_ID, dev: true });
  assert.throws(() => layer.getAnalystRecords(), /without a complete envelope/);
});
