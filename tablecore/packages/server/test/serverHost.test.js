import test from 'node:test';
import assert from 'node:assert/strict';
import { ServerHost } from '../src/index.js';
import { gridDuel } from '@tablecore/game-grid-duel';

function runningHost(){ const h=new ServerHost(); assert.equal(h.createMatch({id:'m1',game:gridDuel,players:['A','B']}).ok,true); assert.equal(h.startMatch({matchId:'m1',actor:'A'}).ok,true); return h; }

test('host owns match and returns snapshot',()=>{ const h=runningHost(); const s=h.getSnapshot('m1'); assert.equal(s.ok,true); assert.equal(s.snapshot.status,'running'); assert.equal(s.snapshot.version,1); });
test('non participant cannot start or act',()=>{ const h=runningHost(); assert.equal(h.submitAction({matchId:'m1',connectionPlayerId:'X',actor:'X',expectedVersion:1,action:{type:'MOVE',direction:'E'}}).error.code,'NOT_MATCH_PARTICIPANT'); });
test('actor spoofing is rejected',()=>{ const h=runningHost(); const r=h.submitAction({matchId:'m1',connectionPlayerId:'A',actor:'B',expectedVersion:1,action:{type:'MOVE',direction:'E'}}); assert.equal(r.error.code,'ACTOR_SPOOFING'); });
test('stale version is rejected without mutation',()=>{ const h=runningHost(); const r=h.submitAction({matchId:'m1',connectionPlayerId:'A',actor:'A',expectedVersion:0,action:{type:'MOVE',direction:'E'}}); assert.equal(r.error.code,'STALE_VERSION'); assert.equal(h.getSnapshot('m1').snapshot.version,1); });
test('valid action advances authoritative state and version',()=>{ const h=runningHost(); const r=h.submitAction({matchId:'m1',connectionPlayerId:'A',actor:'A',expectedVersion:1,action:{type:'MOVE',direction:'E'}}); assert.equal(r.ok,true); assert.equal(r.version,2); assert.equal(r.snapshot.state.players.A.position.x,1); assert.equal(r.events[0].type,'PLAYER_MOVED'); });
test('invalid turn does not mutate authoritative state',()=>{ const h=runningHost(); const r=h.submitAction({matchId:'m1',connectionPlayerId:'B',actor:'B',expectedVersion:1,action:{type:'MOVE',direction:'W'}}); assert.equal(r.error.code,'ILLEGAL_ACTION'); const s=h.getSnapshot('m1').snapshot; assert.equal(s.version,1); assert.deepEqual(s.state.players.B.position,{x:4,y:4}); });
test('unknown match is rejected',()=>{ const h=new ServerHost(); assert.equal(h.getSnapshot('missing').error.code,'MATCH_NOT_FOUND'); });

// Regression/feature tests for sweepExpiredMatches -- the one genuine
// gap found in an otherwise-solid lifecycle story: before this method
// existed, NOTHING ever removed a match from ServerHost's own memory,
// finished or not. Deliberately conservative in scope (see the
// method's own doc comment for the full reasoning) -- these tests
// cover exactly what it does and does NOT remove.

test('sweepExpiredMatches removes a finished match once finishedGraceMs has passed since its last activity', () => {
  const h = runningHost();
  const r = h.submitAction({ matchId:'m1', connectionPlayerId:'A', actor:'A', expectedVersion:1, action:{type:'MOVE',direction:'E'} });
  assert.equal(r.ok, true);
  // Force the match to a real finished state via repeated legal moves
  // is unnecessarily complex for this test's own purpose -- directly
  // verify the TIME-BASED sweep logic using a match already known to
  // be 'running' first (should NOT be removed), then simulate what a
  // real finished match's bookkeeping looks like by checking the
  // documented, real fields this method actually reads.
  const entry = h.matches.get('m1');
  entry.match = { ...entry.match, status: 'finished' };
  entry.lastActivityAt = Date.now() - 40 * 60 * 1000; // 40 minutes ago
  const removed = h.sweepExpiredMatches(Date.now(), { finishedGraceMs: 30 * 60 * 1000 });
  assert.deepEqual(removed, [{ id: 'm1', reason: 'finished-expired' }]);
  assert.equal(h.matches.has('m1'), false);
  assert.equal(h.getMetrics().matchesExpired, 1);
});

test('sweepExpiredMatches does NOT remove a finished match before finishedGraceMs has passed', () => {
  const h = runningHost();
  const entry = h.matches.get('m1');
  entry.match = { ...entry.match, status: 'finished' };
  entry.lastActivityAt = Date.now() - 5 * 60 * 1000; // only 5 minutes ago
  const removed = h.sweepExpiredMatches(Date.now(), { finishedGraceMs: 30 * 60 * 1000 });
  assert.deepEqual(removed, []);
  assert.equal(h.matches.has('m1'), true);
});

test('sweepExpiredMatches also removes an aborted match past its grace period, same as finished', () => {
  const h = runningHost();
  const entry = h.matches.get('m1');
  entry.match = { ...entry.match, status: 'aborted' };
  entry.lastActivityAt = Date.now() - 40 * 60 * 1000;
  const removed = h.sweepExpiredMatches(Date.now(), { finishedGraceMs: 30 * 60 * 1000 });
  assert.deepEqual(removed, [{ id: 'm1', reason: 'finished-expired' }]);
});

test('sweepExpiredMatches removes an abandoned lobby match (created but never started) once abandonedLobbyGraceMs has passed', () => {
  const h = new ServerHost();
  h.createMatch({ id: 'lobby1', game: gridDuel, players: ['A', 'B'] }); // never started -- status stays 'lobby'
  const entry = h.matches.get('lobby1');
  entry.createdAt = Date.now() - 2 * 60 * 60 * 1000; // 2 hours ago
  const removed = h.sweepExpiredMatches(Date.now(), { abandonedLobbyGraceMs: 60 * 60 * 1000 });
  assert.deepEqual(removed, [{ id: 'lobby1', reason: 'abandoned-lobby' }]);
});

test('sweepExpiredMatches NEVER removes a running match, no matter how long it has been idle -- a genuine deployment judgment call this shared class deliberately does not make on anyone\'s behalf', () => {
  const h = runningHost(); // status: 'running'
  const entry = h.matches.get('m1');
  entry.lastActivityAt = Date.now() - 365 * 24 * 60 * 60 * 1000; // a full year idle
  const removed = h.sweepExpiredMatches(Date.now(), { finishedGraceMs: 1000, abandonedLobbyGraceMs: 1000 });
  assert.deepEqual(removed, []);
  assert.equal(h.matches.has('m1'), true);
});

test('sweepExpiredMatches is pure and deterministic -- driven entirely by the `now` parameter, needs no real wall-clock waiting to test', () => {
  const h = runningHost();
  const entry = h.matches.get('m1');
  entry.match = { ...entry.match, status: 'finished' };
  entry.lastActivityAt = 1_000_000; // an arbitrary fixed point in time
  assert.deepEqual(h.sweepExpiredMatches(1_000_000 + 10, { finishedGraceMs: 1000 }), [], 'not expired yet at +10ms with a 1000ms grace period');
  assert.deepEqual(h.sweepExpiredMatches(1_000_000 + 2000, { finishedGraceMs: 1000 }), [{ id: 'm1', reason: 'finished-expired' }], 'expired at +2000ms with a 1000ms grace period');
});

test('sweepExpiredMatches only ever removes matches that are ACTUALLY past their real grace period -- a mixed batch of expired/not-yet-expired/running matches only removes the genuinely-expired ones', () => {
  const h = new ServerHost();
  h.createMatch({ id: 'a', game: gridDuel, players: ['A', 'B'] });
  h.startMatch({ matchId: 'a', actor: 'A' });
  h.matches.get('a').match = { ...h.matches.get('a').match, status: 'finished' };
  h.matches.get('a').lastActivityAt = Date.now() - 40 * 60 * 1000; // expired

  h.createMatch({ id: 'b', game: gridDuel, players: ['A', 'B'] });
  h.startMatch({ matchId: 'b', actor: 'A' });
  h.matches.get('b').match = { ...h.matches.get('b').match, status: 'finished' };
  h.matches.get('b').lastActivityAt = Date.now(); // just finished, not expired yet

  h.createMatch({ id: 'c', game: gridDuel, players: ['A', 'B'] });
  h.startMatch({ matchId: 'c', actor: 'A' }); // still running

  const removed = h.sweepExpiredMatches(Date.now(), { finishedGraceMs: 30 * 60 * 1000 });
  assert.deepEqual(removed.map(r => r.id).sort(), ['a']);
  assert.equal(h.matches.has('a'), false);
  assert.equal(h.matches.has('b'), true);
  assert.equal(h.matches.has('c'), true);
});

// Regression tests for a real, confirmed gap found via direct testing:
// @tablecore/core's own createMatch() THROWS (a plain, synchronous
// TypeError) for invalid configuration, but nothing in ServerHost ever
// caught that throw before this. It never crashed the whole server
// process (some outer catch-all in the real admin API happened to
// prevent that), but it DID surface as a generic, unhelpful error
// instead of a clean, specific validation failure -- unlike every OTHER
// validation failure this same createMatch() method already handles.

test('ServerHost.createMatch returns a clean {ok:false, error} for an invalid match id, instead of letting the underlying TypeError propagate uncaught', () => {
  const h = new ServerHost();
  const result = h.createMatch({ id: '../../../etc/passwd', game: gridDuel, players: ['A', 'B'] });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'INVALID_MATCH_CONFIG');
  assert.match(result.error.message, /match id/i);
});

test('ServerHost.createMatch returns a clean {ok:false, error} for invalid players too, not just an invalid match id', () => {
  const h = new ServerHost();
  const result = h.createMatch({ id: 'm1', game: gridDuel, players: [] }); // createMatch() itself requires at least 1 player
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'INVALID_MATCH_CONFIG');
});
