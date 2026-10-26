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
