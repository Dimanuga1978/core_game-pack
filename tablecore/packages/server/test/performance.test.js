import test from 'node:test';
import assert from 'node:assert/strict';
import { ServerHost } from '../src/ServerHost.js';

test('snapshot projection is cached per viewer within a match version', () => {
  let calls = 0;
  const game = {
    createInitialState: ({ players = ['A','B'] } = {}) => ({ activePlayer: players[0], phase: 'playing', players:Object.fromEntries(players.map(id=>[id,{id}])) }),
    getLegalActions: (state, actor) => actor === state.activePlayer ? [{ type:'PASS' }] : [],
    validateAction: () => true,
    applyActionInPlace: (state, action) => { state.activePlayer = Object.keys(state.players).find(id => id !== action.actor) ?? action.actor; return {state,events:[{type:'PASS',actor:action.actor}]}; },
    getGameStatus: state => ({ finished:false, winner:null }),
    getPlayerView: (state, viewer) => { calls++; return { activePlayer: state.activePlayer, viewer }; },
  };
  const host = new ServerHost();
  assert.equal(host.createMatch({id:'m',game,players:['A','B'],options:{seed:1}}).ok,true);
  assert.equal(host.startMatch({matchId:'m',actor:'A'}).ok,true);
  assert.equal(host.getSnapshot('m','A').ok,true);
  assert.equal(host.getSnapshot('m','A').ok,true);
  assert.equal(calls,1);
  const before = host.getSnapshot('m','A').snapshot.version;
  const action = {type:'PASS',actor:'A'};
  const r=host.submitAction({matchId:'m',connectionPlayerId:'A',actor:'A',expectedVersion:before,action});
  assert.equal(r.ok,true);
  host.getSnapshot('m','A');
  assert.equal(calls,2);
});

// MIG-02 (external migration-derived review request): explicit cache-key
// separation matrix. The invariant is `cached.version === authoritative.
// match.version AND cache key includes viewer identity/capability` -- a
// cache entry must never be reused across viewer A -> viewer B, player ->
// spectator, or match A -> match B.
test('snapshot cache never reuses an entry across different viewers, roles, or matches', () => {
  let calls = 0;
  const game = {
    createInitialState: ({ players = ['A','B'] } = {}) => ({ activePlayer: players[0], phase: 'playing', players:Object.fromEntries(players.map(id=>[id,{id}])) }),
    getLegalActions: () => [],
    getGameStatus: () => ({ finished:false, winner:null }),
    getPlayerView: (state, viewer) => { calls++; return { activePlayer: state.activePlayer, viewer }; },
  };
  const host = new ServerHost();
  host.createMatch({id:'m1',game,players:['A','B'],options:{seed:1}});
  host.startMatch({matchId:'m1',actor:'A'});
  host.createMatch({id:'m2',game,players:['A','B'],options:{seed:1}});
  host.startMatch({matchId:'m2',actor:'A'});

  host.getSnapshot('m1','A'); assert.equal(calls,1);
  host.getSnapshot('m1','A'); assert.equal(calls,1, 'same viewer + same version -> cache hit');
  host.getSnapshot('m1','B'); assert.equal(calls,2, 'different viewer -> cache miss');
  host.getSnapshot('m1',null); assert.equal(calls,3, 'player vs spectator -> cache miss');
  host.getSnapshot('m2','A'); assert.equal(calls,4, 'different match -> cache miss, even for the same viewer id');
});

// MIG-02's other required case: a caller mutating the object getSnapshot()
// returned must never affect what a subsequent call (cache hit or not)
// returns.
test('mutating a returned snapshot never affects the cached value returned on a later call', () => {
  const game = {
    createInitialState: () => ({ activePlayer:'A', phase:'playing', players:{A:{id:'A',tag:'original'}} }),
    getLegalActions: () => [],
    getGameStatus: () => ({ finished:false }),
    getPlayerView: (state) => structuredClone(state),
  };
  const host = new ServerHost();
  host.createMatch({id:'m',game,players:['A'],options:{seed:1}});
  host.startMatch({matchId:'m',actor:'A'});
  const first = host.getSnapshot('m','A').snapshot;
  first.state.players.A.tag = 'MUTATED';
  const second = host.getSnapshot('m','A').snapshot; // same version -> cache hit
  assert.equal(second.state.players.A.tag, 'original', 'the cached snapshot must be unaffected by mutating a previously-returned copy');
});
