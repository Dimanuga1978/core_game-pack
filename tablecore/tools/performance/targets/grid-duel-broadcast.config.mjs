// EXAMPLE benchmark target -- not part of the engine, never imported
// automatically. Plugs one of this repo's own games into the generic
// broadcast benchmark runner (tools/performance/broadcast-benchmark.mjs).
//
// Usage: node tools/performance/broadcast-benchmark.mjs --target=./targets/grid-duel-broadcast.config.mjs
import { gridDuel } from '@tablecore/game-grid-duel';

export const label = 'grid-duel (MOVE action, minimal state -- isolates broadcast-fanout cost from game-logic cost)';
export const game = gridDuel;
export const players = ['A', 'B'];

export function createAction() {
  return { type: 'MOVE', direction: 'E' };
}
