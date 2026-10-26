import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAlprNode } from './records.js';
import { stampAlprRecord } from './provenance.js';
import { alprLabelDetails } from './visuals.js';

/**
 * Hostile-tag harness (Division V gate 2's prescribed cure).
 *
 * Gate 2's sound-by-construction argument was that normalizeAlprNode
 * builds a fresh object from named tags only, so no other OSM content
 * CAN cross. A construction argument is a claim about code; this suite
 * is the adversarial evidence: nodes carrying plate-shaped strings,
 * personal data, mapper identity, and oversized values in every
 * unsanctioned place an OSM element offers, asserting that exactly the
 * twelve sanctioned fields survive normalization, that stamping the
 * provenance envelope smuggles none of it back, and that the drawer's
 * label — built from the record — shows none of it.
 *
 * The storage limb is vacuous by the gate's own finding: no
 * server-side ALPR store exists to leak into. The drawer limb beyond
 * the label (presentation's registerEntityContext) renders a fixed
 * literal of named record properties, so normalization is the single
 * enforcement point — which is what makes this harness sufficient.
 */

const SANCTIONED_KEYS = [
  'cameraType',
  'directionDeg',
  'id',
  'lastVerified',
  'latitude',
  'longitude',
  'manufacturer',
  'operator',
  'osmId',
  'ref',
  'source',
  'zone',
];

const HOSTILE_STRINGS = [
  'ABC-1234', // plate-shaped, in a note tag
  'XYZ 987', // plate-shaped, in an invented vehicle tag
  'jane@example.com', // contact email tag
  'Jane Doe', // owner / name tags
  'mapper_jane', // element-level user
  '+1-512-555-0134', // contact phone tag
  '1200 Congress Ave', // addr:full tag
];

const hostileElement = () => ({
  type: 'node',
  id: 424242,
  lat: 30.2672,
  lon: -97.7431,
  // Element-level metadata an `out meta` query would carry. The layer's
  // query asks `out body` — these must be inert even if they arrive.
  user: 'mapper_jane',
  uid: 777001,
  changeset: 123456789,
  version: 9,
  timestamp: '2026-10-26T00:00:00Z',
  tags: {
    man_made: 'surveillance',
    'surveillance:type': 'ALPR',
    operator: 'City PD',
    manufacturer: 'Flock Safety',
    'camera:type': 'fixed',
    'surveillance:zone': 'Downtown',
    // Hostile payload: personal data, plates, and bulk in tags the
    // sanctioned field list never reads.
    'contact:email': 'jane@example.com',
    'contact:phone': '+1-512-555-0134',
    owner: 'Jane Doe',
    name: 'Jane Doe camera',
    license_plate: 'ABC-1234',
    'vehicle:plate': 'XYZ 987',
    note: 'plate ABC-1234 reads here daily',
    'addr:full': '1200 Congress Ave, Austin, TX',
    description: 'P'.repeat(50_000),
    website: 'https://tracker.example.com/ABC-1234',
  },
});

test('hostile tags: exactly the twelve sanctioned fields survive normalization', () => {
  const record = normalizeAlprNode(hostileElement());
  assert.ok(record, 'the sanctioned core still normalizes');
  assert.deepEqual(Object.keys(record).sort(), SANCTIONED_KEYS);
  // Sanctioned values survive intact — the harness is not a shredder.
  assert.equal(record.operator, 'City PD');
  assert.equal(record.manufacturer, 'Flock Safety');
  assert.equal(record.cameraType, 'fixed');
  assert.equal(record.zone, 'Downtown');
  const serialized = JSON.stringify(record);
  for (const hostile of HOSTILE_STRINGS)
    assert.ok(!serialized.includes(hostile), `hostile string leaked: ${hostile}`);
  assert.ok(!serialized.includes('777001'), 'element uid leaked');
  assert.ok(!serialized.includes('123456789'), 'element changeset leaked');
  assert.ok(!serialized.includes('PPPPPPPPPP'), 'oversized description leaked');
  assert.ok(serialized.length < 1000, 'record stayed small');
});

test('hostile tags: stamping the provenance envelope smuggles nothing back', () => {
  const record = normalizeAlprNode(hostileElement());
  stampAlprRecord(record, { witness: 'overpass', now: 1760000000000 });
  const serialized = JSON.stringify(record);
  for (const hostile of HOSTILE_STRINGS)
    assert.ok(!serialized.includes(hostile), `hostile string leaked: ${hostile}`);
  assert.deepEqual(
    Object.keys(record).sort(),
    [...SANCTIONED_KEYS, 'provenance'].sort(),
  );
});

test('hostile tags: the drawer label shows none of it', () => {
  const record = normalizeAlprNode(hostileElement());
  stampAlprRecord(record, { witness: 'overpass', now: 1760000000000 });
  const label = JSON.stringify(
    alprLabelDetails(record, { attribution: { name: 'OpenStreetMap' } }),
  );
  for (const hostile of HOSTILE_STRINGS)
    assert.ok(!label.includes(hostile), `hostile string in label: ${hostile}`);
});

test('hostile tags: a plate-shaped REF is the one sanctioned carrier — and it is a map ref, not a read', () => {
  // `ref` IS a sanctioned field: mappers use it for the camera's own
  // posted reference. The harness pins the boundary exactly: ref passes
  // because it is sanctioned, everything around it does not.
  const el = hostileElement();
  el.tags = { 'surveillance:type': 'ALPR', ref: 'CAM-0042' };
  const record = normalizeAlprNode(el);
  assert.equal(record.ref, 'CAM-0042');
  assert.deepEqual(Object.keys(record).sort(), SANCTIONED_KEYS);
});

test('hostile tags: rejection paths stay closed — wrong type, bad id, no ALPR tag', () => {
  const el = hostileElement();
  assert.equal(normalizeAlprNode({ ...el, type: 'way' }), null);
  assert.equal(normalizeAlprNode({ ...el, id: -5 }), null);
  assert.equal(normalizeAlprNode({ ...el, id: 1.5 }), null);
  const noAlpr = hostileElement();
  noAlpr.tags = { ...noAlpr.tags, 'surveillance:type': 'camera' };
  assert.equal(normalizeAlprNode(noAlpr), null);
  // Semicolon multi-values still count as ALPR — with hostile extras attached.
  const multi = hostileElement();
  multi.tags = { ...multi.tags, 'surveillance:type': 'camera;ALPR' };
  const record = normalizeAlprNode(multi);
  assert.ok(record);
  assert.deepEqual(Object.keys(record).sort(), SANCTIONED_KEYS);
});
