import test from 'node:test';
import assert from 'node:assert/strict';
import {
  alprAoiBbox,
  alprStampKey,
  buildAlprDiffFeedHeader,
  diffAlprSnapshots,
  filterAlprRecordsToAoi,
} from './diff.js';
import { MAPPER_DENSITY_CAVEAT, NO_MAPPED_READER } from './labelling.js';

const T1 = '2026-10-26T12:00:00.000Z';
const T2 = '2026-10-26T13:00:00.000Z';
const T3 = '2026-10-26T14:00:00.000Z';

const rec = (osmId, overrides = {}) => ({
  id: `alpr:${osmId}`,
  osmId,
  latitude: 31.0,
  longitude: -82.0,
  operator: 'Flock Safety',
  manufacturer: 'Flock Safety',
  cameraType: 'fixed',
  zone: 'Hazlehurst',
  directionDeg: 90,
  ref: null,
  lastVerified: '2025-06-01',
  osmTimestamp: '2026-10-20T00:00:00.000Z',
  ...overrides,
});

const snap = (extractTs, records, overrides = {}) => ({
  aoi_id: 'home',
  extract_ts: extractTs,
  ingest_ts: extractTs,
  records,
  complete: true,
  saturated: false,
  ...overrides,
});

// The planted two-cycle fixture (spec task 5 done-test): one of each
// diff class plus a 10 m jitter that must NOT diff.
const cycle1 = snap(T1, [
  rec(101), // retagged (aim change) in cycle 2
  rec(102), // 10 m jitter in cycle 2 — noise, no event
  rec(103), // moved ~111 m in cycle 2
  rec(104), // absent in cycle 2 — REMOVED (extract)
  rec(105), // unchanged
  rec(107), // retagged (operator) in cycle 2
]);
const cycle2 = snap(T2, [
  rec(101, { directionDeg: 180 }),
  rec(102, { latitude: 31.0 + 0.00009 }),
  rec(103, { latitude: 31.0 + 0.001 }),
  rec(105),
  rec(106), // NEW
  rec(107, { operator: 'City of Hazlehurst' }),
]);

test('two-cycle fixture produces exactly the planted event list', () => {
  const { events, counts, stampQuality, comparisonComplete } =
    diffAlprSnapshots({ previous: cycle1, current: cycle2, now: T2 });
  assert.equal(stampQuality, 'KNOWN');
  assert.equal(comparisonComplete, true);
  assert.deepEqual(counts, { NEW: 1, REMOVED: 1, MOVED: 1, RETAGGED: 2 });
  const byKindId = Object.fromEntries(
    events.map((e) => [`${e.kind}:${e.osm_id}`, e]),
  );
  assert.ok(byKindId['NEW:106']);
  assert.equal(byKindId['NEW:106'].after.operator, 'Flock Safety');
  assert.ok(byKindId['MOVED:103']);
  assert.ok(byKindId['MOVED:103'].distance_m > 100);
  assert.equal(byKindId['RETAGGED:101'].aim_change, true);
  assert.deepEqual(byKindId['RETAGGED:101'].changed_fields, ['directionDeg']);
  assert.equal(byKindId['RETAGGED:107'].aim_change, false);
  assert.deepEqual(byKindId['RETAGGED:107'].changes.operator, {
    from: 'Flock Safety',
    to: 'City of Hazlehurst',
  });
  // The 10 m jitter on 102 diffs as NOTHING (noise law, spec §3.2).
  assert.equal(events.some((e) => e.osm_id === 102), false);
  // Unchanged 105 is silent.
  assert.equal(events.some((e) => e.osm_id === 105), false);
});

test('every event keys on (osm_id, extract stamp pair) at REPORTED', () => {
  const { events } = diffAlprSnapshots({
    previous: cycle1,
    current: cycle2,
    now: T2,
  });
  for (const event of events) {
    assert.equal(event.confidence, 'REPORTED');
    assert.equal(event.confidence_degraded, false);
    assert.deepEqual(event.key, {
      osm_id: event.osm_id,
      prev_extract_ts: T1,
      extract_ts: T2,
    });
    assert.deepEqual(event.witnesses, [
      { source: 'alpr-deflock-tiles', extract_ts: T1 },
      { source: 'alpr-deflock-tiles', extract_ts: T2 },
    ]);
    assert.match(event.event_id, /^alpr-diff:[0-9a-f]{16}$/);
  }
  // Deterministic: the same pair diffed twice yields the same ids.
  const again = diffAlprSnapshots({ previous: cycle1, current: cycle2, now: T2 });
  assert.deepEqual(
    again.events.map((e) => e.event_id),
    events.map((e) => e.event_id),
  );
});

test('a first absence ships REMOVED (extract) and pends; the next cycle confirms it', () => {
  const first = diffAlprSnapshots({ previous: cycle1, current: cycle2, now: T2 });
  const removed = first.events.find((e) => e.osm_id === 104);
  assert.equal(removed.kind, 'REMOVED');
  assert.equal(removed.corroboration, 'extract');
  assert.deepEqual(first.pendingRemovals, { 104: T1 });

  const cycle3 = snap(T3, cycle2.records);
  const second = diffAlprSnapshots({
    previous: cycle2,
    current: cycle3,
    pendingRemovals: first.pendingRemovals,
    now: T3,
  });
  const confirmed = second.events.find((e) => e.osm_id === 104);
  assert.equal(confirmed.kind, 'REMOVED');
  assert.equal(confirmed.corroboration, 'confirmed');
  assert.equal(confirmed.first_absent_extract_ts, T1);
  // Settled: the pending entry is spent, no third emission is possible.
  assert.deepEqual(second.pendingRemovals, {});
});

test('a saturated comparison emits NO removal and records no absence', () => {
  const saturatedCycle = snap(T2, [rec(101)], { saturated: true, complete: false });
  const { events, suppressedRemovals, pendingRemovals, comparisonComplete } =
    diffAlprSnapshots({
      previous: cycle1,
      current: saturatedCycle,
      pendingRemovals: { 104: T1 },
      now: T2,
    });
  assert.equal(comparisonComplete, false);
  assert.equal(events.some((e) => e.kind === 'REMOVED'), false);
  assert.ok(suppressedRemovals >= 5);
  // Pending state passes through untouched: an untrusted cycle may not
  // confirm, clear, or create an absence (reconcile.js rule 3).
  assert.deepEqual(pendingRemovals, { 104: T1 });
});

test('UNKNOWN stamps degrade the cycle labelling, never fabricate a time', () => {
  const unstamped = snap(null, cycle2.records, { ingest_ts: T2 });
  const { events, stampQuality } = diffAlprSnapshots({
    previous: cycle1,
    current: unstamped,
    now: T2,
  });
  assert.equal(stampQuality, 'UNKNOWN');
  assert.ok(events.length > 0);
  for (const event of events) {
    assert.equal(event.key.extract_ts, 'UNKNOWN');
    assert.equal(event.stamp_quality, 'UNKNOWN');
    assert.equal(event.confidence_degraded, true);
    assert.equal(event.degradation_reason, 'UNKNOWN_STAMP_CYCLE');
    assert.equal(event.confidence, 'REPORTED');
  }
  assert.equal(alprStampKey(null), 'UNKNOWN');
  assert.equal(alprStampKey('not a date'), 'UNKNOWN');
  assert.equal(alprStampKey(T1), T1);
});

test('the first cycle is a baseline: no events, no pending state', () => {
  const { events, counts } = diffAlprSnapshots({
    previous: null,
    current: cycle1,
    now: T1,
  });
  assert.deepEqual(events, []);
  assert.deepEqual(counts, { NEW: 0, REMOVED: 0, MOVED: 0, RETAGGED: 0 });
});

test('AOI bounding: polygon and bbox both bound the feed', () => {
  const aoi = {
    id: 'home',
    polygon: [
      [-82.01, 30.99],
      [-81.99, 30.99],
      [-81.99, 31.01],
      [-82.01, 31.01],
    ],
  };
  assert.deepEqual(alprAoiBbox(aoi), {
    south: 30.99,
    west: -82.01,
    north: 31.01,
    east: -81.99,
  });
  const inside = rec(201);
  const outside = rec(202, { latitude: 32.5, longitude: -83.5 });
  assert.deepEqual(
    filterAlprRecordsToAoi([inside, outside], aoi).map((r) => r.osmId),
    [201],
  );
  // No AOI configured: the set passes through whole (the runner, not
  // the filter, is what refuses to run unscoped).
  assert.equal(filterAlprRecordsToAoi([inside, outside], null).length, 2);
});

test('the feed header carries attribution, share-alike, and the §4 labelling', () => {
  const header = buildAlprDiffFeedHeader({
    aoi: { id: 'home', name: 'Hazlehurst / Jeff Davis County' },
    attribution: {
      name: 'OpenStreetMap',
      description: '© OpenStreetMap contributors, ODbL',
      text: '© OpenStreetMap contributors, ODbL',
      href: 'https://www.openstreetmap.org/copyright',
    },
    now: T1,
  });
  assert.equal(header.type, 'alpr-diff-feed-header');
  assert.equal(header.license, 'ODbL-1.0');
  assert.equal(header.share_alike, true);
  assert.equal(header.attribution.text, '© OpenStreetMap contributors, ODbL');
  assert.equal(header.labelling.absence, NO_MAPPED_READER);
  assert.deepEqual(header.labelling.caveats, [MAPPER_DENSITY_CAVEAT]);
});
