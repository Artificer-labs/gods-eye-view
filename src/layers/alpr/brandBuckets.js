/**
 * Flock-vs-other bucketing over the mapped operator/manufacturer tags
 * (spec §2.1, task 3).
 *
 * The buckets are a statement about TAGS, not about the world: FLOCK means
 * a mapper's operator or manufacturer tag names Flock; OTHER means some
 * operator/manufacturer tag exists and none names Flock; UNKNOWN means
 * neither tag exists. UNKNOWN is a first-class bucket — it is never hidden
 * and never redistributed into a guess, and every count this module
 * produces carries its denominator, so a "Flock count" can never be read
 * as a count of Flock cameras in the world.
 *
 * Multi-value OSM tags (`;` lists) are split. A record naming Flock and
 * another vendor lands in FLOCK (primary bucket) and is also counted in
 * `dualTagged`, so the seam stays visible instead of being resolved
 * silently. Primary buckets always sum to the record total.
 *
 * @module layers/alpr/brandBuckets
 */

/** The brand buckets, in display order. */
export const ALPR_BRAND_BUCKETS = Object.freeze(['FLOCK', 'OTHER', 'UNKNOWN']);

/** Normalize one raw tag value for matching: case/punctuation-insensitive. */
export function normalizeBrandValue(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Split a possibly multi-value tag into its normalized values. */
function tagValues(value) {
  return String(value ?? '')
    .split(';')
    .map(normalizeBrandValue)
    .filter(Boolean);
}

const namesFlock = (normalized) =>
  normalized === 'flock' ||
  normalized.startsWith('flock ') ||
  normalized.includes('flock safety') ||
  normalized.includes('flocksafety');

/**
 * The primary brand bucket for one record, from its operator and
 * manufacturer tags (both fields are witnesses; either may name Flock).
 * @param {object} record A normalized ALPR record.
 * @returns {'FLOCK'|'OTHER'|'UNKNOWN'}
 */
export function alprBrandBucket(record) {
  const values = [
    ...tagValues(record?.operator),
    ...tagValues(record?.manufacturer),
  ];
  if (!values.length) return 'UNKNOWN';
  return values.some(namesFlock) ? 'FLOCK' : 'OTHER';
}

/** Whether a FLOCK record also carries a non-Flock operator/manufacturer. */
export function alprAlsoTaggedOther(record) {
  const values = [
    ...tagValues(record?.operator),
    ...tagValues(record?.manufacturer),
  ];
  return values.some(namesFlock) && values.some((v) => !namesFlock(v));
}

/**
 * Bucket counts over a record set, deduped by id, every count carrying
 * its denominator. Primary buckets sum to `total`; `dualTagged` counts
 * FLOCK records that also name another vendor/operator.
 * @param {Array<object>} records Normalized ALPR records.
 * @returns {{total: number, dualTagged: number,
 *   buckets: Object<string, {count: number, denominator: number, fraction: number}>}}
 */
export function summarizeAlprBrands(records) {
  if (!Array.isArray(records))
    throw new TypeError('summarizeAlprBrands requires an array of records');
  const buckets = {};
  for (const bucket of ALPR_BRAND_BUCKETS)
    buckets[bucket] = { count: 0, denominator: 0, fraction: 0 };
  const ids = new Set();
  let total = 0;
  let dualTagged = 0;
  for (const record of records) {
    if (!record || typeof record.id !== 'string' || ids.has(record.id))
      continue;
    ids.add(record.id);
    total += 1;
    buckets[alprBrandBucket(record)].count += 1;
    if (alprAlsoTaggedOther(record)) dualTagged += 1;
  }
  for (const bucket of ALPR_BRAND_BUCKETS) {
    buckets[bucket].denominator = total;
    buckets[bucket].fraction = total ? buckets[bucket].count / total : 0;
  }
  return { total, dualTagged, buckets };
}
