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
### DeFlock live layer — spec tasks 1–3 (branch `array/deflock-live`, Division III ground desk)

Owned outright (created by the fork):

- `src/layers/alpr/provenance.js` — ALPR envelope over `src/data/provenance.js`:
  witnesses, `osm_edit_ts` ("last edited in OSM") and `last_verified`
  ("last field-verified (mapper-asserted)") kept apart by construction;
  `extract_ts` stamps UNKNOWN until the tile path can see it. (Task 1)
- `src/layers/alpr/pmtiles.js` — minimal PMTiles v3 reader for census use. (Task 1)
- `src/layers/alpr/census.js` + `scripts/alpr-census.mjs` — measured tag census
  over a captured extract; artifact `docs/alpr-census-us-2026-10-26.json`
  (144,569 US records; FLOCK 116,972 of 144,569 with UNKNOWN 5,063 carried,
  never guessed away). (Task 1)
- `src/layers/alpr/brandBuckets.js` — FLOCK / OTHER / UNKNOWN bucketing over
  operator+manufacturer, counts always with denominators. (Task 3)
- `src/layers/alpr/reconcile.js` — dual-source reconciliation (tiles ×
  Overpass): per-node Overpass precedence, `sinceExtract`, noted absences
  only under clean queries, >25 m position conflicts flagged never averaged;
  `createReconciledAlprSource` composes the factories without changing the
  layer's default (tile-only, default-off) wiring. (Task 2)

Touched-with-ledger (upstream files):

- `src/data/sourceRegistry.js` — two entries added: `alpr-deflock-tiles`
  (hourly extracts) and `alpr-overpass` (live viewport queries), ODbL-1.0.
  The slice-1 `osm-alpr` entry and layer mapping are untouched. (Task 1)
- `src/layers/alpr/source.js` — both factories now stamp every emitted
  record via `stampAlprRecord` (kind REPORTED; Overpass stamps carry the
  payload's `osm3s.timestamp_osm_base` as source time; tile stamps carry
  source/extract time as explicit UNKNOWN). No fetch behaviour changed. (Task 1)

Layer state: ALPR remains default-off; nothing in this slice lifts the
cage — Division V's gate list (spec §6) still governs release.

### DeFlock spec task 5 — hourly diff engine + §4 labelling law (branch `array/deflock-live`, Division III ground desk)

Owned outright (created by the fork):

- `src/layers/alpr/snapshotStore.js` — append-only per-AOI store:
  hash-chained JSONL snapshot log + chained diff feed + pending-removal
  state, over INJECTED IO (memory IO for tests; file IO over an injected
  fs/promises for the server worker — no node imports in the module).
  Chain shape mirrors the graft ledger ({seq, prev_hash, hash}); default
  digest FNV-1a 64 (tamper-evident, not a signature; sha256 injectable).
- `src/layers/alpr/diff.js` — the pure differ: NEW / REMOVED / MOVED
  (> 25 m, reconcile.js's own threshold and distance, reused) /
  RETAGGED (operator, manufacturer, directionDeg, zone, lastVerified;
  a direction change flags `aim_change`). Absence discipline is
  reconcile.js rule 3 reused, never restated: REMOVED only from a
  completed, unsaturated comparison; a first trusted absence ships
  corroboration 'extract', the next trusted cycle upgrades it to
  'confirmed' and names the upgraded key; an untrusted comparison
  records NO absence (suppressions counted, pending state untouched).
  AOI bounding (bbox + polygon) lives here; the feed header builder
  carries merged attribution, ODbL-1.0 + share-alike marking, and the
  §4 labelling block.
- `src/layers/alpr/diffCycle.js` — the hourly cycle runner a server
  worker drives: ONE source fetch per cycle per AOI; a cycle whose
  extract stamp matches the newest stored snapshot writes nothing;
  records are AOI-bounded BEFORE they are stored or diffed (no national
  firehose); the stall tracker observes every cycle's stamp and a
  frozen extract surfaces as `extract_stalled` in the cycle result.
- `src/layers/alpr/labelling.js` — the §4 labelling law as constants
  and helpers (Greta condition 1): NO_MAPPED_READER ("community
  mapping, unverified absence"), the mapper-density caveat (§4.3), and
  the hedged absence/coverage wordings every product surface uses.

KEYING DECISION (Division V re-examination ruling (b)(2); Greta
condition 3): the diff cycle keys on the SNAPSHOT stamp pair —
(osm_id, prev_extract_ts, extract_ts) — because per-record envelope
`extract_ts` remains UNKNOWN on the tile path by deliberate non-change.
No event inherits UNKNOWN silently: an unknown stamp in the pair sets
`stamp_quality: 'UNKNOWN'`, degrades the event's confidence labelling
(`degradation_reason: 'UNKNOWN_STAMP_CYCLE'`), and derives the
event_id from the pair's INGEST stamps instead — uniqueness without a
fabricated extract time. The spec's alternative (wire per-record
extract_ts) remains open as a future amendment; this decision is the
operative one until then.

Touched-with-ledger (upstream files):

- `src/layers/alpr/index.js` — the four rendered absence labels hedged
  per the law ("No mapped ALPR data for this area — extracts cover the
  US and Canada only"; "No mapped ALPR readers in this view — community
  mapping, unverified absence"; "Coverage limited — mapped data only,
  zoom in"; "None on screen — mapped cameras nearby are outside the
  view"), with a law-pointer comment at the label; barrel exports for
  the four new modules. Locale catalogs (es, ru, zh-CN) re-keyed with
  translations; `npm run i18n` reports all three complete.
- `src/data/alprCameras.test.mjs` — two label expectations updated to
  the hedged wordings (the same truthful-update pattern as the age-band
  slice).

Tests (all new, co-located): `snapshotStore.test.mjs` (7),
`diff.test.mjs` (8 — including the spec's planted two-cycle fixture:
one of each class + a 10 m jitter that must NOT diff),
`diffCycle.test.mjs` (5 — baseline / unchanged-stamp skip / confirm
upgrade / AOI bounding / stall surfacing / in-flight refusal),
`labelling.test.mjs` (4 — a string audit over every rendered literal
in the layer: an unhedged absence claim FAILS the build).

NOT built in this slice (named plainly): the live hourly worker /
scheduler that calls runCycle (server wiring, with the AOI registry of
task 6); Fusion-side ingestion and promotion of the feed's REPORTED
events; §3.3 alert rules 1–5 routing (task 6 — the stall signal exists
in cycle results, no alert is routed yet); coverage analytics (task 7);
Greta condition 2's AOI-addition log (a task-6 registry act — this
slice's runner refuses to run without a named AOI, and adds none).

Layer state at the close of that slice: unchanged — caged,
default-off. That slice built the machinery the re-examination found
missing; it did not enable the layer, wire a scheduler, or open the
feed to any consumer. The state below supersedes it.

### LIGHTING RECORD — DeFlock layer lit for the owner's viewing (2026-10-26)

- **Date:** 2026-10-26.
- **Authority:** Dylan's word in chat, 2026-10-26 11:02 EDT — "Light
  the DeFlock layer for my viewing." Executed only after spec tasks
  1–5 (through the labelling law) were built, tested, and committed,
  per the order's own precondition.
- **Gate closure:** Division V's §6 gate list stands SUSTAIN on every
  line after re-examination (gates 1, 2, 6 cured to SUSTAIN; gates 3
  and 5 SUSTAIN throughout; gate 4's process limb closed by filing).
  Greta's dissent is on file verbatim at
  `hidden_files/packets/deflock-greta-dissent.md`, and her conditions
  are met in code: (1) the §4 labelling law enforced on every surface
  with a string-audit test that fails on an unhedged absence claim;
  (2) products AOI-scoped (the diff runner refuses to run without a
  named AOI); (3) the diff feed's extract-time basis settled — keyed
  on the snapshot stamp pair, UNKNOWN labelled and degraded, never
  inherited silently; (4) the mapper-density caveat printed in the
  feed header before any event.
- **The flip (smallest change, no other layer touched):**
  `src/data/layerState.js` — 'alpr-cameras' joins the durable default
  enabled set in `createDefaultLayerState()`, the representation the
  fork's own cage test used to define the cage. Authored state (share
  payload, stored local state) still replaces the default wholesale,
  as for every layer. `src/ui/layerNames.js` — the panel label now
  reads "Mapped ALPR Cameras · LIVE-MAPPING" (spec §1.4: the compound
  is a term of art, kept verbatim in all locales; the word LIVE alone
  never describes this layer). Tests updated where they pinned the
  cage: `constructCatalog.test.mjs` (assertion inverted for ALPR
  only; traffic stays caged) and two `layerState.test.mjs` fixtures
  that had used the default state as a synonym for "empty".
- **Conditions carried forward (verbatim in substance):**
  - No person/vehicle join keys ever — the ruling's absolute
    exclusions (plate reads, vehicle data, live feeds, portal data)
    are the load-bearing wall of this layer.
  - No published blind-spot feed — blind-spot and corridor products
    are AOI-scoped work product only, home AOI first, each further
    AOI a logged, named decision.
  - Any wider enabling — defaults for other viewers, published
    products — requires fresh Division V re-examination.
  - Absence is always labelled as mapper absence: no surface of this
    layer may state or imply an unhedged "no reader here".
- **Still unbuilt (unchanged by the lighting):** the live hourly
  worker/scheduler and the AOI registry (task 6), Fusion-side feed
  ingestion, §3.3 alert routing, coverage analytics (task 7). The
  layer lights for viewing on the viewport sources it already had;
  the diff feed exists as machinery and files, with no consumer yet.
