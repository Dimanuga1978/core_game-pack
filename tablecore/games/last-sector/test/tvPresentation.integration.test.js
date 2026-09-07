import test from 'node:test';
import assert from 'node:assert/strict';
import { lastSectorPack } from '../src/index.js';
import { ServerHost } from '@tablecore/server';
import { createProtocolServer, createTokenAuth } from '@tablecore/protocol';
import { createWsServer, createWsClient } from '@tablecore/transport-ws';

const wait = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await new Promise(r => setTimeout(r, 10)); }
  return fn();
};

// End-to-end proof that the emitPresentation() role:tv fix (see
// game.js/adversarial.test.js) actually reaches a real TV client over a
// real WebSocket connection -- not just a unit-level check on the events
// array in isolation. This is also the first test anywhere in this pack
// that drives Last Sector through the real ServerHost/protocol/transport
// stack with a genuine (non-bot) player action and a genuine spectator/tv
// connection, matching how a real deployment would actually be used.
test('a real TV connection receives Last Sector presentation events over a real WebSocket, a player connection does not', async () => {
  const host = new ServerHost();
  host.createMatch({ id: 'ls-tv', game: lastSectorPack.game, players: ['A', 'B'], options: { seed: 12 }, spectatorPolicy: 'public' });
  host.startMatch({ matchId: 'ls-tv', actor: 'A' });
  const protocol = createProtocolServer(host);
  const auth = createTokenAuth({ secret: '01234567890123456789012345678901', allowedRoles: ['player', 'spectator', 'tv'] });
  const ws = createWsServer({ protocol, auth, resolveConnection: ({ claims }) => ({ role: claims.role, playerId: claims.playerId }) });
  const port = await ws.listen();

  const a = await createWsClient({ port, hello: { type: 'HELLO', protocolVersion: 1, token: auth.issueToken({ playerId: 'A' }) } });
  const b = await createWsClient({ port, hello: { type: 'HELLO', protocolVersion: 1, token: auth.issueToken({ playerId: 'B' }) } });
  const tv = await createWsClient({ port, hello: { type: 'HELLO', protocolVersion: 1, token: auth.issueToken({ role: 'tv' }) } });

  a.send({ type: 'SYNC_REQUEST', protocolVersion: 1, matchId: 'ls-tv' });
  b.send({ type: 'SYNC_REQUEST', protocolVersion: 1, matchId: 'ls-tv' });
  tv.send({ type: 'SYNC_REQUEST', protocolVersion: 1, matchId: 'ls-tv' });
  assert.equal(await wait(() => [a, b, tv].every(c => c.messages.some(m => m.type === 'SYNC'))), true);

  // Find a legal MOVE for A (mirrors adversarial.test.js's own approach).
  const snap = a.messages.find(m => m.type === 'SYNC').snapshot;
  const unit = snap.state.units.find(u => u.owner === 'A');
  const tileByCoord = new Map(snap.state.tiles.map(t => [t.coord, t]));
  const [q, r] = unit.coord.split(',').map(Number);
  const dirs = r % 2 === 0 ? [[1,0],[-1,0],[0,-1],[-1,-1],[0,1],[-1,1]] : [[1,0],[-1,0],[1,-1],[0,-1],[1,1],[0,1]];
  const to = dirs.map(([dq,dr]) => `${q+dq},${r+dr}`).find(c => tileByCoord.has(c) && !tileByCoord.get(c).collapsed);
  assert.ok(to, 'test precondition: a legal MOVE target must exist');

  a.send({ type: 'ACTION', protocolVersion: 1, matchId: 'ls-tv', expectedVersion: snap.version, action: { type: 'MOVE', actor: 'A', to } });

  assert.equal(await wait(() => tv.messages.some(m => m.type === 'UPDATE' && m.events?.some(e => e.presentation))), true, 'the TV connection must receive a real presentation event over the real transport');
  assert.equal(await wait(() => b.messages.some(m => m.type === 'UPDATE')), true);
  const bUpdate = b.messages.filter(m => m.type === 'UPDATE').at(-1);
  assert.equal((bUpdate.events || []).some(e => e.presentation), false, 'a different PLAYER connection must not receive A\'s presentation events');

  a.close(); b.close(); tv.close();
  await ws.close();
});
