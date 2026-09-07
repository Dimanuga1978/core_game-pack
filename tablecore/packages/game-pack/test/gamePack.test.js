import test from 'node:test'; import assert from 'node:assert/strict';
import { createGamePack, createPackRegistry, PACK_API_VERSION } from '../src/index.js';
import { gridDuel } from '@tablecore/game-grid-duel';
import { coinRacePack } from '@tablecore/game-coin-race';
import { createMatch, startMatch, dispatchMatchAction } from '@tablecore/core';

// last-sector is a SEPARATE, optional game pack (see this repo's own
// two-archive split) -- tried once, dynamically, so the one test below
// that needs it can cleanly `skip` with a real reason when it's not
// present, rather than showing up as a FAILED test (what a bare,
// unguarded `await import(...)` inside that test's own body would have
// done).
let lastSectorPack, lastSectorUnavailableReason = null;
try {
  ({ lastSectorPack } = await import('@tablecore/game-last-sector'));
} catch (error) {
  lastSectorUnavailableReason = `games/last-sector not present in this checkout (${error.code ?? error.message})`;
}
const skipIfNoLastSector = lastSectorUnavailableReason ? { skip: lastSectorUnavailableReason } : {};

test('two independent packs register without engine changes',()=>{
 const gridPack=createGamePack({manifest:{id:'grid-duel',name:'Grid Duel',version:'1.0.0',apiVersion:PACK_API_VERSION},game:gridDuel});
 const registry=createPackRegistry(); registry.register(gridPack); registry.register(coinRacePack);
 assert.deepEqual(registry.list().map(x=>x.id),['grid-duel','coin-race']); assert.equal(registry.get('coin-race').game,coinRacePack.game);
});
test('second pack runs through the same match lifecycle',()=>{
 const game=coinRacePack.game; let match=createMatch({id:'race',game,players:['A','B']}); match=startMatch({match,game}).match;
 let r=dispatchMatchAction({match,game,action:{type:'ADVANCE',actor:'A'}}); assert.equal(r.ok,true); assert.equal(r.match.state.scores.A,1); assert.equal(r.match.state.activePlayer,'B');
});
test('invalid pack contract is rejected early',()=>assert.throws(()=>createGamePack({manifest:{id:'x',name:'x',version:'1',apiVersion:PACK_API_VERSION},game:{}}),/missing/));

// engineCompatibility (real distribution/versioning): a manifest can
// declare `engineCompatibility: ">=X <Y"` (see games/last-sector/
// manifest.json for a real example). Before this, the field existed and
// was never checked against anything -- purely decorative, the same
// class of "field exists, nobody reads it" gap already found and fixed
// twice elsewhere in this codebase (replay.gameVersion, pack-linter's
// authoring==null handling). It is checked against GAME_API_VERSION
// (see packages/game-api's isEngineCompatible()), the actual semver-
// shaped game-authoring contract version a pack is written against.
import { GAME_API_VERSION } from '@tablecore/game-api';

test('a pack with no engineCompatibility declared is not checked against anything (makes no claim)', () => {
  assert.doesNotThrow(() => createGamePack({ manifest:{id:'x',name:'x',version:'1.0.0',apiVersion:PACK_API_VERSION}, game:gridDuel }));
});

test('a pack whose engineCompatibility range covers the current GAME_API_VERSION loads normally', () => {
  assert.doesNotThrow(() => createGamePack({ manifest:{id:'x',name:'x',version:'1.0.0',apiVersion:PACK_API_VERSION,engineCompatibility:`>=${GAME_API_VERSION}`}, game:gridDuel }));
});

test('a pack whose engineCompatibility range does NOT cover the current GAME_API_VERSION is rejected at load time, not silently accepted', () => {
  assert.throws(
    () => createGamePack({ manifest:{id:'x',name:'x',version:'1.0.0',apiVersion:PACK_API_VERSION,engineCompatibility:'>=99.0.0'}, game:gridDuel }),
    /engineCompatibility/
  );
});

test('games/last-sector\'s own declared engineCompatibility is real and satisfied by the current engine', skipIfNoLastSector, async () => {
  assert.equal(lastSectorPack.manifest.engineCompatibility, '>=2.0.0-alpha.1 <3.0.0');
  assert.doesNotThrow(() => createGamePack(lastSectorPack));
});
