// server/providers/cctv.frame.test.mjs
// F-07 (simulation audit): a dead camera must never be answered with a
// historical Google Street View photograph in the live frame's slot. The
// frame chain is upstream -> synthetic status card, nothing in between —
// even when a Google key is configured and Street View would have answered.
import assert from 'node:assert/strict';
import test from 'node:test';

import { cctvProxy } from './cctv.js';

const DEAD_CAMERA = {
  id: 'dead-cam',
  name: 'Dead Camera',
  city: 'Nowhere',
  provider: 'Test Provider',
  lat: 31.23,
  lon: -82.39,
  headingDeg: 90,
  fovDeg: 80,
  pitchDeg: -10,
  feedType: 'image',
  url: 'https://dead-upstream.invalid/frame.jpg',
};

const ENV_KEYS = [
  'CCTV_SOURCES_JSON',
  'GOOGLE_MAPS_SERVER_API_KEY',
  'GOOGLE_MAPS_API_KEY',
];

function fakeResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value;
    },
    writeHead(status, headers = {}) {
      this.statusCode = status;
      for (const [name, value] of Object.entries(headers))
        this.headers[name.toLowerCase()] = value;
      return this;
    },
    end(body = '') {
      this.body = Buffer.isBuffer(body) ? body.toString('utf8') : String(body);
    },
  };
}

/**
 * Drives the plugin's /api/cctv middleware with one registered camera whose
 * upstream is dead. Global fetch is stubbed so the camera upstream always
 * fails while a Street View request WOULD succeed with a real JPEG — the
 * exact conditions under which the old chain substituted the photograph.
 * Returns the response plus every URL the server tried to fetch.
 */
async function requestDeadFrame(t, { withGoogleKey }) {
  const saved = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of saved)
      value === undefined
        ? delete process.env[key]
        : (process.env[key] = value);
  });
  process.env.CCTV_SOURCES_JSON = JSON.stringify([DEAD_CAMERA]);
  if (withGoogleKey) {
    process.env.GOOGLE_MAPS_SERVER_API_KEY = 'test-server-key';
    delete process.env.GOOGLE_MAPS_API_KEY;
  } else {
    delete process.env.GOOGLE_MAPS_SERVER_API_KEY;
    delete process.env.GOOGLE_MAPS_API_KEY;
  }

  const fetched = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    const target = String(url);
    fetched.push(target);
    if (target.includes('maps.googleapis.com')) {
      return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), {
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
      });
    }
    throw new Error('upstream dead');
  });

  const plugin = cctvProxy({ sourceRoot: process.cwd() });
  let handler = null;
  plugin.configureServer({
    httpServer: null,
    middlewares: {
      use: (_path, middleware) => {
        handler = middleware;
      },
    },
  });
  assert.equal(typeof handler, 'function');

  const request = async (path) => {
    const res = fakeResponse();
    await handler(
      {
        url: path,
        method: 'GET',
        headers: { host: 'localhost:5173', 'sec-fetch-site': 'same-origin' },
        socket: {},
      },
      res,
    );
    return res;
  };

  const frame = await request('/frame/dead-cam');
  const health = await request('/health');
  return { frame, health, fetched };
}

test('dead upstream + Google key: the frame is the labelled synthetic card, never Street View', async (t) => {
  const { frame, health, fetched } = await requestDeadFrame(t, {
    withGoogleKey: true,
  });
  assert.equal(frame.statusCode, 200);
  assert.equal(frame.headers['content-type'], 'image/svg+xml');
  assert.equal(frame.headers['x-cctv-source'], 'synthetic');
  assert.match(frame.body, /CCTV FEED PLACEHOLDER/);
  assert.match(frame.body, /UPSTREAM UNAVAILABLE/);
  // Street View is not even consulted any more: no fetch leaves for Google.
  assert.equal(
    fetched.some((url) => url.includes('maps.googleapis.com')),
    false,
  );
  // Health tells the same truth as the frame.
  const report = JSON.parse(health.body);
  const entry = report.cameras.find((camera) => camera.id === 'dead-cam');
  assert.equal(entry?.sourceKind, 'synthetic');
  assert.equal(entry?.status, 'degraded');
});

test('dead upstream without a key: same synthetic card, no photograph', async (t) => {
  const { frame } = await requestDeadFrame(t, { withGoogleKey: false });
  assert.equal(frame.statusCode, 200);
  assert.equal(frame.headers['content-type'], 'image/svg+xml');
  assert.equal(frame.headers['x-cctv-source'], 'synthetic');
  assert.match(frame.body, /CCTV FEED PLACEHOLDER/);
});
