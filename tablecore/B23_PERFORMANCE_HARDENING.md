# TableCore v2 — B23 Performance Hardening

## Baseline
B22 security-remediated full engine.

## Change
Introduced an explicit `applyActionInPlace(state, action, context)` fast path for Game Packs.

The public `applyAction()` contract remains clone-safe for direct callers. Core clones the authoritative state once, then calls `applyActionInPlace()` on that private working state. This removes the second full-state clone that previously occurred after `applyAction()`.

Match lifecycle transitions also stop cloning the entire Match object for every accepted action. Cloning remains at trust boundaries (public snapshots and externally returned values).

Server snapshot projection is cached per `(matchId, viewer, version)` and invalidated on version changes. This avoids repeating expensive player-view projection for the same authoritative version.

## Benchmark
Workload: Sector Expedition, 5,000 `END_TURN` actions, Node.js runtime in the same container.

Legacy path: 695.091842 ms
Optimized path: 242.460511 ms
Measured speedup: 2.8668x

This is a local benchmark, not a hardware-independent performance guarantee.

## Regression
109/109 automated tests passed.

JavaScript syntax checks passed for changed files.
