import test from 'node:test';
import assert from 'node:assert/strict';
import { MatchWorkerPool } from '../src/index.js';
import { createProtocolServer, createTokenAuth } from '@tablecore/protocol';
import { createWsServer, createWsClient } from '@tablecore/transport-ws';

const GRID_DUEL_URL = new URL('../../../games/grid-duel/src/index.js', import.meta.url).href;

const wait = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await new Promise(r => setTimeout(r, 10)); }
  return fn();
};

// This is the actual point of making packages/protocol's createProtocolServer
// and packages/transport-ws's message loop async-aware: MatchWorkerPool's
// methods (createMatch/startMatch/getSnapshot/submitAction) have exactly
// the same shapes as ServerHost's, but return Promises (real RPC round
// trips to a worker thread) instead of plain values. Before this, only a
// SYNCHRONOUS host could be plugged into createProtocolServer() -- the
// worker-pool's crash/resource isolation (see MatchWorkerPool.test.js)
// was real and tested in isolation, but not reachable through the actual
// network-facing stack a real deployment would use. This test drives a
// MatchWorkerPool through a REAL WebSocket connection, end to end -- not
// calling pool methods directly, and not a mock protocol/transport.
test('MatchWorkerPool works as a host through the real protocol + WebSocket transport, end to end', async () => {
  const pool = new MatchWorkerPool({ poolSize: 2 });
  try {
    const created = await pool.createMatch({ id: 'm', gameModuleUrl: GRID_DUEL_URL, gameExportName: 'gridDuel', players: ['A', 'B'], spectatorPolicy: 'public' });
    assert.equal(created.ok, true);
    await pool.startMatch({ matchId: 'm', actor: 'A' });

    const protocol = createProtocolServer(pool); // <-- the point: an async host, wired into the same protocol layer ServerHost uses
    const auth = createTokenAuth({ secret: '01234567890123456789012345678901' });
    const ws = createWsServer({ protocol, auth, resolveConnection: ({ claims }) => ({ role: claims.role, playerId: claims.playerId }) });
    const port = await ws.listen();

    const a = await createWsClient({ port, hello: { type: 'HELLO', protocolVersion: 1, token: auth.issueToken({ playerId: 'A' }) } });
    const spectator = await createWsClient({ port, hello: { type: 'HELLO', protocolVersion: 1, token: auth.issueToken({ role: 'spectator' }) } });

    a.send({ type: 'SYNC_REQUEST', protocolVersion: 1, matchId: 'm' });
    spectator.send({ type: 'SYNC_REQUEST', protocolVersion: 1, matchId: 'm' });
    assert.equal(await wait(() => a.messages.some(m => m.type === 'SYNC') && spectator.messages.some(m => m.type === 'SYNC')), true);

    const v = a.messages.find(m => m.type === 'SYNC').snapshot.version;
    a.send({ type: 'ACTION', protocolVersion: 1, matchId: 'm', expectedVersion: v, action: { type: 'MOVE', direction: 'E' } });

    assert.equal(await wait(() => a.messages.some(m => m.type === 'UPDATE')), true, 'the acting client must receive a real UPDATE, round-tripped through an actual worker thread');
    const actorUpdate = a.messages.find(m => m.type === 'UPDATE');
    assert.deepEqual(actorUpdate.snapshot.state.players.A.position, { x: 1, y: 0 });

    assert.equal(await wait(() => spectator.messages.some(m => m.type === 'UPDATE')), true, 'a real broadcast to a DIFFERENT real connection, also served by the worker pool');

    a.close(); spectator.close();
    await ws.close();
  } finally {
    await pool.close();
  }
});

// The other half of what making this async required: processBuffer()'s
// reentrancy guard (packages/transport-ws/src/index.js). Sending two
// ACTIONs back to back, faster than the (real, async, RPC-latency-bearing)
// host can respond to the first one, must still process them in the
// order they were sent -- not race, not get silently dropped, not answer
// out of order.
test('two ACTIONs sent back-to-back over the same connection are processed in order even against a slow async host', async () => {
  const pool = new MatchWorkerPool({ poolSize: 1 });
  try {
    await pool.createMatch({ id: 'm', gameModuleUrl: GRID_DUEL_URL, gameExportName: 'gridDuel', players: ['A', 'B'] });
    await pool.startMatch({ matchId: 'm', actor: 'A' });
    const protocol = createProtocolServer(pool);
    const auth = createTokenAuth({ secret: '01234567890123456789012345678901' });
    const ws = createWsServer({ protocol, auth, resolveConnection: ({ claims }) => ({ role: claims.role, playerId: claims.playerId }) });
    const port = await ws.listen();

    const a = await createWsClient({ port, hello: { type: 'HELLO', protocolVersion: 1, token: auth.issueToken({ playerId: 'A' }) } });
    const b = await createWsClient({ port, hello: { type: 'HELLO', protocolVersion: 1, token: auth.issueToken({ playerId: 'B' }) } });
    a.send({ type: 'SYNC_REQUEST', protocolVersion: 1, matchId: 'm' });
    b.send({ type: 'SYNC_REQUEST', protocolVersion: 1, matchId: 'm' });
    await wait(() => a.messages.some(m => m.type === 'SYNC') && b.messages.some(m => m.type === 'SYNC'));

    // Turn order alternates A -> B -> A. A sends its ACTION, then
    // IMMEDIATELY (without waiting for a reply) sends a SYNC_REQUEST --
    // exercising two back-to-back messages on the same socket while the
    // first is still an in-flight async RPC to the worker.
    const v = a.messages.find(m => m.type === 'SYNC').snapshot.version;
    a.send({ type: 'ACTION', protocolVersion: 1, matchId: 'm', expectedVersion: v, action: { type: 'MOVE', direction: 'E' } });
    a.send({ type: 'SYNC_REQUEST', protocolVersion: 1, matchId: 'm' });

    assert.equal(await wait(() => a.messages.filter(m => m.type === 'UPDATE').length >= 1 && a.messages.filter(m => m.type === 'SYNC').length >= 2), true);
    const update = a.messages.find(m => m.type === 'UPDATE');
    const secondSync = a.messages.filter(m => m.type === 'SYNC')[1];
    // The SYNC_REQUEST was sent AFTER the ACTION, so processed in order it
    // must reflect the post-move state, not a stale pre-move snapshot.
    assert.equal(secondSync.snapshot.version, update.snapshot.version);
    assert.deepEqual(secondSync.snapshot.state.players.A.position, { x: 1, y: 0 });

    a.close(); b.close();
    await ws.close();
  } finally {
    await pool.close();
  }
});
