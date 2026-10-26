import { createTrafficLayer } from '../../layers/traffic/index.js';
import * as credits from '../../data/dataCredits.js';
import * as ground from '../../data/groundFloor.js';
import * as render from '../../renderGovernor.js';

/** Construct one layer using the application scene owners and a supplied source. */
export function createApplicationTraffic({ source, surface }) {
  const layer = createTrafficLayer({
    source,
    services: { credits, render, ground: surface?.groundFloor || ground },
  });
  // ARRAY FORK (graft task 2): the catalog's traffic layer is born in
  // strict hide-unmatched mode — roads TomTom has no flow for spawn no
  // dots. Together with the controls-level refusal of 'sim', simulated
  // traffic fill is unreachable in this fork's app.
  layer.setParams({ uncoveredRoads: 'hide' });
  return layer;
}
