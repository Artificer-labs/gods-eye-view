# ARRAY_PATCHES — the fork's ledger of edits to upstream files

Upstream: `bilawalsidhu/gods-eye-view` (MIT). Fork: `Artificer-labs/gods-eye-view`,
graft branch `array/tranche-1-graft`, base commit `a7fcb3c2`.

Every edit to an upstream-owned file is entered here at the time it is made
(file, hunk summary, reason, graft task #), per the graft plan §3. Files the
fork owns outright (this ledger, `src/data/provenance.js`,
`src/data/sourceRegistry.js`, and their tests) need no entry per hunk; they
are listed once, when created.

## Owned outright (created by the fork)

- `ARRAY_PATCHES.md` — this ledger. (Task 1)
- `src/data/sourceRegistry.js` — source catalog of record. (Task 1)
- `src/data/provenance.js` — provenance envelope + fail-closed gate. (Tasks 1, 3)
- `src/data/provenance.test.mjs` — envelope/gate contract tests. (Tasks 1, 3)

## Touched-with-ledger (upstream files)

### Graft task 2 — catalog lockdown (cage traffic + ALPR, strike Bhote Koshi)

- `src/app/constructCatalog.js` — Bhote Koshi constructor calls and imports
  removed; `APPLICATION_LAYER_METADATA` now filters the struck pair out of
  `LAYER_STATE_REGISTRY`; `STRUCK_LAYER_IDS` exported with the reason.
  Token reservations in `src/data/layerState.js` deliberately untouched:
  that file's doctrine keeps an allocation "even if its layer is later
  removed", so old share links still decode to the same ids.
- `src/voice/layerManifest.js` — **exception to the never-touch zone**,
  forced by the strike: the two `VOICE_OFF_LAYERS` entries for the Bhote
  Koshi pair removed (registry now empty), because the manifest contract
  requires it to name only catalog layers. No other voice change.
- `src/ui/layerNames.test.mjs` — `UNTRANSLATED_NAMES` emptied (its only
  members were the struck pair).
- `src/app/constructCatalog.test.mjs` — layer count 32 → 30; Bhote
  registered-but-hidden assertions replaced with struck assertions;
  traffic/ALPR registered-but-inactive-by-default assertions added.
- `src/layers/traffic/retention.js` — THE CAGE: in `reconcile`, when the
  layer is not in live (TomTom-keyed) mode, every road's population target
  is forced to 0. Roads are still admitted, prepared and committed; the
  simulated vehicles upstream spawns keyless are never spawned.
- `src/layers/traffic/controls.js` — `setParams` forces
  `uncoveredRoads: 'hide'`; a `'sim'` request is refused.
- `src/app/layers/traffic.js` — the application shim births the catalog's
  traffic layer with `setParams({ uncoveredRoads: 'hide' })`.
- `src/layers/traffic/state.js`, `src/layers/traffic/model.js` —
  comment-only: they record where the cage lives and why the state
  default stays upstream's.
- `src/layers/traffic/navigation.test.mjs` — five tests adjusted: four
  swap the keyless dot-count "it rendered" proxy for the committed-load
  stamp (`lastUpdate`); the stalled-status test is rewritten to assert
  the fork's fail-closed behavior (roads acquired, zero dots until live
  mode is known).
- NOT changed, against the plan's file list: `src/data/bhoteKoshi*.js`
  modules were NOT deleted (see the Task 2 commit message — the Nepal
  scene pack and tools still import their support modules, and the
  token-ledger doctrine forbids the registry half of the deletion);
  `src/data/layerState.js` needed no default change (every layer is
  already absent from `createDefaultLayerState().enabledLayerIds`).

### Graft task 3 — fail-closed provenance gate at the choke point

- `src/data/provenance.js` (owned) — `withProvenanceGate` added: wraps a
  layer's `getAnalystRecords` stream; records without a complete envelope
  are dropped and counted (`provenanceWithheld` on the layer's stats,
  `getProvenanceGateStats()`); dev mode throws. Wrapping is in place and
  idempotent.
- `src/app/constructCatalog.js` — after `createLayerCatalog`, every
  constructed layer is gated with `sourceIdForLayer(layer.id)`. This is
  the only place layers are born, so there is no path around the gate.
- `src/data/provenance.test.mjs` (owned) — gate contract tests: an
  enveloped/bare pair renders exactly the enveloped record; the withheld
  count surfaces; dev mode throws.
- `src/app/constructCatalog.test.mjs` — asserts every catalog layer is
  gated against its registered source.
- Shape note: upstream layers have no single internal record stream —
  each renders into Cesium itself — so the gate sits on the codebase's
  one generic record accessor (`getAnalystRecords`, the stream the
  analyst engine and voice read through). Per-layer stamping adapters
  (tasks 6–10) are what will let real records pass it; until then the
  gate withholds, which is the fail-closed intent.

### Graft task 7 — satellites adapter (PROPAGATED, element epoch)

- `src/layers/satellites/records.js` — analyst records stamped at the
  `getAnalystRecords` seam: source `celestrak-gp`, kind PROPAGATED,
  `source_ts` = the satellite's own TLE element epoch (per-satellite
  `satrec.jdsatepoch`; there is no catalog epoch in the data), additive
  `elementEpoch`/`elementAgeS` fields, `ELEMENTS_AGED` past 72 h or
  when the record's partition carries the proxy's stale aggregate.
  F-11 remedy: the last-rendered-position fallback is DELETED — on
  fresh-propagation failure the record is omitted, never stamped as
  current (the fallback position's computation time is not knowable,
  so any stamp on it would be invented).
- `src/layers/satellites/records.test.mjs` (new) — 5 adapter tests.

### Graft task 10 (vessels half) — AIS adapter + F-14 remedy

- `server/providers/vessels/ais-store.js` — F-14: the fallback 'now'
  for a missing/unparseable AIS timestamp is kept as a number (trail
  math needs one) but the stored position now carries
  `timestampEstimated` (`isAisTimestampEstimated` helper); estimated
  fixes are excluded from trail samples and from freshness math
  (`newestAisPositionAt` skips them).
- `src/sources/live/vessels.js`, `src/layers/vessels/ingestion.js`,
  `src/layers/vessels/records.js` — the marker travels end-to-end to
  the client; `normalizeVesselObservation` nulls `observedAtMs` for
  estimated fixes so no fabricated time becomes an observation time.
- `src/layers/vessels/queries.js` — `stampAnalystRecord` at the
  `getAnalystRecords` seam (mapAnalystRecord's pure shape untouched):
  source `aisstream`, kind OBSERVED, `source_ts` = the position's own
  AIS time; estimated/absent → UNKNOWN + `TIMESTAMP_ESTIMATED` (gate
  withholds); watchdog `transportStatus === 'stale'` adds `FEED_STALE`.
- `src/data/aisProvenance.test.mjs` (new) — 7 adapter tests.
- CCTV half of task 10 is NOT here: it belongs to the sibling
  `array/cctv-honesty` worktree (F-03/F-07/F-08/F-19 remedies).

### Graft task 8 — earthquakes + FIRMS adapters (revisions visible)

- `src/layers/earthquakes/records.js` — `properties.updated` restored
  at the normalize seam (upstream dropped it): rows carry `updated`
  distinct from origin `time`. The store does not mutate in place —
  each poll rebuilds entities from the full snapshot, so a revision
  arrives as a replacement carrying the new `updated`.
- `src/layers/earthquakes/index.js` — analyst records stamped: source
  `usgs-quakes`, kind OBSERVED, `source_ts` = origin time,
  `published_ts` = update time, `SOURCE_REVISED` when updated > time.
- `src/layers/firms/queries.js` — analyst records stamped: source
  `firms-viirs-nrt`, kind OBSERVED, `source_ts` = the record's own
  detection time (`acq_date`+`acq_time` → `acqMs`, never dropped);
  `published_ts` deliberately omitted (the feed carries none; the
  proxy's batch `fetchedAt` is fetch time, not publication) — so
  `latency_ms` states the detection's true age at ingest.
- `src/layers/earthquakes/records.test.mjs` updated for the restored
  field; `src/layers/earthquakes/provenance.test.mjs` and
  `src/layers/firms/provenance.test.mjs` (new) — adapter tests.

### Graft task 6 — flights + military adapters (per-fix source time)

- `src/layers/flights/records.js`, `src/layers/military/records.js` —
  meta gains `positionEpochMs`: the fix's own position epoch
  (OpenSky `time_position` / readsb-derived), null when the source
  gave none. Non-sticky; the motion path's `Date.now()` fallback for
  `fixEpochMs` never leaks into the stored field.
- `src/layers/flights/queries.js`, `src/layers/military/queries.js` —
  `mapAnalystRecord` returns the record stamped: kind OBSERVED (the
  record's lat/lon are the raw poll fix), `source_ts` =
  `positionEpochMs` (null → UNKNOWN → gate withholds), source
  `opensky`/`adsb-lol` by the feed that delivered the poll, flag
  `CLASSIFICATION_DERIVED` (aircraftClass + military flag are derived
  judgements, F-15).
- `src/data/motionModel.js` — F-09: `synthesizeForwardKinematicsFix`
  output now carries a durable `synthetic: true` marker; consumers
  verified to read only time/track/velocity/position.
- Tests: records tests extended in both layers; new
  `src/layers/flights/provenance.test.mjs`,
  `src/layers/military/provenance.test.mjs`; motionModel suite
  extended. Known follow-up: the "full record" deepEqual contract
  tests in `src/data/flights.test.mjs` / `src/data/militaryFlights.test.mjs`
  needed the envelope key added to expectations (integrator fix —
  done, both suites green again).

### Graft task 9 — freshness rendering + provenance surfacing

- `src/ui/layerProvenance.js` (new) — `layerFreshness(records, now)`:
  the newest provenanced envelope in a bounded sample (≤ 50) judged
  by `freshnessOf`; empty sample → null (no claim); records with no
  complete envelope → EXPIRED (fail-closed).
- `src/app/layerPresentation.js` — `_layerFreshness(id)` samples
  through the existing module seam, caches the newest envelope,
  invalidates on `data-updated`, and recomputes state from the cached
  envelope on every read — a dead feed walks LIVE→AGING→STALE→EXPIRED
  with no re-sampling and no wall-clock/poll-success signal.
- `src/ui/layerPanel.js` — the meta line appends the freshness state
  and, when the gate has withheld, "N records withheld —
  unprovenanced"; non-readout rows gain a "Source declaration"
  `<details>` drawer (registry name, uri, license, cadence, latency,
  spatial resolution). Readout rows (weather/recent-imagery) deferred:
  their provenance belongs with their readout panels.
- `src/ui/styles/radio.css`, `src/i18n/locales/{es,ru,zh-CN}.json` —
  drawer styling + 5 translated strings.
- Tests: `src/ui/layerProvenance.test.mjs` (new, 7),
  `src/app/layerPresentation.test.mjs` (new, 3).

## Integrator fix — package-boundary manifest (tasks 6–10 fallout)

`scripts/package-boundaries.json`: declared `src/data/provenance.js` and
`src/data/sourceRegistry.js` (slice-1 modules whose ownership was never
registered) in every boundary group whose build reaches them, and
`src/ui/layerProvenance.js` in the groups that reach it (layer-panel,
ui-shell, application-components). No code change; `npm run
check:boundaries` passes (exit 0, all groups checked).
