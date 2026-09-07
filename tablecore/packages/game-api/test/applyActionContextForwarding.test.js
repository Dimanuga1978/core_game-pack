import test from 'node:test';
import assert from 'node:assert/strict';
import { gridDuel } from '@tablecore/game-grid-duel';
import { coinRace } from '@tablecore/game-coin-race';
import { phaseQuest } from '@tablecore/game-phase-quest';
import { sectorExpedition } from '@tablecore/game-sector-expedition';
import { synthesizeApplyAction } from '@tablecore/core';

// last-sector is a SEPARATE, optional game pack (see this repo's own
// two-archive split: the engine ships independently of any specific
// game). Tried once, dynamically, rather than a static top-level import
// that would fail this WHOLE file to even load on an engine-only
// checkout -- found via a real clean-room test of the split engine-only
// archive: this exact file (added AFTER the earlier pass that made
// every OTHER last-sector-dependent test file in this codebase handle
// this gracefully) was missed, since it didn't exist yet at the time of
// that pass. A real, concrete lesson: this class of fix needs to be
// applied to every NEW test file touching last-sector going forward,
// not just the ones that existed at the time it was first done.
let lastSector, lastSectorUnavailableReason = null;
try {
  ({ lastSector } = await import('@tablecore/game-last-sector'));
} catch (error) {
  lastSectorUnavailableReason = `games/last-sector not present in this checkout (${error.code ?? error.message})`;
}

// A real, external audit found that games/last-sector's own applyAction()
// (part of the GameDefinition contract's own declared entry point --
// packages/core/src/runAction.js's canonical dispatcher calls
// `game.applyAction(workingState, safeAction, context)`, THREE
// arguments) silently dropped whatever real `context` (rng, seed) it
// was actually given, hardcoding an empty {} instead of forwarding it --
// breaking EVERY legal action when applyAction() was called directly,
// since applyActionInPlace unconditionally requires context.rng.
//
// Investigating that finding further (not just fixing the one reported
// instance) found the exact same class of bug, LATENT rather than
// actively broken, in three of the four other shipped games:
// grid-duel/coin-race/phase-quest's own applyAction() also only declared
// two parameters and never forwarded a third `context` argument at all --
// harmless TODAY only because none of their own applyActionInPlace
// implementations happen to read anything from context yet. The moment
// any of them added real randomness (a plausible, ordinary game-design
// change), calling applyAction() directly would have broken in exactly
// the same way last-sector's did, with no engine-level test anywhere to
// have caught it before shipping.
//
// The real, structural fix (not just patching each hand-written
// instance): every game's own hand-derived delegation was DELETED, not
// corrected -- applyAction is now synthesized once, engine-side, via
// packages/core/src/runAction.js's own synthesizeApplyAction(), and each
// game's exported object is built as `{ ...rules, applyAction:
// synthesizeApplyAction(rules.applyActionInPlace) }` (see
// games/grid-duel/src/game.js's own comment for the full pattern). This
// makes the whole class of "hand-copied this wrong" bug structurally
// impossible rather than merely documented -- these tests now verify
// that every real game's own exported `applyAction` genuinely IS (behaves
// identically to) the canonical synthesis for its own
// applyActionInPlace, not a redundant hand-rolled alternative that could
// drift from it again.
const REAL_GAMES = [
  ['grid-duel', gridDuel],
  ['coin-race', coinRace],
  ['phase-quest', phaseQuest],
  ['sector-expedition', sectorExpedition],
  ...(lastSector ? [['last-sector', lastSector]] : []),
];

if (lastSectorUnavailableReason) {
  test(`last-sector: applyAction() context-forwarding checks (skipped)`, { skip: lastSectorUnavailableReason }, () => {});
}

for (const [name, game] of REAL_GAMES) {
  test(`${name}: applyAction() accepts a third context argument without throwing, matching runAction.js's own real 3-argument call signature`, () => {
    const state = game.createInitialState({ players: ['A', 'B'], seed: 1 });
    assert.ok(game.applyAction.length >= 2, `${name}.applyAction must declare at least (state, action) -- found arity ${game.applyAction.length}`);
    assert.doesNotThrow(() => {
      const legal = game.getLegalActions(state, 'A')[0] ?? { type: '__PROBE__', actor: 'A' };
      game.applyAction(state, { ...legal, actor: legal.actor ?? 'A' }, { rng: { next: () => 0.5, int: () => 0, getState: () => ({}) }, seed: 1 });
    }, `${name}.applyAction must not throw when given a real context object -- if it drops the third argument rather than forwarding it, a game whose applyActionInPlace requires context (like last-sector's own context.rng requirement) would fail here`);
  });

  test(`${name}: applyAction() behaves IDENTICALLY to synthesizeApplyAction(applyActionInPlace) for the same real state/action/context -- proves this game genuinely uses the shared, canonical synthesis and not a redundant, independently-derived alternative that could silently drift from it again`, () => {
    const state = game.createInitialState({ players: ['A', 'B'], seed: 1 });
    const legal = game.getLegalActions(state, 'A')[0];
    if (!legal) return;
    const context = { rng: { next: () => 0.5, int: () => 0, getState: () => ({}) }, seed: 1 };
    const viaGamesOwnApplyAction = game.applyAction(structuredClone(state), legal, context);
    const viaCanonicalSynthesis = synthesizeApplyAction(game.applyActionInPlace)(structuredClone(state), legal, context);
    assert.deepEqual(viaGamesOwnApplyAction, viaCanonicalSynthesis, `${name}.applyAction must produce the exact same result as the canonical synthesizeApplyAction(applyActionInPlace) -- any divergence here means this game is (again) using its own, independently-derived delegation instead of the shared, tested one`);
  });
}
