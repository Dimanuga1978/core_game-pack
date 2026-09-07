import test from 'node:test'; import assert from 'node:assert/strict';
import { runAction } from '../src/index.js'; import { gridDuel } from '@tablecore/game-grid-duel';
test('rejects action by inactive player without mutation',()=>{const s=gridDuel.createInitialState();const before=structuredClone(s);const r=runAction({game:gridDuel,state:s,action:{type:'MOVE',actor:'B',direction:'N'}});assert.equal(r.ok,false);assert.deepEqual(s,before);});
test('moves active player and emits events',()=>{const s=gridDuel.createInitialState();const r=runAction({game:gridDuel,state:s,action:{type:'MOVE',actor:'A',direction:'E'}});assert.equal(r.ok,true);assert.deepEqual(r.state.players.A.position,{x:1,y:0});assert.equal(r.events[0].type,'PLAYER_MOVED');});

// Documents, as an explicit test rather than an implicit side effect, a
// real behavior confirmed while investigating a real external audit
// finding: an async applyActionInPlace IS effectively rejected today --
// but only because an async function returns a Promise (which has no
// `.state` property) instead of the real {state,events} object
// synchronously, tripping the SAME generic mutationResult.state contract
// check every OTHER malformed return value trips (GAME_CONTRACT_VIOLATION),
// not a dedicated "is this function async" check. A stale comment in
// runAction.js itself used to attribute this to a nonexistent
// "execution.js" file/check -- fixed alongside this test, so the real
// mechanism has a real, permanent regression test backing the claim
// instead of just a comment.
test('an async applyActionInPlace is rejected as GAME_CONTRACT_VIOLATION -- a real, if indirect, safety property worth a permanent test, not just an implicit side effect of the generic contract check', () => {
  const asyncGame = {
    getLegalActions: () => [{ type: 'X' }],
    async applyActionInPlace(state, action) { state.value = 1; return { state, events: [] }; },
  };
  const result = runAction({ game: asyncGame, state: { value: 0 }, action: { type: 'X', actor: 'A' } });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'GAME_CONTRACT_VIOLATION');
});

// Regression test for a real gap found via a manual, line-by-line
// review of this function (not found by any failing test): the
// `structuredClone(action)` call had no try/catch around it.
// structuredClone() handles circular references natively and correctly
// (confirmed directly -- this is a real, common misconception, and an
// external audit independently made the same false claim about it
// twice), but genuinely throws on functions/Symbols. Not reachable via
// this engine's own real WS transport (message.action always comes
// from JSON.parse(), which cannot represent either), but runAction() is
// itself a public, exported function any direct caller can call with a
// hand-constructed action object.
test('runAction returns a clean INVALID_ACTION result (not an uncaught exception) when action contains something structuredClone cannot handle, like a function', () => {
  const state = gridDuel.createInitialState();
  assert.doesNotThrow(() => runAction({ game: gridDuel, state, action: { type: 'MOVE', actor: 'A', direction: 'E', cb: () => {} } }));
  const result = runAction({ game: gridDuel, state, action: { type: 'MOVE', actor: 'A', direction: 'E', cb: () => {} } });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'INVALID_ACTION');
});

test('runAction correctly handles a circular reference in action -- structuredClone supports cycles natively, this must not be confused with the function/Symbol case above', () => {
  const state = gridDuel.createInitialState();
  const circularAction = { type: 'MOVE', actor: 'A', direction: 'E' };
  circularAction.self = circularAction;
  assert.doesNotThrow(() => runAction({ game: gridDuel, state, action: circularAction }));
});
