/**
 * The ALPR provenance envelope: slice-1's envelope (src/data/provenance.js)
 * plus the fields this layer's honesty depends on (DeFlock spec §1.3).
 *
 * Two dates ride on every record and are never allowed to impersonate each
 * other:
 * - `osm_edit_ts` — when the OSM node was last EDITED ("last edited in OSM").
 * - `last_verified` — the mapper-asserted field-verification date
 *   (`check_date` / `survey:date`, "last field-verified (mapper-asserted)").
 *   Null stays UNKNOWN; an edit date is never promoted into it.
 *
 * `extract_ts` is the tile extract's generation time. The live tile path
 * cannot see it (the TileJSON carries no timestamp and the vector-tile
 * reader discards response headers), so it is stamped UNKNOWN until that
 * wiring lands — an explicit unknown, never a fabricated precision. The
 * census artifact (scripts/alpr-census.mjs) records the extract timestamp
 * of its own capture separately, from the served TileJSON headers.
 *
 * @module layers/alpr/provenance
 */

import { stampRecord, UNKNOWN } from '../../data/provenance.js';

export { UNKNOWN };

/** Registry source id per witness path. */
export const ALPR_SOURCE_IDS = Object.freeze({
  tiles: 'alpr-deflock-tiles',
  overpass: 'alpr-overpass',
});

/**
 * Stamp one normalized ALPR record with the provenance envelope.
 *
 * The record's claim kind is REPORTED: a mapped node is a mapper's claim
 * about the world, not a sighting by this array. `source_ts` is the
 * witness's own time — the extract time for tiles, the OSM base timestamp
 * for Overpass — and UNKNOWN when the path cannot name one, which leaves
 * the envelope incomplete by design (the fail-closed gate withholds such
 * records from analyst consumers until the time is wired).
 *
 * @param {object} record A record from normalizeAlprNode / decodeAlprTile.
 * @param {object} [options]
 * @param {'tiles'|'overpass'} [options.witness] Which path vouches for it.
 * @param {number|Date} [options.now] Ingest clock override (tests).
 * @param {string|null} [options.extractTs] Tile extract generation time (ISO).
 * @param {string|null} [options.sourceTs] Witness source time (ISO); for
 *   Overpass, the payload's `osm3s.timestamp_osm_base`.
 * @returns {object} The same record, with `.provenance` attached.
 */
export function stampAlprRecord(
  record,
  { witness = 'tiles', now, extractTs = null, sourceTs = null } = {},
) {
  const source_id = ALPR_SOURCE_IDS[witness];
  if (!source_id) throw new TypeError(`Unknown ALPR witness: ${witness}`);
  stampRecord(record, {
    source_id,
    source_ts: sourceTs ?? extractTs ?? UNKNOWN,
    observation_kind: 'REPORTED',
    now,
  });
  const envelope = record.provenance;
  envelope.witnesses = [witness];
  envelope.osm_id = record.osmId ?? null;
  // Labelled "last edited in OSM" — an edit is not a field verification.
  envelope.osm_edit_ts = record.osmTimestamp || UNKNOWN;
  // Labelled "last field-verified (mapper-asserted)". NEVER the edit date.
  envelope.last_verified = record.lastVerified || UNKNOWN;
  envelope.extract_ts = extractTs || UNKNOWN;
  const editMs = Date.parse(record.osmTimestamp || '');
  const extractMs = Date.parse(extractTs || '');
  envelope.mapper_lag_s =
    Number.isFinite(editMs) && Number.isFinite(extractMs)
      ? Math.max(0, Math.round((extractMs - editMs) / 1000))
      : null;
  return record;
}
