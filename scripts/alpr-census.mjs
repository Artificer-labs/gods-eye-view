#!/usr/bin/env node
/**
 * ALPR tag census over ONE captured DeFlock extract (spec task 1).
 *
 * Downloads the US PMTiles archive once, decodes every detail tile at
 * `--zoom` (default 9, the coarsest attributed level — each record lives
 * in exactly one such tile), dedupes by OSM node id, and writes the census
 * artifact as JSON: measured fractions for operator / manufacturer /
 * direction / zone / lastVerified, with the capture's own provenance
 * (source URL, extract timestamp as served, fetch time, tiles decoded).
 *
 * Usage:
 *   node scripts/alpr-census.mjs [--zoom 9] [--country us]
 *                                [--pmtiles <path-or-url>] [--out <path>]
 *
 * The artifact is data with provenance, not an estimate: re-running it
 * against a newer extract supersedes earlier artifacts, it never edits
 * them.
 */
import { writeFile } from 'node:fs/promises';
import { createPmtilesReader } from '../src/layers/alpr/pmtiles.js';
import { decodeAlprTile } from '../src/layers/alpr/tileRecords.js';
import { buildCensusArtifact } from '../src/layers/alpr/census.js';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : fallback;
};
const country = option('country', 'us');
const zoom = Number(option('zoom', '9'));
const base = `https://tiles.dontgetflocked.com/cameras-${country}-hourly`;
const pmtilesUrl = option('pmtiles', `${base}.pmtiles`);
const outPath = option('out', null);

// The extract timestamp as served: the TileJSON's Last-Modified header.
let extractTs = null;
try {
  const head = await fetch(`${base}.json`, { method: 'GET' });
  const lastModified = head.headers.get('last-modified');
  if (lastModified) extractTs = new Date(lastModified).toISOString();
  await head.arrayBuffer().catch(() => {});
} catch {
  extractTs = null;
}

const fetchedAt = new Date().toISOString();
const response = await fetch(pmtilesUrl);
if (!response.ok)
  throw new Error(`Extract download failed: HTTP ${response.status}`);
const archive = new Uint8Array(await response.arrayBuffer());
const reader = createPmtilesReader(archive);

const byId = new Map();
let tilesDecoded = 0;
for (const [z, x, y, entry] of reader.tilesAtZoom(zoom)) {
  const bytes = reader.tileBytesForEntry(entry);
  for (const record of decodeAlprTile(bytes, z, x, y)) {
    if (!byId.has(record.id)) byId.set(record.id, record);
  }
  tilesDecoded += 1;
}

const artifact = buildCensusArtifact([...byId.values()], {
  sourceUrl: pmtilesUrl,
  extractTs,
  fetchedAt,
  zoom,
  tilesDecoded,
});
const json = `${JSON.stringify(artifact, null, 2)}\n`;
if (outPath) await writeFile(outPath, json);
process.stdout.write(json);
