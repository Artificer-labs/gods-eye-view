import { defaultSurface } from './surfaceServices.js';
import { createApplicationAlpr } from '../app/layers/alprCameras.js';
import { createSourceSlot } from '../sources/sourceSlot.js';
import {
  createAlprTileSource,
  createOverpassAlprSource,
  createReconciledAlprSource,
} from '../layers/alpr/index.js';
export * from '../layers/alpr/index.js';
// The layer's default source is the RECONCILED source (Division V gate
// ruling, conditional pass): tile extracts as system of record with the
// live Overpass overlay reconciled per spec §1.2, and an attribution
// merged from BOTH witnesses. The layer itself stays caged and
// default-off in the catalog — a better source is not an enabling.
const slot = createSourceSlot(
  createReconciledAlprSource({
    tileSource: createAlprTileSource(),
    overpassSource: createOverpassAlprSource(),
  }),
  ['fetch'],
  'ALPR source',
  { destroy: () => {}, detailZoom: () => null },
);
export const configureAlprSource = slot.configure;
export default createApplicationAlpr({
  surface: defaultSurface,
  source: slot.source,
});
