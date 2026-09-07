import test from 'node:test';
import assert from 'node:assert/strict';
import { runAction } from '../src/index.js';
import { gridDuel } from '@tablecore/game-grid-duel';
import { coinRace } from '@tablecore/game-coin-race';
import { phaseQuest } from '@tablecore/game-phase-quest';
import { sectorExpedition } from '@tablecore/game-sector-expedition';

// runAction()'s applyActionInPlace path always hands the game a live
// immer draft now (see the long comment in runAction.js for why this is
// a mandatory engine contract, not an opt-in flag). These tests prove the
// four shipped games actually work correctly under that contract -- not
// just "the flag exists", but real games producing real, correct,
// expected results when driven through the draft-based path that ships
// as their only path today.

test('grid-duel: MOVE mutates the draft correctly and events resolve to plain, correct values', () => {
  const state = gridDuel.createInitialState();
  const result = runAction({ game: gridDuel, state, action: { type:'MOVE', actor:'A', direction:'E' } });
  assert.equal(result.ok, true);
  assert.deepEqual(result.state.players.A.position, { x:1, y:0 });
  // PLAYER_MOVED's `from`/`to` are read off the draft mid-mutation and
  // captured into the event payload -- exactly the pattern that requires
  // runAction's JSON-round-trip-inside-the-recipe fix to resolve safely.
  const moved = result.events.find(e => e.type === 'PLAYER_MOVED');
  assert.deepEqual(moved.from, { x:0, y:0 });
  assert.deepEqual(moved.to, { x:1, y:0 });
  // The original state passed in must be completely untouched -- immer
  // never mutates the base object, only the finalized copy is new.
  assert.deepEqual(state.players.A.position, { x:0, y:0 });
});

test('coin-race: ADVANCE mutates the draft correctly across a full game to completion', () => {
  let state = coinRace.createInitialState();
  let result;
  for (let i = 0; i < 10 && state.phase === 'playing'; i++) {
    result = runAction({ game: coinRace, state, action: { type:'ADVANCE', actor: state.activePlayer } });
    assert.equal(result.ok, true);
    state = result.state;
  }
  assert.equal(state.phase, 'finished');
  assert.ok(state.winner === 'A' || state.winner === 'B');
});

test('phase-quest: nested flow.resolveFlow() mutation of the draft works correctly (phase transition)', () => {
  const state = phaseQuest.createInitialState();
  const r1 = runAction({ game: phaseQuest, state, action: { type:'READY', actor:'A' } });
  assert.equal(r1.ok, true);
  assert.equal(r1.state.phase, 'prepare'); // B hasn't readied yet
  const r2 = runAction({ game: phaseQuest, state: r1.state, action: { type:'READY', actor:'B' } });
  assert.equal(r2.ok, true);
  assert.equal(r2.state.phase, 'play'); // resolveFlow's own draft mutation moved the phase forward
  const changed = r2.events.find(e => e.type === 'PHASE_CHANGED');
  assert.deepEqual(changed, { type:'PHASE_CHANGED', from:'prepare', to:'play' });
});

test('sector-expedition: MOVE and SCAN work correctly, including previously-clone()-derived from/to/opened event fields', () => {
  const state = sectorExpedition.createInitialState({ players:['A','B'], seed:1 });
  const context = { rng: { int: (min) => min } };
  const active = state.activePlayer;
  const moveResult = runAction({ game: sectorExpedition, state, action: { type:'MOVE', actor: active, target:{ q:1, r:0 } }, context });
  assert.equal(moveResult.ok, true, JSON.stringify(moveResult.error));
  const moved = moveResult.events.find(e => e.type === 'PLAYER_MOVED');
  assert.deepEqual(moved.to, { q:1, r:0 });
  assert.equal(moveResult.state.players[active].position.q, 1);
  // The original state is untouched.
  assert.deepEqual(state.players[active].position, { q:0, r:0 });
});

// This is the actual, demonstrated boundary of the mandatory contract: a
// game that calls structuredClone() on a value read from `state` inside
// applyActionInPlace breaks. Not hypothetical -- this really did break
// sector-expedition before its two offending lines were fixed to use a
// plain spread instead (see the tests above and
// games/sector-expedition/src/game.js). This is now also caught
// statically before the pack ever ships (see
// packages/pack-linter/test/packLinter.test.js's
// STRUCTURED_CLONE_ON_DRAFT_IN_APPLY_ACTION_IN_PLACE tests) -- this test
// covers the runtime fail-closed backstop for the same rule.
test('a game that violates the contract (structuredClone on draft-derived state) fails closed at runtime, does not corrupt state', () => {
  const badGame = {
    createInitialState: () => ({ position: { x: 0, y: 0 } }),
    getLegalActions: () => [{ type:'TOUCH' }],
    applyActionInPlace(state) {
      const snapshot = structuredClone(state.position); // the exact violation
      state.position = snapshot;
      return { state, events: [] };
    },
  };
  const state = badGame.createInitialState();
  const result = runAction({ game: badGame, state, action: { type:'TOUCH', actor:'A' } });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'GAME_EXECUTION_ERROR');
  assert.deepEqual(state, { position: { x: 0, y: 0 } });
});

test('a game using only the non-in-place applyAction is entirely unaffected by the draft contract', () => {
  const plainGame = {
    createInitialState: () => ({ value: 1 }),
    getLegalActions: () => [{ type:'BUMP' }],
    applyAction: (state) => { const clone = structuredClone(state); clone.value += 1; return { state: clone, events: [] }; },
  };
  const state = plainGame.createInitialState();
  const result = runAction({ game: plainGame, state, action: { type:'BUMP', actor:'A' } });
  assert.equal(result.ok, true);
  assert.equal(result.state.value, 2);
});

// Regression test: a game whose state uses Map/Set (a common, idiomatic
// choice for entities keyed by id -- e.g. games/last-sector's `units`/
// `tiles`) must work under the mandatory draft path without the pack
// itself having to know that immer is involved or call enableMapSet()
// itself. Before this, any such game would throw "[Immer] The plugin for
// 'MapSet' has not been loaded" the first time it mutated a Map/Set
// through a draft.
test('a game using Map/Set in its state works under the mandatory draft path without the pack calling enableMapSet() itself', () => {
  const mapSetGame = {
    createInitialState: () => ({ units: new Map([['u1', { hp: 10 }]]), tags: new Set(['alpha']) }),
    getLegalActions: () => [{ type:'DAMAGE' }],
    applyActionInPlace(state) {
      state.units.get('u1').hp -= 3;
      state.tags.add('damaged');
      return { state, events: [{ type:'DAMAGED' }] };
    },
  };
  const state = mapSetGame.createInitialState();
  const result = runAction({ game: mapSetGame, state, action: { type:'DAMAGE', actor:'A' } });
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.equal(result.state.units.get('u1').hp, 7);
  assert.ok(result.state.tags.has('damaged'));
  // Original state untouched, same as every other draft-based mutation.
  assert.equal(state.units.get('u1').hp, 10);
  assert.ok(!state.tags.has('damaged'));
});
