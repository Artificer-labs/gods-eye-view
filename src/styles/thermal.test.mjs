// src/styles/thermal.test.mjs
// F-04 (simulation audit): the FLIR style is a display palette, not a
// sensor. Its HUD must never again render a numeric temperature derived
// from image luminance — a decimal °C figure for a quantity nothing
// measured. Guard the strike at the shader-source level.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { thermalShader } from './thermal.js';

test('the thermal shader fabricates no temperature readout', () => {
  const glsl = thermalShader.fragmentShader;
  assert.equal(glsl.includes('tempC'), false);
  assert.equal(glsl.includes('centerLuma'), false);
  assert.equal(glsl.includes('tempHud'), false);
});

test('the thermal HUD keeps its non-measurement furniture', () => {
  const glsl = thermalShader.fragmentShader;
  // Frame counter and crosshair are presentation, not invented data.
  assert.equal(glsl.includes('framHud'), true);
  assert.equal(glsl.includes('crosshair'), true);
});
