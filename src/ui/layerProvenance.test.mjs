import test from 'node:test';
import assert from 'node:assert/strict';
import { stampRecord } from '../data/provenance.js';
import {
  LAYER_RECORD_SAMPLE,
  layerFreshness,
  newestProvenancedRecord,
  provenanceSourceForLayer,
  provenanceWithheldCount,
} from './layerProvenance.js';
import { LayerPanel } from './layerPanel.js';

// USGS feed in the registry: 60 s cadence, 3 600 s freshness budget.
const T0 = Date.parse('2026-10-26T04:00:00.000Z');

const stamped = (id, sourceTs, now = sourceTs) =>
  stampRecord(
    { id },
    {
      source_id: 'usgs-quakes',
      source_ts: sourceTs,
      observation_kind: 'OBSERVED',
      now,
    },
  );

test('layerFreshness is judged by the newest envelope in the sample', () => {
  const fresh = stamped('fresh', T0);
  const ancient = stamped('ancient', T0 - 86_400_000);
  assert.equal(newestProvenancedRecord([ancient, fresh]), fresh);
  assert.equal(layerFreshness([ancient, fresh], T0 + 30_000), 'LIVE');
  assert.equal(layerFreshness([ancient], T0 + 30_000), 'EXPIRED');
});

test('layerFreshness walks LIVE → AGING → STALE → EXPIRED as a frozen feed ages', () => {
  const record = stamped('q', T0);
  // Cadence 60 s, slack 1.5×: LIVE to 150 s, AGING to 180 s,
  // STALE until valid_to at 3 600 s, EXPIRED beyond it.
  assert.equal(layerFreshness([record], T0 + 150_000), 'LIVE');
  assert.equal(layerFreshness([record], T0 + 151_000), 'AGING');
  assert.equal(layerFreshness([record], T0 + 181_000), 'STALE');
  assert.equal(layerFreshness([record], T0 + 3_601_000), 'EXPIRED');
});

test('layerFreshness claims nothing for an empty sample and fails closed on bare records', () => {
  assert.equal(layerFreshness([], T0), null);
  assert.equal(layerFreshness(null, T0), null);
  assert.equal(layerFreshness([{ id: 'bare' }], T0), 'EXPIRED');
  assert.ok(LAYER_RECORD_SAMPLE > 0 && LAYER_RECORD_SAMPLE <= 50);
});

test('provenanceWithheldCount reads only a positive gate count', () => {
  assert.equal(provenanceWithheldCount({ provenanceWithheld: 3 }), 3);
  assert.equal(provenanceWithheldCount({ provenanceWithheld: 0 }), 0);
  assert.equal(provenanceWithheldCount({}), 0);
  assert.equal(provenanceWithheldCount(undefined), 0);
});

test('the meta line renders the withheld count when the gate dropped records, and omits it at zero', () => {
  const panel = new LayerPanel({
    getLayers: () => [],
    isEnabled: () => true,
    setEnabled() {},
    setLayerParams() {},
    getRowControls: () => null,
    hasRowControls: () => false,
    subscribeRowControls: () => () => {},
    getLayerFreshness: () => 'STALE',
  });
  const layer = {
    id: 'earthquakes',
    name: 'Earthquakes',
    source: 'USGS',
    enabled: true,
    stats: { count: 4, lastUpdate: Date.now(), provenanceWithheld: 3 },
  };
  assert.match(
    panel._buildMetaText(layer),
    / · STALE · 3 records withheld — unprovenanced$/,
  );
  const clean = {
    ...layer,
    stats: { ...layer.stats, provenanceWithheld: 0 },
  };
  assert.doesNotMatch(panel._buildMetaText(clean), /withheld/);
  assert.match(panel._buildMetaText(clean), / · STALE$/);
});

test('a layer row carries the provenance drawer; a readout row does not', async () => {
  const { railFixture } = await import('./railTestFixture.mjs');
  const f = railFixture();
  const previousDocument = globalThis.document;
  globalThis.document = f.document;
  const layers = [
    {
      id: 'flights',
      name: 'Flights',
      icon: '*',
      source: 'OpenSky',
      enabled: true,
      showInTogglePanel: true,
      stats: {},
    },
    {
      id: 'wind',
      name: 'Wind',
      icon: '*',
      source: 'NOAA GFS',
      enabled: true,
      showInTogglePanel: true,
      stats: {},
    },
  ];
  const panel = new LayerPanel({
    getLayers: () => layers,
    isEnabled: () => true,
    setEnabled() {},
    setLayerParams() {},
    hasRowControls: () => true,
    subscribeRowControls: () => () => {},
    getRowControls: (id) => (id === 'wind' ? { readout: true } : null),
  });
  try {
    panel.mount(f.container);
    const flights = f.find((n) => n.dataset.layerId === 'flights');
    const drawer = flights.querySelector('.data-toggle-provenance');
    assert.ok(drawer, 'the flights row has a provenance drawer');
    const texts = [];
    const walk = (node) => {
      if (node.textContent) texts.push(node.textContent);
      for (const child of node.children || []) walk(child);
    };
    walk(drawer);
    assert.ok(texts.some((text) => text.includes('Source declaration')));
    assert.ok(texts.some((text) => text.includes('OpenSky Network')));
    assert.ok(texts.some((text) => text.includes('opensky-network-terms')));
    const wind = f.find((n) => n.dataset.layerId === 'wind');
    assert.equal(
      wind.querySelector('.data-toggle-provenance'),
      null,
      'readout rows stay toggles and metadata only',
    );
  } finally {
    panel.destroy();
    globalThis.document = previousDocument;
  }
});

test('the drawer data resolves the registry entry for a known layer id', () => {
  assert.deepEqual(provenanceSourceForLayer('earthquakes'), {
    sourceId: 'usgs-quakes',
    name: 'USGS earthquake GeoJSON',
    uri: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php',
    licenseId: 'usgs-public-domain',
    cadenceS: 60,
    latencyS: 300,
    spatialRes: 'epicentre, km class; magnitude preliminary',
  });
  assert.equal(provenanceSourceForLayer('flights')?.sourceId, 'opensky');
  assert.equal(provenanceSourceForLayer('no-such-layer'), null);
});
