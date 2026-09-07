import test from 'node:test';
import assert from 'node:assert/strict';
import { lastSector } from '../src/index.js';

// CRITICAL security regression tests, found during a hard adversarial
// audit before real people were given access to a running server.
//
// (1) `options.scenario` used to flow straight into `path.join(__dirname,
// key + '.json')` + `fs.readFileSync` with zero validation. `path.join`
// does NOT contain `..` traversal within a base directory. Confirmed
// directly: `{scenario: '../../../package'}` read this repo's own root
// package.json, and its contents ended up inside the returned game
// state -- a real, severe arbitrary-file-read vulnerability, reachable
// by anyone able to create a match with custom options.
//
// (2) `options.gridWidth`/`gridHeight` used to flow into board-generation
// with zero upper bound. Confirmed directly: `{gridWidth: 100000,
// gridHeight: 100000}` OOM-crashed the entire Node process (heap
// exhaustion, ~47 seconds to fatal error) -- a single request from
// anyone able to create a match could take the whole server down for
// every connected player simultaneously. The fix also had to account
// for a SECOND problem discovered while choosing a safe ceiling: board
// generation itself scales super-linearly with tile count (measured:
// 2500 tiles ~330ms, 10000 tiles ~4500ms -- consistent with an O(n^2)-ish
// `Array.indexOf` scan inside the legacy tile-type-placement loop, not
// touched here since rewriting shipped legacy game logic under time
// pressure is its own risk). The ceiling (40x40) was chosen from real,
// measured timings, not guessed.

test('options.scenario path traversal is blocked -- cannot read files outside the scenarios directory', () => {
  const traversalAttempts = [
    '../../../package',
    '../../../../etc/passwd',
    '..%2f..%2fpackage',
    '....//....//package',
    '/etc/passwd',
    'a/../../../package',
  ];
  for (const attempt of traversalAttempts) {
    assert.throws(
      () => lastSector.createInitialState({ players: ['A', 'B'], seed: 1, scenario: attempt }),
      /invalid-scenario-id/,
      `must reject scenario id: ${JSON.stringify(attempt)}`
    );
  }
});

test('a legitimate scenario id still loads correctly after the path traversal fix', () => {
  const state = lastSector.createInitialState({ players: ['A', 'B'], seed: 1, scenario: 'combat-demo' });
  assert.equal(state.phase, 'playing');
});

test('createInitialState with no scenario option still works (the common case)', () => {
  assert.doesNotThrow(() => lastSector.createInitialState({ players: ['A', 'B'], seed: 1 }));
});

test('an unknown-but-safely-formatted scenario id fails closed with scenario-not-found, not a path/fs error', () => {
  assert.throws(
    () => lastSector.createInitialState({ players: ['A', 'B'], seed: 1, scenario: 'this-scenario-does-not-exist' }),
    /scenario-not-found/
  );
});

test('gridWidth/gridHeight are bounded and fast even at extreme requested values -- cannot be used to exhaust server memory or block the event loop for seconds', () => {
  const t0 = Date.now();
  const state = lastSector.createInitialState({ players: ['A', 'B'], seed: 1, gridWidth: 100000, gridHeight: 100000 });
  const elapsedMs = Date.now() - t0;
  assert.ok(state.tiles.size <= 40 * 40, `tile count must be clamped to a sane maximum, got ${state.tiles.size}`);
  assert.ok(elapsedMs < 1000, `board generation for even the maximum extreme input must stay well under 1s (a real server blocks ALL connected players for this long), took ${elapsedMs}ms`);
});

test('gridWidth/gridHeight also cannot be used to create a degenerate zero/negative-size board', () => {
  for (const bad of [0, -1, -100000, NaN, Infinity]) {
    const state = lastSector.createInitialState({ players: ['A', 'B'], seed: 1, gridWidth: bad, gridHeight: bad });
    assert.ok(state.tiles.size >= 1, `a degenerate gridWidth/gridHeight of ${bad} must still produce a valid, non-empty board`);
  }
});
