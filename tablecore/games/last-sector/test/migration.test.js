import test from 'node:test';
import assert from 'node:assert/strict';
import { lastSector, lastSectorPack } from '../src/index.js';
import { createGamePack } from '@tablecore/game-pack';
import { createMatch, startMatch, dispatchMatchAction } from '@tablecore/core';

test('Last Sector is a valid current-engine Game Pack', () => {
  const pack = createGamePack(lastSectorPack);
  assert.equal(pack.manifest.id, 'last-sector');
  assert.equal(typeof pack.game.createInitialState, 'function');
  assert.equal(typeof pack.game.getPlayerView, 'function');
  assert.equal(pack.manifest.hiddenInformation, true);
});

test('Last Sector creates a deterministic private-info state without leaking seed in player view', () => {
  const a = lastSector.createInitialState({ players:['A','B'], seed:42, gridWidth:9, gridHeight:9 });
  const b = lastSector.createInitialState({ players:['A','B'], seed:42, gridWidth:9, gridHeight:9 });
  assert.deepEqual(lastSector.getPlayerView(a,'A'), lastSector.getPlayerView(b,'A'));
  assert.equal(lastSector.getPlayerView(a,'A').seed, undefined);
  assert.equal(lastSector.getPlayerView(a,'A').rngState, undefined);
});

test('Last Sector runs through the real Match lifecycle and preserves viewer projection', () => {
  const m = createMatch({ id:'ls-migration', game:lastSector, players:['A','B'], options:{seed:77,gridWidth:9,gridHeight:9} });
  const started = startMatch({match:m,game:lastSector});
  assert.equal(started.ok,true);
  const syncState = lastSector.getPlayerView(started.match.state,'A');
  assert.equal(syncState.phase,'playing');
  assert.equal(Array.isArray(syncState.tiles), true);
  const action={type:'END_TURN',actor:'A'};
  const result=dispatchMatchAction({match:started.match,game:lastSector,action});
  assert.equal(result.ok,true);
  assert.equal(result.match.version,2);
});


test('Last Sector passes current Game Pack preflight without requiring authoring bundle', async () => {
  const { lintGamePack } = await import('../../../packages/pack-linter/src/index.js');
  const { lastSectorPack, contentCatalog } = await import('../src/index.js');
  const diagnostics = lintGamePack({ pack:lastSectorPack, content:contentCatalog });
  assert.equal(diagnostics.length, 0, JSON.stringify(diagnostics));
});

// Regression test for a real, previously-drifted duplication: the
// runtime manifest inside createGamePack() used to be a SEPARATE,
// hand-typed literal object, independent of the static manifest.json
// (read by discoverGameCatalog() before any JS is imported -- a
// genuinely necessary separation, see src/index.js's own comment on
// why). The duplication of overlapping field VALUES between the two
// was not architecturally necessary, and had already drifted for real
// once (engineCompatibility went missing from the runtime manifest
// while manifest.json kept declaring it). Fixed by having src/index.js
// import manifest.json directly and DERIVE its runtime manifest from
// it, rather than re-typing the same values -- this test reads
// manifest.json completely independently (its own fs.readFile, not
// reusing anything src/index.js itself imported) and proves the
// runtime manifest genuinely reflects it field-for-field, so the two
// can no longer silently diverge.
test('the runtime pack manifest is genuinely DERIVED from the real, on-disk manifest.json, not an independently-typed duplicate that could silently drift', async () => {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const manifestPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'manifest.json');
  const staticManifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));

  assert.equal(lastSectorPack.manifest.id, staticManifest.gameId, 'id (runtime) must match gameId (static) -- the one deliberate key rename, still the same real value');
  assert.equal(lastSectorPack.manifest.name, staticManifest.name);
  assert.equal(lastSectorPack.manifest.version, staticManifest.version);
  assert.equal(lastSectorPack.manifest.engineCompatibility, staticManifest.engineCompatibility, 'this exact field is the one that already drifted for real once before this fix -- the most important single assertion in this test');
  assert.equal(lastSectorPack.manifest.minPlayers, staticManifest.minPlayers);
  assert.equal(lastSectorPack.manifest.maxPlayers, staticManifest.maxPlayers);
  assert.equal(lastSectorPack.manifest.hiddenInformation, staticManifest.hiddenInformation);
  assert.deepEqual(lastSectorPack.manifest.capabilities, staticManifest.capabilities);
});
