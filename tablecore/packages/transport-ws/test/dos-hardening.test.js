import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import crypto from 'node:crypto';
import { createTokenAuth } from '@tablecore/protocol';
import { createProtocolServer } from '@tablecore/protocol';
import { ServerHost } from '@tablecore/server';
import { gridDuel } from '@tablecore/game-grid-duel';
import { createWsServer, createWsClient } from '../src/index.js';

const wait = async (fn, ms = 1000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await new Promise(r => setTimeout(r, 10)); } return false; };

function rawUpgrade(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let buffer = '';
    let settled = false;
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');
      if (buffer.includes('\r\n\r\n') && !settled) { settled = true; resolve({ socket, head: buffer }); }
    });
    socket.on('error', err => { if (!settled) { settled = true; reject(err); } });
    socket.on('close', () => { if (!settled) { settled = true; resolve({ socket, head: buffer, closedBeforeResponse: true }); } });
    socket.on('connect', () => {
      const key = crypto.randomBytes(16).toString('base64');
      socket.write(`GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
  });
}

function setup() {
  const host = new ServerHost(); host.createMatch({ id: 'm', game: gridDuel, players: ['A', 'B'] }); host.startMatch({ matchId: 'm', actor: 'A' });
  return { host, protocol: createProtocolServer(host), auth: createTokenAuth({ secret: '01234567890123456789012345678901' }) };
}

// Regression test for the DoS gap: opening raw sockets and completing the
// (unauthenticated) WS handshake used to be unbounded, independent of
// maxClients, which only ever counted *authenticated* connections.
test('maxPendingSockets caps unauthenticated handshakes independently of maxClients', async () => {
  const { protocol, auth } = setup();
  const ws = createWsServer({ protocol, auth, resolveConnection: ({ claims }) => ({ role: claims.role, playerId: claims.playerId }), maxClients: 128, maxPendingSockets: 3 });
  const port = await ws.listen();

  const opened = [];
  try {
    for (let i = 0; i < 3; i++) opened.push(await rawUpgrade(port));
    // The first 3 should all have completed a normal 101 handshake and
    // still be open (never sent HELLO, never authenticated).
    for (const o of opened) assert.ok(/^HTTP\/1\.1 101/.test(o.head), 'first maxPendingSockets handshakes should succeed');

    // The 4th, over the pending cap, must be refused before ever reaching
    // the WS upgrade -- this used to succeed unconditionally.
    const fourth = await rawUpgrade(port);
    assert.ok(!/^HTTP\/1\.1 101/.test(fourth.head), 'handshake beyond maxPendingSockets must not succeed');
    assert.ok(/503/.test(fourth.head) || fourth.closedBeforeResponse, 'over-cap connection should be rejected (503) or dropped');
  } finally {
    for (const o of opened) { try { o.socket.destroy(); } catch {} }
    await ws.close();
  }
});

// Regression test: AUTH_TIMEOUT_MS used to be declared and never wired to
// anything -- a socket that completed the handshake and simply never sent
// HELLO stayed open forever (socket.setTimeout(0) explicitly disabled the
// generic idle timeout right after the handshake).
test('a handshake-completed socket that never sends HELLO is closed after authTimeoutMs', async () => {
  const { protocol, auth } = setup();
  const ws = createWsServer({ protocol, auth, resolveConnection: ({ claims }) => ({ role: claims.role, playerId: claims.playerId }), authTimeoutMs: 150 });
  const port = await ws.listen();

  const { socket, head } = await rawUpgrade(port);
  assert.ok(/^HTTP\/1\.1 101/.test(head), 'handshake should succeed');

  let closed = false;
  socket.on('close', () => { closed = true; });
  // Deliberately never send HELLO.
  assert.equal(await wait(() => closed, 1000), true, 'socket should be force-closed once authTimeoutMs elapses without a valid HELLO');

  await ws.close();
});

// Sanity check: a socket that DOES authenticate promptly must not be
// affected by the auth timeout (it only guards the pre-auth window).
test('authTimeoutMs does not disconnect a socket that authenticates in time', async () => {
  const { protocol, auth } = setup();
  const token = auth.issueToken({ playerId: 'A' });
  const ws = createWsServer({ protocol, auth, resolveConnection: ({ claims }) => ({ role: claims.role, playerId: claims.playerId }), authTimeoutMs: 150 });
  const port = await ws.listen();

  const client = await createWsClient({ port, hello: { type: 'HELLO', protocolVersion: 1, token } });
  await wait(() => client.messages.some(m => m.type === 'WELCOME'));
  // Wait past the (short) auth timeout window -- the connection must stay up.
  await new Promise(r => setTimeout(r, 300));
  client.send({ type: 'SYNC_REQUEST', protocolVersion: 1, matchId: 'm' });
  assert.equal(await wait(() => client.messages.some(m => m.type === 'SYNC')), true, 'authenticated connection must survive past authTimeoutMs');

  client.close();
  await ws.close();
});

