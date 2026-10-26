import { createSurfaceServices } from './surfaceServices.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApplicationCatalog } from './constructCatalog.js';
import { createDefaultLayerState } from '../data/layerState.js';
import { sourceIdForLayer } from '../data/sourceRegistry.js';
import { createStandaloneLayerSources } from '../standalone/layerSources.js';
import { catalogControlServices } from './catalog.js';
import { LayerLifecycle } from '../data/lifecycle.js';
import { fakeStreetLevelProvider } from '../testSupport/streetLevelFakes.mjs';

function fixtureSources(ids, calls) {
  const sources = createStandaloneLayerSources();
  sources.military = {
    getSnapshot: async () => {
      throw new Error('Use identity acquisition');
    },
    async getIdentities(_query, { signal }) {
      calls.push(signal);
      return ids;
    },
  };
  return sources;
}

test('catalogs construct distinct layers and classification from their supplied source', async (t) => {
  const a = new AbortController();
  const b = new AbortController();
  t.after(() => {
    a.abort();
    b.abort();
  });
  const callsA = [];
  const callsB = [];
  const first = createApplicationCatalog({
    sources: fixtureSources(['abc123'], callsA),
    signal: a.signal,
    surface: fixtureSurface(a.signal),
  });
  const second = createApplicationCatalog({
    sources: fixtureSources(['def456'], callsB),
    signal: b.signal,
    surface: fixtureSurface(b.signal),
  });
  assert.equal(first.layers.length, 30);
  assert.ok(first.get('local-adsb'), 'Local ADS-B is registered');
  assert.deepEqual(
    first.metadata.find(({ id }) => id === 'local-adsb'),
    { id: 'local-adsb', disposition: 'local-only' },
    'the hardware-local layer is never serialized into links',
  );
  assert.notEqual(first.weatherClock, second.weatherClock);
  await first.weatherClock.setTarget('2026-09-21T12:00:00.000Z');
  assert.match(
    first.get('wind').getRowControls().info,
    /Forecast · does not follow history/,
  );
  assert.equal(second.get('wind').getRowControls().summary.status, null);
  for (const id of ['weather-radar', 'weather-satellite', 'weather-lightning'])
    assert.equal(
      first.get(id).getDiagnostics().clock.target,
      '2026-09-21T12:00:00.000Z',
    );
  assert.ok(first.get('fire-perimeters'));
  assert.ok(first.get('gnss-integrity'));
  assert.ok(first.get('transit'));
  const order = first.layers.map(({ id }) => id);
  assert.deepEqual(
    order.slice(order.indexOf('traffic'), order.indexOf('directions') + 1),
    ['traffic', 'cctv', 'radio', 'transit', 'bikeshare', 'directions'],
  );
  // ARRAY FORK (graft task 2): the Bhote Koshi pair is struck — never
  // constructed, never registered, absent from the catalog metadata.
  assert.equal(first.get('bhote-koshi-2026'), undefined);
  assert.equal(first.get('bhote-koshi-locator'), undefined);
  assert.equal(
    first.metadata.some(({ id }) => id.startsWith('bhote-koshi')),
    false,
  );
  // Caged layers stay registered but inactive by default: traffic is
  // not in the durable default enabled set, and its unmatched-road
  // treatment is forced to strict hide (no simulated dots).
  // ARRAY FORK — DeFlock LIT 2026-10-26 on Dylan's word, Division V's
  // §6 gates SUSTAIN after re-examination, Greta's dissent on file:
  // ALPR alone joins the durable default set (see layerState.js and
  // the LIGHTING RECORD in ARRAY_PATCHES.md). Traffic stays caged.
  const defaults = createDefaultLayerState();
  assert.equal(defaults.enabledLayerIds.includes('traffic'), false);
  assert.equal(defaults.enabledLayerIds.includes('alpr-cameras'), true);
  assert.ok(first.get('traffic'), 'traffic stays registered, caged');
  assert.ok(first.get('alpr-cameras'), 'ALPR stays registered, now lit');
  assert.equal(first.get('traffic').getParams().uncoveredRoads, 'hide');
  first.get('traffic').setParams({ uncoveredRoads: 'sim' });
  assert.equal(
    first.get('traffic').getParams().uncoveredRoads,
    'hide',
    'the fork refuses to re-enable simulated traffic fill',
  );
  const lifecycle = new LayerLifecycle({});
  for (const layer of first.layers) lifecycle.register(layer);
  const rows = lifecycle.getAll();
  // ARRAY FORK (graft task 3): every constructed layer passed the
  // fail-closed provenance gate at this choke point, named against its
  // registered source.
  for (const layer of first.layers) {
    assert.equal(
      typeof layer.getProvenanceGateStats,
      'function',
      `${layer.id} is provenance-gated`,
    );
    assert.equal(
      layer.getProvenanceGateStats().sourceId,
      sourceIdForLayer(layer.id),
      `${layer.id} is gated against its registered source`,
    );
  }
  assert.equal(
    rows.find((row) => row.id === 'flights')?.showInTogglePanel,
    true,
    'ordinary data layer entries remain visible',
  );
  assert.deepEqual(
    first.layers.map(({ id }) => id),
    second.layers.map(({ id }) => id),
  );
  for (const layer of first.layers)
    assert.notEqual(layer, second.get(layer.id));
  assert.equal(
    catalogControlServices(first).satellitesLayer,
    first.get('satellites'),
  );
  assert.equal(callsA.length, 0, 'construction must not acquire');
  await first.militaryRegistry.refreshMilitaryRegistryIfStale();
  await second.militaryRegistry.refreshMilitaryRegistryIfStale();
  assert.equal(first.militaryRegistry.isMilitaryIcao('abc123'), true);
  assert.equal(first.militaryRegistry.isMilitaryIcao('def456'), false);
  assert.equal(second.militaryRegistry.isMilitaryIcao('def456'), true);
  a.abort();
  assert.equal(
    await first.weatherClock.setTarget('2026-09-21T13:00:00.000Z'),
    false,
  );
  assert.equal(callsA[0].aborted, true);
  assert.equal(first.militaryRegistry.isMilitaryIcao('abc123'), false);
  assert.equal(callsB[0].aborted, false);
  assert.equal(second.militaryRegistry.isMilitaryIcao('def456'), true);
});

test('invalid or already cancelled construction fails before classification can acquire', () => {
  const lifetime = new AbortController();
  assert.throws(
    () =>
      createApplicationCatalog({
        sources: { flights: {} },
        signal: lifetime.signal,
        surface: fixtureSurface(lifetime.signal),
      }),
    /catalog source/,
  );
  lifetime.abort();
  assert.throws(
    () =>
      createApplicationCatalog({
        sources: createStandaloneLayerSources(),
        signal: lifetime.signal,
      }),
    { name: 'AbortError' },
  );
});

function fixtureSurface(signal) {
  return createSurfaceServices({
    terrainSource: { getHeights: async () => [] },
    signal,
    eventTarget: null,
  });
}

test('Mapillary can be omitted or replaced without changing catalog membership', (t) => {
  const lifetime = new AbortController();
  t.after(() => lifetime.abort());
  const sources = fixtureSources([], []);
  delete sources.mapillary;
  const options = {
    sources,
    signal: lifetime.signal,
    surface: fixtureSurface(lifetime.signal),
  };
  const catalog = createApplicationCatalog(options);
  assert.equal(catalog.layers.length, 30);
  assert.deepEqual(catalog.get('street-level').providerIds, []);
  assert.equal(
    catalogControlServices(catalog).streetLevelLayer,
    catalog.get('street-level'),
  );
  assert.match(
    catalog.get('street-level').getUIState().coverage.hint,
    /No street-level imagery providers/,
  );
  const provider = fakeStreetLevelProvider({
    id: 'example',
    pickPrefix: 'example:',
  });
  const replacement = createApplicationCatalog({
    ...options,
    streetLevelProviders: [provider],
  });
  assert.deepEqual(replacement.get('street-level').providerIds, ['example']);
  assert.deepEqual(replacement.metadata, catalog.metadata);
  assert.equal(provider.calls.activate, 0, 'construction must not acquire');
  assert.deepEqual(
    createApplicationCatalog({
      ...options,
      sources: fixtureSources([], []),
      streetLevelProviders: [],
    }).get('street-level').providerIds,
    [],
  );
  assert.throws(
    () =>
      createApplicationCatalog({
        ...options,
        sources: { ...sources, mapillary: {} },
      }),
    /Mapillary source/,
  );
});
