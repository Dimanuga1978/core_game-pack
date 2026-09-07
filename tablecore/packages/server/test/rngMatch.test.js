import test from 'node:test';
import assert from 'node:assert/strict';
import { ServerHost } from '../src/index.js';
import { sectorExpedition } from '@tablecore/game-sector-expedition';

test('live match owns deterministic RNG progression',()=>{
  const make=()=>{const h=new ServerHost();h.createMatch({id:'s',game:sectorExpedition,players:['A','B'],options:{seed:42}});h.startMatch({matchId:'s',actor:'A'});return h;};
  const a=make(),b=make();
  const ra=a.submitAction({matchId:'s',connectionPlayerId:'A',actor:'A',expectedVersion:1,action:{type:'MOVE',target:{q:1,r:0}}});
  const rb=b.submitAction({matchId:'s',connectionPlayerId:'A',actor:'A',expectedVersion:1,action:{type:'MOVE',target:{q:1,r:0}}});
  assert.equal(ra.ok,true); assert.equal(rb.ok,true);
  assert.deepEqual(ra.events,rb.events);
  assert.deepEqual(ra.snapshot.state,rb.snapshot.state);
  assert.equal(ra.snapshot.version,2);
});
