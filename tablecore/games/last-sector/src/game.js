import { createRequire } from 'node:module';
import { enableMapSet } from 'immer';
import { createSeededRng, synthesizeApplyAction } from '@tablecore/core';

// Last Sector retains its rich legacy rules implementation, but is hosted by
// the current TableCore Game Pack contract. Immer Map/Set support is enabled
// because the legacy simulation uses Map/Set as authoritative runtime indexes.
enableMapSet();
const require = createRequire(import.meta.url);
const { createDefinition: createLegacyDefinition, SHIPS, LOOT } = require('./legacy/game.cjs');

const ACTIONS = Object.freeze(['MOVE','ATTACK','STEAL','SCAN','REPAIR','BUY_FUEL','BUY_TRAP','ATTACK_TANKER','END_TURN']);
// A real, confirmed logic bug found via manual, line-by-line review of
// the legacy event-emission call sites (not found by any test): the
// legacy game.cjs's own `ctx.emit('NAVIGATION_GLITCH',
// {bonusSeconds:...})` call site never included a `player`/`owner`
// field in its payload -- and NAVIGATION_GLITCH describes a GLOBAL,
// match-wide state change (extending the WHOLE session's shared time
// budget, see legacy/game.cjs's own `timeBonusSec` usage in its session-
// length calculation, which every player's own remaining-time math
// depends on equally), not something scoped to any one player. Because
// it WAS in this set, emit()'s own fallback chain
// (`payload?.player || payload?.owner || action?.actor`) silently
// scoped it to whichever player's own turn happened to be active when
// the periodic glitch check fired -- every OTHER player, who benefits
// from the exact same time extension, never received the event
// explaining why the match suddenly had more time left. Removed from
// this set entirely: this event is correctly public by nature, not
// merely "not private enough".
const PRIVATE_EVENTS = new Set(['SHIP_MOVED','RESOURCE_COLLECTED','LOOT_STOLEN','TRAP_TRIGGERED','TRAP_PLACED','NEBULA_ENTERED','NEBULA_EXIT_PROGRESS','ASTEROID_EXIT_PROGRESS','ACCELERATOR_PUSH','TANKER_ATTACKED','FUEL_PURCHASED','CARGO_DELIVERED','SCAN_RESOLVED']);

function clone(v) { return structuredClone(v); }
function idsOf(players) { return players.map(p => typeof p === 'string' ? p : p?.id).filter(Boolean); }

function legacyRandom(rng) {
  return {
    next: () => rng.next(),
    nextUint32: () => rng.nextUint32(),
    int: (min,max) => max === undefined ? rng.int(0, min - 1) : rng.int(min,max),
    pick: (items) => rng.pick(items),
    getState: () => rng.getState(),
    range(min,max) {
      if (!Number.isInteger(min) || !Number.isInteger(max) || max < min) throw new RangeError('Invalid range');
      return rng.int(min,max);
    },
    shuffle(items) {
      if (!Array.isArray(items)) throw new TypeError('shuffle requires an array');
      for (let i=items.length-1;i>0;i--) { const j=rng.int(0,i); [items[i],items[j]]=[items[j],items[i]]; }
      return items;
    }
  };
}

function normalizePlayers(players) {
  const ids = idsOf(players);
  if (ids.length < 2 || ids.length > 4) throw new RangeError('Last Sector supports 2-4 unique players');
  if (ids.some(id => !/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(id))) throw new TypeError('Invalid player id');
  if (new Set(ids).size !== ids.length) throw new TypeError('Duplicate player id');
  return ids;
}

function buildPlayerMeta(players, options) {
  const ids = normalizePlayers(players);
  const shipTypes = options?.shipTypes || options?.playerShipTypes || {};
  return Object.fromEntries(ids.map((id, i) => {
    const configured = Array.isArray(shipTypes) ? shipTypes[i] : shipTypes[id];
    return [id, { id, shipType: configured || ['scout','transport','warship'][i % 3], eliminated:false }];
  }));
}

function buildContext(state, action, rng, eventSink) {
  const playerMeta = state.playerMeta || {};
  const players = new Map(Object.entries(playerMeta).map(([id, p]) => [id, { ...p }]));
  return {
    state,
    actor: action?.actor,
    random: legacyRandom(rng),
    turn: state.turn,
    active: state.activePlayer,
    phase: state.phase,
    pending: false,
    players,
    turnOrder: { ids: [...players.keys()] },
    knowledge: {
      ensure(viewer, initial = { tiles:{} }) {
        state.knowledge ||= {};
        state.knowledge[viewer] ||= clone(initial);
        return state.knowledge[viewer];
      }
    },
    emit(type, payload = {}, audience = null) {
      const evt = { type, payload: payload == null ? {} : payload };
      const explicitAudience = audience == null ? null : [String(audience)];
      if (explicitAudience) evt.audience = explicitAudience;
      else if (PRIVATE_EVENTS.has(type)) {
        const actor = payload?.player || payload?.owner || action?.actor;
        if (actor != null) evt.audience = [String(actor)];
      }
      eventSink.push(evt);
    },
    emitPresentation(type, payload = {}) {
      // The manifest advertises a 'tv' capability with a dedicated
      // presentation stream (see games/last-sector/src/index.js's
      // `presentation:{clients:['pc','mobile','tv'],...}`), and this is
      // the function that's supposed to feed it -- but it only ever
      // scoped events to the acting player (`audience:[actor]`), never to
      // 'role:tv'. A TV/broadcast client subscribed to this match would
      // never receive a single cinematic presentation event: not one
      // SHIP_MOVE_ANIMATION, not one ROUTE_HIGHLIGHT, nothing. The
      // engine-level mechanism this needs (role:X audience targeting,
      // see packages/protocol/src/visibility.js) exists and is tested --
      // this pack simply never actually used it despite documentation
      // claiming otherwise. Fixed by adding 'role:tv' alongside the
      // existing actor scoping (not replacing it): a TV connection is an
      // omniscient broadcast viewer that should see every player's
      // presentation events, while each PLAYER's own visibility (their
      // own actions only, preserving whatever fog-of-war/privacy
      // intent the original actor-only scoping had) is left unchanged.
      const evt = { type, payload: payload == null ? {} : payload, presentation:true };
      const actor = payload?.player || payload?.owner || null;
      evt.audience = actor != null ? [String(actor), 'role:tv'] : ['role:tv'];
      eventSink.push(evt);
    },
    eliminate(id, reason) {
      const p = playerMeta[id];
      if (p) p.eliminated = true;
      state.eliminated ||= {};
      state.eliminated[id] = true;
      eventSink.push({ type:'PLAYER_ELIMINATED', payload:{ player:id, reason:String(reason) }, audience:[String(id)] });
    },
    finish(winner, reason) {
      state.phase = 'finished';
      state.winner = winner ?? null;
      state.result = { winner: winner ?? null, reason: reason ?? 'finished' };
      this.phase = 'finished';
    },
    endTurn(nextId, meta = {}) {
      state.turn = Number(state.turn || 0) + 1;
      state.activePlayer = nextId;
      this.turn = state.turn;
      this.active = nextId;
      eventSink.push({ type:'TURN_STARTED', payload:{ player:nextId, turn:state.turn, ...clone(meta) } });
    }
  };
}

function createInitialState(options = {}) {
  const players = Array.isArray(options.players) ? options.players : ['A','B'];
  const playerIds = normalizePlayers(players);
  if (options.playerCount != null && Number(options.playerCount) !== playerIds.length) throw new RangeError('playerCount must match players length');
  const setupOptions = { ...options, players: playerIds, playerCount: playerIds.length };
  const def = createLegacyDefinition(setupOptions);
  const base = def.createState();
  const state = clone(base);
  state.turn = 0;
  state.activePlayer = playerIds[0];
  state.phase = 'playing';
  state.winner = null;
  state.result = null;
  state.playerMeta = buildPlayerMeta(playerIds, setupOptions);
  state.knowledge = {};

  // Setup is deterministic content generation, not match-action RNG. A
  // separate setup stream prevents map generation from changing the action
  // RNG sequence used by replays.
  const setupRng = createSeededRng(setupOptions.seed ?? 0);
  const events = [];
  const ctx = buildContext(state, {actor:null}, setupRng, events);
  def.setup(ctx);
  return state;
}

function available(state, actor) {
  if (state.phase !== 'playing' || state.activePlayer !== actor || state.playerMeta?.[actor]?.eliminated) return [];
  const def = createLegacyDefinition(state.cfg || {});
  const rng = createSeededRng(0);
  const events = [];
  const ctx = buildContext(state, {actor}, rng, events);
  return def.availableActions(ctx, actor, ACTIONS).map(type => ({ type }));
}

function offsetNeighbors(coord, w, h) {
  const [q, r] = String(coord).split(',').map(Number);
  const dirs = r % 2 === 0
    ? [[1,0],[-1,0],[0,-1],[-1,-1],[0,1],[-1,1]]
    : [[1,0],[-1,0],[1,-1],[0,-1],[1,1],[0,1]];
  return dirs.map(([dq,dr]) => `${q+dq},${r+dr}`).filter(c => {
    const [cq, cr] = c.split(',').map(Number);
    return cq >= 0 && cr >= 0 && cq < w && cr < h;
  });
}

function unitAt(state, predicate) {
  return [...(state.units?.values?.() || [])].find(predicate) || null;
}

function cargoUsed(cargo) {
  return Array.isArray(cargo) ? cargo.reduce((sum, item) => sum + (Number(item?.slots) || 0), 0) : 0;
}

function canTakeCargo(unit, item) {
  return !!unit && !!item && cargoUsed(unit.cargo) + (Number(item.slots) || 0) <= unit.cargoSlots;
}

function validateAction(state, action) {
  if (!action || typeof action !== 'object' || typeof action.type !== 'string') return { code:'INVALID_ACTION' };
  if (state.phase !== 'playing') return { code:'MATCH_FINISHED' };
  if (state.activePlayer !== action.actor) return { code:'NOT_ACTIVE_PLAYER' };
  if (!state.playerMeta?.[action.actor]) return { code:'UNKNOWN_PLAYER' };
  const actorUnit = unitAt(state, u => u.owner === action.actor && u.hp > 0);
  if (!actorUnit) return { code:'NO_ACTIVE_SHIP' };
  const currentTile = state.tiles?.get?.(actorUnit.coord);
  const moveTo = action.type === 'MOVE'
    ? (typeof action.to === 'string' ? action.to : (action.target && Number.isInteger(action.target.q) && Number.isInteger(action.target.r) ? `${action.target.q},${action.target.r}` : null))
    : null;
  const targetTile = moveTo ? state.tiles?.get?.(moveTo) : null;
  switch (action.type) {
    case 'MOVE': {
      if (typeof moveTo !== 'string' || !/^\-?\d+,\-?\d+$/.test(moveTo)) return { code:'INVALID_TARGET' };
      const targetCoord = moveTo;
      if (!targetTile || targetTile.collapsed) return { code:'INVALID_TARGET' };
      if (actorUnit.moves < 1 || actorUnit.fuel <= 0) return { code:'NO_MOVE_RESOURCE' };
      if (!offsetNeighbors(actorUnit.coord, state.cfg.w, state.cfg.h).includes(targetCoord)) return { code:'OUT_OF_RANGE' };
      if (unitAt(state, u => u !== actorUnit && u.hp > 0 && u.coord === targetCoord)) return { code:'OCCUPIED' };
      if (currentTile?.kind === 'directional_arrow' && currentTile.forceTo && targetCoord !== currentTile.forceTo) return { code:'FORCED_DIRECTION' };
      break;
    }
    case 'ATTACK': {
      if (typeof action.target !== 'string' || !action.target) return { code:'INVALID_TARGET' };
      const target = unitAt(state, u => u.owner === action.target && u.hp > 0);
      if (!target || target.owner === actorUnit.owner || target.owner === 'tanker') return { code:'INVALID_TARGET' };
      if (actorUnit.moves < 1) return { code:'NO_MOVE_RESOURCE' };
      if (!offsetNeighbors(actorUnit.coord, state.cfg.w, state.cfg.h).includes(target.coord)) return { code:'OUT_OF_RANGE' };
      if (currentTile?.kind === 'nebula' && currentTile.resolved) return { code:'ACTION_BLOCKED' };
      if (target.coord === target.home) return { code:'INVALID_TARGET' };
      break;
    }
    case 'STEAL': {
      if (typeof action.target !== 'string' || !action.target) return { code:'INVALID_TARGET' };
      const target = unitAt(state, u => u.owner === action.target && u.hp > 0);
      if (!target || target.owner === actorUnit.owner || target.owner === 'tanker' || !Array.isArray(target.cargo) || !target.cargo.some(item => canTakeCargo(actorUnit, item))) return { code:'INVALID_TARGET' };
      if (actorUnit.moves < 1) return { code:'NO_MOVE_RESOURCE' };
      if (!offsetNeighbors(actorUnit.coord, state.cfg.w, state.cfg.h).includes(target.coord)) return { code:'OUT_OF_RANGE' };
      if (currentTile?.kind === 'nebula' && currentTile.resolved) return { code:'ACTION_BLOCKED' };
      if (target.coord === target.home) return { code:'INVALID_TARGET' };
      break;
    }
    case 'SCAN':
      if (actorUnit.moves < 1 || !actorUnit.scanAvailable || !currentTile || !['station','superstation'].includes(currentTile.kind)) return { code:'INVALID_ACTION' };
      break;
    case 'REPAIR':
      if (actorUnit.moves < 1 || (!actorUnit.coord || (currentTile?.kind !== 'station' && currentTile?.kind !== 'superstation' && actorUnit.coord !== actorUnit.home)) || (actorUnit.hp >= actorUnit.maxHp && actorUnit.fuel >= actorUnit.maxFuel)) return { code:'INVALID_ACTION' };
      break;
    case 'BUY_FUEL': {
      const score = state.scores?.get?.(actorUnit.owner) ?? 0;
      if (actorUnit.moves < 1 || actorUnit.fuel >= actorUnit.maxFuel || score < state.cfg.fuelPrice) return { code:'INVALID_ACTION' };
      break;
    }
    case 'BUY_TRAP': {
      const score = state.scores?.get?.(actorUnit.owner) ?? 0;
      const ownTraps = (state.traps || []).filter(t => t.owner === actorUnit.owner);
      const limit = 2 * (Math.max(2, Math.min(4, state.cfg.n)) - 1);
      if (!state.cfg.trapsEnabled || state.cfg.n < 4 || actorUnit.moves < 1 || score < state.cfg.trapPrice || ownTraps.length >= limit || ownTraps.some(t => t.coord === actorUnit.coord)) return { code:'INVALID_ACTION' };
      break;
    }
    case 'ATTACK_TANKER': {
      const tanker = unitAt(state, u => u.owner === 'tanker' && u.hp > 0);
      if (!tanker || actorUnit.moves < 1 || !offsetNeighbors(actorUnit.coord, state.cfg.w, state.cfg.h).includes(tanker.coord)) return { code:'INVALID_TARGET' };
      break;
    }
    case 'END_TURN':
      break;
    default:
      return { code:'UNKNOWN_ACTION' };
  }
  return true;
}

function createGame(options = {}) {
  const rules = {
    version: 'last-sector@1.0.0',
    createInitialState,
    getLegalActions(state, actor) { return available(state, actor); },
    validateAction,
    applyActionInPlace(state, action, context = {}) {
      const def = createLegacyDefinition(state.cfg || options || {});
      const events = [];
      const rng = context.rng;
      if (!rng) return { state, events:[{ type:'ACTION_REJECTED', code:'RNG_CONTEXT_REQUIRED' }], accepted:false, error:{code:'RNG_CONTEXT_REQUIRED'} };
      const normalizedAction = action.type === 'MOVE' && typeof action.to !== 'string' && typeof action.target === 'object'
        ? { ...action, to: `${action.target.q},${action.target.r}` }
        : action;
      const ctx = buildContext(state, normalizedAction, rng, events);
      const handler = def.actions?.[normalizedAction.type];
      if (typeof handler !== 'function') return { state, events:[{ type:'ACTION_REJECTED', code:'UNKNOWN_ACTION' }], accepted:false, error:{code:'UNKNOWN_ACTION'} };
      const accepted = handler(ctx, normalizedAction);
      if (!accepted) return { state, events:[{ type:'ACTION_REJECTED', code:'ACTION_REJECTED' }], accepted:false, error:{code:'ACTION_REJECTED'} };
      state.activePlayer = ctx.active;
      state.turn = ctx.turn;
      state.phase = ctx.phase;
      const victory = def.victory(ctx);
      if (victory && state.phase !== 'finished') ctx.finish(victory.winner, victory.reason);
      if (state.phase === 'finished' && !state.winner) state.winner = state.result?.winner ?? null;
      return { state, events, accepted:true };
    },
    getGameStatus(state) { return { finished:state.phase === 'finished', winner:state.winner ?? null }; },
    getPlayerView(state, viewer) {
      const def = createLegacyDefinition(state.cfg || options || {});
      const knowledge = state.knowledge?.[viewer] || { tiles:{} };
      const projectedResult = def.project(state, viewer, {}, { knowledge });
      const projected = projectedResult?.state || {};
      return {
        phase: state.phase,
        turn: state.turn,
        activePlayer: state.activePlayer,
        winner: state.winner ?? null,
        players: Object.fromEntries(Object.entries(state.playerMeta || {}).map(([id,p]) => [id,{id,shipType:p.shipType,eliminated:!!state.eliminated?.[id]}])),
        ...projected,
      };
    }
  };
  // applyAction synthesized from the shared, correct implementation in
  // @tablecore/core -- see games/grid-duel/src/game.js's own comment
  // for the full reasoning. This was real, hand-written code here once
  // (found broken via a real external audit: it dropped the third
  // `context` argument, causing RNG_CONTEXT_REQUIRED on every legal
  // action when called directly) -- the SAME class of bug independently
  // repeated in three of this project's other four real games, which is
  // exactly why this delegation now lives once, engine-side, instead of
  // being re-derived by hand in every game pack.
  return { ...rules, applyAction: synthesizeApplyAction(rules.applyActionInPlace) };
}

export const lastSector = createGame();
export { SHIPS, LOOT, offsetNeighbors };
