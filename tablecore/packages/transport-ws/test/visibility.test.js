import test from 'node:test';
import assert from 'node:assert/strict';
import { ServerHost } from '@tablecore/server';
import { createProtocolServer, createTokenAuth } from '@tablecore/protocol';
import { sectorExpedition } from '@tablecore/game-sector-expedition';
import { createWsServer, createWsClient } from '../src/index.js';
const wait=async(fn,ms=1000)=>{const end=Date.now()+ms;while(Date.now()<end){if(fn())return;await new Promise(r=>setTimeout(r,10));}throw new Error('timeout');};

test('websocket broadcasts player-scoped snapshots to different players', async()=>{
  const host=new ServerHost();host.createMatch({id:'s',game:sectorExpedition,players:['A','B'],options:{seed:123}});host.startMatch({matchId:'s',actor:'A'});
  const protocol=createProtocolServer(host);
  const auth=createTokenAuth({secret:'01234567890123456789012345678901'}); const tokens={A:auth.issueToken({playerId:'A'}),B:auth.issueToken({playerId:'B'})};
  const ws=createWsServer({protocol,auth,resolveConnection:({claims})=>({role:claims.role,playerId:claims.playerId})});
  const port=await ws.listen();
  const a=await createWsClient({port,hello:{type:'HELLO',protocolVersion:1,token:tokens.A}});
  const b=await createWsClient({port,hello:{type:'HELLO',protocolVersion:1,token:tokens.B}});
  a.send({type:'SYNC_REQUEST',protocolVersion:1,matchId:'s'});b.send({type:'SYNC_REQUEST',protocolVersion:1,matchId:'s'});
  await wait(()=>a.messages.some(m=>m.type==='SYNC')&&b.messages.some(m=>m.type==='SYNC'));
  const active=host.getAuthoritativeState('s').state.activePlayer;
  const actorClient=active==='A'?a:b;
  const v=host.getSnapshot('s',active).snapshot.version;
  const target=active==='A'?{q:1,r:0}:{q:0,r:-1};
  actorClient.send({type:'ACTION',protocolVersion:1,matchId:'s',expectedVersion:v,action:{type:'MOVE',target,actor:active}});
  await wait(()=>a.messages.some(m=>m.type==='UPDATE')&&b.messages.some(m=>m.type==='UPDATE'));
  const sender=active==='A'?a:b;
  const receiver=active==='A'?b:a;
  const senderUpdate=sender.messages.filter(m=>m.type==='UPDATE').at(-1);
  const receiverUpdate=receiver.messages.filter(m=>m.type==='UPDATE').at(-1);
  assert.deepEqual(senderUpdate.snapshot.state.players[active].position,target);
  assert.equal(receiverUpdate.snapshot.state.players[active].position,null);
  assert.equal(receiverUpdate.snapshot.state.players[active].hull,3);

  // The events channel must respect the same privacy boundary as the
  // snapshot: the mover's own client sees the full PLAYER_MOVED event...
  const senderMoveEvent=senderUpdate.events.find(e=>e.type==='PLAYER_MOVED');
  assert.ok(senderMoveEvent,'acting player should see their own PLAYER_MOVED event');
  assert.deepEqual(senderMoveEvent.to,target);
  // ...but the opponent must not receive it at all -- not redacted, not
  // present. Regression test for the previously-broadcast-to-everyone bug:
  // this event alone leaked exactly the position the snapshot deliberately
  // hides.
  assert.equal(receiverUpdate.events.find(e=>e.type==='PLAYER_MOVED'),undefined,
    'opponent must not receive the PLAYER_MOVED event: it carries the exact position/fuel getPlayerView() hides');

  a.close();b.close();await ws.close();
});

test('a scanning player\'s revealed tiles never appear in the opponent\'s event stream',async()=>{
  const host=new ServerHost();host.createMatch({id:'scan',game:sectorExpedition,players:['A','B'],options:{seed:7}});host.startMatch({matchId:'scan',actor:'A'});
  const protocol=createProtocolServer(host);
  const auth=createTokenAuth({secret:'01234567890123456789012345678901'}); const tokens={A:auth.issueToken({playerId:'A'}),B:auth.issueToken({playerId:'B'})};
  const ws=createWsServer({protocol,auth,resolveConnection:({claims})=>({role:claims.role,playerId:claims.playerId})});
  const port=await ws.listen();
  const a=await createWsClient({port,hello:{type:'HELLO',protocolVersion:1,token:tokens.A}});
  const b=await createWsClient({port,hello:{type:'HELLO',protocolVersion:1,token:tokens.B}});
  a.send({type:'SYNC_REQUEST',protocolVersion:1,matchId:'scan'});b.send({type:'SYNC_REQUEST',protocolVersion:1,matchId:'scan'});
  await wait(()=>a.messages.some(m=>m.type==='SYNC')&&b.messages.some(m=>m.type==='SYNC'));
  const active=host.getAuthoritativeState('scan').state.activePlayer;
  const actorClient=active==='A'?a:b; const other=active==='A'?b:a;
  const v=host.getSnapshot('scan',active).snapshot.version;
  actorClient.send({type:'ACTION',protocolVersion:1,matchId:'scan',expectedVersion:v,action:{type:'SCAN',actor:active}});
  await wait(()=>(active==='A'?a:b).messages.some(m=>m.type==='UPDATE')&&other.messages.some(m=>m.type==='UPDATE'));
  const otherUpdate=other.messages.filter(m=>m.type==='UPDATE').at(-1);
  assert.equal(otherUpdate.events.find(e=>e.type==='SECTOR_SCANNED'),undefined,
    'opponent must not learn which sectors were just revealed via the event stream');

  a.close();b.close();await ws.close();
});
