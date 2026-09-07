# Last Sector on TableCore v2

B24 is the first migration pass of the existing Last Sector Game Pack onto the current TableCore v2 runtime.

The migration keeps the original gameplay implementation under `src/legacy/game.cjs` and exposes it through `src/game.js`, which implements the current Game Pack API:

- `createInitialState`
- `getLegalActions`
- `validateAction`
- `applyAction`
- `applyActionInPlace`
- `getGameStatus`
- `getPlayerView`

The compatibility adapter translates the old engine's context services (`random.range`, `random.shuffle`, `knowledge`, `emit`, `endTurn`, `finish`, `eliminate`) into current-engine semantics.

## Important
The migration is deliberately incremental. The old rule implementation is not considered the permanent API of TableCore. It is isolated so that later external-auditor changes to Core can be absorbed in one adapter layer.
