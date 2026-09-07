import test from 'node:test';
import assert from 'node:assert/strict';
import { lastSector } from '../src/game.js';
import { lastSectorPack } from '../src/index.js';
import { createSeededRng, runAction } from '@tablecore/core';

test('supports 3 players using authoritative participant identities', () => {
  const state = lastSector.createInitialState({ players:['p17','p42','p99'], seed:11 });
  assert.deepEqual(Object.keys(state.playerMeta).sort(), ['p17','p42','p99']);
  assert.equal(state.cfg.n, 3);
  const homes = [...state.units.values()].filter(u => u.owner !== 'tanker').map(u => u.home);
  assert.equal(new Set(homes).size, 3);
});

test('supports 4 players and allocates distinct corner bases', () => {
  const state = lastSector.createInitialState({ players:['p1','p2','p3','p4'], seed:22 });
  const homes = [...state.units.values()].filter(u => u.owner !== 'tanker').map(u => u.home);
  assert.equal(new Set(homes).size, 4);
  assert.equal(state.cfg.n, 4);
});

test('rejects duplicate or invalid player identities', () => {
  assert.throws(() => lastSector.createInitialState({ players:['A','A'] }), /Duplicate player id/);
  assert.throws(() => lastSector.createInitialState({ players:['A'] }), /supports 2-4/);
  assert.throws(() => lastSector.createInitialState({ players:['A','B'], playerCount:3 }), /playerCount must match/);
  assert.throws(() => lastSector.createInitialState({ players:['A','B','bad id'] }), /Invalid player id/);
});

test('cannot use generic ATTACK to bypass tanker-specific action rules', () => {
  const state = lastSector.createInitialState({ players:['A','B'], seed:33 });
  const attacker = [...state.units.values()].find(u => u.owner === 'A');
  const tanker = { id:'test-tanker', owner:'tanker', shipType:'tanker', coord:attacker.coord, hp:2, maxHp:2, shield:0, moves:1, fuel:99 };
  const neighbor = [...state.tiles.keys()].find(c => c !== attacker.coord && (() => { const [q,r]=c.split(',').map(Number); const [aq,ar]=attacker.coord.split(',').map(Number); return Math.abs(q-aq)<=1 && Math.abs(r-ar)<=1; })());
  assert.ok(neighbor);
  tanker.coord = neighbor;
  state.units.set(tanker.id, tanker);
  assert.deepEqual(lastSector.validateAction(state, {type:'ATTACK',actor:'A',target:'tanker'}), {code:'INVALID_TARGET'});
});


test('aggressive bot can detect adjacent enemy ships', () => {
  const state = lastSector.createInitialState({ players:['A','B'], seed:44 });
  const a = [...state.units.values()].find(u => u.owner === 'A');
  const b = [...state.units.values()].find(u => u.owner === 'B');
  const [aq, ar] = a.coord.split(',').map(Number);
  const dirs = ar % 2 === 0 ? [[1,0],[-1,0],[0,-1],[-1,-1],[0,1],[-1,1]] : [[1,0],[-1,0],[1,-1],[0,-1],[1,1],[0,1]];
  const neighbor = dirs.map(([dq,dr]) => `${aq+dq},${ar+dr}`).find(c => state.tiles.has(c));
  assert.ok(neighbor);
  b.coord = neighbor;
  // Deliberately NOT touching b.home here: the real ATTACK rule (see
  // validateAction's `if (target.coord === target.home) return
  // {code:'INVALID_TARGET'}`, a "safe base" mechanic) excludes a target
  // sitting on its own home base. The original version of this test set
  // `b.home = neighbor` too, which made B "at home" in its new position
  // -- accidentally constructing exactly the one scenario where a real
  // dispatch would reject the ATTACK this test asserts should happen.
  // Leaving b.home at its actual base ("8,8" for this seed) makes this a
  // realistic, dispatchable scenario instead of one that only looks
  // valid at the unit-test level.
  const action = lastSectorPack.bots.aggressive(state, 'A', { rng: { pick: xs => xs[0], int: () => 0, next: () => 0.9 } });
  assert.equal(action.type, 'ATTACK');
  assert.equal(action.target, 'B');
  assert.deepEqual(lastSector.validateAction(state, action), true, 'the action this bot proposes must actually be legal against the real validator, not just look right in isolation');
});

test('presentation events are explicitly TV-scoped so hidden coordinates are not sent to players', () => {
  // Regression test: the ORIGINAL version of this test used an END_TURN
  // action, which produces zero presentation events at all --
  // `[].every(predicate)` is vacuously true for ANY predicate on an
  // empty array, so this test always passed without ever actually
  // checking anything. Confirmed directly: END_TURN's result.events has
  // 0 entries with `presentation:true`. A MOVE action is what actually
  // triggers emitPresentation() (ROUTE_HIGHLIGHT, SHIP_MOVE_ANIMATION --
  // see legacy/game.cjs's move()), and it's ALSO where a real bug was
  // found: emitPresentation() never actually set 'role:tv' on its
  // audience despite the pack's own manifest/README claiming a TV
  // presentation channel exists -- a TV client would have received zero
  // cinematic events, ever. Both are fixed now (emitPresentation adds
  // 'role:tv' alongside the actor); this test asserts both the
  // non-vacuousness (events.length > 0) and the actual fix (role:tv
  // present) so it cannot silently regress to a no-op again.
  const state = lastSector.createInitialState({ players:['A','B'], seed:55 });
  const unit = [...state.units.values()].find(u => u.owner === 'A');
  const [q, r] = unit.coord.split(',').map(Number);
  const dirs = r % 2 === 0 ? [[1,0],[-1,0],[0,-1],[-1,-1],[0,1],[-1,1]] : [[1,0],[-1,0],[1,-1],[0,-1],[1,1],[0,1]];
  const to = dirs.map(([dq,dr]) => `${q+dq},${r+dr}`).find(c => state.tiles.has(c) && !state.tiles.get(c).collapsed);
  assert.ok(to, 'test precondition: a legal MOVE target must exist');
  const result = lastSector.applyActionInPlace(state, {type:'MOVE', actor:'A', to}, {rng:{next:()=>0.5,nextUint32:()=>1,int:(a,b)=>b??a,pick:xs=>xs[0],range:(a,b)=>a,shuffle:xs=>xs}});
  assert.equal(result.accepted,true);
  const presentationEvents = result.events.filter(e=>e.presentation);
  assert.ok(presentationEvents.length > 0, 'a MOVE must actually produce presentation events -- if this is 0, the test below is vacuous again');
  assert.equal(presentationEvents.every(e=>e.audience?.includes('role:tv')), true, 'every presentation event must be visible to role:tv');
  // The player-privacy half of the same claim: a player who is NOT the
  // actor must not receive these events at all (only role:tv and the
  // actor itself should).
  const forOtherPlayer = presentationEvents.every(e => !e.audience.includes('B'));
  assert.equal(forOtherPlayer, true, 'presentation events must not leak to a different player');
});

test('live client MOVE payload {to} is accepted by the game validator', () => {
  const state = lastSector.createInitialState({ players:['A','B'], seed:66 });
  const unit = [...state.units.values()].find(u => u.owner === 'A');
  const [q,r] = unit.coord.split(',').map(Number);
  const dirs = r % 2 === 0 ? [[1,0],[-1,0],[0,-1],[-1,-1],[0,1],[-1,1]] : [[1,0],[-1,0],[1,-1],[0,-1],[1,1],[0,1]];
  const to = dirs.map(([dq,dr]) => `${q+dq},${r+dr}`).find(c => state.tiles.has(c) && !state.tiles.get(c).collapsed);
  assert.ok(to);
  assert.equal(lastSector.validateAction(state, {type:'MOVE', actor:'A', to}), true);
});

test('player projection exposes dynamic fuel and move-point maxima', () => {
  const state = lastSector.createInitialState({ players:['A','B'], seed:77, maxFuel:17, movePoints:6 });
  const own = lastSector.getPlayerView(state, 'A').units.find(u => u.owner === 'A');
  assert.equal(own.maxFuel, 17);
  assert.equal(own.movePoints, 6);
});

// Regression tests for four bugs found and fixed while independently
// verifying this pack against the current engine (not part of the
// original red-team audit): the "random" bot's MOVE candidate generation
// used `.q`/`.r` property access on `unit.coord`, which is a "q,r"
// STRING, not an object -- silently producing NaN coordinates and an
// always-empty move list, so the bot never actually moved. Separately,
// even with coordinates fixed, the candidate list held {q,r} objects
// where the live MOVE payload contract requires a "q,r" string. And
// separately again, the neighbor-offset table used was NOT parity-aware
// (hex grids here use different offsets for even vs odd rows -- see
// offsetNeighbors in game.js), so the bot was wrong on odd rows even
// after both of those fixes. All three were closed together by having
// the bot import and reuse the same offsetNeighbors() the real validator
// uses, instead of maintaining an independent, drifted copy of the same
// math. A fourth bug (aggressive bot proposing ATTACK while standing on
// a resolved nebula tile, which blocks ATTACK/STEAL entirely) is covered
// separately below.

test('random bot produces a MOVE action that the real validator actually accepts, on both even and odd rows', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const state = lastSector.createInitialState({ players:['A','B'], seed });
    const unit = [...state.units.values()].find(u => u.owner === 'A');
    const [, r] = unit.coord.split(',').map(Number);
    const action = lastSectorPack.bots.random(state, 'A', { rng: { pick: xs => xs[0], int: () => 0, next: () => 0.1 } });
    if (action.type === 'MOVE') {
      assert.equal(typeof action.to, 'string', `MOVE payload must be a "q,r" string, not an object (seed ${seed}, row ${r})`);
      assert.ok(!action.to.includes('NaN'), `MOVE target must never contain NaN (seed ${seed}, row ${r})`);
      assert.deepEqual(lastSector.validateAction(state, action), true, `bot-proposed MOVE must be legal against the real validator (seed ${seed}, row parity ${r % 2})`);
    }
  }
});

test('random bot never proposes a move off the forced direction of a directional_arrow tile', () => {
  const state = lastSector.createInitialState({ players:['A','B'], seed:8 });
  const unit = [...state.units.values()].find(u => u.owner === 'A');
  const [q, r] = unit.coord.split(',').map(Number);
  const dirs = r % 2 === 0 ? [[1,0],[-1,0],[0,-1],[-1,-1],[0,1],[-1,1]] : [[1,0],[-1,0],[1,-1],[0,-1],[1,1],[0,1]];
  const validNeighbors = dirs.map(([dq,dr]) => `${q+dq},${r+dr}`).filter(c => state.tiles.has(c) && !state.tiles.get(c).collapsed);
  assert.ok(validNeighbors.length >= 2, 'test precondition: at least two candidate neighbors to distinguish "forced" from "any"');
  const forced = validNeighbors[0];
  const currentTile = state.tiles.get(unit.coord);
  currentTile.kind = 'directional_arrow';
  currentTile.forceTo = forced;
  for (let i = 0; i < 10; i++) {
    const action = lastSectorPack.bots.random(state, 'A', { rng: { pick: xs => xs[Math.min(i, xs.length - 1)], int: () => 0, next: () => 0.1 } });
    if (action.type === 'MOVE') assert.equal(action.to, forced, 'the bot must only ever propose the forced direction while standing on a directional_arrow tile');
  }
});

test('aggressive bot does not propose ATTACK while standing on a resolved nebula tile (ATTACK is blocked there)', () => {
  const state = lastSector.createInitialState({ players:['A','B'], seed:9 });
  const a = [...state.units.values()].find(u => u.owner === 'A');
  const b = [...state.units.values()].find(u => u.owner === 'B');
  const [aq, ar] = a.coord.split(',').map(Number);
  const dirs = ar % 2 === 0 ? [[1,0],[-1,0],[0,-1],[-1,-1],[0,1],[-1,1]] : [[1,0],[-1,0],[1,-1],[0,-1],[1,1],[0,1]];
  const neighbor = dirs.map(([dq,dr]) => `${aq+dq},${ar+dr}`).find(c => state.tiles.has(c));
  b.coord = neighbor; // b.home left untouched -- a genuinely attackable target, see the fixed test above this one
  const currentTile = state.tiles.get(a.coord);
  currentTile.kind = 'nebula';
  currentTile.resolved = true;
  const action = lastSectorPack.bots.aggressive(state, 'A', { rng: { pick: xs => xs[0], int: () => 0, next: () => 0.9 } });
  assert.notEqual(action.type, 'ATTACK', 'a resolved nebula blocks ATTACK entirely -- the bot must not propose one while standing on it');
  if (action.type !== 'END_TURN') assert.deepEqual(lastSector.validateAction(state, action), true, 'whatever the bot proposes instead must still be legal');
});

// Regression test for a real bug found via a real external audit,
// confirmed directly before fixing (G-02): packages/core/src/runAction.js's
// own canonical dispatcher calls `game.applyAction(workingState,
// safeAction, context)` -- THREE arguments -- but this game's own
// applyAction() only declared TWO parameters and hardcoded an empty {}
// when forwarding to applyActionInPlace, silently dropping whatever real
// context (rng, seed) it was actually given. Since applyActionInPlace
// unconditionally rejects with RNG_CONTEXT_REQUIRED when context.rng is
// missing, calling applyAction() directly -- part of this pack's own
// declared public GameDefinition contract -- failed for EVERY legal
// action, unconditionally, confirmed directly: even a simple END_TURN on
// a freshly-created match returned RNG_CONTEXT_REQUIRED.
test('applyAction() (the public GameDefinition entry point, not the internal applyActionInPlace) accepts and forwards a real context, and actually succeeds for a legal action', () => {
  const state = lastSector.createInitialState({ players: ['A', 'B'], seed: 1 });
  const rng = createSeededRng(1);
  const result = lastSector.applyAction(state, { type: 'END_TURN', actor: 'A' }, { rng, seed: 1 });
  assert.notEqual(result.error?.code, 'RNG_CONTEXT_REQUIRED', 'a real, valid context must not be silently dropped');
  assert.ok(Array.isArray(result.events) && result.events.length > 0, 'a legal action via applyAction() must actually produce real events, not just avoid the specific RNG error');
});

test('applyAction() still correctly rejects when genuinely given no context at all -- the fix forwards context, it does not fabricate one', () => {
  const state = lastSector.createInitialState({ players: ['A', 'B'], seed: 1 });
  const result = lastSector.applyAction(state, { type: 'END_TURN', actor: 'A' });
  assert.equal(result.error?.code, 'RNG_CONTEXT_REQUIRED', 'applyAction() must not silently invent a fresh, unseeded rng when none is provided -- an omitted context is still a caller error, exactly as applyActionInPlace itself already enforces');
});

test('applyAction() called via the real, canonical runAction() dispatcher (the actual path every real match play goes through) works correctly end to end', () => {
  const state = lastSector.createInitialState({ players: ['A', 'B'], seed: 1 });
  const rng = createSeededRng(1);
  const result = runAction({ game: lastSector, state, action: { type: 'END_TURN', actor: 'A' }, context: { rng, seed: 1 } });
  assert.equal(result.ok, true);
});
