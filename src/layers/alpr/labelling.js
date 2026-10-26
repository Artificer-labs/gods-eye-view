/**
 * The §4 labelling law, as code (spec §4; Division V gate 4 — Greta's
 * dissent, condition 1: "mitigations as code first, light second").
 *
 * This layer's records are claims by OpenStreetMap mappers about where
 * ALPR readers stand. The map can therefore never declare an area free
 * of readers: an empty patch is a statement about where mappers walked,
 * not about where readers are deployed. Every surface this layer feeds —
 * drawer, labels, stats, feed headers, coverage summaries — speaks of
 * absence only in the hedged form, which names the basis:
 *
 *   NO MAPPED READER — community mapping, unverified absence
 *
 * The constants below are the canonical wordings for surfaces that do not
 * pass through the UI's t() extraction (feed headers, cycle summaries,
 * register entries). The browser layer's own t() literals carry the same
 * texts inline (the i18n extractor only sees literals at the call site);
 * labelling.test.mjs audits BOTH — it scans the layer's rendered string
 * literals for an unhedged absence claim and fails the build if one
 * appears, and it pins these constants to the hedged forms.
 *
 * @module layers/alpr/labelling
 */

/** The basis every absence statement on this layer must name. */
export const ALPR_MAPPING_BASIS = 'community mapping (OpenStreetMap)';

/**
 * The mapper-density caveat (spec §4.3): a coverage product for a
 * sparsely mapped area is primarily a statement about the map, and its
 * header says so before any segment is listed. Carried by the diff feed
 * header and every coverage summary this layer emits.
 */
export const MAPPER_DENSITY_CAVEAT =
  'Coverage describes community mapping (OpenStreetMap), not deployment: ' +
  'absence on this map is mapper absence — an unmapped road may still ' +
  'have readers, and a mapped reader may be gone.';

/** Hedged absence, area/segment form (spec §4's own sentence shape). */
export const NO_MAPPED_READER =
  'NO MAPPED READER — community mapping, unverified absence';

/** Hedged absence, in-view form — mirrors the layer's empty-state label. */
export const NO_MAPPED_READERS_IN_VIEW =
  'No mapped ALPR readers in this view — community mapping, unverified absence';

/** Hedged absence, outside the extracts' geography (US + Canada). */
export const NO_MAPPED_DATA_FOR_AREA =
  'No mapped ALPR data for this area — extracts cover the US and Canada only';

/** Saturation wording: our mapped data is limited, never the world. */
export const COVERAGE_LIMITED_MAPPED =
  'Coverage limited — mapped data only, zoom in';

/**
 * The caveat lines a coverage-bearing product header must carry, in
 * order, before any segment, count, or event is listed.
 * @returns {Array<string>}
 */
export function alprCoverageCaveatLines() {
  return [MAPPER_DENSITY_CAVEAT];
}

/**
 * The hedged absence label for an area, segment, or cell — the ONLY
 * absence sentence this layer's products may print about a place.
 * @returns {string}
 */
export function alprAbsenceLabel() {
  return NO_MAPPED_READER;
}
