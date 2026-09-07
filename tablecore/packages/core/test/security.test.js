import test from 'node:test';
import assert from 'node:assert/strict';
import { runAction } from '../src/index.js';

test('runAction fails closed when applyAction rejects after validation', () => {
  const game = {
    getLegalActions: () => [{ type:'TEST' }],
    validateAction: () => true,
    applyAction: () => ({ accepted:false, error:{code:'REJECTED_BY_GAME'}, state:{changed:true}, events:[] }),
    getGameStatus: () => ({finished:false})
  };
  const state = { value:1 };
  const result = runAction({game,state,action:{type:'TEST',actor:'A'}});
  assert.equal(result.ok,false);
  assert.equal(result.error.code,'REJECTED_BY_GAME');
  assert.deepEqual(state,{value:1});
});

test('runAction isolates authoritative state from game mutation on rejected execution', () => {
  const game = {
    getLegalActions: () => [{type:'TEST'}],
    applyAction: working => { working.value=99; return {accepted:false,error:{code:'NOPE'},state:working,events:[]}; },
    getGameStatus: () => ({finished:false})
  };
  const state={value:1}; const result=runAction({game,state,action:{type:'TEST',actor:'A'}});
  assert.equal(result.ok,false); assert.equal(result.error.code,'NOPE'); assert.equal(state.value,1);
});

test('runAction turns game exceptions into rejected actions', () => {
  const game={getLegalActions:()=>[{type:'TEST'}],applyAction:()=>{throw new Error('boom')},getGameStatus:()=>({finished:false})};
  const result=runAction({game,state:{},action:{type:'TEST',actor:'A'}});
  assert.equal(result.ok,false); assert.equal(result.error.code,'GAME_EXECUTION_ERROR');
});
