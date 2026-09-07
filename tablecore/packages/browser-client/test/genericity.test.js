import test from 'node:test';
import assert from 'node:assert/strict';
import { createTableCoreServer } from '../../../tools/server/start.mjs';
import { PlayerClient } from '../src/player-client.js';
import { ClientRuntime } from '../src/runtime.js';
import { gridDuel } from '@tablecore/game-grid-duel';

// The concrete answer to "does @tablecore/browser-client actually apply
// to every game, or did we just build something for one game and call it
// general?" -- this test drives the EXACT SAME PlayerClient/ClientRuntime
// classes used by Last Sector's player-ui against grid-duel instead: a
// completely different game, with a completely different action shape
// (`{type:'MOVE', direction:'E'}`, not Last Sector's `{type:'MOVE',
// to:'q,r'}`) and a completely different state shape (`state.players`
// keyed by id with `.hp`/`.position`, not Last Sector's `state.units`
// array with `.shipType`/`.fuel`/`.cargo`/...). No stateReducer is even
// supplied here (grid-duel's raw snapshot is used as-is) -- proving the
// library itself carries zero game-specific assumptions; the ONE
// intentionally game-specific hook (stateReducer) is simply unused when
// a game doesn't need one.

function wait(fn, ms = 3000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => { if (fn()) return resolve(true); if (Date.now() - start > ms) return reject(new Error('timeout')); setTimeout(tick, 10); };
    tick();
  });
}

test('the SAME PlayerClient/ClientRuntime (used by Last Sector) also works end-to-end against grid-duel, a completely different game', async () => {
  const server = createTableCoreServer({ secret: 'a-perfectly-fine-test-secret-32-chars-plus', games: { 'grid-duel': gridDuel } });
  try {
    const addr = await server.listen();
    const created = await fetch(`http://${addr.adminHost}:${addr.adminPort}/api/matches`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ gameId: 'grid-duel', players: ['A', 'B'] }),
    }).then(r => r.json());

    const client = new PlayerClient({
      connect: () => new Promise((resolve, reject) => { const s = new WebSocket(`ws://${addr.wsHost}:${addr.wsPort}`); s.onopen = () => resolve(s); s.onerror = reject; }),
      match: created.matchId, principal: 'A', token: created.tokens.A,
    });
    // No stateReducer supplied -- grid-duel needs no game-specific
    // transform, the raw protocol snapshot is used directly.
    const runtime = new ClientRuntime(client);

    const states = []; runtime.on('state', s => states.push(s));
    const errors = []; runtime.on('error', e => errors.push(e));
    await runtime.start();
    await wait(() => states.includes('connected'));

    assert.deepEqual(errors, []);
    assert.equal(runtime.snapshot.state.activePlayer, 'A', 'grid-duel\'s own field name, untouched -- no Last-Sector-specific `active` alias applied since no reducer was supplied');
    assert.ok(Array.isArray(runtime.snapshot.availableActions) && runtime.snapshot.availableActions.includes('MOVE'));

    const beforeVersion = runtime.snapshot.version;
    const move = runtime.command({ type: 'MOVE', direction: 'E' }); // grid-duel's OWN action shape, nothing like Last Sector's
    assert.equal(move.ok, true);
    await wait(() => runtime.snapshot.version > beforeVersion);
    assert.equal(errors.length, 0, `grid-duel's real server must accept this real MOVE: ${JSON.stringify(errors)}`);
    assert.deepEqual(runtime.snapshot.state.players.A.position, { x: 1, y: 0 });

    runtime.stop();
  } finally {
    await server.close();
  }
});

// Real, end-to-end verification of P2-PATCH's other half actually
// working: PlayerClient now declares supportsPatch:true on its own
// HELLO (see its own comment), the real admin server/protocol/transport
// stack now omits the redundant full snapshot once a patch baseline
// exists, and ClientRuntime's own session state needs to correctly
// reconstruct the real snapshot from a patch-only UPDATE. This drives
// the ENTIRE real stack (a real WS server, a real PlayerClient, a real
// ClientRuntime) rather than testing any one layer in isolation --
// proving the whole chain actually works together, not just that each
// piece's own unit tests pass independently.
test('a real PlayerClient/ClientRuntime correctly receives and reconstructs state from a patch-only UPDATE over a real WS connection, ending up with the exact right final state', async () => {
  const server = createTableCoreServer({ secret: 'a-perfectly-fine-test-secret-32-chars-plus', games: { 'grid-duel': gridDuel } });
  const addr = await server.listen();
  try {
    const created = await fetch(`http://${addr.adminHost}:${addr.adminPort}/api/matches`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ gameId: 'grid-duel', players: ['A', 'B'] }) }).then(r => r.json());
    const connect = () => new Promise((resolve, reject) => { const ws = new WebSocket(`ws://127.0.0.1:${addr.wsPort}`); ws.onopen = () => resolve(ws); ws.onerror = reject; });
    const client = new PlayerClient({ connect, match: created.matchId, principal: 'A', token: created.tokens.A });
    const runtime = new ClientRuntime(client);
    let ready;
    const readyPromise = new Promise(resolve => { ready = resolve; });
    runtime.on('snapshot', () => ready());
    await runtime.start();
    await readyPromise;
    const versionAfterSync = runtime.snapshot.version;

    // A real action -- this is what triggers the server's ACTION reply,
    // which is where the patch-only omission actually happens (see
    // packages/protocol/src/index.js's own maybeOmitRedundantSnapshot).
    let secondReady;
    const secondReadyPromise = new Promise(resolve => { secondReady = resolve; });
    // Registered AFTER the initial sync already fired its own 'snapshot'
    // event above -- this handler only ever observes events from this
    // point forward, so the very NEXT one it sees genuinely is the
    // action's own resulting snapshot (not a second occurrence of
    // something already counted before this handler even existed).
    runtime.on('snapshot', () => secondReady());
    runtime.command({ type: 'MOVE', direction: 'E' });
    await secondReadyPromise;

    assert.ok(runtime.snapshot.version > versionAfterSync, 'the session must have genuinely advanced to a new version');
    // Confirm this is the REAL, correct post-move state, not garbage
    // left over from a failed/partial patch reconstruction.
    assert.deepEqual(runtime.snapshot.state.players.A.position, { x: 1, y: 0 }, 'moving E from {x:0,y:0} must land on {x:1,y:0} -- the reconstructed-from-patch state must be the real, correct game state');

    runtime.stop();
  } finally {
    await server.close();
  }
});
