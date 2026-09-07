import test from 'node:test';
import assert from 'node:assert/strict';
import { isEngineCompatible, GAME_API_VERSION } from '../src/index.js';

// Real semver-range checking for `manifest.engineCompatibility` -- see
// packages/game-api/src/index.js's module doc comment for why this
// exists (the field used to be pure decoration, checked against nothing)
// and packages/game-pack's gamePack.test.js for the end-to-end
// createGamePack()-level regression tests. These are the focused unit
// tests for the comparator itself, especially prerelease precedence
// (GAME_API_VERSION is '2.0.0-alpha.1', a prerelease version, which
// semver defines as LOWER precedence than the same major.minor.patch
// without a prerelease tag -- an easy rule to get backwards).

test('null/undefined range is always compatible (no declared requirement, nothing to check)', () => {
  assert.equal(isEngineCompatible(null, '1.0.0'), true);
  assert.equal(isEngineCompatible(undefined, '1.0.0'), true);
});

test('a >= clause is satisfied at and above the bound', () => {
  assert.equal(isEngineCompatible('>=2.0.0', '2.0.0'), true);
  assert.equal(isEngineCompatible('>=2.0.0', '2.0.1'), true);
  assert.equal(isEngineCompatible('>=2.0.0', '1.9.9'), false);
});

test('a < clause excludes the bound itself', () => {
  assert.equal(isEngineCompatible('<3.0.0', '2.9.9'), true);
  assert.equal(isEngineCompatible('<3.0.0', '3.0.0'), false);
});

test('multiple space-separated clauses are ANDed together (a real range)', () => {
  const range = '>=2.0.0-alpha.1 <3.0.0';
  assert.equal(isEngineCompatible(range, '2.0.0-alpha.1'), true);
  assert.equal(isEngineCompatible(range, '2.5.0'), true);
  assert.equal(isEngineCompatible(range, '2.9.9'), true);
  assert.equal(isEngineCompatible(range, '3.0.0'), false);
  assert.equal(isEngineCompatible(range, '1.9.9'), false);
});

test('a prerelease version has LOWER precedence than the same version without one (semver rule, easy to get backwards)', () => {
  assert.equal(isEngineCompatible('>=2.0.0', '2.0.0-alpha.1'), false, '2.0.0-alpha.1 is < 2.0.0, so >=2.0.0 must reject it');
  assert.equal(isEngineCompatible('<2.0.0', '2.0.0-alpha.1'), true, '2.0.0-alpha.1 is < 2.0.0');
  assert.equal(isEngineCompatible('>=2.0.0-alpha.1', '2.0.0-alpha.1'), true, 'a version satisfies >= its own exact value');
});

test('numeric prerelease identifiers compare numerically, not lexically (2.0.0-alpha.2 > 2.0.0-alpha.10 would be wrong lexically)', () => {
  assert.equal(isEngineCompatible('>2.0.0-alpha.2', '2.0.0-alpha.10'), true, 'numeric comparison: 10 > 2');
});

test('the current GAME_API_VERSION constant is itself always compatible with its own declared value used as a default', () => {
  assert.equal(isEngineCompatible(`>=${GAME_API_VERSION}`), true);
});

test('an invalid/unparseable clause throws rather than silently passing or failing', () => {
  assert.throws(() => isEngineCompatible('not-a-real-clause', '1.0.0'), TypeError);
});

test('a bare version with no operator is treated as an exact-match (=) clause', () => {
  assert.equal(isEngineCompatible('2.0.0', '2.0.0'), true);
  assert.equal(isEngineCompatible('2.0.0', '2.0.1'), false);
});
