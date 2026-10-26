/**
 * The provenance envelope: the array's founding law in one module.
 *
 * Every record that reaches the map carries an envelope saying where it came
 * from, when the SOURCE says it happened (`source_ts` — the sensor's time,
 * never receipt time), when we took it in (`ingest_ts`), what kind of claim
 * it is (`observation_kind`), and when it stops describing the world
 * (`valid_to`). Freshness is computed from the envelope at render time, never
 * stored as a state a feed could lie about (packet §1.3).
 *
 * An unknown value is the explicit string 'UNKNOWN' plus a quality flag —
 * never a missing key, never a silent null (packet §1.2). The gate below
 * (withProvenanceGate) is stricter than the schema: a record whose envelope
 * is incomplete — no registered `source_id`, no real `source_ts`, no
 * `observation_kind` — does not render at all.
 *
 * @module data/provenance
 */

import { getSource, requireSource } from './sourceRegistry.js';

/** The claim kinds a record may make (packet §1.2). */
export const OBSERVATION_KINDS = Object.freeze([
  'OBSERVED',
  'PROPAGATED',
  'DERIVED',
  'REPORTED',
  'PREDICTED',
  'INTERPOLATED',
]);

/** The freshness states a record can be in at a given instant (packet §1.3). */
export const FRESHNESS_STATES = Object.freeze([
  'LIVE',
  'AGING',
  'STALE',
  'EXPIRED',
]);

/** Explicit unknown marker — an unknown is stated, never omitted. */
export const UNKNOWN = 'UNKNOWN';

/** Slack on the declared cadence before a record stops reading LIVE. */
const FRESHNESS_SLACK = 1.5;

/** Normalize a timestamp input (epoch ms, Date, or ISO string) to epoch ms. */
function toEpochMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === 'string' && value !== UNKNOWN) {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

const toIso = (ms) => new Date(ms).toISOString();

/**
 * Attach the provenance envelope to a record and return the record.
 *
 * `latency_ms` and `valid_to` are computed here, never hand-entered:
 * latency is ingest minus source time; validity ends one freshness budget
 * (from the source registry) after the source time. A `source_ts` the caller
 * cannot name must be passed as 'UNKNOWN' (or omitted): the envelope then
 * says so explicitly, gains the UNKNOWN_FIELD flag, and the record will not
 * pass the gate — an honest unknown, kept out of the live picture.
 *
 * @param {object} record The layer record to stamp (mutated: `.provenance`).
 * @param {object} fields
 * @param {string} fields.source_id Registered source (sourceRegistry.js).
 * @param {number|string|Date} [fields.source_ts] When the source says it happened.
 * @param {string} fields.observation_kind One of OBSERVATION_KINDS.
 * @param {string[]} [fields.quality_flags] Packet §1.2 flags, e.g. ELEMENTS_AGED.
 * @param {number|string|Date} [fields.published_ts] When the source made it available.
 * @param {number|Date} [fields.now] Ingest clock override (tests).
 * @returns {object} The same record, with `.provenance` attached.
 */
export function stampRecord(record, fields = {}) {
  if (!record || typeof record !== 'object')
    throw new TypeError('stampRecord requires a record object');
  const source = requireSource(fields.source_id);
  const kind = fields.observation_kind;
  if (!OBSERVATION_KINDS.includes(kind))
    throw new TypeError(`Invalid observation_kind: ${kind}`);
  const ingestMs = toEpochMs(fields.now ?? Date.now());
  const sourceMs = toEpochMs(fields.source_ts);
  const quality_flags = [...(fields.quality_flags || [])];
  let source_ts = UNKNOWN;
  let latency_ms = null;
  let valid_to = null;
  if (sourceMs === null) {
    if (!quality_flags.includes('UNKNOWN_FIELD'))
      quality_flags.push('UNKNOWN_FIELD');
  } else {
    source_ts = toIso(sourceMs);
    latency_ms = Math.max(0, ingestMs - sourceMs);
    valid_to = toIso(sourceMs + source.freshness_budget_s * 1000);
  }
  const publishedMs = toEpochMs(fields.published_ts);
  record.provenance = {
    source_id: source.source_id,
    source_name: source.name,
    source_uri: source.uri,
    source_ts,
    published_ts: publishedMs === null ? UNKNOWN : toIso(publishedMs),
    ingest_ts: toIso(ingestMs),
    latency_ms,
    declared_latency_s: source.declared_latency_s,
    spatial_res: source.spatial_res,
    temporal_res: {
      cadence_s: source.declared_cadence_s,
      kind: 'UPDATE_INTERVAL',
    },
    observation_kind: kind,
    license_id: source.license_id,
    valid_to,
    quality_flags,
  };
  return record;
}

/**
 * The envelope fields a record is missing or holds invalidly, in check
 * order. An empty list means the envelope is complete: the source is
 * registered, the source time is a real timestamp (an explicit 'UNKNOWN'
 * counts as missing — the schema may state an unknown, the gate may not
 * render one), and the claim kind is a known kind.
 *
 * @param {object} record A record, stamped or not.
 * @returns {string[]} Gap names: 'provenance' | 'source_id' | 'source_ts' | 'observation_kind'.
 */
export function provenanceGaps(record) {
  const envelope = record?.provenance;
  if (!envelope || typeof envelope !== 'object') return ['provenance'];
  const gaps = [];
  if (
    typeof envelope.source_id !== 'string' ||
    !getSource(envelope.source_id)
  )
    gaps.push('source_id');
  if (toEpochMs(envelope.source_ts) === null) gaps.push('source_ts');
  if (!OBSERVATION_KINDS.includes(envelope.observation_kind))
    gaps.push('observation_kind');
  return gaps;
}

/** Whether a record carries a complete provenance envelope. */
export function isProvenanced(record) {
  return provenanceGaps(record).length === 0;
}

/**
 * Assert a record carries a complete envelope; throws listing the gaps.
 * @param {object} record A record, stamped or not.
 * @returns {object} The record, unchanged.
 */
export function assertProvenanced(record) {
  const gaps = provenanceGaps(record);
  if (gaps.length)
    throw new TypeError(
      `Record is missing provenance: ${gaps.join(', ')} (source: ${record?.provenance?.source_id || 'none'})`,
    );
  return record;
}

/**
 * The record's freshness at an instant, computed — never stored.
 *
 * LIVE while the age is within cadence + slack (slack = 1.5 × cadence),
 * AGING to 3 × cadence, STALE beyond that until `valid_to`, EXPIRED past
 * `valid_to` (packet §1.3). A record without a complete envelope is EXPIRED
 * by definition: what cannot say when it happened is not live data.
 *
 * @param {object} record A stamped record.
 * @param {number|Date} [now] The instant to judge at (defaults to now).
 * @returns {'LIVE'|'AGING'|'STALE'|'EXPIRED'}
 */
export function freshnessOf(record, now = Date.now()) {
  if (!isProvenanced(record)) return 'EXPIRED';
  const envelope = record.provenance;
  const nowMs = toEpochMs(now);
  const sourceMs = toEpochMs(envelope.source_ts);
  const validToMs = toEpochMs(envelope.valid_to);
  if (nowMs === null || sourceMs === null) return 'EXPIRED';
  if (validToMs !== null && nowMs > validToMs) return 'EXPIRED';
  const source = getSource(envelope.source_id);
  const cadenceS =
    envelope.temporal_res?.cadence_s ?? source?.declared_cadence_s ?? 0;
  const ageS = Math.max(0, (nowMs - sourceMs) / 1000);
  if (ageS <= cadenceS * (1 + FRESHNESS_SLACK)) return 'LIVE';
  if (ageS <= cadenceS * 3) return 'AGING';
  return 'STALE';
}

/**
 * The fail-closed gate, applied at the one choke point where layers are
 * born (`createApplicationCatalog`): there is no second place a layer can
 * come from, so there is no path around it.
 *
 * The gate wraps the layer's record accessor (`getAnalystRecords` — the
 * stream every consumer, analyst engine and voice included, reads records
 * through). A record without a complete envelope is **dropped and
 * counted**, never handed on; the count is surfaced on the layer's stats
 * as `provenanceWithheld` ("N records withheld — unprovenanced") and via
 * `getProvenanceGateStats()`. In dev builds the gate throws on the first
 * bare record instead, so a missing adapter is a build-time defect, not a
 * silent hole. Per-layer adapters that stamp records at their normalize
 * step land in graft tasks 6–10; until a layer's records are stamped, the
 * gate withholds them — that asymmetry (unprovenanced is absent, not
 * grey) is the whole law.
 *
 * Wrapping is in place and idempotent: identity, getters and the layer's
 * other methods are untouched.
 *
 * @param {object} layer A constructed catalog layer.
 * @param {object} [options]
 * @param {string} [options.source_id] The source the layer's records belong to (registry).
 * @param {boolean} [options.dev] Throw on bare records instead of dropping (dev builds).
 * @returns {object} The same layer, gated.
 */
export function withProvenanceGate(
  layer,
  { source_id, dev = import.meta.env?.DEV ?? false } = {},
) {
  if (!layer || typeof layer !== 'object')
    throw new TypeError('withProvenanceGate requires a layer object');
  if (typeof layer.getProvenanceGateStats === 'function') return layer;
  const stats = { sourceId: source_id ?? null, passed: 0, withheld: 0 };
  const gate = (records) => {
    if (!Array.isArray(records)) return records;
    const kept = [];
    for (const record of records) {
      if (isProvenanced(record)) {
        stats.passed += 1;
        kept.push(record);
        continue;
      }
      stats.withheld += 1;
      if (dev)
        throw new TypeError(
          `Provenance gate: layer ${layer.id || '(unknown)'} emitted a record without a complete envelope (${provenanceGaps(record).join(', ')})`,
        );
    }
    return kept;
  };
  if (typeof layer.getAnalystRecords === 'function') {
    const original = layer.getAnalystRecords;
    layer.getAnalystRecords = function (...args) {
      const out = original.apply(this, args);
      return out && typeof out.then === 'function' ? out.then(gate) : gate(out);
    };
  }
  if (typeof layer.getStats === 'function') {
    const originalStats = layer.getStats;
    layer.getStats = function (...args) {
      const result = originalStats.apply(this, args);
      return result && typeof result === 'object'
        ? { ...result, provenanceWithheld: stats.withheld }
        : result;
    };
  }
  layer.getProvenanceGateStats = () => ({ ...stats });
  return layer;
}
