import test from 'node:test';
import assert from 'node:assert/strict';
import { stampRecord } from '../data/provenance.js';
import { LayerPresentation } from './layerPresentation.js';

const stamped = (id, sourceTs) =>
  stampRecord(
    { id },
    {
      source_id: 'usgs-quakes',
      source_ts: sourceTs,
      observation_kind: 'OBSERVED',
      now: sourceTs,
    },
  );

function fakePresentation(records) {
  let activity = null;
  let calls = 0;
  const module = {
    getAnalystRecords: (maxCount) => {
      calls += 1;
      assert.ok(maxCount <= 50, 'the sample stays bounded');
      return records;
    },
  };
  const manager = {
    layers: new Map([['earthquakes', { module }]]),
    subscribeActivity: (listener) => {
      activity = listener;
      return () => {};
    },
  };
  const presentation = new LayerPresentation(manager, {
    weatherClock: null,
    requestRender: () => {},
    invalidateDetection: () => {},
  });
  return {
    presentation,
    calls: () => calls,
    publish: (change) => activity(change),
  };
}

test('layer freshness samples the gated records once, then recomputes from the cached envelope', () => {
  const now = Date.now();
  const { presentation, calls } = fakePresentation([
    stamped('q', now - 30_000),
  ]);
  assert.equal(presentation._layerFreshness('earthquakes'), 'LIVE');
  assert.equal(presentation._layerFreshness('earthquakes'), 'LIVE');
  assert.equal(calls(), 1, 'repeat reads reuse the cached envelope');
  presentation.destroy();
});

test('layer freshness reads EXPIRED when the newest envelope has aged out', () => {
  const now = Date.now();
  const { presentation } = fakePresentation([
    stamped('q', now - 7_200_000),
  ]);
  assert.equal(presentation._layerFreshness('earthquakes'), 'EXPIRED');
  presentation.destroy();
});

test('new data invalidates the cached sample; an unknown layer claims no state', () => {
  const now = Date.now();
  const records = [stamped('old', now - 7_200_000)];
  const { presentation, calls, publish } = fakePresentation(records);
  assert.equal(presentation._layerFreshness('earthquakes'), 'EXPIRED');
  records[0] = stamped('new', now - 5_000);
  assert.equal(
    presentation._layerFreshness('earthquakes'),
    'EXPIRED',
    'the cache holds until the layer reports new data',
  );
  publish({ type: 'data-updated', layerId: 'earthquakes' });
  assert.equal(presentation._layerFreshness('earthquakes'), 'LIVE');
  assert.equal(calls(), 2);
  assert.equal(presentation._layerFreshness('no-such-layer'), null);
  presentation.destroy();
});
