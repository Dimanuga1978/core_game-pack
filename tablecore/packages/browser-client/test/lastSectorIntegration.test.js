import test from 'node:test';
import assert from 'node:assert/strict';
import { createTableCoreServer } from '../../../tools/server/start.mjs';
import { PlayerClient } from '../src/player-client.js';
import { ClientRuntime } from '../src/runtime.js';

// last-sector is a SEPARATE, optional game pack (see this repo's own
// two-archive split: the engine ships independently of any specific
// game, and games/last-sector -- the one real, shippable game in this
// repository -- is meant to be physically dropped into a running
// engine's own games/ directory, not bundled with it). This WHOLE FILE
// is a dedicated integration test specifically FOR last-sector (it
// exists to prove the real browser client library works end-to-end
// against last-sector's own real client-state reducer, not an engine
// fixture's simpler one), so there is no meaningful partial-skip here
// -- either it's present and every test runs, or it's absent and the
// whole file gracefully skips. Both the package import AND the
// relative path into games/last-sector/client/ are tried dynamically
// (neither could be a static top-level import without breaking this
// entire file's ability to even load when the game pack isn't
// installed).
let lastSector, reduceLastSectorEvent, lastSectorUnavailableReason = null;
try {
  ({ lastSector } = await import('@tablecore/game-last-sector'));
  ({ reduceLastSectorEvent } = await import('../../../games/last-sector/client/client-state.mjs'));
} catch (error) {
  lastSectorUnavailableReason = `games/last-sector not present in this checkout (${error.code ?? error.message})`;
}
const skipIfNoLastSector = lastSectorUnavailableReason ? { skip: lastSectorUnavailableReason } : {};

// End-to-end test of the REAL browser client library (PlayerClient +
// ClientRuntime + reduceLastSectorEvent), against a REAL running server
// -- not a mock of either side. Node has a native `WebSocket` global
// (stable since Node 22, which is what this whole engine has been
// developed/tested against throughout this project), so these files,
// despite being written to be loaded by a real browser, can be exercised
// directly here with zero DOM shimming: everything they depend on
// (WebSocket, setTimeout, structuredClone/JSON fallback) is either a
// real Web/Node standard already available, or has its own fallback
// (see frame-scheduler.js's requestAnimationFrame fallback -- not
// exercised here since nothing in this test calls .schedule()).
//
// This exists specifically because player-ui/main.js's OWN DOM-
// manipulating code (document.getElementById, canvas rendering, etc.)
// genuinely cannot be tested outside a real browser -- but the actual
// RISKY, correctness-relevant logic (protocol handshake, session/version
// bookkeeping, action dispatch, reconnect) lives entirely in the three
// files this test exercises directly, which are NOT DOM-dependent at
// all. That split is deliberate.

function wait(fn, ms = 3000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (fn()) return resolve(true);
      if (Date.now() - start > ms) return reject(new Error('timeout waiting for condition'));
      setTimeout(tick, 10);
    };
    tick();
  });
}

test('real client library connects, authenticates, syncs, and dispatches a real MOVE through a real running server', skipIfNoLastSector, async () => {
  const server = createTableCoreServer({ secret: 'a-perfectly-fine-test-secret-32-chars-plus', games: { 'last-sector': lastSector } });
  try {
    const addr = await server.listen();
    const created = await fetch(`http://${addr.adminHost}:${addr.adminPort}/api/matches`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ gameId: 'last-sector', players: ['A', 'B'], options: { seed: 3 } }),
    }).then(r => r.json());

    const client = new PlayerClient({
      connect: () => new Promise((resolve, reject) => {
        const socket = new WebSocket(`ws://${addr.wsHost}:${addr.wsPort}`);
        socket.onopen = () => resolve(socket);
        socket.onerror = reject;
      }),
      match: created.matchId,
      principal: 'A',
      token: created.tokens.A,
    });
    const runtime = new ClientRuntime(client, { stateReducer: reduceLastSectorEvent });

    const states = [];
    runtime.on('state', s => states.push(s));
    const errors = [];
    runtime.on('error', e => errors.push(e));

    await runtime.start();
    await wait(() => states.includes('connected'));

    assert.deepEqual(errors, [], 'no protocol/auth errors during a normal connect+sync');
    assert.ok(runtime.snapshot, 'a reduced snapshot must be available after the first sync');
    assert.equal(runtime.snapshot.active, 'A', 'the reducer must correctly surface activePlayer as `active`');
    assert.ok(Array.isArray(runtime.snapshot.availableActions) && runtime.snapshot.availableActions.length > 0, 'the real availableActions field (added to ServerHost.getSnapshot() for exactly this) must reach the client');
    assert.ok(Array.isArray(runtime.snapshot.state.tiles) && runtime.snapshot.state.tiles.length > 0);
    assert.ok(Array.isArray(runtime.snapshot.state.units) && runtime.snapshot.state.units.length > 0);

    const beforeVersion = runtime.snapshot.version;
    const ownUnit = runtime.snapshot.state.units.find(u => u.owner === 'A');
    assert.ok(ownUnit);

    const snapshotEvents = [];
    runtime.on('snapshot', () => snapshotEvents.push(runtime.snapshot.version));
    const moveResult = runtime.command({ type: 'MOVE', to: '1,0' });
    assert.equal(moveResult.ok, true);

    await wait(() => snapshotEvents.some(v => v > beforeVersion));
    assert.equal(errors.length, 0, `MOVE must be accepted by the real server, not rejected: ${JSON.stringify(errors)}`);
    assert.equal(runtime.snapshot.version, beforeVersion + 1);

    runtime.stop();
    await wait(() => states.includes('stopped'));
  } finally {
    await server.close();
  }
});

test('PlayerClient refuses to open without a token, rather than silently connecting unauthenticated', skipIfNoLastSector, async () => {
  const client = new PlayerClient({ connect: () => Promise.reject(new Error('should never be called')), match: 'm', principal: 'A' });
  await assert.rejects(() => client.open(), /token/);
});

test('a MOVE with a stale expectedVersion is rejected by the real server, and the client surfaces the error rather than silently ignoring it', skipIfNoLastSector, async () => {
  const server = createTableCoreServer({ secret: 'a-perfectly-fine-test-secret-32-chars-plus', games: { 'last-sector': lastSector } });
  try {
    const addr = await server.listen();
    const created = await fetch(`http://${addr.adminHost}:${addr.adminPort}/api/matches`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ gameId: 'last-sector', players: ['A', 'B'] }),
    }).then(r => r.json());
    const client = new PlayerClient({
      connect: () => new Promise((resolve, reject) => { const s = new WebSocket(`ws://${addr.wsHost}:${addr.wsPort}`); s.onopen = () => resolve(s); s.onerror = reject; }),
      match: created.matchId, principal: 'A', token: created.tokens.A,
    });
    const runtime = new ClientRuntime(client, { stateReducer: reduceLastSectorEvent });
    const states = []; runtime.on('state', s => states.push(s));
    const errors = []; runtime.on('error', e => errors.push(e));
    await runtime.start();
    await wait(() => states.includes('connected'));

    // Manually corrupt the session's tracked version to simulate a stale
    // client (e.g. one that missed an update) attempting an action.
    runtime._session.snapshot.version = 999999;
    runtime.command({ type: 'MOVE', to: '1,0' });
    await wait(() => errors.length > 0);
    assert.ok(errors.length > 0);

    runtime.stop();
  } finally {
    await server.close();
  }
});

test('ClientRuntime automatically reconnects after the connection drops, and reports "resumed" rather than "connected" on the second sync', skipIfNoLastSector, async () => {
  const server = createTableCoreServer({ secret: 'a-perfectly-fine-test-secret-32-chars-plus', games: { 'last-sector': lastSector } });
  try {
    const addr = await server.listen();
    const created = await fetch(`http://${addr.adminHost}:${addr.adminPort}/api/matches`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ gameId: 'last-sector', players: ['A', 'B'] }),
    }).then(r => r.json());

    let rawSockets = [];
    const client = new PlayerClient({
      connect: () => new Promise((resolve, reject) => {
        const s = new WebSocket(`ws://${addr.wsHost}:${addr.wsPort}`);
        rawSockets.push(s);
        s.onopen = () => resolve(s);
        s.onerror = reject;
      }),
      match: created.matchId, principal: 'A', token: created.tokens.A,
    });
    const runtime = new ClientRuntime(client, { stateReducer: reduceLastSectorEvent });
    const states = []; runtime.on('state', s => states.push(s));
    await runtime.start();
    await wait(() => states.includes('connected'));

    // Simulate the connection dropping unexpectedly (network blip), NOT
    // a deliberate client.stop() -- the raw socket closes on its own.
    rawSockets[0].close();
    await wait(() => states.includes('disconnected'));
    await wait(() => states.includes('resumed'), 5000);

    assert.deepEqual(states.filter(s => s === 'connected' || s === 'resumed'), ['connected', 'resumed'], 'the SECOND successful sync after a drop must be reported as "resumed", not "connected" again');
    assert.ok(rawSockets.length >= 2, 'a genuinely new socket must have been opened for the reconnect');

    runtime.stop();
  } finally {
    await server.close();
  }
});

// The real TV-board scenario: a spectator connection (no playerId, no
// ability to act), driven by the exact same PlayerClient/ClientRuntime
// games/last-sector/tv-ui/main.js actually uses. This is what proves the
// new, working TV board (replacing a version that never loaded in a
// browser at all -- see tv-ui/main.js's own module doc comment) really
// receives live match state, not just that a player connection does.
test('a spectator (TV board) connection receives live match state and events with no ability to act', skipIfNoLastSector, async () => {
  const server = createTableCoreServer({ secret: 'a-perfectly-fine-test-secret-32-chars-plus', games: { 'last-sector': lastSector } });
  try {
    const addr = await server.listen();
    const created = await fetch(`http://${addr.adminHost}:${addr.adminPort}/api/matches`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ gameId: 'last-sector', players: ['A', 'B'], options: { seed: 4 }, spectatorPolicy: 'public' }),
    }).then(r => r.json());
    const spectatorToken = await fetch(`http://${addr.adminHost}:${addr.adminPort}/api/spectator-tokens`, { method: 'POST' }).then(r => r.json());

    const client = new PlayerClient({
      connect: () => new Promise((resolve, reject) => { const s = new WebSocket(`ws://${addr.wsHost}:${addr.wsPort}`); s.onopen = () => resolve(s); s.onerror = reject; }),
      match: created.matchId, principal: null, token: spectatorToken.token,
    });
    const runtime = new ClientRuntime(client, { stateReducer: reduceLastSectorEvent });
    const states = []; runtime.on('state', s => states.push(s));
    const errors = []; runtime.on('error', e => errors.push(e));
    await runtime.start();
    await new Promise((resolve, reject) => { const end = Date.now() + 3000; const tick = () => { if (states.includes('connected')) return resolve(); if (Date.now() > end) return reject(new Error('timeout')); setTimeout(tick, 10); }; tick(); });

    assert.deepEqual(errors, [], 'a real spectator token must connect and sync with no protocol errors');
    assert.ok(runtime.snapshot, 'the spectator must receive a real snapshot');
    assert.ok(Array.isArray(runtime.snapshot.state.tiles) && runtime.snapshot.state.tiles.length > 0, 'the spectator must see the real board');
    assert.deepEqual(runtime.snapshot.availableActions, [], 'a spectator must never have any available actions -- it cannot act, only watch');

    // Attempting to act anyway must be rejected by the real server, not
    // silently accepted -- the TV board has no action UI at all, but the
    // underlying connection-level guarantee is what actually matters.
    const commandResult = runtime.command({ type: 'END_TURN' });
    await new Promise(r => setTimeout(r, 200));
    assert.ok(errors.length > 0 || commandResult.ok === false, 'a spectator action attempt must not silently succeed');

    runtime.stop();
  } finally {
    await server.close();
  }
});
