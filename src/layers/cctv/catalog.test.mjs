// src/layers/cctv/catalog.test.mjs
// F-03/F-19 (simulation audit): the catalog is built from server sources
// and nothing else. An empty source list stays empty (the lifecycle no
// longer substitutes the authored seed grid), and a real source whose id
// happens to match a seed must not inherit the seed's 'high' heading
// confidence — authored defaults are not a survey of that camera.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createCatalog } from './catalog.js';

function catalogHarness() {
  return createCatalog({
    state: {},
    services: {
      locations: {
        CITY_POIS: {
          nyc: {
            name: 'New York',
            groundElevation: 10,
            pois: [
              { lat: 40.7, lon: -74.0 },
              { lat: 40.75, lon: -73.98, heading: 10 },
              { lat: 40.71, lon: -74.01 },
            ],
          },
        },
      },
    },
    parts: {
      model: {
        safeNumber: (value, fallback) => {
          const n = Number(value);
          return value !== undefined && value !== null && value !== '' &&
            Number.isFinite(n)
            ? n
            : fallback;
        },
        normalizeHeading: (deg) => ((deg % 360) + 360) % 360,
        clamp: (value, min, max) => Math.min(max, Math.max(min, value)),
        headingFromId: () => 0,
        normalizeFeedType: (type) => String(type || 'image').toLowerCase(),
        offsetDegrees: () => ({ latOffset: 0, lonOffset: 0 }),
        ensureCameraPose: () => {},
      },
    },
    source: {},
  });
}

test('an empty source list builds an empty catalog — no invented cameras', () => {
  const catalog = catalogHarness();
  assert.deepEqual(catalog.buildCatalogFromSources([]), []);
  assert.deepEqual(catalog.buildCatalogFromSources(null), []);
});

test('a seed-matching real source keeps its own (low) heading confidence', () => {
  const catalog = catalogHarness();
  const built = catalog.buildCatalogFromSources([
    { id: 'nyc-times-square-ne', lat: 40.75, lon: -73.98 },
  ]);
  // Exactly the one registered source — the seed itself never leaks in
  // as an additional camera.
  assert.equal(built.length, 1);
  assert.equal(built[0].id, 'nyc-times-square-ne');
  assert.equal(built[0].headingConfidence, 'low');
});

test('a source-stated heading confidence is preserved', () => {
  const catalog = catalogHarness();
  const built = catalog.buildCatalogFromSources([
    {
      id: 'nyc-times-square-ne',
      lat: 40.75,
      lon: -73.98,
      headingConfidence: 'medium',
    },
  ]);
  assert.equal(built[0].headingConfidence, 'medium');
});
