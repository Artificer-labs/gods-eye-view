/**
 * Extract stall detection (spec §1.4 + §3.3 rule 5; Division V gate 6,
 * plant i — the frozen-extract plant).
 *
 * The tile extract is generated hourly and served with a timestamp (the
 * TileJSON's Last-Modified — the same served stamp the census artifact
 * records as its extract_ts basis). This tracker watches that stamp
 * across fetch cycles: a healthy extract's stamp keeps advancing roughly
 * hourly, so a stamp that stops advancing necessarily grows old — and
 * once it is older than the stall threshold, the extract is FROZEN,
 * however successful the fetches carrying it remain. A frozen extract
 * returning HTTP 200 forever is exactly the failure this exists to name:
 * silence from the pipeline is a finding, not a freshness.
 *
 * An UNSEEN stamp (the server named none, or the probe failed) is never
 * a stall: the tracker reports extractTs UNKNOWN and stalled false —
 * NO DATA is a different word from NO EVENT, in both directions.
 *
 * Pure and clock-injected so the frozen-extract plant runs as a unit
 * test with scripted cycles.
 *
 * @module layers/alpr/stall
 */

import { EXTRACT_STALL_MS } from './policy.js';

const toMs = (value) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
};

/**
 * Create a stall tracker for one extract witness.
 * @param {object} [options]
 * @param {number} [options.stallAfterMs] Age past which a served stamp
 *   reads as frozen (default EXTRACT_STALL_MS).
 * @returns {{observe: Function, status: Function}}
 */
export function createExtractStallTracker({
  stallAfterMs = EXTRACT_STALL_MS,
} = {}) {
  if (!Number.isFinite(stallAfterMs) || stallAfterMs <= 0)
    throw new TypeError('stallAfterMs must be a positive duration');
  let latestStampMs = null;
  let lastAdvanceMs = null;
  let observations = 0;

  function status(now = Date.now()) {
    const nowMs = toMs(now) ?? Date.now();
    return {
      // The newest served stamp seen, or the explicit UNKNOWN.
      extractTs:
        latestStampMs == null
          ? 'UNKNOWN'
          : new Date(latestStampMs).toISOString(),
      // Frozen ⟺ a known stamp has grown older than the threshold
      // without advancing. An advancing stamp is young by construction
      // (it was served within the last cycle), so age alone decides.
      extractStalled:
        latestStampMs != null && nowMs - latestStampMs > stallAfterMs,
      lastAdvanceAt:
        lastAdvanceMs == null ? null : new Date(lastAdvanceMs).toISOString(),
      observations,
    };
  }

  return {
    /**
     * Record one fetch cycle's served stamp.
     * @param {string|number|Date|null} servedTs The stamp as served;
     *   null/unparseable records a cycle that named none.
     * @param {number|Date} [now] Observation clock (tests).
     * @returns {object} The tracker's status after this observation.
     */
    observe(servedTs, now = Date.now()) {
      const nowMs = toMs(now) ?? Date.now();
      observations += 1;
      const stampMs = toMs(servedTs);
      if (stampMs != null && (latestStampMs == null || stampMs > latestStampMs)) {
        latestStampMs = stampMs;
        lastAdvanceMs = nowMs;
      }
      return status(nowMs);
    },
    status,
  };
}
