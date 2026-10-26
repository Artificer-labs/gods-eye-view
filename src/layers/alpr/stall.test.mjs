import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createExtractStallTracker } from './stall.js';
import { createAlprTileSource } from './source.js';
import { EXTRACT_STALL_MS } from './policy.js';

const HOUR = 60 * 60 * 1000;
const T0 = Date.parse('2026-10-26T00:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();

test('an advancing hourly stamp never stalls', () => {
  const tracker = createExtractStallTracker();
  for (let cycle = 0; cycle < 6; cycle++) {
    const status = tracker.observe(iso(T0 + cycle * HOUR), T0 + cycle * HOUR + 5 * 60 * 1000);
    assert.equal(status.extractStalled, false);
    assert.equal(status.extractTs, iso(T0 + cycle * HOUR));
    assert.equal(status.observations, cycle + 1);
  }
});

test('FROZEN-EXTRACT FIXTURE: a stamp that stops advancing stalls past the threshold', () => {
  const tracker = createExtractStallTracker();
  // Cycle 1: the extract is served, stamp T0, observed shortly after.
  let status = tracker.observe(iso(T0), T0 + 10 * 60 * 1000);
  assert.equal(status.extractStalled, false);
  // Cycle 2 (one hour later): the SAME stamp comes back — the pipeline
  // is silent, but the stamp is not yet old enough to convict.
  status = tracker.observe(iso(T0), T0 + HOUR + 10 * 60 * 1000);
  assert.equal(status.extractStalled, false);
  // Cycle 3: still the same stamp, now older than the stall threshold —
  // the extract is frozen and the tracker says so, however many 200s
  // carried it.
  status = tracker.observe(iso(T0), T0 + EXTRACT_STALL_MS + 1);
  assert.equal(status.extractStalled, true);
  assert.equal(status.extractTs, iso(T0));
  assert.equal(status.lastAdvanceAt, iso(T0 + 10 * 60 * 1000));
});

test('an unseen stamp is UNKNOWN, never a stall and never a freshness', () => {
  const tracker = createExtractStallTracker();
  const status = tracker.observe(null, T0 + 100 * HOUR);
  assert.equal(status.extractTs, 'UNKNOWN');
  assert.equal(status.extractStalled, false);
  const garbage = tracker.observe('not-a-date', T0 + 200 * HOUR);
  assert.equal(garbage.extractTs, 'UNKNOWN');
  assert.equal(garbage.extractStalled, false);
});

test('a missing stamp does not erase a known one; an older stamp never rewinds', () => {
  const tracker = createExtractStallTracker();
  tracker.observe(iso(T0 + HOUR), T0 + HOUR);
  let status = tracker.observe(null, T0 + 2 * HOUR);
  assert.equal(status.extractTs, iso(T0 + HOUR));
  status = tracker.observe(iso(T0), T0 + 2 * HOUR);
  assert.equal(status.extractTs, iso(T0 + HOUR));
  assert.equal(status.lastAdvanceAt, iso(T0 + HOUR));
});

test('a custom threshold is honored and validated', () => {
  assert.throws(() => createExtractStallTracker({ stallAfterMs: 0 }), TypeError);
  const tracker = createExtractStallTracker({ stallAfterMs: 1000 });
  assert.equal(tracker.observe(iso(T0), T0).extractStalled, false);
  assert.equal(tracker.observe(iso(T0), T0 + 1001).extractStalled, true);
});

// --- Through the tile source: the served stamp is the TileJSON's
// Last-Modified, probed from the same injected fetch. ---

const fixture = readFileSync(
  new URL('../../data/fixtures/osm-alpr-austin-11-467-843.pbf', import.meta.url),
);
const metadata = (country) => ({
  tiles: [
    `https://tiles.dontgetflocked.com/cameras-${country}-hourly/{z}/{x}/{y}.mvt`,
  ],
  bounds: country === 'ca' ? [-124, 42, -63, 54] : [-160, 17, -64, 59],
});
const austin = { south: 30.2, north: 30.35, west: -97.85, east: -97.65 };

const sourceWithStamp = (stampHeader) =>
  createAlprTileSource({
    tileFetchImpl: async (url) => {
      if (url.endsWith('.json'))
        return new Response(
          JSON.stringify(metadata(url.includes('-ca-') ? 'ca' : 'us')),
          stampHeader
            ? { headers: { 'last-modified': stampHeader } }
            : undefined,
        );
      return new Response(fixture);
    },
  });

test('tile source: a served stamp three hours old marks the snapshot stalled', async () => {
  const frozen = new Date(Date.now() - 3 * HOUR).toUTCString();
  const snapshot = await sourceWithStamp(frozen).fetch(austin);
  assert.ok(snapshot.records.length > 0);
  assert.equal(snapshot.extractStalled, true);
  assert.equal(snapshot.stale, true);
  assert.equal(snapshot.extractTs, new Date(frozen).toISOString());
});

test('tile source: a current served stamp reads fresh', async () => {
  const fresh = new Date(Date.now() - 20 * 60 * 1000).toUTCString();
  const snapshot = await sourceWithStamp(fresh).fetch(austin);
  assert.equal(snapshot.extractStalled, false);
  assert.equal(snapshot.stale, false);
  assert.equal(snapshot.extractTs, new Date(fresh).toISOString());
});

test('tile source: no served stamp — UNKNOWN, and the snapshot never claims stale or fresh from it', async () => {
  const snapshot = await sourceWithStamp(null).fetch(austin);
  assert.equal(snapshot.extractTs, null);
  assert.equal(snapshot.extractStalled, false);
  assert.equal(snapshot.stale, false);
});
