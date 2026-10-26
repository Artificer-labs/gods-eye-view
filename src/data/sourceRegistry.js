/**
 * The array's catalog of record: one entry per source the fork may render.
 *
 * Division III owns the truth of these declarations (cadence, latency,
 * resolution, licence); Division II owns this file. Every provenance envelope
 * (src/data/provenance.js) is stamped against an entry here, and the
 * fail-closed gate treats a record naming a source absent from this registry
 * as unprovenanced — an unregistered source is not a source.
 *
 * `freshness_budget_s` is the validity window: a record stamped from this
 * source stops describing the world at `source_ts + freshness_budget_s`
 * (packet §1.2 `valid_to`). Budgets are seeded generously for static and
 * bundled reference data, whose per-record `source_ts` is the extract or
 * capture date, and tightly for live feeds, whose honesty is their cadence.
 *
 * @module data/sourceRegistry
 */

const entry = (
  source_id,
  name,
  uri,
  declared_cadence_s,
  declared_latency_s,
  spatial_res,
  license_id,
  freshness_budget_s,
) =>
  Object.freeze({
    source_id,
    name,
    uri,
    declared_cadence_s,
    declared_latency_s,
    spatial_res,
    license_id,
    freshness_budget_s,
  });

/** Every source the array renders from, keyed by `source_id`. */
export const SOURCE_REGISTRY = Object.freeze({
  opensky: entry(
    'opensky',
    'OpenSky Network (via /api/flights)',
    'https://opensky-network.org/api/states/all',
    15,
    5,
    'ADS-B position, ~10 m class',
    'opensky-network-terms',
    120,
  ),
  'adsb-lol': entry(
    'adsb-lol',
    'adsb.lol community ADS-B',
    'https://api.adsb.lol/v2',
    10,
    5,
    'ADS-B position, ~10 m class',
    'ODbL-1.0',
    120,
  ),
  'adsb-lol-gnss': entry(
    'adsb-lol-gnss',
    'adsb.lol GNSS integrity facts (aircraft-reported)',
    'https://api.adsb.lol/v2',
    60,
    30,
    'per-aircraft reported NIC/NACp',
    'ODbL-1.0',
    600,
  ),
  'local-adsb-receiver': entry(
    'local-adsb-receiver',
    "Operator's own ADS-B receiver",
    'local://aircraft.json',
    1,
    1,
    'ADS-B position, ~10 m class',
    'operator-owned',
    30,
  ),
  aisstream: entry(
    'aisstream',
    'AISStream (via websocket proxy)',
    'wss://stream.aisstream.io/v0/stream',
    60,
    30,
    'AIS position report, ~10 m class',
    'aisstream-terms',
    1800,
  ),
  'celestrak-gp': entry(
    'celestrak-gp',
    'CelesTrak GP elements (SGP4 propagated)',
    'https://celestrak.org/NORAD/elements/gp.php',
    43_200,
    0,
    'orbital elements; propagated position, km class',
    'celestrak-terms',
    259_200,
  ),
  'usgs-quakes': entry(
    'usgs-quakes',
    'USGS earthquake GeoJSON',
    'https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php',
    60,
    300,
    'epicentre, km class; magnitude preliminary',
    'usgs-public-domain',
    3600,
  ),
  'firms-viirs-nrt': entry(
    'firms-viirs-nrt',
    'NASA FIRMS VIIRS/MODIS near-real-time detections',
    'https://firms.modaps.eosdis.nasa.gov/api',
    10_800,
    10_800,
    '375 m pixel (VIIRS); a hot pixel, not a perimeter',
    'nasa-firms-terms',
    86_400,
  ),
  'nifc-wfigs': entry(
    'nifc-wfigs',
    'NIFC WFIGS fire perimeters (ArcGIS)',
    'https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services',
    3600,
    1800,
    'agency-edited perimeter polygon',
    'nifc-wfigs-terms',
    86_400,
  ),
  'noaa-nowcoast-radar': entry(
    'noaa-nowcoast-radar',
    'NOAA nowCOAST MRMS radar (WMS)',
    'https://nowcoast.noaa.gov/geoserver/observations/weather_radar/ows',
    240,
    240,
    'MRMS base reflectivity grid, ~1 km',
    'noaa-public-domain',
    1800,
  ),
  'noaa-goes-ir': entry(
    'noaa-goes-ir',
    'NOAA nowCOAST GOES infrared (WMS)',
    'https://nowcoast.noaa.gov/geoserver/observations/satellite/ows',
    300,
    300,
    'GOES Band 14 IR, km scale — weather, not ground activity',
    'noaa-public-domain',
    3600,
  ),
  'noaa-nowcoast-lightning': entry(
    'noaa-nowcoast-lightning',
    'NOAA nowCOAST lightning density (WMS)',
    'https://nowcoast.noaa.gov/geoserver/observations/lightning_detection/ows',
    900,
    600,
    '15-minute accumulated density, ~8 km grid (derived)',
    'noaa-vaisala-derived',
    3600,
  ),
  'nhc-cphc': entry(
    'nhc-cphc',
    'NOAA NHC / CPHC cyclone advisories',
    'https://www.nhc.noaa.gov/CurrentStorms.json',
    21_600,
    300,
    'advisory position, ~10 km class; cone is a forecast',
    'nws-public-data',
    86_400,
  ),
  'noaa-gfs': entry(
    'noaa-gfs',
    'NOAA GFS forecast model (wind)',
    'https://noaa-gfs-bdp-pds.s3.amazonaws.com',
    21_600,
    3600,
    '0.25° forecast grid — a model field, not a measurement',
    'noaa-public-domain',
    86_400,
  ),
  'eccc-aqhi': entry(
    'eccc-aqhi',
    'ECCC AQHI via MSC GeoMet (Canada only)',
    'https://geo.weather.gc.ca/geomet',
    3600,
    1800,
    'community AQHI index, hourly',
    'eccc-geoMet-terms',
    21_600,
  ),
  'cctv-municipal': entry(
    'cctv-municipal',
    'Municipal / DOT public traffic cameras',
    'server-brokered catalogs (server/providers/cctv)',
    60,
    30,
    'fixed camera frame; pose is an estimate',
    'per-catalog-terms',
    600,
  ),
  'street-level-providers': entry(
    'street-level-providers',
    'Street-level imagery (Mapillary / KartaView / Panoramax)',
    'https://www.mapillary.com',
    31_536_000,
    0,
    'dated photograph; capture date is the record time',
    'CC-BY-SA-4.0',
    31_536_000,
  ),
  'tomtom-flow': entry(
    'tomtom-flow',
    'TomTom traffic flow (keyed)',
    'https://api.tomtom.com/traffic/services/4/flowSegmentData',
    60,
    60,
    'road-segment flow model',
    'tomtom-terms',
    600,
  ),
  'osm-alpr': entry(
    'osm-alpr',
    'OpenStreetMap ALPR camera locations (DeFlock extracts)',
    'https://tiles.dontgetflocked.com',
    3600,
    3600,
    'mapped camera location; presence is a survey claim',
    'ODbL-1.0',
    86_400,
  ),
  'radio-browser': entry(
    'radio-browser',
    'Radio Browser directory',
    'https://de1.api.radio-browser.info',
    86_400,
    0,
    'station directory entry (reference)',
    'PDDL-1.0',
    604_800,
  ),
  'gtfs-realtime': entry(
    'gtfs-realtime',
    'GTFS-realtime vehicle positions (agency feeds)',
    'server-brokered feeds (server/providers/transit)',
    30,
    30,
    'vehicle position, ~10 m class',
    'per-agency-open-data',
    600,
  ),
  gbfs: entry(
    'gbfs',
    'GBFS bikeshare feeds',
    'server-brokered feeds (server/providers/gbfs)',
    60,
    60,
    'station availability counts (operator-reported)',
    'per-operator-open-data',
    900,
  ),
  osrm: entry(
    'osrm',
    'OSRM routing (FOSSGIS)',
    'https://router.project-osrm.org',
    1,
    0,
    'computed route — a calculation, never a track',
    'osrm-terms',
    300,
  ),
  'nasa-gibs-cmr': entry(
    'nasa-gibs-cmr',
    'NASA GIBS / CMR granules (HLS S30/L30, VIIRS)',
    'https://cmr.earthdata.nasa.gov/search',
    86_400,
    86_400,
    '30 m (HLS) / 375 m (VIIRS) granule, per-day',
    'nasa-earthdata-terms',
    604_800,
  ),
  'launch-library-2': entry(
    'launch-library-2',
    'Launch Library 2 (The Space Devs)',
    'https://ll.thespacedevs.com/2.2.0',
    900,
    300,
    'reported schedule/status; trajectory is reconstructed',
    'launch-library-terms',
    86_400,
  ),
  'osm-overture-installations': entry(
    'osm-overture-installations',
    'OSM + Overture military installations pack',
    'bundled extract + Overpass on demand',
    2_592_000,
    0,
    'named site location (reference)',
    'ODbL-1.0',
    7_776_000,
  ),
  'derived-awareness': entry(
    'derived-awareness',
    'Derived awareness rollup (inherits witness provenance)',
    'in-client derivation over flights/military/vessels/installations',
    60,
    0,
    'rollup over witness records — kind DERIVED by construction',
    'internal',
    900,
  ),
  telegeography: entry(
    'telegeography',
    'TeleGeography submarine cables (bundled)',
    'bundled extract',
    2_592_000,
    0,
    'cable route line (reference, approximate landings)',
    'CC-BY-NC-SA-telegeography',
    7_776_000,
  ),
  'bundled-infrastructure': entry(
    'bundled-infrastructure',
    'Bundled infrastructure GeoJSON (dams, datacenters)',
    'bundled extract',
    2_592_000,
    0,
    'facility location (reference)',
    'per-dataset-terms',
    7_776_000,
  ),
});

/**
 * Catalog layer id → the `source_id` its records are stamped and gated
 * against. Multi-provider layers name their primary source; fallback
 * providers carry their own registry entries and stamp their own records.
 */
export const LAYER_SOURCE_IDS = Object.freeze({
  flights: 'opensky',
  military: 'adsb-lol',
  'local-adsb': 'local-adsb-receiver',
  'ais-live-vessels': 'aisstream',
  satellites: 'celestrak-gp',
  earthquakes: 'usgs-quakes',
  'local-firms': 'firms-viirs-nrt',
  'fire-perimeters': 'nifc-wfigs',
  'weather-radar': 'noaa-nowcoast-radar',
  'weather-satellite': 'noaa-goes-ir',
  'weather-lightning': 'noaa-nowcoast-lightning',
  'weather-cyclones': 'nhc-cphc',
  wind: 'noaa-gfs',
  'air-quality': 'eccc-aqhi',
  'gnss-integrity': 'adsb-lol-gnss',
  cctv: 'cctv-municipal',
  'street-level': 'street-level-providers',
  traffic: 'tomtom-flow',
  'alpr-cameras': 'osm-alpr',
  radio: 'radio-browser',
  transit: 'gtfs-realtime',
  bikeshare: 'gbfs',
  directions: 'osrm',
  'recent-imagery': 'nasa-gibs-cmr',
  'rocket-launches': 'launch-library-2',
  'military-installations': 'osm-overture-installations',
  'military-awareness': 'derived-awareness',
  'telegeography-submarine-cables': 'telegeography',
  'local-dams': 'bundled-infrastructure',
  'local-datacenters': 'bundled-infrastructure',
});

/** The registry entry for a source, or undefined when unregistered. */
export function getSource(source_id) {
  return Object.hasOwn(SOURCE_REGISTRY, source_id)
    ? SOURCE_REGISTRY[source_id]
    : undefined;
}

/** The registry entry for a source; an unregistered source is a defect. */
export function requireSource(source_id) {
  const found = getSource(source_id);
  if (!found) throw new TypeError(`Unregistered source: ${source_id}`);
  return found;
}

/** The source_id a catalog layer's records belong to, if it has one. */
export function sourceIdForLayer(layerId) {
  return Object.hasOwn(LAYER_SOURCE_IDS, layerId)
    ? LAYER_SOURCE_IDS[layerId]
    : undefined;
}

/** Every registered source entry, in registration order. */
export function listSources() {
  return Object.values(SOURCE_REGISTRY);
}
