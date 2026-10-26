/**
 * A minimal PMTiles v3 reader — just enough to census a captured extract.
 *
 * The DeFlock extracts are published as PMTiles archives (~50 MB for the
 * US). The census needs every detail tile at one zoom; this reader parses
 * the header and directory (root + leaf), resolves tile ids through the
 * Hilbert-curve addressing the format specifies, and returns raw tile
 * bytes for the layer's own decoder (tileRecords.js). It is a census tool,
 * not a serving path: no caching, no range requests, whole archive in
 * memory.
 *
 * Format: https://github.com/protomaps/PMTiles/blob/main/spec/v3/spec.md
 *
 * @module layers/alpr/pmtiles
 */

import { gunzipSync, brotliDecompressSync } from 'node:zlib';

const COMPRESSION = { UNKNOWN: 0, NONE: 1, GZIP: 2, BROTLI: 3, ZSTD: 4 };

function decompress(bytes, compression) {
  switch (compression) {
    case COMPRESSION.NONE:
    case COMPRESSION.UNKNOWN:
      return bytes;
    case COMPRESSION.GZIP:
      return gunzipSync(bytes);
    case COMPRESSION.BROTLI:
      return brotliDecompressSync(bytes);
    default:
      throw new Error(`Unsupported PMTiles compression: ${compression}`);
  }
}

/** Read one LEB128 varint at `pos`; returns [value, nextPos]. */
function readVarint(bytes, pos) {
  let value = 0n;
  let shift = 0n;
  let cursor = pos;
  for (;;) {
    const byte = bytes[cursor++];
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7n;
    if (shift > 63n) throw new Error('PMtiles varint too long');
  }
  return [Number(value), cursor];
}

/** Parse one directory section into entries with absolute tile ids. */
function parseDirectory(bytes) {
  let pos = 0;
  let count;
  [count, pos] = readVarint(bytes, pos);
  const tileIds = [];
  let running = 0;
  for (let i = 0; i < count; i++) {
    let delta;
    [delta, pos] = readVarint(bytes, pos);
    running += delta;
    tileIds.push(running);
  }
  const runLengths = [];
  for (let i = 0; i < count; i++) {
    let value;
    [value, pos] = readVarint(bytes, pos);
    runLengths.push(value);
  }
  const lengths = [];
  for (let i = 0; i < count; i++) {
    let value;
    [value, pos] = readVarint(bytes, pos);
    lengths.push(value);
  }
  const entries = [];
  for (let i = 0; i < count; i++) {
    let value;
    [value, pos] = readVarint(bytes, pos);
    let offset;
    if (value === 0 && i > 0)
      offset = entries[i - 1].offset + entries[i - 1].length;
    else offset = value - 1;
    entries.push({
      tileId: tileIds[i],
      offset,
      length: lengths[i],
      runLength: runLengths[i],
    });
  }
  return entries;
}

/**
 * The first tile id of zoom level `z` in PMTiles addressing:
 * ids are assigned level by level, sum_{i<z} 4^i = (4^z - 1) / 3.
 */
export function firstTileIdOfZoom(z) {
  return (4 ** z - 1) / 3;
}

/** Convert z/x/y to a PMTiles tile id (Hilbert curve within the level). */
export function zxyToTileId(z, x, y) {
  const n = 2 ** z;
  let d = 0;
  for (let s = n / 2; s > 0; s = Math.floor(s / 2)) {
    const rx = (x & s) > 0 ? 1 : 0;
    const ry = (y & s) > 0 ? 1 : 0;
    d += s * s * ((3 * rx) ^ ry);
    if (ry === 0) {
      if (rx === 1) {
        x = s - 1 - x;
        y = s - 1 - y;
      }
      const swap = x;
      x = y;
      y = swap;
    }
  }
  return firstTileIdOfZoom(z) + d;
}

/** Convert a PMTiles tile id back to [z, x, y]. */
export function tileIdToZxy(tileId) {
  let acc = 0;
  let z = 0;
  for (;;) {
    const levelTiles = 4 ** z;
    if (tileId < acc + levelTiles) break;
    acc += levelTiles;
    z += 1;
  }
  let t = tileId - acc;
  let x = 0;
  let y = 0;
  for (let s = 1; s < 2 ** z; s *= 2) {
    const rx = 1 & Math.floor(t / 2);
    const ry = 1 & (Math.floor(t) ^ rx);
    if (ry === 0) {
      if (rx === 1) {
        x = s - 1 - x;
        y = s - 1 - y;
      }
      const swap = x;
      x = y;
      y = swap;
    }
    x += s * rx;
    y += s * ry;
    t /= 4;
  }
  return [z, x, y];
}

/**
 * Open a PMTiles archive held in memory.
 * @param {Uint8Array|Buffer} input The whole archive.
 * @returns {{header: object, entries: Array, getTile: Function}}
 *   `entries` is the fully resolved directory (leaves inlined);
 *   `getTile(z, x, y)` returns the tile bytes or null.
 */
export function createPmtilesReader(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (
    bytes.length < 127 ||
    String.fromCharCode(...bytes.subarray(0, 7)) !== 'PMTiles'
  )
    throw new Error('Not a PMTiles archive');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u64 = (at) => Number(view.getBigUint64(at, true));
  const header = {
    version: bytes[7],
    rootOffset: u64(8),
    rootLength: u64(16),
    metadataOffset: u64(24),
    metadataLength: u64(32),
    leafOffset: u64(40),
    leafLength: u64(48),
    tilesOffset: u64(56),
    tilesLength: u64(64),
    addressedTiles: u64(72),
    tileEntries: u64(80),
    tileContents: u64(88),
    clustered: bytes[96] === 1,
    internalCompression: bytes[97],
    tileCompression: bytes[98],
    tileType: bytes[99],
    minZoom: bytes[100],
    maxZoom: bytes[101],
  };
  if (header.version !== 3)
    throw new Error(`Unsupported PMTiles version: ${header.version}`);

  function readDirectory(offset, length) {
    const raw = bytes.subarray(offset, offset + length);
    return parseDirectory(decompress(raw, header.internalCompression));
  }

  // Resolve the directory once: entries with runLength 0 are leaf pointers.
  const entries = [];
  const queue = readDirectory(header.rootOffset, header.rootLength);
  for (const entry of queue) {
    if (entry.runLength === 0) {
      const leaf = readDirectory(
        header.leafOffset + entry.offset,
        entry.length,
      );
      entries.push(...leaf);
    } else entries.push(entry);
  }
  entries.sort((a, b) => a.tileId - b.tileId);

  function findEntry(tileId) {
    let lo = 0;
    let hi = entries.length - 1;
    let found = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const entry = entries[mid];
      if (tileId < entry.tileId) hi = mid - 1;
      else if (tileId >= entry.tileId + entry.runLength) lo = mid + 1;
      else {
        found = entry;
        break;
      }
    }
    return found;
  }

  return {
    header,
    entries,
    /** Raw (decompressed) tile bytes for z/x/y, or null when unaddressed. */
    getTile(z, x, y) {
      const entry = findEntry(zxyToTileId(z, x, y));
      if (!entry) return null;
      const start = header.tilesOffset + entry.offset;
      const raw = bytes.subarray(start, start + entry.length);
      return decompress(raw, header.tileCompression);
    },
    /** Every addressed tile id at exactly zoom `z`, as [z, x, y, entry]. */
    tilesAtZoom(z) {
      const first = firstTileIdOfZoom(z);
      const pastLast = first + 4 ** z;
      const out = [];
      for (const entry of entries) {
        const start = Math.max(entry.tileId, first);
        const end = Math.min(entry.tileId + entry.runLength, pastLast);
        for (let tileId = start; tileId < end; tileId++) {
          const [tz, x, y] = tileIdToZxy(tileId);
          out.push([tz, x, y, entry]);
        }
      }
      return out;
    },
    /** Raw bytes for a directory entry (shared by its whole run). */
    tileBytesForEntry(entry) {
      const start = header.tilesOffset + entry.offset;
      return decompress(
        bytes.subarray(start, start + entry.length),
        header.tileCompression,
      );
    },
  };
}
