// EXAMPLE benchmark target -- not part of the engine, never imported
// automatically. Plugs one of this repo's own games into the generic
// benchmark runner (tools/performance/benchmark.mjs). A real target
// against a different game just needs to export the same three things.
//
// Usage: node tools/performance/benchmark.mjs --target=./targets/sector-expedition.config.mjs
import { sectorExpedition, buildSectorMap } from '@tablecore/game-sector-expedition';

export const label = 'sector-expedition (implements applyAction AND applyActionInPlace)';
export const game = sectorExpedition;

export function createState(scale) {
  const base = sectorExpedition.createInitialState({ players: ['A', 'B'], seed: 123 });
  return { ...base, map: buildSectorMap(scale) };
}

export function createAction(state) {
  return { type: 'END_TURN', actor: state.activePlayer };
}
