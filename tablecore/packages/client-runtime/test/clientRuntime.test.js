import test from 'node:test';
import assert from 'node:assert/strict';
import { ClientRuntime } from '../src/index.js';

const sync = { type:'SYNC', protocolVersion:1, matchId:'m1', snapshot:{ version:3, state:{ activePlayer:'A', players:{ A:{hp:3}, B:{hp:2} } } } };

test('client runtime builds a presentation frame from authoritative protocol data', () => {
  const sent=[];
  const client = new ClientRuntime({ client:'pc', send:m=>sent.push(m) });
  client.connect('m1');
  assert.equal(sent[0].type, 'SYNC_REQUEST');
  client.receive(sync);
  const view=client.getView();
  assert.equal(view.frame.version, 3);
  assert.equal(view.frame.state.players.A.hp, 3);
  assert.equal(view.local.selectedObject, null);
});

test('local UI state never becomes an authoritative protocol action', () => {
  const sent=[]; const client=new ClientRuntime({ client:'mobile', send:m=>sent.push(m) });
  const intent=client.ui('UI_SELECT_OBJECT',{id:'ship-A'});
  assert.equal(intent.localOnly,true);
  assert.equal(client.getView().local.selectedObject,'ship-A');
  assert.equal(sent.length,0);
});

test('interactive clients send actions only after sync and with authoritative version', () => {
  const sent=[]; const client=new ClientRuntime({ client:'pc', send:m=>sent.push(m) });
  assert.deepEqual(client.dispatch({type:'MOVE'},'m1'),{ok:false,error:'NOT_SYNCED'});
  client.receive(sync);
  const result=client.dispatch({type:'MOVE',to:{x:1,y:0}},'m1');
  assert.equal(result.ok,true);
  assert.equal(sent[0].type,'ACTION');
  assert.equal(sent[0].expectedVersion,3);
});

test('TV runtime can present state but cannot submit game actions', () => {
  const sent=[]; const tv=new ClientRuntime({ client:'tv', send:m=>sent.push(m) });
  tv.receive(sync);
  assert.equal(tv.getView().frame.capabilities.input,false);
  assert.deepEqual(tv.dispatch({type:'MOVE'},'m1'),{ok:false,error:'CLIENT_CANNOT_ACT'});
  assert.equal(sent.length,0);
});

test('older network updates cannot roll presentation back', () => {
  const client=new ClientRuntime({client:'pc'});
  client.receive(sync);
  const stale={...sync,type:'UPDATE',snapshot:{...sync.snapshot,version:2,state:{players:{A:{hp:0}}}}};
  assert.equal(client.receive(stale).applied,false);
  assert.equal(client.getView().frame.version,3);
});
