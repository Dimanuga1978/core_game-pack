# Last Sector — TableCore v2 migration status (B24)

This directory contains the legacy Last Sector content/rules adapted to the current TableCore v2 Game Pack contract.

## Scope
- Reused the existing Last Sector rules implementation through an explicit compatibility adapter.
- Added current Game Pack manifest and content catalog.
- Preserved player/mobile/TV/preview assets as migration material.
- Added deterministic RNG adapter for legacy `range`, `shuffle`, and one-argument `int` calls.
- Added current-engine player-view projection and event audience scoping.
- Added current Match lifecycle compatibility.

## Verified
- Game Pack contract validation: PASS.
- Deterministic initialization for identical seed/player inputs: PASS.
- Player view does not expose server RNG state/seed: PASS.
- Match lifecycle with repeated END_TURN: PASS across 100 matches.
- Mixed gameplay smoke stress: 100 matches / 1,100 actions, PASS.
- Pack preflight lint without authoring bundle: PASS.
- Full TableCore test suite: 139/139 PASS in the local execution environment.

## Known migration boundary
The pack remains an adapter around the legacy Last Sector rule code. This is intentional for the first migration pass: the new engine remains authoritative, while game-specific legacy mechanics are isolated behind `src/game.js`.

The next migration phase should replace the legacy API surface incrementally instead of rewriting the game and the engine simultaneously.
