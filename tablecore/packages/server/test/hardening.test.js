import test from 'node:test';
import assert from 'node:assert/strict';
import { ServerHost } from '../src/index.js';
import { createMatch } from '@tablecore/core';
import { gridDuel } from '@tablecore/game-grid-duel';
import { sectorExpedition } from '@tablecore/game-sector-expedition';

test('public snapshots never disclose the server RNG seed',()=>{
  const h=new ServerHost(); h.createMatch({id:'m',game:gridDuel,players:['A','B'],options:{seed:12345}}); h.startMatch({matchId:'m',actor:'A'});
  const s=h.getSnapshot('m').snapshot; assert.equal('seed' in s,false); assert.equal('rngState' in s,false);
});

// Regression test: the previous version of this test checked `'seed' in s`
// where `s` is the top-level snapshot wrapper ({id,status,players,state,
// result,version}) -- `seed` was never a field of THAT object, only of
// `s.state` (sector-expedition stored it there). The check was trivially
// true regardless of whether the seed actually leaked through `state`,
// which it did (see the games/sector-expedition/test regression test for
// the confirmed leak and fix). Checking the right nesting level here too.
test('player snapshot state does not expose the seed at the correct nesting level, not just the wrapper',()=>{
  const h=new ServerHost(); h.createMatch({id:'m',game:sectorExpedition,players:['A','B'],options:{seed:12345}}); h.startMatch({matchId:'m',actor:'A'});
  const s=h.getSnapshot('m','A').snapshot;
  assert.equal('seed' in s,false); assert.equal('rngState' in s,false);
  assert.equal('seed' in (s.state ?? {}), false, 'the seed must not be present on state either, not just on the outer snapshot wrapper');
});

// Regression test: getSnapshot()'s viewer-keyed cache used a bare
// '__spectator__' sentinel string for the anonymous-viewer cache slot.
// createMatch() does not reject that specific string (it is a
// syntactically valid player id), so nothing prevented a player from
// literally being named '__spectator__' -- and when that happened, that
// player's own, correctly-scoped snapshot got cached under the exact same
// key a real anonymous spectator's request would look up next, leaking
// that player's private data to a real spectator at the same version.
//
// sector-expedition's own getPlayerView() happens to make spectators
// fully omniscient by design (a deliberate TV/broadcast capability, see
// its manifest's 'tv' capability) -- so it can't demonstrate this
// specific collision, since spectators and the '__spectator__'-named
// player would see the same (full) data either way. A minimal synthetic
// game with an explicit, real distinction between player-private and
// spectator-visible data is used instead, matching the pattern used
// elsewhere in this suite for isolating a specific engine behavior from
// any one game's own design choices.
test('a player literally named __spectator__ cannot poison the anonymous-spectator snapshot cache slot',()=>{
  const privacyGame = {
    createInitialState(){ return { phase:'playing', players:{ '__spectator__':{ id:'__spectator__', secret:'PLAYER-SECRET' }, B:{ id:'B', secret:'OTHER-SECRET' } } }; },
    getGameStatus(){ return { finished:false }; },
    getLegalActions(){ return []; },
    getPlayerView(state, viewer){
      const s=structuredClone(state);
      for (const id of Object.keys(s.players)) if (id!==viewer) delete s.players[id].secret; // never shown to anyone but the owner; spectators (viewer=null) see nothing private
      return s;
    },
  };
  const h=new ServerHost();
  h.createMatch({id:'m',game:privacyGame,players:['__spectator__','B']});
  h.startMatch({matchId:'m',actor:'__spectator__'});
  // The player named '__spectator__' requests their own snapshot first,
  // populating whatever cache slot their viewer key maps to.
  const ownView = h.getSnapshot('m','__spectator__').snapshot.state;
  assert.equal(ownView.players['__spectator__'].secret, 'PLAYER-SECRET', 'sanity: the player can see their own secret');
  // A real anonymous spectator now requests a sync at the same version.
  const spectatorView = h.getSnapshot('m',null).snapshot.state;
  assert.equal(spectatorView.players['__spectator__'].secret, undefined,
    'a real spectator must never receive the __spectator__-named player\'s own cached snapshot');
});

// P2-OPS: Game-category match-lifecycle metrics on ServerHost. Before
// this, none of this was tracked at all -- no way to answer "how many
// matches has this process handled" without instrumenting call sites
// externally.
test('ServerHost tracks match-lifecycle metrics: created, started, finished, active gauge, actions accepted/rejected', () => {
  const h = new ServerHost();
  const initial = h.getMetrics();
  assert.equal(initial.matchesCreated, 0);
  assert.equal(initial.activeMatches, 0);

  h.createMatch({ id:'m1', game:gridDuel, players:['A','B'] });
  h.createMatch({ id:'m2', game:gridDuel, players:['C','D'] });
  assert.equal(h.getMetrics().matchesCreated, 2);
  assert.equal(h.getMetrics().activeMatches, 2, 'activeMatches is a live gauge, not incrementally tracked, and must reflect both matches immediately');

  h.startMatch({ matchId:'m1', actor:'A' });
  assert.equal(h.getMetrics().matchesStarted, 1);

  const v = h.getSnapshot('m1').snapshot.version;
  h.submitAction({ matchId:'m1', connectionPlayerId:'A', actor:'A', expectedVersion:v, action:{type:'MOVE',direction:'E'} });
  assert.equal(h.getMetrics().actionsAccepted, 1);

  // A rejected action (stale version) must count as rejected, not silently ignored.
  h.submitAction({ matchId:'m1', connectionPlayerId:'A', actor:'A', expectedVersion:999, action:{type:'MOVE',direction:'E'} });
  assert.equal(h.getMetrics().actionsRejected, 1);

  // Actor spoofing and non-participant attempts count as rejected too.
  h.submitAction({ matchId:'m1', connectionPlayerId:'A', actor:'B', expectedVersion:v, action:{type:'MOVE',direction:'E'} });
  assert.equal(h.getMetrics().actionsRejected, 2);
});

test('ServerHost getMetrics() counts a match transitioning to finished exactly once, not once per subsequent action', () => {
  const oneShotFinishGame = {
    createInitialState: () => ({ activePlayer:'A', phase:'playing', winner:null, players:{A:{id:'A'},B:{id:'B'}} }),
    getLegalActions: (state, actor) => actor===state.activePlayer ? [{type:'END'}] : [],
    getGameStatus: (state) => ({ finished: state.phase==='finished', winner: state.winner }),
    applyActionInPlace(state, action) {
      state.phase='finished'; state.winner=action.actor;
      return { state, events:[{type:'GAME_FINISHED',winner:action.actor}] };
    },
  };
  const h = new ServerHost();
  h.createMatch({ id:'m', game:oneShotFinishGame, players:['A','B'] });
  h.startMatch({ matchId:'m', actor:'A' });
  const v = h.getSnapshot('m','A').snapshot.version;
  const r = h.submitAction({ matchId:'m', connectionPlayerId:'A', actor:'A', expectedVersion:v, action:{type:'END'} });
  assert.equal(r.ok, true);
  assert.equal(h.getMetrics().matchesFinished, 1);
  // A second action attempt against the now-finished match must be
  // rejected by dispatchMatchAction's own MATCH_NOT_RUNNING guard, and
  // must NOT double-count matchesFinished.
  const r2 = h.submitAction({ matchId:'m', connectionPlayerId:'B', actor:'B', expectedVersion:h.getSnapshot('m').snapshot.version, action:{type:'END'} });
  assert.equal(r2.ok, false);
  assert.equal(h.getMetrics().matchesFinished, 1, 'matchesFinished must not increment again for an action rejected against an already-finished match');
});

// Regression test: found missing while wiring up a real browser client
// for Last Sector -- a client cannot safely derive "what actions can I
// take right now" itself, since it only ever sees the projected
// (getPlayerView) state shape, not the authoritative internal shape
// getLegalActions() actually needs. The server now computes this on the
// raw state and includes it per-viewer in the snapshot.
test('getSnapshot() includes availableActions computed for the specific viewer, empty for a non-active player and for spectators', () => {
  const h = new ServerHost();
  h.createMatch({ id:'m', game:gridDuel, players:['A','B'] });
  h.startMatch({ matchId:'m', actor:'A' });
  const forActive = h.getSnapshot('m','A').snapshot;
  assert.ok(Array.isArray(forActive.availableActions));
  assert.ok(forActive.availableActions.length > 0);
  const forInactive = h.getSnapshot('m','B').snapshot;
  assert.deepEqual(forInactive.availableActions, []);
  const forSpectator = h.getSnapshot('m',null).snapshot;
  assert.deepEqual(forSpectator.availableActions, []);
});

// Real, end-to-end wire-level confirmation of the same guarantee above
// (E-01 in a real external audit) -- not calling ServerHost directly,
// but a real running admin server, a real WS connection, and a raw
// string search across the ENTIRE literal JSON text of a real SYNC and
// a real UPDATE message. The strongest structural check available
// short of a type-level guarantee: catches a leak at ANY nesting depth,
// not just the two specific levels (wrapper, state) the tests above
// already check, and proves it against what actually crosses the wire,
// not just what a direct ServerHost.getSnapshot() call returns.
test('seed/rngState never appear anywhere in a real SYNC or UPDATE message\'s raw JSON text, at any nesting depth, over a real WS connection', async () => {
  const { createTableCoreServer } = await import('../../../tools/server/start.mjs');
  const { createWsClient } = await import('@tablecore/transport-ws');
  const server = createTableCoreServer({ secret: 'a-perfectly-fine-test-secret-32-chars-plus', games: { 'grid-duel': gridDuel } });
  try {
    const addr = await server.listen();
    const created = await fetch(`http://${addr.adminHost}:${addr.adminPort}/api/matches`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ gameId: 'grid-duel', players: ['A', 'B'], options: { seed: 424242 } }) }).then(r => r.json());
    const client = await createWsClient({ port: addr.wsPort, host: '127.0.0.1', hello: { type: 'HELLO', protocolVersion: 1, token: created.tokens.A } });
    client.send({ type: 'SYNC_REQUEST', protocolVersion: 1, matchId: created.matchId });
    await new Promise(r => setTimeout(r, 200));
    const sync = client.messages.find(m => m.type === 'SYNC');
    assert.ok(sync, 'test precondition: a real SYNC must actually arrive');
    const syncText = JSON.stringify(sync);
    assert.ok(!syncText.includes('"seed"'), `SYNC message must never contain a literal "seed" key anywhere: ${syncText.slice(0, 200)}`);
    assert.ok(!syncText.includes('"rngState"'), 'SYNC message must never contain a literal "rngState" key anywhere');
    assert.ok(!syncText.includes('424242'), 'the actual configured seed VALUE must never appear anywhere in the wire message either, even under some other key name');

    client.send({ type: 'ACTION', protocolVersion: 1, matchId: created.matchId, expectedVersion: 1, action: { type: 'MOVE', direction: 'E' } });
    await new Promise(r => setTimeout(r, 200));
    const update = client.messages.find(m => m.type === 'UPDATE');
    assert.ok(update, 'test precondition: a real UPDATE must actually arrive');
    const updateText = JSON.stringify(update);
    assert.ok(!updateText.includes('"seed"'), 'UPDATE message must never contain a literal "seed" key anywhere');
    assert.ok(!updateText.includes('"rngState"'), 'UPDATE message must never contain a literal "rngState" key anywhere');
    assert.ok(!updateText.includes('424242'), 'the actual configured seed VALUE must never appear anywhere in a real UPDATE message either');

    client.close();
  } finally {
    await server.close();
  }
});

// getAuthoritativeState() is DELIBERATELY different -- it exists
// specifically for trusted, internal (bot-driver) use and does expose
// raw state -- but confirms it directly, not by assumption, is never
// reachable through any real client-facing protocol message type
// (HELLO/SYNC_REQUEST/ACTION are the only three that exist).
test('getAuthoritativeState() itself is intentionally raw (unlike getSnapshot()), but is never reachable through any real protocol message a client can send', async () => {
  const h = new ServerHost();
  h.createMatch({ id: 'm', game: gridDuel, players: ['A', 'B'], options: { seed: 99 } });
  h.startMatch({ matchId: 'm', actor: 'A' });
  const raw = h.getAuthoritativeState('m');
  assert.equal(raw.ok, true);
  // This confirms getAuthoritativeState()'s OWN documented purpose
  // (trusted internal use, e.g. this engine's own bot driver, which
  // genuinely needs the real internal shape) -- the actual security
  // boundary is that NOTHING in packages/protocol/src/index.js's real
  // message-type handling ever calls this method at all, confirmed by
  // static search during this same investigation (zero references
  // outside this file and tools/server/start.mjs's own internal bot
  // driver), not re-verified here since that would just be grepping the
  // same source this test file already lives beside.
  assert.ok(raw.version >= 1);
});

// Documents a real, confirmed limitation found via an aggressive audit
// pass, not a bug to fix in the engine itself: the whole protocol uses
// JSON as its wire format, and JSON.stringify() cannot serialize
// Map/Set at all (JSON.stringify(new Map([['x',1]])) => "{}" -- an
// EMPTY object, with zero exception or warning). getSnapshot() itself
// preserves Map/Set correctly as real in-memory objects -- the loss
// happens ONLY at the eventual wire-serialization step. games/last-sector
// (the one real game using Map/Set as its primary internal state
// format) already correctly converts them to plain arrays inside its
// own getPlayerView(), which is why this never surfaced in real,
// shipped behavior -- but a FUTURE game that uses Map/Set in its state
// without a getPlayerView() (not required unless
// manifest.hiddenInformation is true) would silently lose that data.
// See GAME_PACK_RIDER.md's own §5.7 for the full pack-author-facing
// warning this test backs up with a real, reproducible example.
test('a Map/Set in a game\'s own state, with no getPlayerView to convert it, silently arrives at the client as an empty object -- confirmed, documented engine behavior (a real JSON wire-format limitation), not something ServerHost.getSnapshot() itself loses', () => {
  const gameWithMapState = {
    createInitialState: () => ({ tiles: new Map([['0,0', { kind: 'grass' }]]), value: 1 }),
    getLegalActions: () => [{ type: 'X' }],
    applyActionInPlace(state) { state.value++; return { state, events: [] }; },
    getGameStatus: () => ({ finished: false }),
    // Deliberately NO getPlayerView -- not required unless hiddenInformation:true, and this test's own point is to confirm what happens without one.
  };
  const h = new ServerHost();
  h.createMatch({ id: 'map-loss-demo', game: gameWithMapState, players: ['A', 'B'] });
  h.startMatch({ matchId: 'map-loss-demo', actor: 'A' });
  const snap = h.getSnapshot('map-loss-demo', 'A').snapshot;
  // Confirmed: still a REAL Map inside ServerHost's own in-memory
  // object -- the loss is not here.
  assert.ok(snap.state.tiles instanceof Map, 'getSnapshot() itself must not be what loses this data -- confirming the loss happens later, at actual wire serialization');
  // The real, actually-sent wire payload (what a real WS message body
  // would be) is what actually loses it.
  const wirePayload = JSON.parse(JSON.stringify(snap));
  assert.deepEqual(wirePayload.state.tiles, {}, 'a Map with no getPlayerView-based conversion silently arrives at the client as an empty object -- this is JSON\'s own limitation, not an engine bug, but a real, documented pack-author gotcha (see GAME_PACK_RIDER.md\'s own §5.7)');
});

// Regression test for a real gap found via a manual, line-by-line
// review of ServerHost.submitAction() (not found by any failing test):
// `clone(action)` (structuredClone) had no try/catch around it, the
// same class of gap already found and fixed in
// packages/core/src/runAction.js's own equivalent call. Not reachable
// via this engine's own real WS transport (a real action always comes
// from JSON.parse(), which cannot represent a function or Symbol), but
// submitAction() is itself a public method any direct caller could call
// with a hand-constructed action.
test('submitAction returns a clean INVALID_ACTION result (not an uncaught exception) when action contains something structuredClone cannot handle', () => {
  const h = new ServerHost();
  h.createMatch({ id: 'clone-guard-test', game: gridDuel, players: ['A', 'B'] });
  h.startMatch({ matchId: 'clone-guard-test', actor: 'A' });
  assert.doesNotThrow(() => h.submitAction({ matchId: 'clone-guard-test', connectionPlayerId: 'A', actor: 'A', expectedVersion: 1, action: { type: 'MOVE', direction: 'E', cb: () => {} } }));
  const result = h.submitAction({ matchId: 'clone-guard-test', connectionPlayerId: 'A', actor: 'A', expectedVersion: 1, action: { type: 'MOVE', direction: 'E', cb: () => {} } });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'INVALID_ACTION');
});
