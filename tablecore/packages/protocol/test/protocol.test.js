import test from 'node:test'; import assert from 'node:assert/strict';
import { ServerHost } from '@tablecore/server'; import { gridDuel } from '@tablecore/game-grid-duel';
import { filterEventsForViewer, Visibility, applyPatch } from '../src/index.js';
import { createProtocolServer, ClientSession, PROTOCOL_VERSION } from '../src/index.js';
const clone = (v) => structuredClone(v);
function setup(){ const host=new ServerHost(); host.createMatch({id:'m',game:gridDuel,players:['A','B']}); host.startMatch({matchId:'m',actor:'A'}); return {host,p:createProtocolServer(host)}; }

// Regression tests: a spectator used to be allowed to SYNC_REQUEST any
// match that exists, unless the deployer remembered to set the optional
// `connection.allowedMatches` -- fail OPEN by omission. Fixed to fail
// CLOSED: a spectator needs either an explicit per-connection grant
// (allowedMatches) or the match itself declaring spectatorPolicy:'public'.
test('spectator SYNC_REQUEST is denied by default (fail closed, not fail open)',async () =>{
  const {p}=setup(); // setup()'s match has no spectatorPolicy override -> defaults to 'deny'
  const tv={role:'spectator'};
  const denied=(await p.handle({connection:tv,message:{type:'SYNC_REQUEST',protocolVersion:1,matchId:'m'}}))[0];
  assert.equal(denied.type,'ACTION_REJECTED');
  assert.equal(denied.error.code,'MATCH_ACCESS_DENIED');
});

test('spectator SYNC_REQUEST succeeds when the match explicitly declares spectatorPolicy:public',async () =>{
  const host=new ServerHost(); host.createMatch({id:'m',game:gridDuel,players:['A','B'],spectatorPolicy:'public'}); host.startMatch({matchId:'m',actor:'A'});
  const p=createProtocolServer(host);
  const tv={role:'spectator'};
  const synced=(await p.handle({connection:tv,message:{type:'SYNC_REQUEST',protocolVersion:1,matchId:'m'}}))[0];
  assert.equal(synced.type,'SYNC');
});

test('spectator SYNC_REQUEST succeeds with an explicit per-connection grant even when the match itself is not public',async () =>{
  const {p}=setup(); // still spectatorPolicy:'deny' at the match level
  const tv={role:'spectator',allowedMatches:new Set(['m'])}; // e.g. a private invite-only viewing link
  const synced=(await p.handle({connection:tv,message:{type:'SYNC_REQUEST',protocolVersion:1,matchId:'m'}}))[0];
  assert.equal(synced.type,'SYNC');
});

test('spectator SYNC_REQUEST is still denied for a DIFFERENT match than the one an explicit grant names',async () =>{
  const host=new ServerHost();
  host.createMatch({id:'m1',game:gridDuel,players:['A','B']}); host.startMatch({matchId:'m1',actor:'A'});
  host.createMatch({id:'m2',game:gridDuel,players:['C','D']}); host.startMatch({matchId:'m2',actor:'C'});
  const p=createProtocolServer(host);
  const tv={role:'spectator',allowedMatches:new Set(['m1'])};
  const denied=(await p.handle({connection:tv,message:{type:'SYNC_REQUEST',protocolVersion:1,matchId:'m2'}}))[0];
  assert.equal(denied.error.code,'MATCH_ACCESS_DENIED');
});
test('sync, action and spectator permissions work through protocol',async () =>{ const {p}=setup(); const a={role:'player',playerId:'A'}, tv={role:'spectator'}; let m=(await p.handle({connection:a,message:{type:'SYNC_REQUEST',protocolVersion:PROTOCOL_VERSION,matchId:'m'}}))[0]; assert.equal(m.type,'SYNC'); const client=new ClientSession(); client.receive(m); const update=(await p.handle({connection:a,message:client.makeAction({matchId:'m',action:{type:'MOVE',direction:'E'}})}))[0]; assert.equal(update.type,'UPDATE'); const reject=(await p.handle({connection:tv,message:{type:'ACTION',protocolVersion:1,matchId:'m',expectedVersion:2,action:{type:'MOVE',direction:'W'}}}))[0]; assert.equal(reject.error.code,'ROLE_CANNOT_ACT'); });
test('reconnect sync and out of order protection restore latest state',async () =>{ const {host,p}=setup(); const a={role:'player',playerId:'A'}; const c=new ClientSession(); const sync=(await p.handle({connection:a,message:{type:'SYNC_REQUEST',protocolVersion:1,matchId:'m'}}))[0]; c.receive(sync); const update=(await p.handle({connection:a,message:c.makeAction({matchId:'m',action:{type:'MOVE',direction:'E'}})}))[0]; c.receive(update); const old=structuredClone(sync); const latest=(await p.handle({connection:a,message:{type:'SYNC_REQUEST',protocolVersion:1,matchId:'m'}}))[0]; const r=c.receive(latest); assert.equal(r.applied,true); assert.equal(c.receive(old).reason,'STALE_UPDATE'); assert.equal(c.snapshot.version,host.getSnapshot('m').snapshot.version); });

test('player cannot sync another match and sync subscribes the connection to that match',async () =>{
  const {p}=setup();
  const a={role:'player',playerId:'A'};
  const denied=(await p.handle({connection:a,message:{type:'SYNC_REQUEST',protocolVersion:1,matchId:'missing'}}))[0];
  assert.equal(denied.error.code,'MATCH_NOT_FOUND');
  const synced=(await p.handle({connection:a,message:{type:'SYNC_REQUEST',protocolVersion:1,matchId:'m'}}))[0];
  assert.equal(synced.type,'SYNC');
  assert.equal(a.subscribedMatches.has('m'),true);
});

// filterEventsForViewer is the primitive the audience-scoping fix rests on:
// unit-test it directly rather than only via the (slower) end-to-end
// websocket scenarios in transport-ws.
test('filterEventsForViewer keeps public events for everyone, scopes private ones, and fails closed on malformed audience', async () => {
  const events = [
    { type: 'PUBLIC_NO_AUDIENCE_FIELD', value: 1 },
    { type: 'PUBLIC_EXPLICIT_NULL', audience: null, value: 2 },
    { type: 'PRIVATE_TO_A', audience: ['A'], value: 3 },
    { type: 'PRIVATE_TO_A_AND_B', audience: ['A', 'B'], value: 4 },
    { type: 'MALFORMED_AUDIENCE', audience: 'A', value: 5 },
  ];
  const forA = filterEventsForViewer(events, 'A').map(e => e.type);
  const forB = filterEventsForViewer(events, 'B').map(e => e.type);
  const forSpectator = filterEventsForViewer(events, null).map(e => e.type);

  assert.deepEqual(forA, ['PUBLIC_NO_AUDIENCE_FIELD', 'PUBLIC_EXPLICIT_NULL', 'PRIVATE_TO_A', 'PRIVATE_TO_A_AND_B']);
  assert.deepEqual(forB, ['PUBLIC_NO_AUDIENCE_FIELD', 'PUBLIC_EXPLICIT_NULL', 'PRIVATE_TO_A_AND_B']);
  // A spectator (viewerId === null) can never match an array-based
  // audience, no matter what it contains -- only truly public events.
  assert.deepEqual(forSpectator, ['PUBLIC_NO_AUDIENCE_FIELD', 'PUBLIC_EXPLICIT_NULL']);
  // A malformed (non-array, non-null) audience must never be treated as
  // public by accident -- it is dropped for every viewer, including the
  // string's own coincidental match.
  assert.ok(!forA.includes('MALFORMED_AUDIENCE') && !forB.includes('MALFORMED_AUDIENCE') && !forSpectator.includes('MALFORMED_AUDIENCE'));
});

// MIG-01 (external migration-derived review request): "no recipient may
// ever receive another recipient's already-filtered event object; every
// recipient must be independently authorized against the authoritative
// raw event set." filterEventsForViewer() itself only filters the ARRAY
// -- it does not clone the individual event objects that pass the filter
// -- so this specifically tests that calling code (protocol.handle's
// ACTION case) does not accidentally let two recipients' event lists
// share mutable object references, which could let mutating one
// recipient's own copy corrupt what another recipient later receives.
test('mutating one viewer\'s filtered event objects cannot affect another viewer\'s independently-filtered copy', () => {
  const rawEvents = [
    { type: 'PUBLIC_EVENT', payload: { count: 1 } },
    { type: 'PRIVATE_TO_A', audience: ['A'], payload: { secret: 'A-secret' } },
  ];
  const forA = filterEventsForViewer(clone(rawEvents), 'A');
  const forB = filterEventsForViewer(clone(rawEvents), 'B');
  // Mutate A's own copy of the public event's nested payload.
  forA[0].payload.count = 999;
  assert.equal(forB[0].payload.count, 1, 'B\'s independently-cloned event list must be unaffected by A\'s mutation');
});

// Documents an explicit, known boundary of the `audience` mechanism
// rather than a bug: audience scoping operates at the EVENT level (keep
// or drop a whole event for a given viewer). It does not, and cannot
// generically, redact fields NESTED inside an otherwise-public event's
// own payload. A game that embeds sensitive data inside a public event's
// payload (rather than emitting a separate, properly-scoped private
// event) is not protected by this mechanism -- the same discipline
// getPlayerView() already requires of state applies to event payloads
// too. This test exists so that boundary is asserted and visible, not
// silently assumed.
test('audience scoping does not redact fields nested inside an otherwise-public event payload (documented boundary, not a defect)', async () => {
  const carelessEvent = { type: 'PUBLIC_UPDATE', payload: { opponentHand: ['secret-card'] } }; // no audience: field -- public by the engine's rules, even though a careless game author embedded private-looking data inside it
  const forSpectator = filterEventsForViewer([carelessEvent], null);
  assert.deepEqual(forSpectator, [carelessEvent], 'the event is public (no audience set), so its full payload -- including anything a game mistakenly nested inside it -- passes through unredacted; only a correctly-scoped `audience` on the event itself protects nested data');
});

// P0-IFLOW end-to-end: Visibility.MATCH/SPECTATOR/DENY reach through the
// real protocol.handle()/buildUpdate() pipeline (matchPlayers threaded
// from the real snapshot, not a hand-built test double).
test('Visibility.MATCH/SPECTATOR/DENY policies work end-to-end through protocol.handle()', async () => {
  const host = new ServerHost();
  host.createMatch({ id:'m', game:{
    ...gridDuel,
    applyActionInPlace(state, action) {
      const r = gridDuel.applyActionInPlace(state, action);
      r.events.push({ type:'MATCH_ONLY', audience: Visibility.MATCH });
      r.events.push({ type:'SPECTATOR_ONLY', audience: Visibility.SPECTATOR });
      r.events.push({ type:'NOBODY', audience: Visibility.DENY });
      return r;
    },
  }, players:['A','B'], spectatorPolicy:'public' });
  host.startMatch({ matchId:'m', actor:'A' });
  const p = createProtocolServer(host);
  const a = { role:'player', playerId:'A' };
  const tv = { role:'spectator' };
  (await p.handle({ connection:a, message:{ type:'SYNC_REQUEST', protocolVersion:1, matchId:'m' } }));
  (await p.handle({ connection:tv, message:{ type:'SYNC_REQUEST', protocolVersion:1, matchId:'m' } }));

  const v = host.getSnapshot('m').snapshot.version;
  const reply = (await p.handle({ connection:a, message:{ type:'ACTION', protocolVersion:1, matchId:'m', expectedVersion:v, action:{ type:'MOVE', direction:'E' } } }))[0];
  const actorTypes = reply.events.map(e => e.type);
  assert.ok(actorTypes.includes('MATCH_ONLY'), 'the acting player is a match participant, must see MATCH_ONLY');
  assert.ok(!actorTypes.includes('SPECTATOR_ONLY'), 'a player must never see SPECTATOR_ONLY');
  assert.ok(!actorTypes.includes('NOBODY'), 'DENY reaches nobody, not even the actor');

  const scopedForSpectator = (await p.buildUpdate({ connection:tv, matchId:'m', previousVersion:v, events:reply._rawEvents }));
  const spectatorTypes = scopedForSpectator.events.map(e => e.type);
  assert.ok(!spectatorTypes.includes('MATCH_ONLY'), 'a spectator must never see MATCH_ONLY');
  assert.ok(spectatorTypes.includes('SPECTATOR_ONLY'), 'the spectator must see SPECTATOR_ONLY');
  assert.ok(!spectatorTypes.includes('NOBODY'));
});

// P2-PATCH: additive, backward-compatible patch delivery alongside the
// full snapshot on every UPDATE.
test('buildUpdate attaches no patch on the first UPDATE after SYNC (no baseline yet), then a patch on subsequent ones', async () => {
  const host = new ServerHost();
  host.createMatch({ id:'m', game:gridDuel, players:['A','B'] });
  host.startMatch({ matchId:'m', actor:'A' });
  const p = createProtocolServer(host);
  const a = { role:'player', playerId:'A' };
  const b = { role:'player', playerId:'B' };
  (await p.handle({ connection:a, message:{ type:'SYNC_REQUEST', protocolVersion:1, matchId:'m' } }));
  (await p.handle({ connection:b, message:{ type:'SYNC_REQUEST', protocolVersion:1, matchId:'m' } }));

  const v1 = host.getSnapshot('m').snapshot.version;
  const reply1 = (await p.handle({ connection:a, message:{ type:'ACTION', protocolVersion:1, matchId:'m', expectedVersion:v1, action:{ type:'MOVE', direction:'E' } } }))[0];
  assert.ok(Array.isArray(reply1.patch), 'a baseline was seeded by SYNC_REQUEST, so even the first ACTION reply should carry a patch');
  assert.ok(reply1.patch.length > 0);

  // Turn alternates after a MOVE -- it is now B's turn. B acting, then A
  // receiving the resulting broadcast, exercises a SECOND patch for A
  // without A needing to (illegally) act twice in a row.
  const bUpdate1 = (await p.buildUpdate({ connection:b, matchId:'m', previousVersion:v1, events:reply1._rawEvents }));
  const v2 = bUpdate1.snapshot.version;
  const reply2 = (await p.handle({ connection:b, message:{ type:'ACTION', protocolVersion:1, matchId:'m', expectedVersion:v2, action:{ type:'MOVE', direction:'W' } } }))[0];
  const aUpdate2 = (await p.buildUpdate({ connection:a, matchId:'m', previousVersion:v2, events:reply2._rawEvents }));
  assert.ok(Array.isArray(aUpdate2.patch), 'a second UPDATE for A must also carry a patch, diffed from A\'s own previous snapshot');
});

test('applying the delivered patch to the previous snapshot reconstructs the new snapshot exactly', async () => {
  const host = new ServerHost();
  host.createMatch({ id:'m', game:gridDuel, players:['A','B'] });
  host.startMatch({ matchId:'m', actor:'A' });
  const p = createProtocolServer(host);
  const a = { role:'player', playerId:'A' };
  const syncReply = (await p.handle({ connection:a, message:{ type:'SYNC_REQUEST', protocolVersion:1, matchId:'m' } }))[0];
  const v = syncReply.snapshot.version;
  const actionReply = (await p.handle({ connection:a, message:{ type:'ACTION', protocolVersion:1, matchId:'m', expectedVersion:v, action:{ type:'MOVE', direction:'E' } } }))[0];

  const reconstructed = applyPatch(syncReply.snapshot, actionReply.patch);
  assert.deepEqual(reconstructed, actionReply.snapshot, 'applying the patch to the prior snapshot must reproduce the new snapshot exactly');
});

// The critical privacy property: a patch is computed from the SAME
// already-projected, viewer-scoped snapshot a full UPDATE would carry --
// never from raw authoritative state. This proves it directly with a
// hidden-information game (state.players[id].secret, visible only to its
// owner), not just by inspecting the diffing code in isolation.
test('a patch never contains a value that the viewer\'s own projected snapshot would not also contain', async () => {
  const secretGame = {
    version: 'secret-game@1',
    createInitialState({ players = ['A','B'] } = {}) {
      return { activePlayer: players[0], phase:'playing', winner:null, players: Object.fromEntries(players.map(id => [id, { id, secret: `${id}-secret-0` }])) };
    },
    getLegalActions(state, actor) { return actor === state.activePlayer ? [{ type:'REVEAL' }] : []; },
    getGameStatus() { return { finished:false, winner:null }; },
    applyActionInPlace(state, action) {
      state.players[action.actor].secret = `${action.actor}-secret-${Date.now() % 1000}-changed`;
      state.activePlayer = state.activePlayer === 'A' ? 'B' : 'A';
      return { state, events: [] };
    },
    getPlayerView(state, viewer) {
      const s = structuredClone(state);
      for (const id of Object.keys(s.players)) if (id !== viewer) delete s.players[id].secret;
      return s;
    },
  };
  const host = new ServerHost();
  host.createMatch({ id:'m', game:secretGame, players:['A','B'] });
  host.startMatch({ matchId:'m', actor:'A' });
  const p = createProtocolServer(host);
  const a = { role:'player', playerId:'A' };
  const b = { role:'player', playerId:'B' };
  (await p.handle({ connection:a, message:{ type:'SYNC_REQUEST', protocolVersion:1, matchId:'m' } }));
  (await p.handle({ connection:b, message:{ type:'SYNC_REQUEST', protocolVersion:1, matchId:'m' } }));

  const v = host.getSnapshot('m').snapshot.version;
  const aReply = (await p.handle({ connection:a, message:{ type:'ACTION', protocolVersion:1, matchId:'m', expectedVersion:v, action:{ type:'REVEAL' } } }))[0];
  // A's own patch legitimately reflects A's own secret changing.
  assert.ok(aReply.patch.some(op => op.path.includes('/players/A/secret')));
  // B's independently-computed UPDATE (via buildUpdate, same as a real broadcast) must never carry A's secret in its patch, exactly as B's snapshot never carries it.
  const bUpdate = (await p.buildUpdate({ connection:b, matchId:'m', previousVersion:v, events:aReply._rawEvents }));
  assert.ok(!bUpdate.patch.some(op => op.path.includes('/players/A/secret')), `B's patch must never reference A's secret field: ${JSON.stringify(bUpdate.patch)}`);
  assert.equal('secret' in bUpdate.snapshot.state.players.A, false, 'sanity: the full snapshot already correctly hides it too');
});

// Regression test for a bug found and reproduced (not just described)
// while reviewing an external delta that added a hypothetical 'tv'
// connection role: the fail-closed spectator ACL used to check `role ===
// 'spectator'` literally. A NEW non-player role (e.g. 'tv', added for
// role:X audience targeting -- see visibility.js) would have fallen
// through to the weaker `else if` branch, reproducing exactly the
// fail-open bug that check exists to prevent, just for a different role
// string. Generalized to `role !== 'player'` so this can never recur for
// any future non-player role, without needing to remember to update this
// check by hand each time.
test('a non-player, non-"spectator"-named role (e.g. tv) is ALSO fail-closed by default, not just literal spectator',async () => {
  const {p}=setup();
  const tvViewer={role:'tv'};
  const denied=(await p.handle({connection:tvViewer,message:{type:'SYNC_REQUEST',protocolVersion:1,matchId:'m'}}))[0];
  assert.equal(denied.error.code,'MATCH_ACCESS_DENIED');
});

test('role:tv events reach a real tv-role connection end-to-end through protocol.handle(), not a player',async () => {
  const host = new ServerHost();
  host.createMatch({ id:'m', game:{
    ...gridDuel,
    applyActionInPlace(state, action) {
      const r = gridDuel.applyActionInPlace(state, action);
      r.events.push({ type:'CINEMATIC_EVENT', audience:['role:tv'] });
      return r;
    },
  }, players:['A','B'], spectatorPolicy:'public' });
  host.startMatch({ matchId:'m', actor:'A' });
  const p = createProtocolServer(host);
  const a = { role:'player', playerId:'A' };
  const tv = { role:'tv' };
  await p.handle({ connection:a, message:{ type:'SYNC_REQUEST', protocolVersion:1, matchId:'m' } });
  await p.handle({ connection:tv, message:{ type:'SYNC_REQUEST', protocolVersion:1, matchId:'m' } });

  const v = host.getSnapshot('m').snapshot.version;
  const reply = (await p.handle({ connection:a, message:{ type:'ACTION', protocolVersion:1, matchId:'m', expectedVersion:v, action:{ type:'MOVE', direction:'E' } } }))[0];
  assert.ok(!reply.events.some(e => e.type === 'CINEMATIC_EVENT'), 'the acting player must not receive the role:tv event');

  const tvUpdate = await p.buildUpdate({ connection:tv, matchId:'m', previousVersion:v, events:reply._rawEvents });
  assert.ok(tvUpdate.events.some(e => e.type === 'CINEMATIC_EVENT'), 'the tv-role connection must receive the role:tv event');
});

// Regression/feature tests for the OTHER half of P2-PATCH actually
// saving bytes on the wire: the diff/patch computation (diffValues,
// see patch.js) already existed and was already being attached to
// every UPDATE, but the full, redundant snapshot was ALSO always
// included regardless -- so nothing was ever actually saved. Now, a
// connection can opt in via `supportsPatch:true` on its own HELLO (see
// transport-ws's own comment on capturing this) to have the redundant
// `snapshot` field OMITTED once a real, applicable patch exists.

test('a connection WITHOUT supportsPatch keeps getting the full snapshot on every UPDATE, even once a patch also exists -- zero behavior change for an existing/unaware client', async () => {
  const { host, p } = setup();
  const a = { role: 'player', playerId: 'A' }; // no supportsPatch at all
  await p.handle({ connection: a, message: { type: 'SYNC_REQUEST', protocolVersion: 1, matchId: 'm' } });
  const v = host.getSnapshot('m').snapshot.version;
  const reply = (await p.handle({ connection: a, message: { type: 'ACTION', protocolVersion: 1, matchId: 'm', expectedVersion: v, action: { type: 'MOVE', direction: 'E' } } }))[0];
  assert.ok(reply.snapshot, 'an unaware connection must always get the full snapshot');
  assert.ok(Array.isArray(reply.patch), 'a patch is still computed and attached (harmless if unused) -- this is the pre-existing, already-tested behavior');
});

test('a connection WITH supportsPatch:true gets the full snapshot on its FIRST update (no previous snapshot to patch against yet), then gets it OMITTED once a real patch baseline exists', async () => {
  const { host, p } = setup();
  const a = { role: 'player', playerId: 'A', supportsPatch: true };
  await p.handle({ connection: a, message: { type: 'SYNC_REQUEST', protocolVersion: 1, matchId: 'm' } });
  // SYNC itself always includes the full snapshot regardless of
  // supportsPatch (it IS the baseline) -- confirmed as part of this
  // same test, not assumed.
  const syncReply = (await p.handle({ connection: a, message: { type: 'SYNC_REQUEST', protocolVersion: 1, matchId: 'm' } }))[0];
  assert.ok(syncReply.snapshot, 'SYNC must always carry the full snapshot, even for a patch-supporting connection');
  assert.equal(syncReply.patch, undefined, 'SYNC never carries a patch field at all');

  const v = host.getSnapshot('m').snapshot.version;
  const reply1 = (await p.handle({ connection: a, message: { type: 'ACTION', protocolVersion: 1, matchId: 'm', expectedVersion: v, action: { type: 'MOVE', direction: 'E' } } }))[0];
  assert.equal(reply1.snapshot, undefined, 'once a real patch baseline exists (seeded by the SYNC_REQUEST above), the redundant snapshot must be omitted for an opted-in connection');
  assert.ok(Array.isArray(reply1.patch) && reply1.patch.length > 0);

  // Reconstruct the actual new snapshot purely from the patch, proving
  // the client-side story genuinely works end-to-end, not just "the
  // server sends less data" in isolation.
  const reconstructed = applyPatch(syncReply.snapshot, reply1.patch);
  const directSnapshot = host.getSnapshot('m', 'A').snapshot;
  assert.deepEqual(reconstructed, directSnapshot, 'applying the patch to the last full snapshot must reconstruct the exact real current snapshot');
});

test('supportsPatch is per-CONNECTION, not global -- one connection opting in never affects what a different connection (even for the same match) receives', async () => {
  const { host, p } = setup();
  const a = { role: 'player', playerId: 'A', supportsPatch: true };
  const b = { role: 'player', playerId: 'B' }; // NOT opted in
  await p.handle({ connection: a, message: { type: 'SYNC_REQUEST', protocolVersion: 1, matchId: 'm' } });
  await p.handle({ connection: b, message: { type: 'SYNC_REQUEST', protocolVersion: 1, matchId: 'm' } });
  const v = host.getSnapshot('m').snapshot.version;
  await p.handle({ connection: a, message: { type: 'ACTION', protocolVersion: 1, matchId: 'm', expectedVersion: v, action: { type: 'MOVE', direction: 'E' } } });
  const bUpdate = await p.buildUpdate({ connection: b, matchId: 'm', previousVersion: v, events: [] });
  assert.ok(bUpdate.snapshot, 'B (not opted in) must still receive the full snapshot regardless of what A opted into');
});
