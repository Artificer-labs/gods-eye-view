/**
 * Dual-source reconciliation: tile extracts × live Overpass (spec §1.2,
 * task 2). Identity is the OSM node id (`record.id`) — the join is exact,
 * never spatial guessing.
 *
 * Rules, as specified:
 * 1. Per-node precedence: where both witnesses hold a node, the Overpass
 *    version wins for tags and position (it is the newer witness); the
 *    merged record carries `witnesses: ['tiles', 'overpass']`.
 * 2. Overpass-only nodes (mapped since the extract) are admitted at once,
 *    flagged `sinceExtract: true` — the layer's freshest objects.
 * 3. Tile-only nodes are NEVER deleted off an Overpass query. Inside a
 *    completed, unsaturated, error-free query their absence is noted
 *    (`absenceNoted: true`, with the query time); a second consecutive
 *    noted absence (the caller passes the previously noted ids) promotes
 *    them to `removedCandidate: true` for the diff engine. A saturated or
 *    failed query records no absence at all — NO DATA is a different word
 *    from NO EVENT.
 * 4. Position conflicts > 25 m between witnesses keep the Overpass
 *    position and are flagged `positionConflict: true` — never averaged.
 *
 * The merged set is re-validated through validateAlprSnapshot's record
 * rules by the caller; this module's own output contract is the flags
 * above plus a provenance envelope whose witness list reflects the join.
 *
 * @module layers/alpr/reconcile
 */

import { stampAlprRecord } from './provenance.js';

/** Metres; below this, witness disagreement is tile-quantization noise. */
export const POSITION_CONFLICT_M = 25;

const EARTH_RADIUS_M = 6371008.8;

/** Great-circle distance between two lat/lon points, in metres. */
export function distanceMeters(a, b) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

const byId = (records) => {
  const map = new Map();
  for (const record of records || []) {
    if (record && typeof record.id === 'string' && !map.has(record.id))
      map.set(record.id, record);
  }
  return map;
};

/**
 * Merge one tile snapshot with one Overpass snapshot for the same view.
 *
 * @param {object} input
 * @param {Array<object>} input.tileRecords System-of-record records.
 * @param {Array<object>} [input.overpassRecords] Freshness-overlay records.
 * @param {object} [input.overpassQuery] The overlay query's honesty state:
 *   {completed: boolean, saturated: boolean, at: number|Date}. Absence is
 *   only meaningful when completed && !saturated.
 * @param {Set<string>|Array<string>} [input.previouslyAbsentIds] Ids whose
 *   absence was already noted by an earlier clean query; a repeat absence
 *   promotes them to removed candidates.
 * @param {number|Date} [input.now] Ingest clock override (tests).
 * @param {string|null} [input.extractTs] Tile extract time, when wired.
 * @param {string|null} [input.overpassSourceTs] Overpass OSM base time.
 * @returns {{records: Array<object>, stats: {merged: number,
 *   overpassOnly: number, tileOnly: number, absencesNoted: number,
 *   removedCandidates: number, positionConflicts: number}}}
 */
export function reconcileAlprSnapshots({
  tileRecords = [],
  overpassRecords = [],
  overpassQuery = null,
  previouslyAbsentIds = null,
  now,
  extractTs = null,
  overpassSourceTs = null,
} = {}) {
  const tiles = byId(tileRecords);
  const overpass = byId(overpassRecords);
  const previouslyAbsent = new Set(previouslyAbsentIds || []);
  const absenceCounts =
    overpassQuery?.completed === true && overpassQuery?.saturated !== true;
  const absenceAt =
    overpassQuery?.at instanceof Date
      ? overpassQuery.at.toISOString()
      : typeof overpassQuery?.at === 'number'
        ? new Date(overpassQuery.at).toISOString()
        : null;
  const stats = {
    merged: 0,
    overpassOnly: 0,
    tileOnly: 0,
    absencesNoted: 0,
    removedCandidates: 0,
    positionConflicts: 0,
  };
  const records = [];

  for (const [id, tile] of tiles) {
    const live = overpass.get(id);
    if (!live) {
      const record = {
        ...tile,
        witnesses: ['tiles'],
        sinceExtract: false,
        absenceNoted: absenceCounts,
        absenceNotedAt: absenceCounts ? absenceAt : null,
        removedCandidate: absenceCounts && previouslyAbsent.has(id),
        positionConflict: false,
      };
      if (absenceCounts) {
        stats.absencesNoted += 1;
        if (record.removedCandidate) stats.removedCandidates += 1;
      }
      stats.tileOnly += 1;
      stampAlprRecord(record, { witness: 'tiles', now, extractTs });
      record.provenance.witnesses = ['tiles'];
      records.push(record);
      continue;
    }
    const conflict =
      distanceMeters(tile, live) > POSITION_CONFLICT_M;
    const record = {
      ...tile,
      ...live,
      witnesses: ['tiles', 'overpass'],
      sinceExtract: false,
      absenceNoted: false,
      removedCandidate: false,
      positionConflict: conflict,
    };
    if (conflict) stats.positionConflicts += 1;
    stats.merged += 1;
    stampAlprRecord(record, {
      witness: 'overpass',
      now,
      sourceTs: overpassSourceTs,
    });
    record.provenance.witnesses = ['tiles', 'overpass'];
    records.push(record);
  }

  for (const [id, live] of overpass) {
    if (tiles.has(id)) continue;
    const record = {
      ...live,
      witnesses: ['overpass'],
      sinceExtract: true,
      absenceNoted: false,
      removedCandidate: false,
      positionConflict: false,
    };
    stats.overpassOnly += 1;
    stampAlprRecord(record, {
      witness: 'overpass',
      now,
      sourceTs: overpassSourceTs,
    });
    record.provenance.witnesses = ['overpass'];
    records.push(record);
  }

  return { records, stats };
}

/**
 * Merge two witnesses' attribution objects into one credit that names
 * BOTH. The witnesses credit the same data under different lines (the
 * tile extract's "© OpenStreetMap contributors, ODbL" and the Overpass
 * path's "OpenStreetMap contributors (ODbL 1.0; community mapped)"), and
 * Division V's gate ruling is explicit: a reconciled source that passes
 * through only one witness's attribution silently drops the other's
 * credit. Distinct lines are unioned, never overwritten; identical lines
 * appear once.
 *
 * @param {object|null} primary The system-of-record witness's attribution.
 * @param {object|null} secondary The overlay witness's attribution.
 * @returns {object|null} The merged attribution {name, description, text, href}.
 */
export function mergeAlprAttributions(primary, secondary) {
  if (!primary) return secondary || null;
  if (!secondary) return primary;
  const joinDistinct = (a, b) =>
    [
      ...new Set(
        [a, b].filter((v) => typeof v === 'string' && v.trim()),
      ),
    ].join(' · ');
  return {
    name: primary.name || secondary.name,
    description: joinDistinct(primary.description, secondary.description),
    text: joinDistinct(primary.text, secondary.text),
    href: primary.href || secondary.href,
  };
}

/**
 * Compose the two existing source factories into one reconciled source
 * for the layer. The tile extract is fetched first (system of record);
 * the Overpass overlay is then attempted for the same box — an overlay
 * failure never costs the tile picture: the snapshot degrades to
 * tile-only with `overlayError` named, and (per rule 3) records no
 * absences from a query that never completed.
 *
 * This is the layer's default source (wired in src/data/alprCameras.js)
 * under Division V's conditional ruling: the reconciled source is at
 * least as honest as the tile-only incumbent on every axis the gates
 * measure — PROVIDED its attribution is merged from both witnesses
 * (mergeAlprAttributions above), never the tile credit alone. The layer
 * itself remains caged and default-off in the catalog; wiring the
 * better source does not enable it.
 *
 * @param {object} sources {tileSource, overpassSource} — each with fetch(box, signal).
 * @returns {{fetch: Function, label: string, attribution: object}}
 */
export function createReconciledAlprSource({ tileSource, overpassSource }) {
  if (
    typeof tileSource?.fetch !== 'function' ||
    typeof overpassSource?.fetch !== 'function'
  )
    throw new TypeError('Reconciled ALPR source requires both witnesses');
  return {
    async fetch(box, signal) {
      const tileSnapshot = await tileSource.fetch(box, signal);
      if (tileSnapshot.zoomIn || tileSnapshot.noCoverage) return tileSnapshot;
      let overlay = null;
      let overlayError = null;
      try {
        overlay = await overpassSource.fetch(box, signal);
      } catch (error) {
        overlayError = error?.message || 'Overpass overlay unavailable';
      }
      const { records, stats } = reconcileAlprSnapshots({
        tileRecords: tileSnapshot.records,
        overpassRecords: overlay?.records || [],
        overpassQuery: overlay
          ? {
              completed: true,
              saturated: overlay.saturated === true,
              at: Date.now(),
            }
          : { completed: false, saturated: false },
      });
      return {
        records,
        stale: Boolean(tileSnapshot.stale || overlay?.stale),
        // Stall health rides through untouched (spec §3.3 rule 5): a
        // frozen extract degrades the reconciled snapshot exactly as it
        // degrades the tile-only one.
        extractTs: tileSnapshot.extractTs ?? null,
        extractStalled: tileSnapshot.extractStalled === true,
        saturated:
          tileSnapshot.saturated === true ||
          overlay?.saturated === true,
        coverage: tileSnapshot.coverage,
        zoom: tileSnapshot.zoom,
        reconciliation: stats,
        ...(overlayError ? { overlayError } : {}),
      };
    },
    detailZoom: tileSource.detailZoom,
    destroy() {
      tileSource.destroy?.();
      overpassSource.destroy?.();
    },
    label: tileSource.label,
    attribution: mergeAlprAttributions(
      tileSource.attribution,
      overpassSource.attribution,
    ),
  };
}
