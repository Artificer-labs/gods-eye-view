/**
 * The ALPR diff cycle runner (spec §3.2/§3.3, task 5) — the hourly
 * heartbeat a server worker drives. One cycle:
 *
 *   probe once → (extract unchanged? stop) → bound records to the AOI →
 *   store the snapshot → diff against the previous → append events to
 *   the feed → carry the pending-removal state forward.
 *
 * Fetch discipline (§6 gate 1's reasonable-use limb, as code):
 * - ONE source fetch per cycle per AOI. The runner is cycle-driven —
 *   it has no pan/zoom input and cannot storm the network.
 * - A cycle whose extract stamp equals the newest stored snapshot's
 *   stamp writes NOTHING: no snapshot, no diff, no feed lines. Asking
 *   an hourly source faster than it changes buys nothing and abuses a
 *   community service; the tile source's own 60-minute TTL cache sits
 *   underneath as a second belt.
 * - The served stamp also feeds the stall tracker (stall.js): a frozen
 *   extract surfaces as `extractStalled` in the cycle result — silence
 *   from the pipeline is a finding (spec §3.3 rule 5). Alert routing
 *   for it is task 6's register work, not this runner's.
 *
 * The feed is bounded to the subscribed AOI: records are filtered to
 * the AOI before they are stored or diffed, so the feed can never
 * become a national firehose by configuration drift. The feed header
 * (written once, by the store) carries the merged attribution and the
 * §4 labelling (mapper-density caveat, hedged absence) — see diff.js.
 *
 * An UNKNOWN extract stamp never blocks a cycle and never gets
 * invented: the cycle proceeds, its snapshot's stamp stays null, and
 * the differ labels every event degraded (UNKNOWN_STAMP_CYCLE).
 *
 * @module layers/alpr/diffCycle
 */

import {
  alprAoiBbox,
  buildAlprDiffFeedHeader,
  diffAlprSnapshots,
  filterAlprRecordsToAoi,
  liteAlprRecord,
} from './diff.js';
import { createExtractStallTracker } from './stall.js';
import { alprCoverageCaveatLines } from './labelling.js';

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

/**
 * @param {object} input
 * @param {object} input.source A tile-shaped source: fetch(box) →
 *   {records, extractTs, saturated, stale?, extractStalled?} plus
 *   `attribution` (createAlprTileSource / the reconciled source both
 *   fit; the reconciled source's merged attribution is preferred).
 * @param {object} input.store createAlprSnapshotStore output.
 * @param {object} input.aoi {id, name?, bbox?|polygon} — required; the
 *   cycle is meaningless unscoped (Greta condition 2: AOI-scoped).
 * @param {Function} [input.now] Clock override (tests).
 */
export function createAlprDiffCycleRunner({ source, store, aoi, now } = {}) {
  if (typeof source?.fetch !== 'function')
    throw new TypeError('diff cycle requires a source with fetch()');
  if (!store) throw new TypeError('diff cycle requires a snapshot store');
  if (!aoi?.id) throw new TypeError('diff cycle requires an AOI with an id');
  const box = alprAoiBbox(aoi);
  if (!box) throw new TypeError('diff cycle AOI requires a bbox or polygon');
  const tracker = createExtractStallTracker();
  let inFlight = false;

  const clock = () => toIso(now ? now() : Date.now());

  return {
    aoi,
    /**
     * Run one hourly cycle.
     * @returns {Promise<object>} Cycle outcome: {skipped} or {stored,
     *   extract_ts, stamp_quality, extract_stalled, counts,
     *   suppressed_removals, comparison_complete, summary_lines}.
     */
    async runCycle() {
      if (inFlight) return { skipped: 'cycle-in-flight', aoi_id: aoi.id };
      inFlight = true;
      try {
        const ingestTs = clock();
        // The single fetch of this cycle.
        const fetched = await source.fetch(box);
        const extractTs = toIso(fetched?.extractTs);
        const stall = tracker.observe(extractTs, ingestTs);
        const previous = await store.latestSnapshot(aoi.id);
        if (
          extractTs != null &&
          previous &&
          toIso(previous.extract_ts) === extractTs
        ) {
          return {
            skipped: 'extract-unchanged',
            aoi_id: aoi.id,
            extract_ts: extractTs,
            extract_stalled: stall.extractStalled,
          };
        }
        const bounded = filterAlprRecordsToAoi(fetched?.records ?? [], aoi)
          .map(liteAlprRecord)
          .filter(Boolean);
        const current = {
          aoi_id: aoi.id,
          extract_ts: extractTs,
          ingest_ts: ingestTs,
          records: bounded,
          complete: fetched?.saturated !== true,
          saturated: fetched?.saturated === true,
        };
        const previousShape = previous
          ? {
              aoi_id: aoi.id,
              extract_ts: previous.extract_ts,
              ingest_ts: previous.ingest_ts,
              records: previous.records,
              complete: previous.complete !== false,
              saturated: previous.saturated === true,
            }
          : null;
        const pendingRemovals = await store.getPendingRemovals(aoi.id);
        const diff = diffAlprSnapshots({
          previous: previousShape,
          current,
          pendingRemovals,
          now: ingestTs,
        });
        await store.appendSnapshot(aoi.id, current);
        const header = buildAlprDiffFeedHeader({
          aoi,
          // When the worker drives the reconciled source, its
          // attribution is already merged from both witnesses
          // (reconcile.js); a tile-only source contributes its own.
          attribution: source.attribution ?? null,
          now: ingestTs,
        });
        await store.appendDiffCycle(aoi.id, {
          header,
          events: diff.events,
        });
        await store.setPendingRemovals(aoi.id, diff.pendingRemovals);
        return {
          stored: true,
          aoi_id: aoi.id,
          extract_ts: extractTs,
          stamp_quality: diff.stampQuality,
          extract_stalled: stall.extractStalled,
          comparison_complete: diff.comparisonComplete,
          counts: diff.counts,
          suppressed_removals: diff.suppressedRemovals,
          summary_lines: [
            ...alprCoverageCaveatLines(),
            `Diff cycle for AOI ${aoi.id}: ${diff.events.length} change events at REPORTED confidence (NEW ${diff.counts.NEW} · REMOVED ${diff.counts.REMOVED} · MOVED ${diff.counts.MOVED} · RETAGGED ${diff.counts.RETAGGED}); removals describe mapped records, not physical readers.`,
          ],
        };
      } finally {
        inFlight = false;
      }
    },
  };
}
