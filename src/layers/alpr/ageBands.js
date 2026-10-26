/**
 * Age bands (spec §2.4 rendering; Division V gate 6, plant ii — the
 * phantom-reader plant's STALE-band limb).
 *
 * A record's rendered band is the WORSE of two honest answers:
 *
 * 1. The field-verification band, from the mapper-asserted
 *    `last_verified` in the provenance envelope: VERIFIED within a year,
 *    AGING to three years, STALE beyond — and a null/UNKNOWN verification
 *    is STALE, never fresh. An OSM edit date is not a verification and is
 *    never read here.
 * 2. The envelope freshness cap, from `freshnessOf` over the record's
 *    own envelope: a record whose source time is UNKNOWN or past its
 *    validity is EXPIRED whatever its field date claims. This is the
 *    clause the gate demanded: on the tile path today, `extract_ts` —
 *    and with it `source_ts` — is UNKNOWN, so every tile record renders
 *    EXPIRED-class. A camera the extract cannot timestamp may be real,
 *    but it may not LOOK fresh.
 *
 * Bands are computed at render time from the envelope, never stored —
 * the same record ages as the clock moves, exactly like freshness.
 *
 * @module layers/alpr/ageBands
 */

import { freshnessOf } from '../../data/provenance.js';
import { UNKNOWN } from './provenance.js';
import { AGE_BAND_VERIFIED_MS, AGE_BAND_AGING_MS } from './policy.js';

/** The four age bands, best to worst. */
export const ALPR_AGE_BANDS = Object.freeze([
  'VERIFIED',
  'AGING',
  'STALE',
  'EXPIRED',
]);

const SEVERITY = Object.freeze({
  VERIFIED: 0,
  AGING: 1,
  STALE: 2,
  EXPIRED: 3,
});

/** Envelope freshness state → the worst band it permits. */
const FRESHNESS_CAP = Object.freeze({
  LIVE: 'VERIFIED',
  AGING: 'AGING',
  STALE: 'STALE',
  EXPIRED: 'EXPIRED',
});

/**
 * Billboard tint + alpha per band (RGBA, 0–1). VERIFIED renders the
 * marker as designed; each worse band is greyer and fainter, so age is
 * visible at map scale before any label is read. EXPIRED is a ghost of
 * a marker — present, because absence would be a claim too, but plainly
 * not current.
 */
export const ALPR_AGE_BAND_TINT = Object.freeze({
  VERIFIED: Object.freeze([1, 1, 1, 1]),
  AGING: Object.freeze([0.8, 0.8, 0.8, 0.9]),
  STALE: Object.freeze([0.62, 0.62, 0.62, 0.6]),
  EXPIRED: Object.freeze([0.55, 0.55, 0.55, 0.38]),
});

const toMs = (value) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  const ms = Date.parse(value ?? '');
  return Number.isFinite(ms) ? ms : null;
};

/**
 * The band the field-verification date alone earns (spec §2.4).
 * @param {object} record A stamped (or bare) ALPR record.
 * @param {number|Date} [now] Judgment instant.
 * @returns {'VERIFIED'|'AGING'|'STALE'}
 */
export function alprVerificationBand(record, now = Date.now()) {
  const raw =
    record?.provenance?.last_verified ?? record?.lastVerified ?? null;
  if (!raw || raw === UNKNOWN) return 'STALE';
  const verifiedMs = toMs(raw);
  if (verifiedMs == null) return 'STALE';
  const nowMs = toMs(now) ?? Date.now();
  const ageMs = Math.max(0, nowMs - verifiedMs);
  if (ageMs <= AGE_BAND_VERIFIED_MS) return 'VERIFIED';
  if (ageMs <= AGE_BAND_AGING_MS) return 'AGING';
  return 'STALE';
}

/**
 * The record's rendered age band: the worse of its verification band
 * and the cap its provenance envelope's freshness imposes. A record
 * with no envelope at all is EXPIRED — it cannot say when anything
 * about it happened.
 * @param {object} record A stamped (or bare) ALPR record.
 * @param {number|Date} [now] Judgment instant.
 * @returns {'VERIFIED'|'AGING'|'STALE'|'EXPIRED'}
 */
export function alprAgeBand(record, now = Date.now()) {
  const band = alprVerificationBand(record, now);
  const cap = record?.provenance
    ? FRESHNESS_CAP[freshnessOf(record, now)]
    : 'EXPIRED';
  return SEVERITY[cap] > SEVERITY[band] ? cap : band;
}

/**
 * The overlay alpha multiplier for a record's band (1 for VERIFIED).
 * @param {object} record A stamped (or bare) ALPR record.
 * @param {number|Date} [now] Judgment instant.
 * @returns {number} 0–1.
 */
export function alprAgeBandAlpha(record, now = Date.now()) {
  return ALPR_AGE_BAND_TINT[alprAgeBand(record, now)][3];
}

/**
 * Band mix for a record set, with explicit denominators — the counts
 * story the layer's stats tell (gate 5's discipline applied to bands:
 * every record is in exactly one band, and the bands sum to the total).
 * @param {Array<object>} records Stamped records.
 * @param {number|Date} [now] Judgment instant.
 * @returns {{total: number, counts: object, fractions: object}}
 */
export function summarizeAlprAgeBands(records, now = Date.now()) {
  const counts = { VERIFIED: 0, AGING: 0, STALE: 0, EXPIRED: 0 };
  const list = Array.isArray(records) ? records : [];
  for (const record of list) counts[alprAgeBand(record, now)] += 1;
  const total = list.length;
  const fractions = Object.fromEntries(
    ALPR_AGE_BANDS.map((band) => [
      band,
      total ? counts[band] / total : 0,
    ]),
  );
  return { total, counts, fractions };
}
