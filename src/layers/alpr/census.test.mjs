import test from 'node:test';
import assert from 'node:assert/strict';
import {
  censusAlprRecords,
  buildCensusArtifact,
} from './census.js';
import { stampAlprRecord, UNKNOWN } from './provenance.js';
import {
  createPmtilesReader,
  zxyToTileId,
  tileIdToZxy,
  firstTileIdOfZoom,
} from './pmtiles.js';

const rec = (id, fields = {}) => ({
  id: `alpr:${id}`,
  osmId: id,
  latitude: 30,
  longitude: -97,
  operator: null,
  manufacturer: null,
  cameraType: null,
  zone: null,
  directionDeg: null,
  ref: null,
  lastVerified: null,
  source: null,
  ...fields,
});

test('census counts measured fractions with the denominator attached', () => {
  const records = [
    rec(1, { operator: 'City PD', manufacturer: 'Flock Safety', directionDeg: 90 }),
    rec(2, { operator: 'County Sheriff' }),
    rec(3, { zone: 'Downtown', lastVerified: '2024-03-01' }),
    rec(4, {}),
    rec(1, { operator: 'Duplicate id — must not double count' }),
  ];
  const census = censusAlprRecords(records);
  assert.equal(census.total, 4);
  assert.deepEqual(census.fields.operator, { count: 2, fraction: 0.5 });
  assert.deepEqual(census.fields.manufacturer, { count: 1, fraction: 0.25 });
  assert.deepEqual(census.fields.directionDeg, { count: 1, fraction: 0.25 });
  assert.deepEqual(census.fields.zone, { count: 1, fraction: 0.25 });
  assert.deepEqual(census.fields.lastVerified, { count: 1, fraction: 0.25 });
});

test('census artifact carries the capture provenance and brand buckets', () => {
  const artifact = buildCensusArtifact(
    [rec(1, { manufacturer: 'Flock Safety' }), rec(2, {})],
    {
      sourceUrl: 'https://tiles.dontgetflocked.com/cameras-us-hourly.pmtiles',
      extractTs: '2026-10-26T12:45:12.000Z',
      fetchedAt: '2026-10-26T12:50:00.000Z',
      zoom: 9,
      tilesDecoded: 1234,
    },
  );
  assert.equal(artifact.provenance.extract_ts, '2026-10-26T12:45:12.000Z');
  assert.equal(artifact.provenance.decoded_zoom, 9);
  assert.equal(artifact.total, 2);
  assert.equal(artifact.brands.buckets.FLOCK.count, 1);
  assert.equal(artifact.brands.buckets.UNKNOWN.count, 1);
  assert.equal(artifact.brands.buckets.FLOCK.denominator, 2);
});

test('the envelope never promotes an OSM edit date into last_verified', () => {
  const record = rec(7, { lastVerified: null });
  record.osmTimestamp = '2025-06-01T00:00:00.000Z';
  stampAlprRecord(record, { witness: 'tiles', now: 1760000000000 });
  assert.equal(record.provenance.source_id, 'alpr-deflock-tiles');
  assert.equal(record.provenance.observation_kind, 'REPORTED');
  assert.equal(record.provenance.osm_edit_ts, '2025-06-01T00:00:00.000Z');
  assert.equal(record.provenance.last_verified, UNKNOWN);
  assert.equal(record.provenance.extract_ts, UNKNOWN);
  assert.deepEqual(record.provenance.witnesses, ['tiles']);
});

test('the envelope keeps a mapper-asserted verification date verbatim', () => {
  const record = rec(8, { lastVerified: '2023-05-01' });
  record.osmTimestamp = '2025-06-01T00:00:00.000Z';
  stampAlprRecord(record, {
    witness: 'tiles',
    now: 1760000000000,
    extractTs: '2025-06-02T00:00:00.000Z',
  });
  assert.equal(record.provenance.last_verified, '2023-05-01');
  assert.equal(record.provenance.extract_ts, '2025-06-02T00:00:00.000Z');
  assert.equal(
    record.provenance.mapper_lag_s,
    Math.round(
      (Date.parse('2025-06-02T00:00:00.000Z') -
        Date.parse('2025-06-01T00:00:00.000Z')) /
        1000,
    ),
  );
});

test('the Overpass stamp uses the OSM base timestamp as its source time', () => {
  const record = rec(9, {});
  stampAlprRecord(record, {
    witness: 'overpass',
    now: 1760000000000,
    sourceTs: '2026-10-26T12:44:00.000Z',
  });
  assert.equal(record.provenance.source_id, 'alpr-overpass');
  assert.equal(record.provenance.source_ts, '2026-10-26T12:44:00.000Z');
});

test('tile id conversion round-trips across zooms', () => {
  for (const [z, x, y] of [
    [0, 0, 0],
    [1, 0, 0],
    [1, 1, 0],
    [9, 128, 210],
    [11, 467, 843],
    [12, 1078, 1645],
    [14, 4312, 6580],
  ]) {
    assert.deepEqual(tileIdToZxy(zxyToTileId(z, x, y)), [z, x, y]);
  }
  assert.equal(firstTileIdOfZoom(0), 0);
  assert.equal(firstTileIdOfZoom(1), 1);
  assert.equal(firstTileIdOfZoom(2), 5);
});

// --- a synthetic PMTiles archive, built byte by byte -------------------
function varintBytes(n) {
  const out = [];
  let v = BigInt(n);
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v) byte |= 0x80;
    out.push(byte);
  } while (v);
  return out;
}
function directoryBytes(entries) {
  const sorted = [...entries].sort((a, b) => a.tileId - b.tileId);
  const parts = [...varintBytes(sorted.length)];
  let prev = 0;
  for (const e of sorted) {
    parts.push(...varintBytes(e.tileId - prev));
    prev = e.tileId;
  }
  for (const e of sorted) parts.push(...varintBytes(e.runLength));
  for (const e of sorted) parts.push(...varintBytes(e.length));
  for (let i = 0; i < sorted.length; i++) {
    const e = sorted[i];
    if (i > 0 && e.offset === sorted[i - 1].offset + sorted[i - 1].length)
      parts.push(...varintBytes(0));
    else parts.push(...varintBytes(e.offset + 1));
  }
  return Uint8Array.from(parts);
}
function archiveBytes({ rootDir, tilesBlob, leafDir = null }) {
  const headerLength = 127;
  const rootOffset = headerLength;
  const tilesOffset = rootOffset + rootDir.length;
  const leafOffset = tilesOffset + tilesBlob.length;
  const bytes = new Uint8Array(
    leafOffset + (leafDir ? leafDir.length : 0),
  );
  bytes.set(new TextEncoder().encode('PMTiles'), 0);
  bytes[7] = 3;
  const view = new DataView(bytes.buffer);
  const set = (at, value) => view.setBigUint64(at, BigInt(value), true);
  set(8, rootOffset);
  set(16, rootDir.length);
  set(24, 0);
  set(32, 0);
  set(40, leafOffset);
  set(48, leafDir ? leafDir.length : 0);
  set(56, tilesOffset);
  set(64, tilesBlob.length);
  bytes[97] = 1; // internal compression: none
  bytes[98] = 1; // tile compression: none
  bytes.set(rootDir, rootOffset);
  bytes.set(tilesBlob, tilesOffset);
  if (leafDir) bytes.set(leafDir, leafOffset);
  return bytes;
}

test('the PMTiles reader resolves root-directory tiles', () => {
  const blobA = new TextEncoder().encode('tile-a');
  const blobB = new TextEncoder().encode('tile-b!');
  const tilesBlob = new Uint8Array(blobA.length + blobB.length);
  tilesBlob.set(blobA, 0);
  tilesBlob.set(blobB, blobA.length);
  const rootDir = directoryBytes([
    { tileId: zxyToTileId(1, 0, 0), offset: 0, length: blobA.length, runLength: 1 },
    {
      tileId: zxyToTileId(1, 1, 0),
      offset: blobA.length,
      length: blobB.length,
      runLength: 1,
    },
  ]);
  const reader = createPmtilesReader(archiveBytes({ rootDir, tilesBlob }));
  assert.equal(reader.header.version, 3);
  assert.deepEqual(reader.getTile(1, 0, 0), blobA);
  assert.deepEqual(reader.getTile(1, 1, 0), blobB);
  assert.equal(reader.getTile(1, 0, 1), null);
  assert.equal(reader.tilesAtZoom(1).length, 2);
});

test('the PMTiles reader resolves leaf directories', () => {
  const blob = new TextEncoder().encode('leaf-tile');
  const leafDir = directoryBytes([
    { tileId: zxyToTileId(2, 1, 1), offset: 0, length: blob.length, runLength: 1 },
  ]);
  const rootDir = directoryBytes([
    { tileId: zxyToTileId(2, 0, 0), offset: 0, length: leafDir.length, runLength: 0 },
  ]);
  const reader = createPmtilesReader(
    archiveBytes({ rootDir, tilesBlob: blob, leafDir }),
  );
  assert.deepEqual(reader.getTile(2, 1, 1), blob);
  assert.equal(reader.tilesAtZoom(2).length, 1);
});
