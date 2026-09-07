import test from 'node:test';
import assert from 'node:assert/strict';
import { createReplay, playReplay, ENGINE_VERSION, RNG_ALGORITHM } from '../src/index.js';
import { gridDuel } from '@tablecore/game-grid-duel';
import { sectorExpedition, sectorExpeditionPack } from '@tablecore/game-sector-expedition';
import { contentCatalog } from '@tablecore/game-sector-expedition';
import { createGamePack } from '@tablecore/game-pack';

const actions = [
  { type:'MOVE', actor:'A', direction:'E' },
  { type:'MOVE', actor:'B', direction:'W' },
  { type:'MOVE', actor:'A', direction:'S' },
  { type:'MOVE', actor:'B', direction:'N' },
  { type:'MOVE', actor:'A', direction:'E' },
  { type:'MOVE', actor:'B', direction:'W' },
  { type:'MOVE', actor:'A', direction:'S' },
  { type:'ATTACK', actor:'B' },
  { type:'ATTACK', actor:'A' },
  { type:'ATTACK', actor:'B' },
  { type:'ATTACK', actor:'A' },
  { type:'ATTACK', actor:'B' }
];

test('replay reproduces identical final state and event history', () => {
  const replay = createReplay({ gameVersion:'grid-duel@1', seed:42, initialState:gridDuel.createInitialState(), actions });
  const a = playReplay({ game:gridDuel, replay });
  const b = playReplay({ game:gridDuel, replay });
  assert.equal(a.ok, true); assert.equal(b.ok, true);
  assert.deepEqual(a.state, b.state);
  assert.deepEqual(a.results, b.results);
  assert.equal(a.state.phase, 'finished');
  assert.equal(a.state.winner, 'B');
});

test('replay does not mutate recorded initial state', () => {
  const initial = gridDuel.createInitialState();
  const replay = createReplay({ seed:7, initialState:initial, actions:[{type:'MOVE',actor:'A',direction:'E'}] });
  playReplay({ game:gridDuel, replay });
  assert.deepEqual(replay.initialState, initial);
});

// Regression test: `gameVersion` used to be recorded and never checked
// against anything -- replaying a recording against a different game
// version silently "succeeded" with whatever result the (possibly patched)
// rules produced, no signal that the comparison was meaningless.
test('playReplay refuses to replay against a mismatched game version', () => {
  const replay = createReplay({ gameVersion:'grid-duel@0', seed:1, initialState:gridDuel.createInitialState(), actions:[{type:'MOVE',actor:'A',direction:'E'}] });
  const result = playReplay({ game:gridDuel, replay });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'REPLAY_PROVENANCE_MISMATCH');
  assert.ok(result.error.mismatches.some(m => m.field === 'gameVersion' && m.recorded === 'grid-duel@0' && m.current === gridDuel.version));
});

test('playReplay allows a mismatched game version when explicitly told to ignore it', () => {
  const replay = createReplay({ gameVersion:'grid-duel@0', seed:1, initialState:gridDuel.createInitialState(), actions:[{type:'MOVE',actor:'A',direction:'E'}] });
  const result = playReplay({ game:gridDuel, replay, ignoreVersionMismatch:true });
  assert.equal(result.ok, true);
});

test('playReplay matching gameVersion (as already used by the other tests) plays normally', () => {
  const replay = createReplay({ gameVersion:gridDuel.version, seed:1, initialState:gridDuel.createInitialState(), actions:[{type:'MOVE',actor:'A',direction:'E'}] });
  const result = playReplay({ game:gridDuel, replay });
  assert.equal(result.ok, true);
});

// The rest of the provenance header (external remediation request,
// "Replay provenance is incomplete"): engineVersion, rngAlgorithm,
// gamePackDigest, contentDigest, initialStateDigest -- not just
// gameVersion. Each is independently checkable and independently
// bypassable via the same ignoreProvenanceMismatch escape hatch.

test('createReplay records engineVersion, rngAlgorithm, and initialStateDigest even without a full pack', () => {
  const initial = gridDuel.createInitialState();
  const replay = createReplay({ seed:1, initialState:initial, actions:[] });
  assert.equal(replay.engineVersion, ENGINE_VERSION);
  assert.equal(replay.rngAlgorithm, RNG_ALGORITHM);
  assert.equal(replay.simulationSeed, 1);
  assert.ok(replay.initialStateDigest.startsWith('sha256:'));
  // No pack was supplied -- these stay null rather than guessing.
  assert.equal(replay.gamePackId, null);
  assert.equal(replay.gamePackDigest, null);
});

test('playReplay fails closed on an engineVersion mismatch and reports it distinctly from a gameVersion mismatch', () => {
  const replay = createReplay({ gameVersion:gridDuel.version, seed:1, initialState:gridDuel.createInitialState(), actions:[] });
  const tampered = { ...replay, engineVersion: 'some-other-engine-build' };
  const result = playReplay({ game:gridDuel, replay:tampered });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'REPLAY_PROVENANCE_MISMATCH');
  assert.deepEqual(result.error.mismatches, [{ field:'engineVersion', recorded:'some-other-engine-build', current:ENGINE_VERSION }]);
});

test('playReplay fails closed on an rngAlgorithm mismatch -- this is exactly the class of bug the Mulberry32->xoshiro128** migration could have silently caused without it', () => {
  const replay = createReplay({ gameVersion:gridDuel.version, seed:1, initialState:gridDuel.createInitialState(), actions:[] });
  const tampered = { ...replay, rngAlgorithm: 'mulberry32-v1' };
  const result = playReplay({ game:gridDuel, replay:tampered });
  assert.equal(result.ok, false);
  assert.ok(result.error.mismatches.some(m => m.field === 'rngAlgorithm'));
});

test('playReplay fails closed on an initialStateDigest mismatch (the recorded initialState was tampered with independently of the digest)', () => {
  const replay = createReplay({ gameVersion:gridDuel.version, seed:1, initialState:gridDuel.createInitialState(), actions:[] });
  const tampered = { ...replay, initialState: { ...replay.initialState, activePlayer:'B' } }; // digest not recomputed to match
  const result = playReplay({ game:gridDuel, replay:tampered });
  assert.equal(result.ok, false);
  assert.ok(result.error.mismatches.some(m => m.field === 'initialStateDigest'));
});

test('createReplay derives gamePackId/gamePackVersion/gamePackDigest when a full pack is supplied, and playReplay checks it', () => {
  const pack = createGamePack(sectorExpeditionPack);
  const initial = sectorExpedition.createInitialState({ players:['A','B'], seed:1 });
  const replay = createReplay({ gameVersion:sectorExpedition.version, seed:1, initialState:initial, actions:[], pack });
  assert.equal(replay.gamePackId, pack.manifest.id);
  assert.equal(replay.gamePackVersion, pack.manifest.version);
  assert.ok(replay.gamePackDigest.startsWith('sha256:'));

  // Matches today -> plays fine.
  const ok = playReplay({ pack, replay });
  assert.equal(ok.ok, true);

  // A different game object (different rule code, freshly wrapped so its
  // function source text literally differs) with the SAME declared
  // version string must still be caught -- this is exactly the gap a
  // bare version-string check cannot close, and the actual motivation
  // for gamePackDigest existing at all.
  const patchedGame = { ...sectorExpedition, applyActionInPlace: (state, action, ctx) => sectorExpedition.applyActionInPlace(state, action, ctx) };
  const patchedPack = { ...pack, game: patchedGame };
  const mismatched = playReplay({ pack: patchedPack, replay });
  assert.equal(mismatched.ok, false);
  assert.ok(mismatched.error.mismatches.some(m => m.field === 'gamePackDigest'));
});

// `content` is its own parameter (matching pack-linter's
// `lintGamePack({pack, content, authoring})` convention), not nested
// inside `pack` -- most shipped packs' own object literal never carries a
// `content` field, content catalogs are exported as a sibling value.
test('createReplay/playReplay check contentDigest when content is supplied as its own parameter', () => {
  const initial = sectorExpedition.createInitialState({ players:['A','B'], seed:1 });
  const replay = createReplay({ gameVersion:sectorExpedition.version, seed:1, initialState:initial, actions:[], content:contentCatalog });
  assert.ok(replay.contentDigest.startsWith('sha256:'));
  const ok = playReplay({ game:sectorExpedition, replay, content:contentCatalog });
  assert.equal(ok.ok, true);
  const mismatched = playReplay({ game:sectorExpedition, replay, content:{ different:true } });
  assert.equal(mismatched.ok, false);
  assert.ok(mismatched.error.mismatches.some(m => m.field === 'contentDigest'));
});

test('ignoreProvenanceMismatch bypasses every provenance check at once, not just gameVersion', () => {
  const replay = createReplay({ seed:1, initialState:gridDuel.createInitialState(), actions:[] });
  const tampered = { ...replay, engineVersion:'x', rngAlgorithm:'y', initialStateDigest:'sha256:0000' };
  const result = playReplay({ game:gridDuel, replay:tampered, ignoreProvenanceMismatch:true });
  assert.equal(result.ok, true);
});

// Regression test for a real gap found via a manual, line-by-line code
// review of playReplay() (not found by any failing test): this file's
// own runAction() call used to pass `seed: replay.seed` into the
// context a game's rule code receives, the SAME class of raw-seed leak
// already found and fixed in dispatchMatchAction() (see
// packages/core/src/match/createMatch.js's own comment on this) in
// response to an external audit finding. That earlier fix's own
// regression tests only exercised dispatchMatchAction() -- this second,
// separate call site in playReplay() was missed entirely and remained
// leaking the raw seed into every replayed action's own context.
test('playReplay() never includes the raw seed value in the context passed to the game -- only the real rng object, matching dispatchMatchAction()\'s own equivalent fix', () => {
  const gameCapturingContext = {
    createInitialState: () => ({ value: 0 }),
    getLegalActions: () => [{ type: 'X' }],
    applyActionInPlace(state, action, context) { state.receivedContext = { hasRng: typeof context.rng?.next === 'function', hasSeed: 'seed' in context }; return { state, events: [] }; },
    getGameStatus: () => ({ finished: false }),
  };
  const replay = createReplay({ seed: 777, initialState: { value: 0 }, actions: [{ type: 'X', actor: 'A' }] });
  const result = playReplay({ game: gameCapturingContext, replay });
  assert.equal(result.ok, true);
  assert.equal(result.state.receivedContext.hasRng, true, 'the real rng object must still be present -- this fix only removes the raw seed, not randomness itself');
  assert.equal(result.state.receivedContext.hasSeed, false, 'the raw seed value must never be included in the context a replayed action\'s own rule code receives');
});
