/**
 * The ALPR tag census: MEASURED fractions, never estimates (spec §2.1).
 *
 * The spec's design phase could only guess how many DeFlock records carry
 * operator / manufacturer / direction / zone / lastVerified tags. This
 * module replaces the guesses with counts over a real captured extract:
 * feed it the decoded, deduped record set and it reports, per field, the
 * count and the fraction of the total — the denominator always attached,
 * because a brand or field count without one is a KILL-able offence in
 * this house (Division V gate 5).
 *
 * Pure and synchronous so the same code runs in tests, in the CLI
 * (scripts/alpr-census.mjs), and later in the layer's drawer.
 *
 * @module layers/alpr/census
 */

import { summarizeAlprBrands } from './brandBuckets.js';

/** The fields the census measures, as record keys. */
export const CENSUS_FIELDS = Object.freeze([
  'operator',
  'manufacturer',
  'directionDeg',
  'zone',
  'lastVerified',
]);

const present = (value) =>
  value !== null && value !== undefined && value !== '';

/**
 * Count field presence over a record set.
 * @param {Array<object>} records Normalized ALPR records (deduped by id).
 * @returns {{total: number, fields: Object<string, {count: number, fraction: number}>}}
 */
export function censusAlprRecords(records) {
  if (!Array.isArray(records))
    throw new TypeError('censusAlprRecords requires an array of records');
  const fields = {};
  for (const field of CENSUS_FIELDS) fields[field] = { count: 0, fraction: 0 };
  let total = 0;
  const ids = new Set();
  for (const record of records) {
    if (!record || typeof record.id !== 'string') continue;
    if (ids.has(record.id)) continue;
    ids.add(record.id);
    total += 1;
    for (const field of CENSUS_FIELDS)
      if (present(record[field])) fields[field].count += 1;
  }
  for (const field of CENSUS_FIELDS)
    fields[field].fraction = total ? fields[field].count / total : 0;
  return { total, fields };
}

/**
 * Build a census artifact: the counts plus the provenance of the capture
 * itself. A census is data with provenance, not an estimate — the artifact
 * names the extract it measured, when the extract was served, when it was
 * fetched, and what slice of it was decoded.
 *
 * @param {Array<object>} records The deduped decoded records measured.
 * @param {object} capture
 * @param {string} capture.sourceUrl The extract endpoint captured.
 * @param {string|null} capture.extractTs The extract timestamp as served
 *   (TileJSON Last-Modified), or null when the server named none.
 * @param {string} capture.fetchedAt ISO time the capture was fetched.
 * @param {number} capture.zoom The detail zoom decoded.
 * @param {number} capture.tilesDecoded How many tiles were decoded.
 * @returns {object} The artifact (JSON-safe).
 */
export function buildCensusArtifact(
  records,
  { sourceUrl, extractTs = null, fetchedAt, zoom, tilesDecoded },
) {
  const census = censusAlprRecords(records);
  return {
    artifact: 'alpr-tag-census',
    brands: summarizeAlprBrands(records),
    provenance: {
      source_url: sourceUrl,
      extract_ts: extractTs ?? 'UNKNOWN',
      extract_ts_basis:
        'TileJSON Last-Modified response header at capture time',
      fetched_at: fetchedAt,
      decoded_zoom: zoom,
      tiles_decoded: tilesDecoded,
      dedupe: 'by OSM node id (record.id)',
    },
    ...census,
  };
}
