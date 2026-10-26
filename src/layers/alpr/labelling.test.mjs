import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MAPPER_DENSITY_CAVEAT,
  NO_MAPPED_DATA_FOR_AREA,
  NO_MAPPED_READER,
  NO_MAPPED_READERS_IN_VIEW,
  alprAbsenceLabel,
  alprCoverageCaveatLines,
} from './labelling.js';

/**
 * The §4 labelling-law audit (Greta condition 1: a test that FAILS on
 * the unhedged string). Absence on this map is mapper absence; any
 * rendered string that asserts "no <reader|camera|coverage|data>"
 * without naming the mapping basis is a claim about the world this
 * layer cannot make, and this suite kills it on sight.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AUDITED_FILES = [
  ...readdirSync(HERE)
    .filter((name) => name.endsWith('.js') && !name.endsWith('.test.mjs'))
    .map((name) => path.join(HERE, name)),
  path.join(HERE, '..', '..', 'data', 'alprCameras.js'),
];

// String literals, in the same shape the i18n extractor sees them.
const STRING_LITERAL =
  /'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\$])*`/g;

function literalsOf(file) {
  const source = readFileSync(file, 'utf8');
  return (source.match(STRING_LITERAL) || []).map((literal) =>
    literal.slice(1, -1),
  );
}

/**
 * Absence assertions inside one literal that fail to name the mapping
 * basis. A claim is the word "no" governing (within three words) one of
 * the absence nouns; it is hedged only if the governing span itself
 * says "mapped". Literals opening with "None" (a screen-scope word)
 * must also name mapped objects.
 */
function unhedgedAbsenceClaims(literal) {
  const claims = [];
  const pattern =
    /\bno\s+(?:[a-z]+\s+){0,3}?(reader|readers|camera|cameras|coverage|data)\b/gi;
  let match;
  while ((match = pattern.exec(literal))) {
    const span = literal.slice(match.index, match.index + match[0].length);
    if (!/mapped/i.test(span)) claims.push(span);
  }
  if (/^none\b/i.test(literal) && !/mapped/i.test(literal))
    claims.push(literal.slice(0, 40));
  return claims;
}

test('the canonical absence wordings name the mapping basis', () => {
  for (const wording of [
    NO_MAPPED_READER,
    NO_MAPPED_READERS_IN_VIEW,
    NO_MAPPED_DATA_FOR_AREA,
  ]) {
    assert.match(wording, /mapped/i);
    assert.deepEqual(unhedgedAbsenceClaims(wording), []);
  }
  assert.equal(alprAbsenceLabel(), NO_MAPPED_READER);
  assert.match(NO_MAPPED_READER, /community mapping, unverified absence/);
});

test('the mapper-density caveat states that absence is mapper absence', () => {
  assert.match(MAPPER_DENSITY_CAVEAT, /community mapping/);
  assert.match(MAPPER_DENSITY_CAVEAT, /absence on this map is mapper absence/);
  assert.deepEqual(alprCoverageCaveatLines(), [MAPPER_DENSITY_CAVEAT]);
});

test('AUDIT: no rendered string in the layer asserts unhedged absence', () => {
  const findings = [];
  for (const file of AUDITED_FILES) {
    for (const literal of literalsOf(file)) {
      for (const claim of unhedgedAbsenceClaims(literal)) {
        findings.push(`${path.basename(file)}: "${claim}" in "${literal}"`);
      }
    }
  }
  assert.deepEqual(findings, []);
});

test('AUDIT: the pre-law absence labels are gone from the layer source', () => {
  const banned = [
    'No ALPR data for this area',
    'Coverage limited — zoom in',
    'nearby cameras are outside the view',
  ];
  for (const file of AUDITED_FILES) {
    const source = readFileSync(file, 'utf8');
    for (const phrase of banned)
      assert.equal(
        source.includes(phrase),
        false,
        `${path.basename(file)} still carries the unhedged phrase: ${phrase}`,
      );
  }
});
