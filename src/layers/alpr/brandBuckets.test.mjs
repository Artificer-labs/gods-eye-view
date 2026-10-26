import test from 'node:test';
import assert from 'node:assert/strict';
import {
  alprBrandBucket,
  summarizeAlprBrands,
  normalizeBrandValue,
} from './brandBuckets.js';

const rec = (id, fields = {}) => ({
  id: `alpr:${id}`,
  operator: null,
  manufacturer: null,
  ...fields,
});

test('normalization is case and punctuation insensitive', () => {
  assert.equal(normalizeBrandValue('  FLOCK   Safety!! '), 'flock safety');
  assert.equal(normalizeBrandValue('Axis Communications'), 'axis communications');
});

test('Flock is named by either witness field, in any dress', () => {
  assert.equal(alprBrandBucket(rec(1, { manufacturer: 'Flock Safety' })), 'FLOCK');
  assert.equal(alprBrandBucket(rec(2, { operator: 'FLOCK SAFETY' })), 'FLOCK');
  assert.equal(alprBrandBucket(rec(3, { manufacturer: 'FlockSafety' })), 'FLOCK');
  assert.equal(alprBrandBucket(rec(4, { manufacturer: 'Flock' })), 'FLOCK');
});

test('tagged-but-not-Flock is OTHER; untagged is UNKNOWN, never guessed', () => {
  assert.equal(alprBrandBucket(rec(1, { operator: 'City of Austin' })), 'OTHER');
  assert.equal(alprBrandBucket(rec(2, { manufacturer: 'Axis' })), 'OTHER');
  assert.equal(alprBrandBucket(rec(3, {})), 'UNKNOWN');
  assert.equal(alprBrandBucket(rec(4, { operator: ' ', manufacturer: '' })), 'UNKNOWN');
});

test('semicolon multi-values split; a dual-tagged record is FLOCK and counted', () => {
  const summary = summarizeAlprBrands([
    rec(1, { manufacturer: 'Flock Safety;Motorola Solutions' }),
    rec(2, { operator: 'County Sheriff' }),
    rec(3, {}),
    rec(3, { manufacturer: 'Flock Safety' }), // duplicate id: counted once
  ]);
  assert.equal(summary.total, 3);
  assert.equal(summary.dualTagged, 1);
  assert.equal(summary.buckets.FLOCK.count, 1);
  assert.equal(summary.buckets.OTHER.count, 1);
  assert.equal(summary.buckets.UNKNOWN.count, 1);
  // Primary buckets always sum to the total, and every count has a denominator.
  const sum = Object.values(summary.buckets).reduce((n, b) => n + b.count, 0);
  assert.equal(sum, summary.total);
  for (const bucket of Object.values(summary.buckets))
    assert.equal(bucket.denominator, summary.total);
  assert.ok(Math.abs(summary.buckets.FLOCK.fraction - 1 / 3) < 1e-12);
});
