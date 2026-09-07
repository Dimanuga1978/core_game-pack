import test from 'node:test';
import assert from 'node:assert/strict';
import { sectorExpedition, sectorExpeditionPack } from '../src/index.js';
import { createSeededRng } from '@tablecore/core';
import { runAction } from '@tablecore/core';

function play(seed, botA, botB, maxActions=500){
  let state=sectorExpedition.createInitialState({players:['A','B'],seed});
  const rng=createSeededRng(seed);
  const bots={A:botA,B:botB}; const events=[];
  for(let i=0;i<maxActions;i++){
    if(state.phase==='finished')break;
    const actor=state.activePlayer;
    const action=bots[actor](state,actor,{rng});
    const r=runAction({game:sectorExpedition,state,action,context:{rng,seed}});
    assert.equal(r.ok,true);
    state=r.state; events.push(...r.events);
  }
  return {state,events,actions:events.length};
}

test('500 authoritative bot matches complete and remain deterministic',()=>{
  const bots=sectorExpeditionPack.bots;
  let max=0;
  for(let seed=1;seed<=500;seed++){
    const a=play(seed,bots.aggressive,bots.aggressive);
    const b=play(seed,bots.aggressive,bots.aggressive);
    assert.equal(a.state.phase,'finished',`seed ${seed} did not finish`);
    assert.equal(a.state.winner=== 'A' || a.state.winner==='B',true);
    assert.deepEqual(a.state,b.state);
    assert.deepEqual(a.events,b.events);
    max=Math.max(max,a.actions);
  }
  assert.ok(max<500);
});
