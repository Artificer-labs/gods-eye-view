import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createAlprSnapshotStore,
  createChainedJsonl,
  createFileSnapshotIo,
  createMemorySnapshotIo,
  fnv1a64Hex,
  stableStringify,
} from './snapshotStore.js';

const snapshot = (extractTs, ids) => ({
  extract_ts: extractTs,
  ingest_ts: '2026-10-26T13:00:00.000Z',
  complete: true,
  saturated: false,
  records: ids.map((osmId) => ({
    id: `alpr:${osmId}`,
    osmId,
    latitude: 31,
    longitude: -82,
  })),
});

test('stableStringify is key-order independent; fnv1a64Hex is stable', () => {
  assert.equal(
    stableStringify({ b: 1, a: { d: 2, c: 3 } }),
    stableStringify({ a: { c: 3, d: 2 }, b: 1 }),
  );
  assert.equal(fnv1a64Hex('alpr'), fnv1a64Hex('alpr'));
  assert.notEqual(fnv1a64Hex('alpr'), fnv1a64Hex('alpr2'));
  assert.match(fnv1a64Hex('alpr'), /^[0-9a-f]{16}$/);
});

test('snapshots append, read back in order, and verify as a chain', async () => {
  const store = createAlprSnapshotStore({ io: createMemorySnapshotIo() });
  await store.appendSnapshot('home', snapshot('2026-10-26T12:00:00.000Z', [1, 2]));
  await store.appendSnapshot('home', snapshot('2026-10-26T13:00:00.000Z', [1, 2, 3]));
  const all = await store.listSnapshots('home');
  assert.equal(all.length, 2);
  assert.equal(all[0].record_count, 2);
  assert.equal(all[1].record_count, 3);
  const latest = await store.latestSnapshot('home');
  assert.equal(latest.extract_ts, '2026-10-26T13:00:00.000Z');
  const verified = await store.verifySnapshots('home');
  assert.equal(verified.valid, true);
  assert.equal(verified.brokenAt, null);
});

test('a tampered line breaks chain verification at that line', async () => {
  const io = createMemorySnapshotIo();
  const store = createAlprSnapshotStore({ io });
  await store.appendSnapshot('home', snapshot('2026-10-26T12:00:00.000Z', [1]));
  await store.appendSnapshot('home', snapshot('2026-10-26T13:00:00.000Z', [1]));
  const pathKey = [...io._files.keys()].find((k) => k.endsWith('snapshots.jsonl'));
  const lines = io._files.get(pathKey).split('\n');
  const tampered = JSON.parse(lines[0]);
  tampered.record_count = 999;
  lines[0] = JSON.stringify(tampered);
  io._files.set(pathKey, lines.join('\n'));
  const verified = await store.verifySnapshots('home');
  assert.equal(verified.valid, false);
  assert.equal(verified.brokenAt, 1);
});

test('the diff feed writes its header exactly once, before any event', async () => {
  const store = createAlprSnapshotStore({ io: createMemorySnapshotIo() });
  const header = { v: 1, type: 'alpr-diff-feed-header', feed: 'alpr-diff' };
  const event = { v: 1, type: 'alpr-diff-event', kind: 'NEW', osm_id: 7 };
  await store.appendDiffCycle('home', { header, events: [event] });
  await store.appendDiffCycle('home', { header, events: [event] });
  const feed = await store.readDiffFeed('home');
  assert.equal(feed.valid, true);
  assert.equal(feed.entries.length, 3);
  assert.equal(feed.entries[0].type, 'alpr-diff-feed-header');
  assert.equal(
    feed.entries.filter((e) => e.type === 'alpr-diff-feed-header').length,
    1,
  );
});

test('pending removals persist across store instances sharing one IO', async () => {
  const io = createMemorySnapshotIo();
  const first = createAlprSnapshotStore({ io });
  await first.setPendingRemovals('home', { 42: '2026-10-26T12:00:00.000Z' });
  const second = createAlprSnapshotStore({ io });
  assert.deepEqual(await second.getPendingRemovals('home'), {
    42: '2026-10-26T12:00:00.000Z',
  });
});

test('file-backed IO round-trips a store under a real directory', async () => {
  const root = await fsp.mkdtemp(path.join(tmpdir(), 'alpr-store-'));
  try {
    const io = createFileSnapshotIo(root, fsp);
    const store = createAlprSnapshotStore({ io });
    await store.appendSnapshot('home-aoi', snapshot('2026-10-26T12:00:00.000Z', [5]));
    const reread = createAlprSnapshotStore({
      io: createFileSnapshotIo(root, fsp),
    });
    const latest = await reread.latestSnapshot('home-aoi');
    assert.equal(latest.record_count, 1);
    assert.equal((await reread.verifySnapshots('home-aoi')).valid, true);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('createChainedJsonl sequences from GENESIS', async () => {
  const io = createMemorySnapshotIo();
  const chain = createChainedJsonl({ io, path: 'x/y.jsonl' });
  const first = await chain.append({ a: 1 });
  const second = await chain.append({ a: 2 });
  assert.equal(first.seq, 1);
  assert.equal(first.prev_hash, 'GENESIS');
  assert.equal(second.seq, 2);
  assert.equal(second.prev_hash, first.hash);
});
