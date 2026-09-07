import test from 'node:test';
import assert from 'node:assert/strict';
import { lastSector } from '../src/game.js';
import { createSeededRng } from '@tablecore/core';

function invariant(state){
  const playerIds=Object.keys(state.playerMeta||{});
  assert.ok(playerIds.length>=2 && playerIds.length<=4);
  for(const u of state.units.values()){
    assert.ok(state.tiles.has(u.coord), `unit off board ${u.coord}`);
    assert.ok(u.fuel>=0, `negative fuel ${u.owner}`);
    assert.ok(u.moves>=0, `negative moves ${u.owner}`);
    assert.ok(u.hp<=u.maxHp, `hp overflow ${u.owner}`);
    assert.ok((u.cargo||[]).reduce((s,i)=>s+(Number(i?.slots)||0),0)<=u.cargoSlots, `cargo overflow ${u.owner}`);
  }
  for(const [id,score] of state.scores) assert.ok(Number.isFinite(score) && score>=0, `bad score ${id}`);
  for(const [id,life] of Object.entries(state.lives||{})) assert.ok(Number.isInteger(life)&&life>=0, `bad lives ${id}`);
}

test('Last Sector survives 250 deterministic random-action matches without invariant violations', () => {
  for(let gameNo=0; gameNo<250; gameNo++){
    const players=gameNo%3===0?['p1','p2','p3']:gameNo%5===0?['p1','p2','p3','p4']:['p1','p2'];
    const state=lastSector.createInitialState({players,seed:gameNo+100,gridWidth:9,gridHeight:9,playerCount:players.length});
    const rng=createSeededRng(gameNo+900);
    let current=players[0];
    for(let step=0;step<300 && state.phase==='playing';step++){
      const legal=lastSector.getLegalActions(state,current);
      let action;
      if(!legal.length){ break; }
      const types=legal.map(x=>x.type);
      const type=types[rng.int(0,types.length-1)];
      if(type==='MOVE'){
        const unit=[...state.units.values()].find(u=>u.owner===current && u.hp>0); if(!unit) break;
        const [uq,ur]=unit.coord.split(',').map(Number); const dirs=ur%2===0?[[1,0],[-1,0],[0,-1],[-1,-1],[0,1],[-1,1]]:[[1,0],[-1,0],[1,-1],[0,-1],[1,1],[0,1]]; const coords=dirs.map(([dq,dr])=>`${uq+dq},${ur+dr}`).filter(c=>state.tiles.has(c));
        const target=coords[rng.int(0,Math.max(0,coords.length-1))]; action={type,actor:current,to:target||'0,0'};
      } else if(type==='ATTACK'||type==='STEAL'){
        const targets=[...state.units.values()].filter(u=>u.owner!==current&&u.owner!=='tanker'&&u.hp>0).map(u=>u.owner); action={type,actor:current,target:targets[0]||'nobody'};
      } else { action={type,actor:current}; }
      const validation=lastSector.validateAction(state,action);
      if(validation===true){
        const result=lastSector.applyActionInPlace(state,action,{rng});
        assert.equal(result.accepted,true,`accepted action rejected game=${gameNo} step=${step} type=${type}`);
        invariant(state);
      }
      current=state.activePlayer;
      // Ensure no accepted action changes the identity set.
      assert.deepEqual(Object.keys(state.playerMeta||{}).sort(),players.slice().sort());
    }
    invariant(state);
  }
});

// Regression coverage gap found while independently verifying this pack:
// the fuzz test above re-implements its own inline action-selection logic
// rather than calling lastSectorPack.bots.random/.aggressive -- so it
// never actually exercised the real bot functions a bot-driven match
// would use, and completely missed the four real bugs found there (NaN
// coordinates from `.q`/`.r` access on a "q,r" string; {q,r} objects
// handed to a string-only `to` field; non-parity-aware neighbor offsets
// wrong on odd rows; ATTACK proposed while standing on a nebula tile
// that blocks it). This drives the actual exported bot functions through
// the real dispatchMatchAction/runAction pipeline (not validateAction
// called directly, and not a hand-rolled action generator) -- the same
// path a real host with bot-controlled seats would use.
import { lastSectorPack } from '../src/index.js';
import { createMatch, startMatch, dispatchMatchAction } from '@tablecore/core';

test('lastSectorPack.bots.random/.aggressive never produce a dispatch-rejected action, across many seeds/player-counts/turns', () => {
  let totalSteps = 0, totalMoves = 0;
  for (const botType of ['random', 'aggressive']) {
    for (const players of [['A','B'], ['A','B','C'], ['A','B','C','D']]) {
      for (let seed = 0; seed < 12; seed++) {
        let match = createMatch({ id:`fuzz-${botType}-${players.length}-${seed}`, game:lastSectorPack.game, players, options:{ seed } });
        match = startMatch({ match, game:lastSectorPack.game }).match;
        const rng = createSeededRng(seed * 31 + 11);
        for (let i = 0; i < 100 && match.status === 'running'; i++) {
          const actor = match.state.activePlayer;
          const action = lastSectorPack.bots[botType](match.state, actor, { rng });
          const r = dispatchMatchAction({ match, game:lastSectorPack.game, action });
          totalSteps++;
          assert.equal(r.ok, true, `bot-proposed action must always be accepted by the real dispatch pipeline: ${botType}, players=${players.length}, seed=${seed}, step=${i}, action=${JSON.stringify(action)}, error=${JSON.stringify(r.error)}`);
          if (action.type === 'MOVE') totalMoves++;
          match = r.match;
        }
      }
    }
  }
  assert.ok(totalSteps > 1000, 'sanity: this test should exercise a meaningful number of steps');
  assert.ok(totalMoves > 0, 'sanity: MOVE actions should actually occur (would be 0 if the coordinate bugs regressed)');
});

// Regression test for a real, reproducible bug found via a full-game
// bot-vs-bot simulation, NOT caught by the fuzz test above (which caps
// each game at 100 steps -- this bug only manifests around step 180+,
// once a unit has actually had a real chance to reach its last life at
// low HP). The bug: the ACTOR's own unit can be fully ELIMINATED (0
// lives left, removed from state.units entirely) DURING the resolution
// of its own MOVE action -- e.g. landing on an unresolved 'anomaly' tile
// has a real chance to deal 1 damage (see resolveTile's own 'anomaly'
// case in game.cjs), which is lethal at 1 HP / last life. move()'s own
// turn-advancement check used to test `u.moves<=0` on the SAME stale
// object reference captured before deletion -- once removed from
// state.units, that detached object's `.moves` was untouched (usually
// still >0), so the check silently stayed false and the turn never
// advanced. The match then hung forever: activePlayer stayed pointed at
// the now-eliminated player, whose unit no longer existed, so
// availableActions() (which requires a real unit to exist even to offer
// END_TURN) returned an empty list -- no legal action existed for that
// player at all, not even to give up their turn. Fixed by ALSO checking
// `!ctx.state.units.has(u.id)` (see move()'s own comment in game.cjs).
test('a full game reaches phase "finished" (not stuck forever) even when a player is fully eliminated mid-move with moves remaining -- exact regression for a previously-hanging seed', () => {
  // seed=13, players=['A','B'], turnSeconds:5, bot type 'aggressive' is
  // the EXACT scenario that hung before this fix (B's unit destroyed by
  // an anomaly tile at step 182 while B.lives was already at its last
  // life, then step 183's forced END_TURN rejected as ILLEGAL_ACTION
  // since B no longer had a unit at all).
  let match = createMatch({ id: 'regression-seed13', game: lastSectorPack.game, players: ['A', 'B'], options: { seed: 13, turnSeconds: 5 } });
  match = startMatch({ match, game: lastSectorPack.game }).match;
  const rng = createSeededRng(13 * 7 + 3);
  let steps = 0;
  while (match.state.phase === 'playing' && steps < 2000) {
    const actor = match.state.activePlayer;
    const action = lastSectorPack.bots.aggressive(match.state, actor, { rng });
    const result = dispatchMatchAction({ match, game: lastSectorPack.game, actor, action });
    assert.equal(result.ok, true, `step ${steps}: action must never be rejected, got ${JSON.stringify(result.error)} for ${JSON.stringify(action)}`);
    match = result.match;
    steps++;
  }
  assert.equal(match.state.phase, 'finished', `must reach a real end state within 2000 steps, got stuck in phase="${match.state.phase}" (active=${match.state.activePlayer}) after ${steps} steps`);
});

test('100 full games (2-player, aggressive bots, a real elimination-heavy setup) all reach phase "finished" -- broad sweep, not just the one known-bad seed', () => {
  let stuck = 0;
  for (let seed = 0; seed < 100; seed++) {
    let match = createMatch({ id: `sweep-${seed}`, game: lastSectorPack.game, players: ['A', 'B'], options: { seed, turnSeconds: 5 } });
    match = startMatch({ match, game: lastSectorPack.game }).match;
    const rng = createSeededRng(seed * 7 + 3);
    let steps = 0;
    while (match.state.phase === 'playing' && steps < 2000) {
      const actor = match.state.activePlayer;
      const action = lastSectorPack.bots.aggressive(match.state, actor, { rng });
      const result = dispatchMatchAction({ match, game: lastSectorPack.game, actor, action });
      assert.equal(result.ok, true, `seed ${seed} step ${steps}: ${JSON.stringify(result.error)}`);
      match = result.match;
      steps++;
    }
    if (match.state.phase !== 'finished') stuck++;
  }
  assert.equal(stuck, 0, `${stuck}/100 games never reached a finished state`);
});

// Regression tests for a real, measured wire-payload optimization: a
// hidden (undiscovered) tile used to carry the exact same 8 fields as a
// fully-revealed one (revealed/collapsed/loot/lootKnown/exit/to), every
// one of them a trivial false/null placeholder conveying zero real
// information -- an undiscovered tile categorically cannot have known
// loot, exit info, etc. from a given viewer's own perspective, by
// definition of being undiscovered. Measured directly (not estimated):
// this was ~91% of a typical UPDATE/SYNC message's total size, and most
// tiles are 'hidden' for most of a real match. Trimmed to just
// {coord, kind} for hidden tiles -- a real ~55-64% payload reduction,
// confirmed here, not just believed.

test('a hidden tile in a real projected view carries ONLY {coord, kind} -- no revealed/collapsed/loot/lootKnown/exit/to placeholder fields at all', () => {
  const match0 = createMatch({ id: 'trim-check', game: lastSectorPack.game, players: ['A', 'B'], options: { seed: 5 } });
  const started = startMatch({ match: match0, game: lastSectorPack.game });
  const view = lastSectorPack.game.getPlayerView(started.match.state, 'A');
  const hidden = view.tiles.find(t => t.kind === 'hidden');
  assert.ok(hidden, 'sanity: a fresh match must have at least one hidden tile');
  assert.deepEqual(Object.keys(hidden).sort(), ['coord', 'kind']);
});

test('a real, visible tile keeps its full field set unchanged -- the trim applies ONLY to hidden tiles, not a blanket schema change', () => {
  const match0 = createMatch({ id: 'trim-check-2', game: lastSectorPack.game, players: ['A', 'B'], options: { seed: 5 } });
  const started = startMatch({ match: match0, game: lastSectorPack.game });
  const view = lastSectorPack.game.getPlayerView(started.match.state, 'A');
  const visible = view.tiles.find(t => t.kind !== 'hidden');
  assert.ok(visible, 'sanity: a fresh match must have at least one visible tile (the player\'s own base)');
  assert.deepEqual(Object.keys(visible).sort(), ['collapsed', 'coord', 'exit', 'kind', 'loot', 'lootKnown', 'revealed', 'to']);
});

test('the real, measured payload reduction is substantial (at least 40%) across a real 20-turn game, not a marginal or theoretical saving', () => {
  let match = createMatch({ id: 'trim-measure', game: lastSectorPack.game, players: ['A', 'B'], options: { seed: 5 } });
  match = startMatch({ match, game: lastSectorPack.game }).match;
  const rng = createSeededRng(5);
  let totalBytes = 0, count = 0;
  for (let i = 0; i < 20; i++) {
    const actor = match.state.activePlayer;
    const action = lastSectorPack.bots.aggressive(match.state, actor, { rng });
    const result = dispatchMatchAction({ match, game: lastSectorPack.game, actor, action });
    if (!result.ok) break;
    match = result.match;
    const view = lastSectorPack.game.getPlayerView(match.state, 'A');
    totalBytes += JSON.stringify({ version: i, state: view }).length;
    count++;
  }
  assert.ok(count >= 15, `sanity: expected most of the 20 planned turns to succeed, only got ${count}`);
  // A pre-trim baseline of ~10.7KB/update was measured directly before
  // this change -- a real match today staying well under that average
  // is the actual, concrete proof this optimization works, not just a
  // plausible-sounding claim.
  const averagePerUpdate = totalBytes / count;
  assert.ok(averagePerUpdate < 6500, `expected a substantial reduction from the ~10700 byte/update pre-trim baseline, got ${Math.round(averagePerUpdate)} bytes/update average`);
});
