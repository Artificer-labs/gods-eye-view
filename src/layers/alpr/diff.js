/**
 * The ALPR hourly diff engine — pure core (spec §3.2, task 5).
 *
 * Compares two consecutive extract snapshots of one watched AOI and
 * emits change events for Fusion's register: NEW / REMOVED / MOVED /
 * RETAGGED. Every event is single-witness-family (OSM via the tile
 * extract) and therefore ships at REPORTED confidence — this engine
 * never writes CONFIRMED; promotion is Fusion's act, not the differ's.
 *
 * KEYING DECISION (settled here, per Division V's re-examination ruling
 * (b)(2) and Greta's condition 3): the diff cycle keys on the SNAPSHOT
 * stamp pair. A snapshot carries one extract stamp — the served
 * Last-Modified basis the stall tracker already reads — because the
 * per-record envelope's `extract_ts` remains UNKNOWN on the tile path
 * (the builder's deliberate non-change). Events therefore key on
 * (osm_id, prev_extract_ts, extract_ts) at snapshot level, and NO event
 * ever inherits an UNKNOWN silently: when either stamp of the pair is
 * unknown, the key says UNKNOWN, `stamp_quality` reads 'UNKNOWN', and
 * the event's confidence is labelled degraded
 * (`degradation_reason: 'UNKNOWN_STAMP_CYCLE'`). An unknown-stamp
 * event_id is derived from the pair's INGEST stamps instead, so it
 * stays unique per observed cycle without fabricating an extract time.
 *
 * ABSENCE DISCIPLINE (reused from reconcile.js §1.2 rule 3 — one
 * standard, never a second): a REMOVED event may be emitted only from a
 * completed, unsaturated comparison — BOTH snapshots complete and
 * neither saturated. An untrusted comparison records no absence at all:
 * would-be removals are counted as `suppressedRemovals` (a health
 * figure, not events) and the pending-removal state passes through
 * untouched. A first trusted absence ships as REMOVED with
 * corroboration 'extract'; if the node is still absent at the next
 * trusted comparison, the event upgrades to corroboration 'confirmed'
 * and names the event it upgrades. This mirrors the register's
 * REMOVED (extract) → REMOVED promotion in spec §3.2.
 *
 * @module layers/alpr/diff
 */

import { distanceMeters, POSITION_CONFLICT_M } from './reconcile.js';
import { fnv1a64Hex, stableStringify } from './snapshotStore.js';
import {
  MAPPER_DENSITY_CAVEAT,
  NO_MAPPED_READER,
  alprCoverageCaveatLines,
} from './labelling.js';

export const ALPR_DIFF_FEED_VERSION = 1;

/** MOVED threshold: a shift beyond this is a move, not tile noise. */
export const ALPR_MOVED_THRESHOLD_M = POSITION_CONFLICT_M;

/** Fields whose change makes a RETAGGED event (spec §3.2). */
export const ALPR_RETAGGED_FIELDS = Object.freeze([
  'operator',
  'manufacturer',
  'directionDeg',
  'zone',
  'lastVerified',
]);

const UNKNOWN_STAMP = 'UNKNOWN';

const toIso = (value) => {
  if (value == null) return null;
  const ms =
    typeof value === 'number'
      ? value
      : value instanceof Date
        ? value.getTime()
        : Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};

/** The stamp as a key component: its ISO form, or the explicit UNKNOWN. */
export function alprStampKey(value) {
  return toIso(value) ?? UNKNOWN_STAMP;
}

/**
 * The diff-relevant shape of a record: exactly the sanctioned fields the
 * differ may look at (records.js's twelve, minus nothing) — provenance
 * envelopes and render state never enter the store or the feed.
 */
export function liteAlprRecord(record) {
  if (!record || typeof record.id !== 'string') return null;
  return {
    id: record.id,
    osmId: record.osmId ?? null,
    latitude: record.latitude,
    longitude: record.longitude,
    operator: record.operator ?? null,
    manufacturer: record.manufacturer ?? null,
    cameraType: record.cameraType ?? null,
    zone: record.zone ?? null,
    directionDeg: record.directionDeg ?? null,
    ref: record.ref ?? null,
    lastVerified: record.lastVerified ?? null,
    osmTimestamp: record.osmTimestamp ?? null,
  };
}

/** Bounding box of an AOI ({bbox} directly, or the bounds of {polygon}). */
export function alprAoiBbox(aoi) {
  if (!aoi) return null;
  if (aoi.bbox) return aoi.bbox;
  if (Array.isArray(aoi.polygon) && aoi.polygon.length) {
    let south = Infinity,
      west = Infinity,
      north = -Infinity,
      east = -Infinity;
    for (const [lon, lat] of aoi.polygon) {
      if (lat < south) south = lat;
      if (lat > north) north = lat;
      if (lon < west) west = lon;
      if (lon > east) east = lon;
    }
    return { south, west, north, east };
  }
  return null;
}

const pointInPolygon = (lon, lat, ring) => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (
      yi > lat !== yj > lat &&
      lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi
    )
      inside = !inside;
  }
  return inside;
};

/** Whether a record falls inside the AOI (bbox gate, polygon exact). */
export function alprRecordInAoi(record, aoi) {
  if (!aoi) return true;
  const bbox = alprAoiBbox(aoi);
  if (
    bbox &&
    (record.latitude < bbox.south ||
      record.latitude > bbox.north ||
      record.longitude < bbox.west ||
      record.longitude > bbox.east)
  )
    return false;
  if (Array.isArray(aoi.polygon) && aoi.polygon.length >= 3)
    return pointInPolygon(record.longitude, record.latitude, aoi.polygon);
  return true;
}

/**
 * Bound a record set to the subscribed AOI (spec §3.2/§3.3; Greta
 * condition 2 — AOI-scoped product). With no AOI configured the set
 * passes through whole; a national firehose is never the default when
 * an AOI exists.
 */
export function filterAlprRecordsToAoi(records, aoi) {
  if (!aoi) return [...(records || [])];
  return (records || []).filter((record) => alprRecordInAoi(record, aoi));
}

// Pending-removal state rides JSON between cycles, so its keys come
// back as strings; OSM ids are numeric and events must not change the
// id's type between the first absence and its confirmation.
const asOsmId = (key) => (/^\d+$/.test(key) ? Number(key) : key);

const byOsmId = (records) => {
  const map = new Map();
  for (const record of records || []) {
    const lite = liteAlprRecord(record);
    if (!lite) continue;
    const key = lite.osmId ?? lite.id;
    if (!map.has(key)) map.set(key, lite);
  }
  return map;
};

const positionOf = (record) => ({
  latitude: record.latitude,
  longitude: record.longitude,
});

/**
 * Diff two consecutive snapshots of one AOI.
 *
 * @param {object} input
 * @param {object} input.previous {records, extract_ts, ingest_ts,
 *   complete, saturated} — the earlier snapshot (may be null: first
 *   cycle establishes the baseline and emits nothing).
 * @param {object} input.current Same shape, the new snapshot.
 * @param {object} [input.pendingRemovals] osmId → first-absent extract
 *   stamp key, carried from the previous cycle's output.
 * @param {number|Date} [input.now] Emission clock (tests).
 * @param {Function} [input.digest] Hash for event ids (tests).
 * @returns {{events: Array<object>, pendingRemovals: object,
 *   comparisonComplete: boolean, suppressedRemovals: number,
 *   stampQuality: 'KNOWN'|'UNKNOWN', counts: object}}
 */
export function diffAlprSnapshots({
  previous,
  current,
  pendingRemovals = {},
  now,
  digest = fnv1a64Hex,
} = {}) {
  if (!current || !Array.isArray(current.records))
    throw new TypeError('diff requires a current snapshot with records');
  const emittedTs = toIso(now ?? Date.now());
  const aoiId = current.aoi_id ?? previous?.aoi_id ?? null;
  const prevStamp = alprStampKey(previous?.extract_ts);
  const curStamp = alprStampKey(current.extract_ts);
  const stampQuality =
    prevStamp === UNKNOWN_STAMP || curStamp === UNKNOWN_STAMP
      ? 'UNKNOWN'
      : 'KNOWN';
  const degraded = stampQuality === 'UNKNOWN';
  // Absence is meaningful only under a completed, unsaturated
  // comparison (reconcile.js rule 3, reused verbatim as doctrine).
  const comparisonComplete =
    previous != null &&
    previous.complete !== false &&
    previous.saturated !== true &&
    current.complete !== false &&
    current.saturated !== true;

  const prevById = byOsmId(previous?.records);
  const curById = byOsmId(current?.records);
  const pendingIn = { ...(pendingRemovals || {}) };
  const pendingOut = {};
  const events = [];
  let suppressedRemovals = 0;

  const baseEvent = (kind, osmId) => {
    const key = { osm_id: osmId, prev_extract_ts: prevStamp, extract_ts: curStamp };
    const idBasis = degraded
      ? [osmId, kind, previous?.ingest_ts ?? null, current.ingest_ts ?? null, 'UNKNOWN_STAMP_CYCLE']
      : [osmId, kind, prevStamp, curStamp];
    return {
      v: ALPR_DIFF_FEED_VERSION,
      type: 'alpr-diff-event',
      event_id: `alpr-diff:${digest(stableStringify(idBasis))}`,
      key,
      kind,
      osm_id: osmId,
      aoi_id: aoiId,
      confidence: 'REPORTED',
      ...(degraded
        ? {
            confidence_degraded: true,
            degradation_reason: 'UNKNOWN_STAMP_CYCLE',
          }
        : { confidence_degraded: false }),
      stamp_quality: stampQuality,
      witnesses: [
        { source: 'alpr-deflock-tiles', extract_ts: prevStamp },
        { source: 'alpr-deflock-tiles', extract_ts: curStamp },
      ],
      emitted_ts: emittedTs,
    };
  };

  if (previous != null) {
    for (const [osmId, cur] of curById) {
      const prev = prevById.get(osmId);
      if (!prev) {
        events.push({
          ...baseEvent('NEW', osmId),
          record_id: cur.id,
          before: null,
          after: cur,
        });
        continue;
      }
      const movedM = distanceMeters(prev, cur);
      if (movedM > ALPR_MOVED_THRESHOLD_M) {
        events.push({
          ...baseEvent('MOVED', osmId),
          record_id: cur.id,
          distance_m: Math.round(movedM * 10) / 10,
          before: positionOf(prev),
          after: positionOf(cur),
        });
        continue;
      }
      const changes = {};
      for (const field of ALPR_RETAGGED_FIELDS) {
        const from = prev[field] ?? null;
        const to = cur[field] ?? null;
        if (from !== to) changes[field] = { from, to };
      }
      if (Object.keys(changes).length) {
        events.push({
          ...baseEvent('RETAGGED', osmId),
          record_id: cur.id,
          changed_fields: Object.keys(changes),
          // A direction change is an aim change; say so (spec §3.2).
          aim_change: 'directionDeg' in changes,
          changes,
          before: positionOf(prev),
          after: positionOf(cur),
        });
      }
    }

    for (const [osmId, prev] of prevById) {
      if (curById.has(osmId)) continue;
      if (!comparisonComplete) {
        // Untrusted comparison: NO absence is recorded — the pending
        // state passes through untouched and the suppression is a
        // counted health figure, never an event.
        suppressedRemovals += 1;
        if (osmId in pendingIn) pendingOut[osmId] = pendingIn[osmId];
        continue;
      }
      const firstAbsent = pendingIn[osmId];
      const event = {
        ...baseEvent('REMOVED', osmId),
        record_id: prev.id,
        corroboration: firstAbsent ? 'confirmed' : 'extract',
        before: prev,
        after: null,
      };
      if (firstAbsent) {
        event.first_absent_extract_ts = firstAbsent;
        event.upgrades_key = {
          osm_id: osmId,
          prev_extract_ts: firstAbsent,
          extract_ts: prevStamp,
        };
      }
      events.push(event);
      pendingOut[osmId] = firstAbsent ?? prevStamp;
    }
    // The confirmation pass: a node already pending from an earlier
    // cycle is absent from BOTH snapshots now. Under a second trusted
    // comparison its removal upgrades to CONFIRMED-corroboration and
    // the pending entry settles (the baseline no longer holds the node,
    // so no later cycle can re-emit it). Under an untrusted comparison
    // it simply rides along — still no absence is recorded.
    for (const [rawKey, firstAbsent] of Object.entries(pendingIn)) {
      const osmId = asOsmId(rawKey);
      if (prevById.has(osmId) || curById.has(osmId)) continue;
      if (!comparisonComplete) {
        pendingOut[osmId] = firstAbsent;
        continue;
      }
      events.push({
        ...baseEvent('REMOVED', osmId),
        record_id: `alpr:${osmId}`,
        corroboration: 'confirmed',
        first_absent_extract_ts: firstAbsent,
        upgrades_key: {
          osm_id: osmId,
          prev_extract_ts: firstAbsent,
          extract_ts: prevStamp,
        },
        // The record itself was last seen two snapshots ago; this
        // differ holds only the pair, so before/after stay null rather
        // than resurrecting a stale copy as if current.
        before: null,
        after: null,
      });
    }
  }

  events.sort(
    (a, b) =>
      String(a.osm_id).localeCompare(String(b.osm_id), 'en', {
        numeric: true,
      }) || a.kind.localeCompare(b.kind),
  );
  const counts = { NEW: 0, REMOVED: 0, MOVED: 0, RETAGGED: 0 };
  for (const event of events) counts[event.kind] += 1;
  return {
    events,
    pendingRemovals: pendingOut,
    comparisonComplete,
    suppressedRemovals,
    stampQuality,
    counts,
  };
}

/**
 * The diff feed's header — the first line of every feed file. Carries
 * the merged attribution and the ODbL share-alike marking (gate 1: the
 * marking duty rides every derived product, per the census precedent),
 * and — Greta condition 4 / spec §4.3 — the mapper-density caveat lines
 * BEFORE any event is listed, plus the hedged absence sentence the
 * feed's REMOVED class must be read under (condition 1).
 *
 * @param {object} input
 * @param {object} input.aoi {id, name?} The watched AOI.
 * @param {object} input.attribution Merged attribution object
 *   ({name, description, text, href} — mergeAlprAttributions output).
 * @param {number|Date} [input.now] Header clock (tests).
 * @returns {object} Header entry for the feed's chained JSONL.
 */
export function buildAlprDiffFeedHeader({ aoi, attribution, now } = {}) {
  if (!aoi?.id) throw new TypeError('diff feed header requires an AOI');
  return {
    v: ALPR_DIFF_FEED_VERSION,
    type: 'alpr-diff-feed-header',
    feed: 'alpr-diff',
    aoi_id: aoi.id,
    aoi_name: aoi.name ?? null,
    attribution: attribution ?? null,
    license: 'ODbL-1.0',
    share_alike: true,
    labelling: {
      absence: NO_MAPPED_READER,
      caveats: alprCoverageCaveatLines(),
    },
    created_ts: toIso(now ?? Date.now()),
  };
}

export { MAPPER_DENSITY_CAVEAT };
