// Single source of truth for the engine's own version identity, in the
// same spirit as PACK_API_VERSION (game-pack), GAME_API_VERSION
// (game-api), and AUTHORING_API_VERSION (authoring-sdk) -- each layer of
// this system declares its own version as an explicit, importable
// constant rather than leaving it to be inferred from package.json (which
// is fragile to read at runtime from inside a published/bundled package,
// and easy to drift out of sync with what the code actually does).
//
// Used by replay provenance (packages/core/src/replay/replay.js) so a
// recorded replay can identify exactly which engine build produced it,
// not just which game-rule version.
export const ENGINE_VERSION = 'tablecore-v2-b24';
