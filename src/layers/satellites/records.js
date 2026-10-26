import { satelliteClassLabel } from '../../data/satelliteClass.js';
import { stampRecord } from '../../data/provenance.js';
import { ISS_NORAD } from './policy.js';

/** Registry source every satellite analyst record is stamped against. */
const SOURCE_ID = 'celestrak-gp';

/** Julian Date of the Unix epoch, for converting `satrec.jdsatepoch`. */
const JULIAN_DAY_UNIX_EPOCH = 2440587.5;

/** Elements older than this are flagged ELEMENTS_AGED (graft task 7). */
const ELEMENTS_AGED_S = 72 * 3600;

/**
 * The element epoch of one satellite's element set, in epoch ms.
 *
 * The epoch is PER-SATELLITE: it lives on the SGP4 record built from that
 * satellite's own two lines (`satrec.jdsatepoch`, a Julian Date), not on
 * the catalog or the fetch — two satellites in one group response routinely
 * carry element sets from different epochs. Null when the satrec carries no
 * usable epoch.
 * @param {object|null|undefined} satrec satellite.js SGP4 record.
 * @returns {number|null} Epoch ms, or null.
 */
export function elementEpochMs(satrec) {
  const jd = satrec?.jdsatepoch;
  if (!Number.isFinite(jd)) return null;
  const ms = Math.round((jd - JULIAN_DAY_UNIX_EPOCH) * 86_400_000);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Map one CelesTrak catalog satellite to a JSON-safe analyst record
 * (analyst query engine seam). Pure — no Cesium types. Missing/unknown
 * fields are null, never NaN/undefined. `id` is the display name (same
 * convention as vessels); `noradId` is the track_entity key.
 * @param {Object|null|undefined} raw - {noradId, name, group, lat, lon, altitudeM, speedMps}.
 * @returns {{id: string, noradId: string|null, name: string|null,
 *   lat: number|null, lon: number|null, altitudeM: number|null,
 *   speedMps: number|null, satelliteClass: string|null, group: string|null}}
 */
export function mapAnalystRecord(raw) {
  const num = (v) => (Number.isFinite(v) ? v : null);
  const text = (v) => {
    const t = String(v ?? '').trim();
    return t || null;
  };
  const noradNum =
    raw?.noradId == null || raw.noradId === '' ? NaN : Number(raw.noradId);
  const noradId = Number.isFinite(noradNum)
    ? String(Math.trunc(noradNum))
    : text(raw?.noradId);
  const name = text(raw?.name);
  const group = text(raw?.group);
  const isIss = noradNum === ISS_NORAD;
  return {
    id: name || (noradId ? `SAT-${noradId}` : 'SAT-00000'),
    noradId,
    name,
    lat: num(raw?.lat),
    lon: num(raw?.lon),
    altitudeM: num(raw?.altitudeM),
    speedMps: num(raw?.speedMps),
    // Empty records stay class-less; the class table's fallback is VISUAL and
    // must not leak onto a row that has no satellite identity.
    satelliteClass:
      noradId || group
        ? satelliteClassLabel(group, { isIss, localize: false })
        : null,
    group,
  };
}

/** Create on-demand analyst snapshots owned by one layer instance. */
export function createRecords({ state, parts }) {
  function analystGeo(sat, now) {
    const pos = sat?.satrec
      ? parts.orbits.propagatePosition(sat.satrec, now)
      : null;
    if (
      pos &&
      Number.isFinite(pos.latitude) &&
      Number.isFinite(pos.longitude)
    ) {
      return {
        lat: pos.latitude,
        lon: pos.longitude,
        altitudeM: pos.altitude,
        speedMps: Number.isFinite(pos.speedMps) ? pos.speedMps : null,
      };
    }
    // F-11 remedy: fresh propagation failed, so there is NO analyst record
    // for this satellite in this cycle. The previous code fell back to the
    // point primitive's last rendered position and returned it as current —
    // a frozen satellite masquerading as live. The fallback is not stamped
    // instead, because its computation time is not known truthfully: points
    // carry no per-point timestamp (the layer-global `_lastPropagation`
    // covers core render ticks only, and dense chunk propagations never
    // stamp it), so any source_ts for a fallback position would be invented.
    // Omitting the record is the honest seam: absent, not frozen.
    return null;
  }

  function getAnalystRecords(maxCount = 2000) {
    if (!state._enabled || !state._catalog.size) return [];
    const limit = Number.isFinite(maxCount)
      ? Math.max(1, Math.floor(maxCount))
      : 2000;
    const now = new Date();
    const nowMs = now.getTime();
    const result = [];
    const emit = (noradId, sat) => {
      if (result.length >= limit) return false;
      const pos = analystGeo(sat, now);
      if (!pos) return true;
      // No element epoch, no record: a PROPAGATED claim must name the
      // element set it was propagated from, or the gate drops it anyway.
      const epochMs = elementEpochMs(sat?.satrec);
      if (epochMs === null) return true;
      const elementAgeS = Math.max(0, Math.round((nowMs - epochMs) / 1000));
      const quality_flags = [];
      if (elementAgeS > ELEMENTS_AGED_S)
        quality_flags.push('ELEMENTS_AGED');
      // The proxy's stale signal (x-tle-cache: STALE-ERROR, read in
      // source.js) reaches this seam only as the layer's per-partition
      // aggregates — `_coreStale` for core groups, `_denseStale` for dense
      // extras (per-entry stale is folded into them at ingestion and is not
      // retained on catalog entries). A stale-served element set is aged by
      // definition, whichever partition this record belongs to.
      const partitionStale =
        sat?.group === 'dense' ? state._denseStale : state._coreStale;
      if (partitionStale && !quality_flags.includes('ELEMENTS_AGED'))
        quality_flags.push('ELEMENTS_AGED');
      const record = mapAnalystRecord({
        noradId,
        name: sat?.name,
        group: sat?.group,
        lat: pos.lat,
        lon: pos.lon,
        altitudeM: pos.altitudeM,
        speedMps: pos.speedMps,
      });
      record.elementEpoch = new Date(epochMs).toISOString();
      record.elementAgeS = elementAgeS;
      result.push(
        stampRecord(record, {
          source_id: SOURCE_ID,
          // The source time of a propagated position is the epoch of the
          // element set it was propagated from — never the propagation
          // (receipt) time. Satellite positions are SGP4 PROPAGATED from
          // CelesTrak elements, never OBSERVED (F-16).
          source_ts: epochMs,
          observation_kind: 'PROPAGATED',
          quality_flags,
          now,
        }),
      );
      return result.length < limit;
    };
    for (const [noradId, sat] of state._catalog) {
      if (sat?.group === 'dense') continue;
      if (!emit(noradId, sat)) break;
    }
    if (result.length < limit) {
      for (const [noradId, sat] of state._catalog) {
        if (sat?.group !== 'dense') continue;
        if (!emit(noradId, sat)) break;
      }
    }
    return result;
  }
  return { getAnalystRecords };
}
