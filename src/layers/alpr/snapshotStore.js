/**
 * Append-only snapshot store for the ALPR diff engine (spec §3.2,
 * task 5). Per watched AOI: a hash-chained JSONL of extract snapshots
 * (the differ's memory) and the chained diff feed itself, plus a small
 * mutable state file (pending removals, feed-initialised flag) that is
 * working state, not record — the chained files are the record.
 *
 * Storage is INJECTED ({readText, appendText, writeText}) so the module
 * stays isomorphic: unit tests drive it with the memory IO below, and a
 * server worker drives it with createFileSnapshotIo over node:fs —
 * the same split the codebase keeps between census.js (pure) and its
 * driving script. Nothing here fetches, renders, or knows the layer is
 * caged; it is machinery a worker runs on the extract's hourly cadence.
 *
 * Chain shape mirrors the graft-plan ledger: every line carries
 * {seq, prev_hash, hash}, hash = digest(prev_hash + canonical entry).
 * The default digest is FNV-1a 64-bit (the codebase's stable-identity
 * hash family — cctv frames, detection cohorts): tamper-EVIDENT for a
 * tranche-1 file store, not a cryptographic signature; a worker may
 * inject sha256 via node:crypto without changing the format.
 *
 * @module layers/alpr/snapshotStore
 */

/** Deterministic JSON: object keys sorted at every depth. */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object')
    return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value))
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(',')}}`;
}

/** FNV-1a 64-bit over the UTF-16 code units of `text`, as 16 hex chars. */
export function fnv1a64Hex(text) {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  const s = String(text);
  for (let i = 0; i < s.length; i++) {
    hash ^= BigInt(s.charCodeAt(i));
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, '0');
}

const GENESIS_HASH = 'GENESIS';

/** In-memory IO for tests and dry runs. Paths are opaque keys. */
export function createMemorySnapshotIo() {
  const files = new Map();
  return {
    async readText(path) {
      return files.has(path) ? files.get(path) : null;
    },
    async appendText(path, text) {
      files.set(path, (files.get(path) ?? '') + text);
    },
    async writeText(path, text) {
      files.set(path, text);
    },
    _files: files,
  };
}

/**
 * File-backed IO over an injected node:fs/promises-shaped object
 * ({mkdir, readFile, appendFile, writeFile}) — the server worker passes
 * the real module; this file never imports node builtins itself.
 * Paths are joined under `rootDir` with forward slashes.
 */
export function createFileSnapshotIo(rootDir, fsPromises) {
  if (!rootDir || !fsPromises)
    throw new TypeError('file snapshot IO requires a root dir and fs');
  const resolve = (path) => `${rootDir}/${path}`;
  const ensureDir = async (path) => {
    const dir = resolve(path).split('/').slice(0, -1).join('/');
    await fsPromises.mkdir(dir, { recursive: true });
  };
  return {
    async readText(path) {
      try {
        return await fsPromises.readFile(resolve(path), 'utf8');
      } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
      }
    },
    async appendText(path, text) {
      await ensureDir(path);
      await fsPromises.appendFile(resolve(path), text, 'utf8');
    },
    async writeText(path, text) {
      await ensureDir(path);
      await fsPromises.writeFile(resolve(path), text, 'utf8');
    },
  };
}

/**
 * One hash-chained JSONL file. Appends are serialised per instance;
 * reads verify the chain and report the first broken link.
 */
export function createChainedJsonl({ io, path, digest = fnv1a64Hex }) {
  if (!io || !path) throw new TypeError('chained JSONL requires io + path');
  let tailCache = null;
  let queue = Promise.resolve();

  async function tail() {
    if (tailCache) return tailCache;
    const text = await io.readText(path);
    if (!text) return (tailCache = { seq: 0, hash: GENESIS_HASH });
    const lines = text.split('\n').filter((line) => line.trim());
    if (!lines.length) return (tailCache = { seq: 0, hash: GENESIS_HASH });
    const last = JSON.parse(lines[lines.length - 1]);
    return (tailCache = {
      seq: last.chain?.seq ?? lines.length,
      hash: last.chain?.hash ?? GENESIS_HASH,
    });
  }

  return {
    path,
    /** Append one entry; resolves to the stored line's chain block. */
    append(entry) {
      const run = queue.then(async () => {
        const { seq, hash: prevHash } = await tail();
        const hash = digest(`${prevHash}\n${stableStringify(entry)}`);
        const chain = { seq: seq + 1, prev_hash: prevHash, hash };
        await io.appendText(path, `${JSON.stringify({ ...entry, chain })}\n`);
        tailCache = { seq: chain.seq, hash };
        return chain;
      });
      queue = run.catch(() => {});
      return run;
    },
    /** Read every entry back, chain stripped, with verification. */
    async readAll() {
      const text = await io.readText(path);
      if (!text) return { entries: [], valid: true, brokenAt: null };
      const lines = text.split('\n').filter((line) => line.trim());
      const entries = [];
      let prevHash = GENESIS_HASH;
      let brokenAt = null;
      for (let i = 0; i < lines.length; i++) {
        const parsed = JSON.parse(lines[i]);
        const { chain, ...entry } = parsed;
        const expected = digest(`${prevHash}\n${stableStringify(entry)}`);
        if (
          !chain ||
          chain.seq !== i + 1 ||
          chain.prev_hash !== prevHash ||
          chain.hash !== expected
        ) {
          brokenAt = i + 1;
          break;
        }
        prevHash = chain.hash;
        entries.push(entry);
      }
      return { entries, valid: brokenAt === null, brokenAt };
    },
  };
}

/**
 * The per-AOI store: snapshots + diff feed + pending-removal state.
 * @param {object} input
 * @param {object} input.io Injected storage IO (see above).
 * @param {Function} [input.digest] Chain digest override (e.g. sha256).
 */
export function createAlprSnapshotStore({ io, digest = fnv1a64Hex } = {}) {
  if (!io) throw new TypeError('snapshot store requires injected IO');
  const dirFor = (aoiId) =>
    `alpr/${String(aoiId).replace(/[^a-z0-9-_]+/gi, '-')}`;
  const chains = new Map();
  const chainFor = (aoiId, file) => {
    const path = `${dirFor(aoiId)}/${file}`;
    if (!chains.has(path))
      chains.set(path, createChainedJsonl({ io, path, digest }));
    return chains.get(path);
  };
  const statePath = (aoiId) => `${dirFor(aoiId)}/state.json`;

  async function readState(aoiId) {
    const text = await io.readText(statePath(aoiId));
    if (!text) return { pendingRemovals: {}, feedInitialized: false };
    try {
      const parsed = JSON.parse(text);
      return {
        pendingRemovals: parsed.pendingRemovals ?? {},
        feedInitialized: parsed.feedInitialized === true,
      };
    } catch {
      return { pendingRemovals: {}, feedInitialized: false };
    }
  }
  async function writeState(aoiId, state) {
    await io.writeText(statePath(aoiId), `${JSON.stringify(state)}\n`);
  }

  return {
    /** Persist one cycle's snapshot (records already AOI-bounded). */
    async appendSnapshot(aoiId, snapshot) {
      return chainFor(aoiId, 'snapshots.jsonl').append({
        v: 1,
        type: 'alpr-snapshot',
        aoi_id: aoiId,
        extract_ts: snapshot.extract_ts ?? null,
        ingest_ts: snapshot.ingest_ts ?? null,
        complete: snapshot.complete !== false,
        saturated: snapshot.saturated === true,
        record_count: snapshot.records?.length ?? 0,
        records: snapshot.records ?? [],
      });
    },
    /** The newest stored snapshot entry, or null before cycle one. */
    async latestSnapshot(aoiId) {
      const { entries } = await chainFor(aoiId, 'snapshots.jsonl').readAll();
      return entries.length ? entries[entries.length - 1] : null;
    },
    /** Every stored snapshot entry, oldest first. */
    async listSnapshots(aoiId) {
      const { entries } = await chainFor(aoiId, 'snapshots.jsonl').readAll();
      return entries;
    },
    /** Verify a snapshot chain end to end (tamper evidence). */
    async verifySnapshots(aoiId) {
      return chainFor(aoiId, 'snapshots.jsonl').readAll();
    },
    /**
     * Append one cycle's events to the diff feed. The header is written
     * exactly once, as the feed's first chained line, before any event.
     */
    async appendDiffCycle(aoiId, { header, events }) {
      const feed = chainFor(aoiId, 'diff-feed.jsonl');
      const state = await readState(aoiId);
      if (!state.feedInitialized) {
        if (!header)
          throw new TypeError('first diff cycle requires a feed header');
        await feed.append(header);
        state.feedInitialized = true;
        await writeState(aoiId, state);
      }
      for (const event of events || []) await feed.append(event);
      return { appended: (events || []).length };
    },
    /** Read the diff feed back (header first), chain verified. */
    async readDiffFeed(aoiId) {
      return chainFor(aoiId, 'diff-feed.jsonl').readAll();
    },
    async getPendingRemovals(aoiId) {
      return (await readState(aoiId)).pendingRemovals;
    },
    async setPendingRemovals(aoiId, pendingRemovals) {
      const state = await readState(aoiId);
      state.pendingRemovals = pendingRemovals ?? {};
      await writeState(aoiId, state);
    },
  };
}
