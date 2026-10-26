/**
 * Provenance presentation for the layer panel: layer-level freshness from
 * gated analyst records, the gate's withheld count, and the registry truth
 * a layer's provenance drawer shows.
 *
 * Pure functions over the envelope contract (../data/provenance.js) and the
 * source registry (../data/sourceRegistry.js) — no DOM, no layer internals.
 * Freshness is computed from an envelope at the instant it is asked for,
 * never stored: a layer whose feed died keeps its last records, their
 * envelopes age, and the state walks LIVE → AGING → STALE → EXPIRED on its
 * own.
 */

import { freshnessOf, isProvenanced } from '../data/provenance.js';
import { getSource, sourceIdForLayer } from '../data/sourceRegistry.js';

/** Bounded analyst-record sample a layer freshness read may take. */
export const LAYER_RECORD_SAMPLE = 50;

/**
 * The provenanced record with the newest source time in a sample, or null
 * when the sample holds no complete envelope.
 * @param {Array<object>} records Analyst records (already gate-filtered).
 * @returns {object|null}
 */
export function newestProvenancedRecord(records) {
  if (!Array.isArray(records)) return null;
  let newest = null;
  let newestMs = -Infinity;
  for (const record of records) {
    if (!isProvenanced(record)) continue;
    const ms = Date.parse(record.provenance.source_ts);
    if (Number.isFinite(ms) && ms > newestMs) {
      newest = record;
      newestMs = ms;
    }
  }
  return newest;
}

/**
 * A layer's freshness at an instant, judged by the newest envelope in a
 * bounded sample of its gated analyst records.
 *
 * No records → null: the layer claims nothing, so the panel shows no state.
 * Records but no complete envelope → 'EXPIRED', the gate's own fail-closed
 * reading (freshnessOf on a bare record): what cannot say when it happened
 * is not live data.
 *
 * @param {Array<object>} records Analyst records (already gate-filtered).
 * @param {number|Date} [now] The instant to judge at (defaults to now).
 * @returns {'LIVE'|'AGING'|'STALE'|'EXPIRED'|null}
 */
export function layerFreshness(records, now = Date.now()) {
  if (!Array.isArray(records) || records.length === 0) return null;
  const newest = newestProvenancedRecord(records);
  return newest ? freshnessOf(newest, now) : 'EXPIRED';
}

/**
 * Records the provenance gate withheld from a layer, as its stats report
 * them (`provenanceWithheld`, added by withProvenanceGate). Anything that
 * is not a positive count reads as 0 — no segment is rendered for it.
 * @param {object} [stats] Layer getStats() result.
 * @returns {number}
 */
export function provenanceWithheldCount(stats) {
  const count = stats?.provenanceWithheld;
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

/**
 * The registry truth behind a layer's provenance drawer: the source
 * declaration — name, uri, licence, declared cadence and latency, spatial
 * resolution — for the source the layer's records are stamped against.
 * Static registry truth, labelled as the source declaration; it says what
 * the source promises, not what any one record did.
 * @param {string} layerId Catalog layer id.
 * @returns {{sourceId: string, name: string, uri: string, licenseId: string,
 *   cadenceS: number, latencyS: number, spatialRes: string}|null}
 *   Null when the layer has no registered source.
 */
export function provenanceSourceForLayer(layerId) {
  const sourceId = sourceIdForLayer(layerId);
  const source = sourceId ? getSource(sourceId) : undefined;
  if (!source) return null;
  return {
    sourceId: source.source_id,
    name: source.name,
    uri: source.uri,
    licenseId: source.license_id,
    cadenceS: source.declared_cadence_s,
    latencyS: source.declared_latency_s,
    spatialRes: source.spatial_res,
  };
}
