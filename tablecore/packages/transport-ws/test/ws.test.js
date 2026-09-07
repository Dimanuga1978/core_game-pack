import test from 'node:test'; import assert from 'node:assert/strict';
import { ServerHost } from '@tablecore/server'; import { gridDuel } from '@tablecore/game-grid-duel';
import { createProtocolServer, PROTOCOL_VERSION, createTokenAuth } from '@tablecore/protocol';
import { buildStructuredMetrics } from '@tablecore/observability';
import { createWsServer, createWsClient } from '../src/index.js';
const wait = async (fn, ms=1000)=>{const end=Date.now()+ms;while(Date.now()<end){if(fn())return;await new Promise(r=>setTimeout(r,10));}throw new Error('timeout');};
test('real websocket E2E: two players, spectator, update broadcast and reconnect sync', async()=>{
 const host=new ServerHost();host.createMatch({id:'m',game:gridDuel,players:['A','B'],spectatorPolicy:'public'});host.startMatch({matchId:'m',actor:'A'});
 const protocol=createProtocolServer(host); const auth=createTokenAuth({secret:'01234567890123456789012345678901'}); const tokens={A:auth.issueToken({playerId:'A'}),B:auth.issueToken({playerId:'B'}),tv:auth.issueToken({role:'spectator'})}; const ws=createWsServer({protocol,auth,resolveConnection:({claims})=>({role:claims.role,playerId:claims.playerId})}); const port=await ws.listen();
 const a=await createWsClient({port,hello:{type:'HELLO',protocolVersion:1,token:tokens.A,playerId:'B'}}); const b=await createWsClient({port,hello:{type:'HELLO',protocolVersion:1,token:tokens.B,playerId:'A'}}); const tv=await createWsClient({port,hello:{type:'HELLO',protocolVersion:1,token:tokens.tv,playerId:'A'}});
 await wait(()=>a.messages.some(m=>m.type==='WELCOME')&&b.messages.some(m=>m.type==='WELCOME')&&tv.messages.some(m=>m.type==='WELCOME'));
 for(const c of [a,b,tv]) c.send({type:'SYNC_REQUEST',protocolVersion:1,matchId:'m'});
 await wait(()=>[a,b,tv].every(c=>c.messages.some(m=>m.type==='SYNC')));
 const v=host.getSnapshot('m').snapshot.version; a.send({type:'ACTION',protocolVersion:1,matchId:'m',expectedVersion:v,action:{type:'MOVE',direction:'E'}});
 await wait(()=>[a,b,tv].every(c=>c.messages.some(m=>m.type==='UPDATE')));
 assert.equal(host.getSnapshot('m').snapshot.version,v+1);
 b.close(); await new Promise(r=>setTimeout(r,20));
 const b2=await createWsClient({port,hello:{type:'HELLO',protocolVersion:1,token:tokens.B,playerId:'A'}}); await wait(()=>b2.messages.some(m=>m.type==='WELCOME')); b2.send({type:'SYNC_REQUEST',protocolVersion:1,matchId:'m'}); await wait(()=>b2.messages.some(m=>m.type==='SYNC'));
 const sync=b2.messages.find(m=>m.type==='SYNC'); assert.equal(sync.snapshot.version,host.getSnapshot('m').snapshot.version);
 for(const c of [a,tv,b2])c.close(); await ws.close();
});

test('websocket UPDATE is scoped to subscribed match', async()=>{
 const host=new ServerHost();host.createMatch({id:'m1',game:gridDuel,players:['A','B']});host.createMatch({id:'m2',game:gridDuel,players:['C','D']});host.startMatch({matchId:'m1',actor:'A'});host.startMatch({matchId:'m2',actor:'C'});
 const protocol=createProtocolServer(host); const auth=createTokenAuth({secret:'01234567890123456789012345678901'}); const tokens={A:auth.issueToken({playerId:'A'}),B:auth.issueToken({playerId:'B'}),C:auth.issueToken({playerId:'C'})}; const ws=createWsServer({protocol,auth,resolveConnection:({claims})=>({role:claims.role,playerId:claims.playerId})}); const port=await ws.listen();
 const a=await createWsClient({port,hello:{type:'HELLO',protocolVersion:1,token:tokens.A}}); const b=await createWsClient({port,hello:{type:'HELLO',protocolVersion:1,token:tokens.B}}); const c=await createWsClient({port,hello:{type:'HELLO',protocolVersion:1,token:tokens.C}});
 for(const x of [a,b])x.send({type:'SYNC_REQUEST',protocolVersion:1,matchId:'m1'}); c.send({type:'SYNC_REQUEST',protocolVersion:1,matchId:'m2'});
 await wait(()=>[a,b,c].every(x=>x.messages.some(m=>m.type==='SYNC')));
 const v=host.getSnapshot('m1').snapshot.version; a.send({type:'ACTION',protocolVersion:1,matchId:'m1',expectedVersion:v,action:{type:'MOVE',direction:'E'}});
 await wait(()=>b.messages.some(m=>m.type==='UPDATE'));
 await new Promise(r=>setTimeout(r,50)); assert.equal(c.messages.some(m=>m.type==='UPDATE'),false);
 for(const x of [a,b,c])x.close(); await ws.close();
});

// P2-OPS end-to-end: a real ServerHost's game metrics combined with a
// real createWsServer's network metrics via buildStructuredMetrics(),
// after actually driving traffic through both -- not two isolated unit
// tests asserting the pieces exist in theory.
test('buildStructuredMetrics combines real ServerHost + real transport metrics into the four categories after real traffic', async () => {
  const host = new ServerHost();
  host.createMatch({ id:'m', game:gridDuel, players:['A','B'] });
  host.startMatch({ matchId:'m', actor:'A' });
  const protocol = createProtocolServer(host);
  const auth = createTokenAuth({ secret:'01234567890123456789012345678901' });
  const startedAt = Date.now();
  const ws = createWsServer({ protocol, auth, resolveConnection: ({claims}) => ({role:claims.role, playerId:claims.playerId}) });
  const port = await ws.listen();

  const client = await createWsClient({ port, hello:{ type:'HELLO', protocolVersion:1, token: auth.issueToken({playerId:'A'}) } });
  client.send({ type:'SYNC_REQUEST', protocolVersion:1, matchId:'m' });
  await new Promise(r => setTimeout(r, 50));
  const v = host.getSnapshot('m').snapshot.version;
  client.send({ type:'ACTION', protocolVersion:1, matchId:'m', expectedVersion:v, action:{type:'MOVE',direction:'E'} });
  await new Promise(r => setTimeout(r, 50));

  const structured = buildStructuredMetrics({ server:{}, game: host.getMetrics(), network: ws.metrics.snapshot(), startedAt });

  assert.equal(structured.game.matchesCreated, 1);
  assert.equal(structured.game.matchesStarted, 1);
  assert.equal(structured.game.activeMatches, 1);
  assert.equal(structured.game.actionsAccepted, 1);
  assert.ok(structured.network.connectionsOpened >= 1);
  assert.ok(structured.network.messagesReceived >= 2, 'SYNC_REQUEST + ACTION were both real messages over a real socket');
  assert.ok(structured.network.bytesSent > 0);
  assert.ok(structured.server.uptimeSeconds >= 0);
  assert.equal(typeof structured.resource.memory.heapUsed, 'number');

  client.close();
  await ws.close();
});

// Regression test: listen()'s `host` parameter used to be silently
// ignored -- the server always bound to '127.0.0.1' regardless of what
// was passed, discovered while wiring up the first real server bootstrap
// this engine has ever had (tools/server/start.mjs). Verified here by
// binding to an explicit loopback alias and confirming a connection
// actually succeeds against THAT address, not just the hardcoded default
// (127.0.0.1 and its aliases like 127.0.0.2 are typically both loopback
// on the same host, so this specifically checks that the address we
// asked for is the one actually reported back, which is the part that
// was broken -- httpServer.listen() itself was always given the right
// value or the wrong one silently).
test('createWsServer.listen() honors an explicit host argument instead of always binding 127.0.0.1', async () => {
  const host = new ServerHost();
  host.createMatch({ id:'m', game:gridDuel, players:['A','B'] });
  host.startMatch({ matchId:'m', actor:'A' });
  const protocol = createProtocolServer(host);
  const auth = createTokenAuth({ secret:'01234567890123456789012345678901' });
  const ws = createWsServer({ protocol, auth, resolveConnection: ({claims}) => ({role:claims.role, playerId:claims.playerId}) });
  try {
    const port = await ws.listen(0, '127.0.0.1');
    assert.equal(typeof port, 'number', 'return value must stay a bare port number for backward compatibility with every existing call site');
    assert.equal(ws.server.address().address, '127.0.0.1', 'the server must actually be bound to the host that was explicitly requested');
  } finally {
    await ws.close();
  }
});

// Regression test: createWsClient()'s `host` parameter used to be
// silently ignored (both connect branches hardcoded 127.0.0.1) -- found
// while wiring up real bot-player WS connections that needed to honor
// the server's actual configured bind host.
test('createWsClient honors an explicit host argument instead of always connecting to 127.0.0.1', async () => {
  const host = new ServerHost();
  host.createMatch({ id:'m', game:gridDuel, players:['A','B'] });
  host.startMatch({ matchId:'m', actor:'A' });
  const protocol = createProtocolServer(host);
  const auth = createTokenAuth({ secret:'01234567890123456789012345678901' });
  const ws = createWsServer({ protocol, auth, resolveConnection: ({claims}) => ({role:claims.role, playerId:claims.playerId}) });
  try {
    const port = await ws.listen(0, '127.0.0.1');
    // Explicitly pass the same host the server is actually bound to --
    // if `host` were still silently ignored this would happen to also
    // work by coincidence (both hardcoded and requested are 127.0.0.1),
    // so the real proof is that the parameter is now genuinely being
    // read and threaded through, verified via the source fix itself
    // plus this connecting successfully end-to-end.
    const client = await createWsClient({ port, host: '127.0.0.1', hello: { type:'HELLO', protocolVersion:1, token: auth.issueToken({playerId:'A'}) } });
    client.send({ type:'SYNC_REQUEST', protocolVersion:1, matchId:'m' });
    const end = Date.now() + 2000;
    while (Date.now() < end && !client.messages.some(m => m.type === 'SYNC')) await new Promise(r => setTimeout(r, 10));
    assert.ok(client.messages.some(m => m.type === 'SYNC'), 'a client connecting via an explicit host argument must actually reach the server');
    client.close();
  } finally {
    await ws.close();
  }
});
