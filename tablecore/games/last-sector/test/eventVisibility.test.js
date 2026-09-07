import test from 'node:test';
import assert from 'node:assert/strict';
import { lastSector, offsetNeighbors } from '../src/game.js';
import { createSeededRng } from '@tablecore/core';

// Regression tests for two real, confirmed logic bugs found via a
// manual, line-by-line review of every real PRIVATE_EVENTS emit() call
// site in games/last-sector/src/legacy/game.cjs (not found by any
// failing test):
//
// 1. TRAP_TRIGGERED used to only carry `victim` in its payload, not
//    `player`/`owner` -- emit()'s own audience-scoping fallback
//    (games/last-sector/src/game.js) only reads payload.player/
//    payload.owner, never payload.victim, so this event only ever
//    reached the correct person by COINCIDENCE (the trap's victim
//    always happens to equal action.actor in this specific mechanic,
//    since a trap can only be triggered by walking onto it with your
//    own move), not by an explicit, stated contract. Fixed by adding
//    `player` alongside the original `victim` field.
//
// 2. NAVIGATION_GLITCH describes a GLOBAL, match-wide state change
//    (extending the whole session's shared time budget -- every
//    player's own remaining-time math depends on the same
//    `timeBonusSec` value equally) but was incorrectly listed in
//    PRIVATE_EVENTS, meaning it got silently scoped to whichever
//    player's own turn happened to be active when the periodic glitch
//    check fired -- every OTHER player, who benefits from the exact
//    same time extension, never received the event explaining why the
//    match suddenly had more time left. Fixed by removing it from
//    PRIVATE_EVENTS entirely.

test('TRAP_TRIGGERED carries an explicit player field matching the real trap victim, not relying on emit()\'s own action.actor fallback coinciding with it', () => {
  const state = lastSector.createInitialState({ players: ['A', 'B'], seed: 1 });
  const rng = createSeededRng(5);
  const unitA = [...state.units.values()].find(u => u.owner === 'A');
  const neighbors = offsetNeighbors(unitA.coord, state.cfg.w, state.cfg.h);
  const targetCoord = neighbors.find(c => state.tiles.get(c) && !state.tiles.get(c).collapsed);
  assert.ok(targetCoord, 'test precondition: a real, valid neighboring tile must exist to move onto');

  const modified = structuredClone(state);
  modified.traps = [{ owner: 'B', coord: targetCoord }];
  const result = lastSector.applyActionInPlace(modified, { type: 'MOVE', actor: 'A', to: targetCoord }, { rng });

  const trapEvent = result.events.find(e => e.type === 'TRAP_TRIGGERED');
  assert.ok(trapEvent, 'test precondition: walking onto another player\'s trap must actually trigger TRAP_TRIGGERED');
  assert.equal(trapEvent.payload.player, 'A', 'the payload must explicitly declare who the real victim is via the SAME field name every other private event in this pack uses');
  assert.equal(trapEvent.payload.victim, 'A', 'the original victim field must still be present -- this fix adds player alongside it, does not remove existing data');
  assert.deepEqual(trapEvent.audience, ['A'], 'the event must correctly reach the real victim');
});

test('NAVIGATION_GLITCH is never restricted to a single player\'s audience -- confirmed via the actual legacy source text, not a live playthrough (a probabilistic, turn>=3-gated event genuinely can\'t be forced to fire deterministically through normal play)', async () => {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const legacyPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'legacy', 'game.cjs');
  const legacySource = await fs.readFile(legacyPath, 'utf8');
  assert.match(legacySource, /ctx\.emit\('NAVIGATION_GLITCH'/, 'test precondition: this event must still genuinely exist in the real source');

  const gameJsPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'game.js');
  const gameJsSource = await fs.readFile(gameJsPath, 'utf8');
  const privateEventsMatch = gameJsSource.match(/const PRIVATE_EVENTS = new Set\(\[([^\]]*)\]\)/);
  assert.ok(privateEventsMatch, 'test precondition: the PRIVATE_EVENTS declaration must be found in the real source');
  assert.ok(!privateEventsMatch[1].includes('NAVIGATION_GLITCH'), 'NAVIGATION_GLITCH must never be listed in PRIVATE_EVENTS -- it describes a global, match-wide time extension every player benefits from equally, not a per-player secret');
});
