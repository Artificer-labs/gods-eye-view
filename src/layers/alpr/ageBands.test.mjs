import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ALPR_AGE_BAND_TINT,
  alprAgeBand,
  alprAgeBandAlpha,
  alprVerificationBand,
  summarizeAlprAgeBands,
} from './ageBands.js';
import { stampAlprRecord } from './provenance.js';

const NOW = Date.parse('2026-10-26T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();

const bare = (overrides = {}) => ({
  id: 'alpr:1',
  osmId: 1,
  latitude: 30.27,
  longitude: -97.74,
  operator: null,
  manufacturer: null,
  cameraType: null,
  zone: null,
  directionDeg: null,
  ref: null,
  lastVerified: null,
  source: 'node/1',
  ...overrides,
});
const tileRecord = (overrides) =>
  stampAlprRecord(bare(overrides), { witness: 'tiles', now: NOW });
const overpassRecord = (overrides, sourceTs = iso(NOW - 60_000)) =>
  stampAlprRecord(bare(overrides), {
    witness: 'overpass',
    now: NOW,
    sourceTs,
  });

test('verification bands follow the field date: year, three years, null', () => {
  assert.equal(
    alprVerificationBand(bare({ lastVerified: iso(NOW - 30 * DAY) }), NOW),
    'VERIFIED',
  );
  assert.equal(
    alprVerificationBand(bare({ lastVerified: iso(NOW - 2 * 365 * DAY) }), NOW),
    'AGING',
  );
  assert.equal(
    alprVerificationBand(bare({ lastVerified: iso(NOW - 4 * 365 * DAY) }), NOW),
    'STALE',
  );
  // Null is STALE, never fresh — and an OSM edit date is not consulted:
  // the bare record carries no lastVerified at all.
  assert.equal(alprVerificationBand(bare(), NOW), 'STALE');
  assert.equal(
    alprVerificationBand(bare({ lastVerified: 'UNKNOWN' }), NOW),
    'STALE',
  );
});

test('GATE CLAUSE: tile-path records render EXPIRED-class — extract_ts UNKNOWN caps the band', () => {
  // Field-verified YESTERDAY. On any honest freshness reading this is the
  // freshest record imaginable — but the tile envelope cannot name its
  // source time, so the band must refuse to call it fresh.
  const record = tileRecord({ lastVerified: iso(NOW - DAY) });
  assert.equal(record.provenance.extract_ts, 'UNKNOWN');
  assert.equal(alprVerificationBand(record, NOW), 'VERIFIED');
  assert.equal(alprAgeBand(record, NOW), 'EXPIRED');
  assert.ok(alprAgeBandAlpha(record, NOW) < 0.5);
});

test('a live-envelope record renders its verification band', () => {
  assert.equal(
    alprAgeBand(overpassRecord({ lastVerified: iso(NOW - 180 * DAY) }), NOW),
    'VERIFIED',
  );
  assert.equal(
    alprAgeBand(overpassRecord({ lastVerified: iso(NOW - 2 * 365 * DAY) }), NOW),
    'AGING',
  );
  assert.equal(
    alprAgeBand(overpassRecord({ lastVerified: iso(NOW - 4 * 365 * DAY) }), NOW),
    'STALE',
  );
  assert.equal(alprAgeBand(overpassRecord({}), NOW), 'STALE');
});

test('an envelope past its validity caps even a recently verified record at EXPIRED', () => {
  const record = overpassRecord(
    { lastVerified: iso(NOW - DAY) },
    iso(NOW - 3 * 60 * 60 * 1000),
  );
  assert.equal(alprAgeBand(record, NOW), 'EXPIRED');
});

test('a record with no envelope at all is EXPIRED', () => {
  assert.equal(alprAgeBand(bare({ lastVerified: iso(NOW - DAY) }), NOW), 'EXPIRED');
  assert.equal(alprAgeBand(null, NOW), 'EXPIRED');
});

test('band tints fade monotonically — age is visible, not just labelled', () => {
  const alphas = ['VERIFIED', 'AGING', 'STALE', 'EXPIRED'].map(
    (band) => ALPR_AGE_BAND_TINT[band][3],
  );
  assert.deepEqual(alphas, [1, 0.9, 0.6, 0.38]);
  for (let i = 1; i < alphas.length; i++) assert.ok(alphas[i] < alphas[i - 1]);
});

test('the band summary counts every record exactly once, with denominators', () => {
  const records = [
    tileRecord({ lastVerified: iso(NOW - DAY) }),
    overpassRecord({ lastVerified: iso(NOW - 30 * DAY) }),
    overpassRecord({ lastVerified: iso(NOW - 2 * 365 * DAY) }),
    overpassRecord({}),
    overpassRecord({ lastVerified: iso(NOW - 4 * 365 * DAY) }),
  ];
  const summary = summarizeAlprAgeBands(records, NOW);
  assert.equal(summary.total, 5);
  assert.deepEqual(summary.counts, {
    VERIFIED: 1,
    AGING: 1,
    STALE: 2,
    EXPIRED: 1,
  });
  const counted = Object.values(summary.counts).reduce((a, b) => a + b, 0);
  assert.equal(counted, summary.total);
  const fractionSum = Object.values(summary.fractions).reduce(
    (a, b) => a + b,
    0,
  );
  assert.ok(Math.abs(fractionSum - 1) < 1e-9);
  assert.deepEqual(summarizeAlprAgeBands([], NOW).counts, {
    VERIFIED: 0,
    AGING: 0,
    STALE: 0,
    EXPIRED: 0,
  });
});
