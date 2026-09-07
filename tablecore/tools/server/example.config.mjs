// EXAMPLE config for tools/server/start.mjs -- this file is NOT part of
// the engine and is never imported automatically by anything. It is one
// possible way to plug this repository's own demo games into a running
// server; a real deployment would write its own config file (in this
// exact shape: `export const games = { <id>: <GameDefinition or
// {game, bots}>, ... }`) listing whichever games it actually wants to
// host, which could just as easily be entirely different, third-party
// game packs this engine has never heard of.
//
// Usage:
//   TABLECORE_SERVER_CONFIG=tools/server/example.config.mjs TABLECORE_SERVER_SECRET=... npm run server
import { gridDuel } from '@tablecore/game-grid-duel';
import { coinRace } from '@tablecore/game-coin-race';
import { phaseQuest } from '@tablecore/game-phase-quest';
import { sectorExpedition } from '@tablecore/game-sector-expedition';

export const games = {
  'grid-duel': gridDuel,
  'coin-race': coinRace,
  'phase-quest': phaseQuest,
  'sector-expedition': sectorExpedition,
};

// last-sector is a SEPARATE, optional game pack -- this repository ships
// as TWO independent archives (the engine itself, and games/last-sector,
// the one real, playable game built on top of it), specifically so the
// engine can be used with entirely different third-party games without
// last-sector's own content along for the ride, and so last-sector can
// be updated/distributed on its own schedule without touching the
// engine at all. Confirmed directly, not assumed: production code
// under packages/ has zero imports of any specific game (only comments
// reference one, for explanatory context); the only real coupling was
// in this project's OWN test suite (now handled the same way this
// config handles it here) and in exactly this file, which is not part
// of the engine at all.
//
// Included here ONLY if it's actually present in this checkout's
// games/ directory -- the SAME file works correctly whether last-sector
// has been physically added or not, rather than needing two separate
// example configs to keep in sync. A real deployment that always wants
// last-sector (because it always ships both archives together) can
// simply drop this try/catch and import it unconditionally instead.
try {
  const { lastSector, lastSectorPack } = await import('@tablecore/game-last-sector');
  // Last Sector is the only shipped game with real bot strategies
  // ('random'/'aggressive', see games/last-sector/src/index.js's own
  // `bots` export) -- registered here as `{game, bots}` instead of a
  // bare game object specifically so a match's POST /api/matches body
  // can request `{"bots": {"<playerId>": "aggressive"}}` and have the
  // server drive that player's turns automatically. Any OTHER game
  // registered as a bare object (like the four above) simply has no bot
  // strategies available -- requesting one is a clean, explicit
  // UNKNOWN_BOT_STRATEGY rejection, not a silent no-op.
  games['last-sector'] = { game: lastSector, bots: lastSectorPack.bots };
} catch {
  // Not present in this checkout -- this example simply serves the four
  // engine-fixture demo games instead, exactly as if last-sector had
  // never been mentioned. Not an error condition; nothing to log here.
}
