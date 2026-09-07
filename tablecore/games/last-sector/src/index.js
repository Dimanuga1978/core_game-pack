import { createGamePack, PACK_API_VERSION } from '@tablecore/game-pack';
import { lastSector, SHIPS, LOOT, offsetNeighbors } from './game.js';
import { contentCatalog } from './content.js';
import { createLastSectorPresentation } from '../client/presentation.js';
// Real, previously-drifted duplication found and fixed: this runtime
// manifest (below) used to hand-duplicate id/name/version/
// engineCompatibility/minPlayers/maxPlayers/hiddenInformation/
// capabilities as separate, independently-typed literals from the
// static manifest.json (read by discoverGameCatalog() BEFORE any JS is
// imported -- see that file's own module doc comment for why that
// specific file genuinely must stay JS-import-free: a security/trust
// boundary against executing an uncofigured pack's code just to list
// it in a catalog, not something this file itself needs to worry about
// once it's already executing). Nothing about THAT constraint prevents
// THIS file -- already running as real JS by definition -- from simply
// reading the same static manifest.json directly and deriving its own
// runtime manifest from it, rather than re-typing the same values by
// hand a second time. The duplication had already drifted once for
// real (engineCompatibility went missing here while manifest.json kept
// declaring it -- see the git history/this file's own prior version)
// -- deriving instead of duplicating makes that entire class of bug
// structurally impossible, not just less likely.
import staticManifest from '../manifest.json' with { type: 'json' };

// `hexDistance` is used only by the aggressive bot's adjacency check
// (an offset-cube-coordinate distance -- correct regardless of row
// parity, since cube distance is parity-independent). Regular MOVE
// candidate generation deliberately does NOT duplicate its own neighbor-
// offset table here anymore: game.js's `offsetNeighbors()` (the exact
// function `validateAction` itself uses to decide what's adjacent) is
// imported and reused directly instead. This file used to have its own,
// simpler `neighbors(q, r)` with a single fixed offset table -- but this
// hex grid's neighbor offsets are PARITY-DEPENDENT (different for even
// vs odd rows; see `offsetNeighbors` in game.js), and the fixed table
// only ever matched the even-row case. On odd rows the "random" bot
// computed six coordinates the game's own validator did not consider
// adjacent, so MOVE actions built from them were rejected with
// OUT_OF_RANGE roughly half the time (whenever the bot's unit happened to
// be on an odd row) -- confirmed directly by running the bot repeatedly
// and observing the rejection. Importing the single source of truth for
// hex adjacency, instead of keeping a second, drifted copy of the same
// math in this file, closes this entire class of bug rather than fixing
// one instance of it.
function hexDistance(a, b) {
  const [aq, ar] = String(a).split(',').map(Number);
  const [bq, br] = String(b).split(',').map(Number);
  const ax = aq - (ar - (ar & 1)) / 2, az = ar, ay = -ax - az;
  const bx = bq - (br - (br & 1)) / 2, bz = br, by = -bx - bz;
  return Math.max(Math.abs(ax-bx), Math.abs(ay-by), Math.abs(az-bz));
}

function botAction(state, actor, rng, aggressive=false) {
  const p = state.playerMeta?.[actor];
  const unit = p ? [...state.units.values()].find(u => u.owner===actor) : null;
  if (!unit) return { type:'END_TURN', actor };
  const currentTile = state.tiles.get(unit.coord);
  // A resolved nebula tile blocks ATTACK/STEAL entirely for whoever's
  // standing on it (see validateAction's ACTION_BLOCKED check and
  // availableActions' matching `!(tile?.kind==='nebula' && tile.resolved)`
  // guard) -- a "the fog hides you, but it also blinds you" mechanic.
  // Without this check the aggressive bot occasionally proposed an ATTACK
  // that could never have appeared in that state's legal-action list at
  // all, rejected with ILLEGAL_ACTION -- confirmed directly (seed 5, step
  // 29: actor standing on a resolved nebula at "1,3", real adjacent
  // target at "1,2", dist()===1 by the engine's own cube-distance
  // formula, yet ATTACK absent from getLegalActions purely because of
  // this tile condition).
  const inBlockingNebula = currentTile?.kind === 'nebula' && currentTile.resolved;
  if (aggressive && !inBlockingNebula) {
    // Mirrors the server's own ATTACK legality rule (validateAction/
    // availableActions in game.js/legacy.cjs both exclude a target
    // sitting on its own home base -- a "safe base" rule): without this
    // check the bot occasionally targeted a freshly-spawned/returned
    // enemy still on its home tile, which the server correctly rejects
    // as ILLEGAL_ACTION since ATTACK never even appears in that state's
    // legal action list.
    const target = [...state.units.values()].find(u=>u.owner!==actor&&u.owner!=='tanker'&&u.hp>0&&u.coord!==u.home&&hexDistance(u.coord, unit.coord)<=1);
    if (target && unit.moves>0) return {type:'ATTACK',actor,target:target.owner};
  }
  const legal = lastSector.getLegalActions(state, actor).map(a=>a.type);
  if (legal.includes('SCAN')) return {type:'SCAN',actor};
  if (legal.includes('BUY_FUEL') && unit.fuel < 2) return {type:'BUY_FUEL',actor};
  // offsetNeighbors() -- the SAME function validateAction() itself uses
  // to decide what's adjacent -- already returns "q,r" strings, already
  // bounds-checked against the board, and is correct on both even and
  // odd rows. See the module-level comment above for why this file no
  // longer maintains its own, independently-drifted copy of hex-grid
  // neighbor math.
  let candidates = offsetNeighbors(unit.coord, state.cfg.w, state.cfg.h);
  // A 'directional_arrow' tile forces movement to exactly one coordinate
  // (see validateAction's FORCED_DIRECTION check) -- restrict candidates
  // to that single target when standing on one, instead of proposing
  // every geometric neighbor and letting the server reject whichever
  // ones aren't the forced direction. Not a correctness requirement (the
  // server is the actual authority and always validates independently),
  // but there is no reason for the bot to routinely propose moves it
  // could know in advance are illegal.
  if (currentTile?.kind === 'directional_arrow' && currentTile.forceTo) candidates = candidates.filter(to => to === currentTile.forceTo);
  const moves = candidates
    .filter(to => state.tiles.has(to) && !state.tiles.get(to).collapsed && ![...state.units.values()].some(u=>u.hp>0&&u.coord===to));
  if (legal.includes('MOVE') && moves.length) return {type:'MOVE',actor,to:rng.pick(moves)};
  return {type:'END_TURN',actor};
}

export const lastSectorPack = createGamePack({
  manifest: {
    // Every field below except apiVersion is DERIVED from the real,
    // on-disk manifest.json (imported above), not re-typed by hand --
    // see this file's own import comment for why. `id` is the one
    // deliberate rename: manifest.json uses `gameId` (its own,
    // separately-established convention -- see discoverGameCatalog()),
    // this runtime shape uses `id` (validateGamePack()'s own
    // convention) -- same real value, different key name, mapped
    // explicitly here rather than silently relying on both files
    // happening to agree on a key name neither actually enforces
    // against the other.
    id: staticManifest.gameId,
    name: staticManifest.name,
    version: staticManifest.version,
    // apiVersion is NOT in manifest.json and genuinely should not be --
    // it is the game-PACK-FORMAT contract version (from
    // @tablecore/game-pack's own PACK_API_VERSION), a different axis of
    // versioning entirely from this GAME's own version/engineCompatibility
    // (which describe this game's compatibility with the game-AUTHORING
    // API, @tablecore/game-api's GAME_API_VERSION) -- conflating the two
    // would be actively wrong, not just redundant.
    apiVersion: PACK_API_VERSION,
    engineCompatibility: staticManifest.engineCompatibility,
    minPlayers: staticManifest.minPlayers,
    maxPlayers: staticManifest.maxPlayers,
    hiddenInformation: staticManifest.hiddenInformation,
    capabilities: staticManifest.capabilities,
  },
  game:lastSector,
  content:contentCatalog,
  presentation:{ clients:['pc','mobile','tv'], map:'hex', cinematicEvents:['SECTOR_SCANNED','COMBAT_RESOLVED','NAVIGATION_GLITCH','GAME_FINISHED'] },
  bots:{ random:(state,actor,{rng})=>botAction(state,actor,rng,false), aggressive:(state,actor,{rng})=>botAction(state,actor,rng,true) }
});

export { lastSector, SHIPS, LOOT, contentCatalog, createLastSectorPresentation };
