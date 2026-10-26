import test from 'node:test';
import assert from 'node:assert/strict';
import { createAlprSnapshotStore, createMemorySnapshotIo } from './snapshotStore.js';
import { createAlprDiffCycleRunner } from './diffCycle.js';
import { MAPPER_DENSITY_CAVEAT } from './labelling.js';

const HOUR = 60 * 60 * 1000;
const T0 = Date.parse('2026-10-26T12:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();

const AOI = {
  id: 'home',
  name: 'Hazlehurst / Jeff Davis County',
  polygon: [
    [-82.01, 30.99],
    [-81.99, 30.99],
    [-81.99, 31.01],
    [-82.01, 31.01],
  ],
};

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
  ...overrides,
});

/** A scripted tile-shaped source: each fetch pops the next frame. */
function scriptedSource(frames) {
  const state = { calls: 0 };
  return {
    state,
    attribution: {
      name: 'OpenStreetMap',
      description: '© OpenStreetMap contributors, ODbL',
      text: '© OpenStreetMap contributors, ODbL',
      href: 'https://www.openstreetmap.org/copyright',
    },
    async fetch() {
      state.calls += 1;
      const frame = frames[Math.min(state.calls - 1, frames.length - 1)];
      return {
        records: frame.records,
        extractTs: frame.extractTs,
        saturated: frame.saturated === true,
        stale: false,
      };
    },
  };
}

const frame = (extractTs, records, overrides = {}) => ({
  extractTs,
  records,
  ...overrides,
});

test('hourly cycles: baseline, unchanged-stamp skip, then a diffed cycle', async () => {
  const store = createAlprSnapshotStore({ io: createMemorySnapshotIo() });
  const source = scriptedSource([
    frame(iso(T0), [rec(1), rec(2)]),
    frame(iso(T0), [rec(1), rec(2)]), // same extract served again
    frame(iso(T0 + HOUR), [rec(1), rec(3)]), // 2 removed, 3 new
  ]);
  let nowMs = T0 + 5 * 60 * 1000;
  const runner = createAlprDiffCycleRunner({
    source,
    store,
    aoi: AOI,
    now: () => nowMs,
  });

  const first = await runner.runCycle();
  assert.equal(first.stored, true);
  assert.deepEqual(first.counts, { NEW: 0, REMOVED: 0, MOVED: 0, RETAGGED: 0 });
  assert.equal(first.summary_lines[0], MAPPER_DENSITY_CAVEAT);

  nowMs = T0 + HOUR + 5 * 60 * 1000;
  const second = await runner.runCycle();
  assert.equal(second.skipped, 'extract-unchanged');
  assert.equal((await store.listSnapshots('home')).length, 1);

  nowMs = T0 + 2 * HOUR + 5 * 60 * 1000;
  const third = await runner.runCycle();
  assert.equal(third.stored, true);
  assert.deepEqual(third.counts, { NEW: 1, REMOVED: 1, MOVED: 0, RETAGGED: 0 });
  // One fetch per cycle — no more, whatever the cycle decided.
  assert.equal(source.state.calls, 3);

  const feed = await store.readDiffFeed('home');
  assert.equal(feed.valid, true);
  assert.equal(feed.entries[0].type, 'alpr-diff-feed-header');
  assert.equal(feed.entries[0].labelling.caveats[0], MAPPER_DENSITY_CAVEAT);
  const kinds = feed.entries.slice(1).map((e) => `${e.kind}:${e.osm_id}`);
  assert.deepEqual(kinds.sort(), ['NEW:3', 'REMOVED:2']);
  const removed = feed.entries.find((e) => e.kind === 'REMOVED');
  assert.equal(removed.corroboration, 'extract');
  assert.equal(removed.confidence, 'REPORTED');
});

test('a removal confirmed by the next cycle upgrades in the feed', async () => {
  const store = createAlprSnapshotStore({ io: createMemorySnapshotIo() });
  const source = scriptedSource([
    frame(iso(T0), [rec(1), rec(2)]),
    frame(iso(T0 + HOUR), [rec(1)]),
    frame(iso(T0 + 2 * HOUR), [rec(1)]),
  ]);
  let nowMs = T0;
  const runner = createAlprDiffCycleRunner({
    source,
    store,
    aoi: AOI,
    now: () => nowMs,
  });
  await runner.runCycle();
  nowMs = T0 + HOUR;
  await runner.runCycle();
  nowMs = T0 + 2 * HOUR;
  await runner.runCycle();
  const feed = await store.readDiffFeed('home');
  const removals = feed.entries.filter((e) => e.kind === 'REMOVED');
  assert.equal(removals.length, 2);
  assert.equal(removals[0].corroboration, 'extract');
  assert.equal(removals[1].corroboration, 'confirmed');
  assert.equal(removals[1].first_absent_extract_ts, iso(T0));
});

test('the feed is AOI-bounded: records outside the AOI are never stored', async () => {
  const store = createAlprSnapshotStore({ io: createMemorySnapshotIo() });
  const outside = rec(9, { latitude: 34.0, longitude: -84.0 });
  const source = scriptedSource([frame(iso(T0), [rec(1), outside])]);
  const runner = createAlprDiffCycleRunner({ source, store, aoi: AOI });
  const result = await runner.runCycle();
  assert.equal(result.stored, true);
  const snapshot = await store.latestSnapshot('home');
  assert.equal(snapshot.record_count, 1);
  assert.equal(snapshot.records[0].osmId, 1);
});

test('a frozen extract surfaces as stalled even when the cycle skips', async () => {
  const store = createAlprSnapshotStore({ io: createMemorySnapshotIo() });
  const source = scriptedSource([
    frame(iso(T0), [rec(1)]),
    frame(iso(T0), [rec(1)]), // the pipeline stops advancing the stamp
  ]);
  let nowMs = T0 + 10 * 60 * 1000;
  const runner = createAlprDiffCycleRunner({
    source,
    store,
    aoi: AOI,
    now: () => nowMs,
  });
  const first = await runner.runCycle();
  assert.equal(first.extract_stalled, false);
  nowMs = T0 + 3 * HOUR; // stamp now 3 h old, threshold is 2 h
  const second = await runner.runCycle();
  assert.equal(second.skipped, 'extract-unchanged');
  assert.equal(second.extract_stalled, true);
});

test('a second runCycle while one is in flight is refused, not queued', async () => {
  const store = createAlprSnapshotStore({ io: createMemorySnapshotIo() });
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const source = {
    attribution: null,
    async fetch() {
      await gate;
      return { records: [rec(1)], extractTs: iso(T0), saturated: false };
    },
  };
  const runner = createAlprDiffCycleRunner({ source, store, aoi: AOI });
  const first = runner.runCycle();
  const second = await runner.runCycle();
  assert.equal(second.skipped, 'cycle-in-flight');
  release();
  assert.equal((await first).stored, true);
});
