import test from 'node:test';
import assert from 'node:assert/strict';
import { synthesizeApplyAction } from '../src/index.js';

// Regression test for a real, genuine gap found via an aggressive audit
// pass: this function's own try/catch (around its internal produce()
// call) was missing entirely -- confirmed directly, not assumed, that a
// real exception thrown inside a game's own applyActionInPlace
// propagated UNCAUGHT out of the synthesized applyAction, unlike
// runAction()'s own equivalent draft-path handling (which has always
// wrapped this in a try/catch). This matters specifically because
// applyAction() is the REQUIRED, PUBLIC GameDefinition contract entry
// point -- it must behave safely when called directly and standalone,
// not only when reached through the normal dispatch flow (which always
// prefers applyActionInPlace directly and never actually calls the
// synthesized function during ordinary play).
test('synthesizeApplyAction catches a real exception thrown inside applyActionInPlace, returning a clean GAME_EXECUTION_ERROR result instead of propagating it uncaught', () => {
  const buggyApplyActionInPlace = () => { throw new Error('a real bug in this game\'s own rule code'); };
  const applyAction = synthesizeApplyAction(buggyApplyActionInPlace);
  assert.doesNotThrow(() => applyAction({ value: 0 }, { type: 'X' }, {}));
  const result = applyAction({ value: 0 }, { type: 'X' }, {});
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'GAME_EXECUTION_ERROR');
  assert.equal(result.error.message, 'a real bug in this game\'s own rule code');
  assert.equal(result.state, null);
  assert.deepEqual(result.events, []);
});

test('synthesizeApplyAction still works correctly for a well-behaved applyActionInPlace, unaffected by the added try/catch', () => {
  const applyActionInPlace = (state, action) => { state.value += 1; return { state, events: [{ type: 'INCREMENTED' }] }; };
  const applyAction = synthesizeApplyAction(applyActionInPlace);
  const result = applyAction({ value: 5 }, { type: 'INC' }, {});
  assert.deepEqual(result, { state: { value: 6 }, events: [{ type: 'INCREMENTED' }] });
});

test('synthesizeApplyAction correctly passes through a real, legitimate action rejection (accepted:false), distinct from a genuine thrown exception', () => {
  const applyActionInPlace = (state) => ({ state, events: [{ type: 'ACTION_REJECTED', code: 'ILLEGAL' }], accepted: false });
  const applyAction = synthesizeApplyAction(applyActionInPlace);
  const result = applyAction({ value: 0 }, { type: 'X' }, {});
  assert.equal(result.accepted, false);
  assert.equal(result.events[0].code, 'ILLEGAL');
  assert.notEqual(result.error?.code, 'GAME_EXECUTION_ERROR', 'a normal, well-formed rejection must not be confused with a genuine thrown exception');
});

test('synthesizeApplyAction correctly finalizes real immer draft mutations, matching what a hand-written delegation via structuredClone + applyActionInPlace would produce', () => {
  const applyActionInPlace = (state, action) => { state.nested.value = action.newValue; return { state, events: [] }; };
  const applyAction = synthesizeApplyAction(applyActionInPlace);
  const initial = { nested: { value: 1, other: 'unchanged' } };
  const result = applyAction(initial, { type: 'SET', newValue: 42 }, {});
  assert.equal(result.state.nested.value, 42);
  assert.equal(result.state.nested.other, 'unchanged');
  assert.equal(initial.nested.value, 1, 'the original input state must never be mutated -- produce() must operate on its own internal draft copy');
});

test('synthesizeApplyAction correctly strips live draft references out of events (the real, found-and-fixed hazard: an event can legitimately hold a reference to a nested draft sub-object taken before mutation, which becomes an invalid revoked proxy the instant produce() finishes)', () => {
  const applyActionInPlace = (state, action) => {
    const from = state.position; // a live reference to a draft sub-object
    state.position = { x: 9, y: 9 };
    return { state, events: [{ type: 'MOVED', from, to: state.position }] };
  };
  const applyAction = synthesizeApplyAction(applyActionInPlace);
  const result = applyAction({ position: { x: 0, y: 0 } }, { type: 'MOVE' }, {});
  assert.doesNotThrow(() => JSON.stringify(result), 'reading the returned events must never throw due to a stale, revoked proxy reference');
  assert.deepEqual(result.events[0].from, { x: 0, y: 0 });
  assert.deepEqual(result.events[0].to, { x: 9, y: 9 });
});

// Regression test for a third real gap found via manual code review
// (not testing): the real draft path in runAction() (see this file's
// own module, runAction.js) rejects a game whose applyActionInPlace
// mutates the draft correctly but returns a DIFFERENT, unrelated object
// as `.state` (a classic immer mistake) as GAME_CONTRACT_VIOLATION.
// synthesizeApplyAction used to have no equivalent check at all --
// confirmed directly: the exact same buggy applyActionInPlace was
// correctly rejected via the real draft path, but silently accepted
// (using the real, correctly-mutated state regardless of what bogus
// `.state` the game itself claimed) via this synthesis.
test('synthesizeApplyAction rejects a game that mutates the draft correctly but returns a different, unrelated object as .state, matching runAction()\'s own equivalent GAME_CONTRACT_VIOLATION check', () => {
  const buggyApplyActionInPlace = (draft) => { draft.value = 999; return { state: { completely: 'unrelated' }, events: [] }; };
  const applyAction = synthesizeApplyAction(buggyApplyActionInPlace);
  const result = applyAction({ value: 0 }, { type: 'X' }, {});
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'GAME_CONTRACT_VIOLATION');
});
