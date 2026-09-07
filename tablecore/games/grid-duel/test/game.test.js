import test from 'node:test'; import assert from 'node:assert/strict'; import { gridDuel } from '../src/index.js';
test('initial state is valid',()=>{const s=gridDuel.createInitialState();assert.equal(s.activePlayer,'A');assert.equal(s.players.A.hp,3);});
test('same input produces same result',()=>{const s=gridDuel.createInitialState();const a={type:'MOVE',actor:'A',direction:'E'};assert.deepEqual(gridDuel.applyAction(s,a),gridDuel.applyAction(s,a));});
test('out of bounds is rejected by game without state mutation',()=>{const s=gridDuel.createInitialState();const before=structuredClone(s);const r=gridDuel.applyAction(s,{type:'MOVE',actor:'A',direction:'N'});assert.equal(r.events[0].code,'OUT_OF_BOUNDS');assert.deepEqual(s,before);});

// Regression test for a real bug found via an aggressive audit pass:
// createInitialState() used to completely ignore whatever real players
// list it was given, always hardcoding literal 'A'/'B' -- a match
// created with real participant ids like ['Alice','Bob'] (via
// createMatch/startMatch, matching match.players exactly) ended up with
// state.players keyed 'A'/'B' instead of the real ids. Confirmed
// directly before fixing: getLegalActions(state, 'Alice') always
// returned [] (since 'Alice' !== the hardcoded 'A'), and
// dispatchMatchAction for the real participant 'Alice' returned
// ILLEGAL_ACTION unconditionally -- the match was completely unplayable
// for anyone whose real player id wasn't the exact literal string 'A'
// or 'B'.
test('createInitialState uses the REAL player ids it is given, not hardcoded literal A/B -- a real participant can actually take a legal action', () => {
  const state = gridDuel.createInitialState({ players: ['Alice', 'Bob'] });
  assert.deepEqual(Object.keys(state.players).sort(), ['Alice', 'Bob']);
  assert.equal(state.activePlayer, 'Alice');
  const legal = gridDuel.getLegalActions(state, 'Alice');
  assert.ok(legal.length > 0, 'the real, registered participant must have real legal actions available, not be silently locked out');
});

test('combat correctly resolves against "the other real player", not a hardcoded A/B toggle', () => {
  let state = gridDuel.createInitialState({ players: ['Alice', 'Bob'] });
  // Alice starts (0,0), Bob starts (4,4). Alice walks E to (4,0); Bob
  // walks N to (4,1) -- Manhattan distance 1, adjacent -- via real,
  // legal MOVE actions only, verified directly before writing this
  // assertion.
  for (let i = 0; i < 4; i++) { state = gridDuel.applyAction(state, { type: 'MOVE', actor: 'Alice', direction: 'E' }).state; state = gridDuel.applyAction(state, { type: 'MOVE', actor: 'Bob', direction: 'N' }).state; }
  const attack = gridDuel.applyAction(state, { type: 'ATTACK', actor: 'Alice' });
  assert.equal(attack.events[0].type, 'PLAYER_ATTACKED');
  assert.equal(attack.events[0].target, 'Bob', 'the attack must resolve against the real other player (Bob), not a hardcoded id that would not even exist in this match');
});

test('createInitialState still defaults to A/B when no players are explicitly given -- preserves every existing caller\'s behavior', () => {
  const state = gridDuel.createInitialState();
  assert.deepEqual(Object.keys(state.players).sort(), ['A', 'B']);
  assert.equal(state.activePlayer, 'A');
});
