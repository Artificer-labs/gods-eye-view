// Provenance adapter (graft task 8): USGS analyst records are stamped at
// the getAnalystRecords seam — origin time as source_ts, the USGS revision
// time (`updated`) as published_ts, SOURCE_REVISED when updated > time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEarthquakesLayer } from './index.js';
import { isProvenanced } from '../../data/provenance.js';

const T0 = 1_753_600_000_000; // origin time for both fixture events
const REVISED = T0 + 3_600_000; // revised one hour after origin

const ROWS = [
  {
    stableId: 'us-unrevised',
    usgsId: 'us-unrevised',
    lon: -150.41,
    lat: 61.02,
    depthKm: 41.7,
    mag: 5.2,
    place: 'Unrevised fixture',
    time: T0,
    updated: T0,
  },
  {
    stableId: 'us-revised',
    usgsId: 'us-revised',
    lon: 139.7,
    lat: 35.6,
    depthKm: 310,
    mag: 4.8,
    place: 'Revised fixture',
    time: T0,
    updated: REVISED,
  },
];

async function analystRecords() {
  const dataSources = [];
  const viewer = {
    dataSources: {
      add(dataSource) {
        dataSources.push(dataSource);
        return dataSource;
      },
      remove() {
        return true;
      },
    },
  };
  const layer = createEarthquakesLayer({
    source: { getSnapshot: async () => ROWS },
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
  });
  layer.init(viewer);
  layer.enable(viewer);
  await layer.update(viewer);
  const records = layer.getAnalystRecords();
  layer.destroy(viewer);
  return records;
}

test('quake analyst records carry the usgs-quakes envelope', async () => {
  const records = await analystRecords();
  assert.equal(records.length, 2);
  for (const record of records) {
    assert.ok(isProvenanced(record), `${record.id} passes the gate`);
    assert.equal(record.provenance.source_id, 'usgs-quakes');
    assert.equal(record.provenance.observation_kind, 'OBSERVED');
    // source_ts is the event ORIGIN time, never the revision time.
    assert.equal(record.provenance.source_ts, new Date(T0).toISOString());
  }
});

test('an unrevised quake publishes at its origin time, unflagged', async () => {
  const [record] = await analystRecords();
  assert.equal(record.id, 'us-unrevised');
  assert.equal(record.provenance.published_ts, new Date(T0).toISOString());
  assert.ok(!record.provenance.quality_flags.includes('SOURCE_REVISED'));
});

test('a revised quake supersedes visibly: published_ts = update, SOURCE_REVISED', async () => {
  const [, record] = await analystRecords();
  assert.equal(record.id, 'us-revised');
  assert.equal(record.provenance.source_ts, new Date(T0).toISOString());
  assert.equal(record.provenance.published_ts, new Date(REVISED).toISOString());
  assert.ok(record.provenance.quality_flags.includes('SOURCE_REVISED'));
});
