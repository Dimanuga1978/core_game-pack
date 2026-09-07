/** Minimal, explicit Game Pack contract. Packs are content definitions, not engine subclasses. */
import { GAME_API_VERSION, isEngineCompatible } from '@tablecore/game-api';
import { synthesizeApplyAction } from '@tablecore/core';
export const PACK_API_VERSION = '1.0.0';
const clone = (v) => structuredClone(v);
const requiredGame = ['createInitialState','getLegalActions','applyAction','getGameStatus'];
export function validateGamePack(pack) {
  if (!pack || typeof pack !== 'object') throw new TypeError('Game pack must be an object');
  const m = pack.manifest;
  if (!m || typeof m !== 'object') throw new TypeError('Game pack requires manifest');
  for (const key of ['id','name','version','apiVersion']) if (typeof m[key] !== 'string' || !m[key]) throw new TypeError(`Invalid manifest.${key}`);
  if (m.apiVersion !== PACK_API_VERSION) throw new TypeError(`Unsupported pack apiVersion: ${m.apiVersion}`);
  // `engineCompatibility` used to exist on manifests (e.g.
  // ">=2.0.0-alpha.1 <3.0.0") and mean nothing -- nothing anywhere ever
  // read it. It is checked against GAME_API_VERSION here: that is the
  // actual semver-shaped game-authoring contract version a pack is
  // written against (see game-api's own module doc comment for why,
  // and for the full compatibility-checking implementation this reuses).
  // A pack that never declares the field makes no claim and is not
  // checked (isEngineCompatible(undefined, ...) === true); a pack that
  // DOES declare a range it turns out not to satisfy fails validation
  // loudly, at pack-load time, instead of silently loading anyway and
  // failing in some less obvious way at first actual use.
  if (m.engineCompatibility != null && !isEngineCompatible(m.engineCompatibility, GAME_API_VERSION)) {
    throw new TypeError(`Pack ${m.id}@${m.version} declares engineCompatibility "${m.engineCompatibility}", incompatible with the current game API version ${GAME_API_VERSION}`);
  }
  if (!pack.game || typeof pack.game !== 'object') throw new TypeError('Game pack requires game');
  for (const key of requiredGame) if (typeof pack.game[key] !== 'function') throw new TypeError(`Game pack game missing ${key}`);
  if (pack.presentation && typeof pack.presentation !== 'object') throw new TypeError('presentation must be metadata object');
  if (pack.game.validateAction && typeof pack.game.validateAction !== 'function') throw new TypeError('validateAction must be a function');
  if (pack.game.getPlayerView && typeof pack.game.getPlayerView !== 'function') throw new TypeError('getPlayerView must be a function');
  if (pack.bots && typeof pack.bots !== 'object') throw new TypeError('bots must be an object');
  return true;
}
export function createGamePack(pack) {
  // A real, previously-hand-duplicated bug class, found via external
  // audit and confirmed to affect three of the four other shipped games
  // too, not just the one specifically reported: every game that
  // implements applyActionInPlace also had to hand-write its own
  // `applyAction` (the REQUIRED contract entry point, see requiredGame
  // above) as a thin delegating wrapper -- and three of this project's
  // five real games silently dropped the third `context` argument while
  // doing it, independently, each time. See
  // packages/core/src/runAction.js's own synthesizeApplyAction() for the
  // full history and the correct, single, reusable implementation of
  // this delegation (including a real, found-and-fixed hazard of its
  // own: an event object can legitimately hold live references to
  // nested draft sub-objects that become invalid the instant produce()
  // finishes). A game that provides applyActionInPlace never needs to
  // write applyAction by hand at all -- it is synthesized here,
  // automatically, before validation runs, so requiredGame's own check
  // below is satisfied without every pack author re-deriving the same
  // one-line wrapper (and risking getting it wrong, as three already
  // did). A game that DOES provide its own applyAction explicitly is
  // never overridden -- this only fills a genuine gap, never replaces an
  // author's own deliberate implementation.
  let game = pack.game;
  if (game && typeof game === 'object' && typeof game.applyActionInPlace === 'function' && typeof game.applyAction !== 'function') {
    game = { ...game, applyAction: synthesizeApplyAction(game.applyActionInPlace.bind(game)) };
  }
  const normalizedPack = game === pack.game ? pack : { ...pack, game };
  validateGamePack(normalizedPack);
  return Object.freeze({ ...normalizedPack, manifest: Object.freeze(clone(normalizedPack.manifest)) });
}
export function createPackRegistry() {
  const packs = new Map();
  return Object.freeze({
    register(pack) { const checked = createGamePack(pack); if (packs.has(checked.manifest.id)) throw new Error(`Pack already registered: ${checked.manifest.id}`); packs.set(checked.manifest.id, checked); return checked; },
    get(id) { return packs.get(id) ?? null; },
    list() { return [...packs.values()].map(p => ({ ...p.manifest })); }
  });
}

export { createFlow, getPhaseActions, resolveFlow } from './flow.js';
