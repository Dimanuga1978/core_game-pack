import test from 'node:test'; import assert from 'node:assert/strict';
import { phaseQuest } from '../src/game.js';
import { createMatch,startMatch,dispatchMatchAction } from '@tablecore/core';

test('optional pack flow transitions from prepare to play without changing engine lifecycle',()=>{
 let match=createMatch({id:'pq',game:phaseQuest,players:['A','B']}); match=startMatch({match,game:phaseQuest}).match;
 let r=dispatchMatchAction({match,game:phaseQuest,action:{type:'READY',actor:'A'}}); assert.equal(r.ok,true); match=r.match; assert.equal(match.state.phase,'prepare');
 r=dispatchMatchAction({match,game:phaseQuest,action:{type:'READY',actor:'B'}}); assert.equal(r.ok,true); match=r.match; assert.equal(match.state.phase,'play'); assert.ok(r.events.some(e=>e.type==='PHASE_CHANGED'));
});
test('phase-restricted actions are enforced through existing legal action loop',()=>{
 let match=createMatch({id:'pq2',game:phaseQuest,players:['A','B']}); match=startMatch({match,game:phaseQuest}).match;
 const before=structuredClone(match.state); const r=dispatchMatchAction({match,game:phaseQuest,action:{type:'CLAIM',actor:'A'}});
 assert.equal(r.ok,false); assert.deepEqual(match.state,before);
});
test('phase quest finishes through normal match lifecycle',()=>{
 let match=createMatch({id:'pq3',game:phaseQuest,players:['A','B']}); match=startMatch({match,game:phaseQuest}).match;
 for(const actor of ['A','B']) match=dispatchMatchAction({match,game:phaseQuest,action:{type:'READY',actor}}).match;
 for(const actor of ['A','B','A','B','A']) match=dispatchMatchAction({match,game:phaseQuest,action:{type:'CLAIM',actor}}).match;
 assert.equal(match.status,'finished'); assert.equal(match.result.winner,'A');
});
