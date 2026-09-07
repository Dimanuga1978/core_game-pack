import { runAction } from '../runAction.js';
import { createSeededRng } from '../rng/SeededRng.js';

const clone = (value) => structuredClone(value);

// A real external audit finding (E-04): match.events accumulated via
// `[...match.events, ...events]` on every single action, with no bound
// at all -- genuinely unbounded memory growth AND an O(current length)
// copy cost on every action (O(n^2) total over a match's full
// lifetime). Confirmed directly before fixing: nothing in this entire
// codebase's production code ever actually READS the accumulated
// match.events array (only ever writes/appends to it) -- playReplay()
// reconstructs a match from its own, separately-recorded
// `replay.actions` log, not from this field at all, so bounding this to
// a recent window breaks no real functionality. Kept as a genuinely
// bounded recent-history window (not deleted entirely) in case a future
// diagnostic/debugging consumer wants SOME limited visibility without
// needing a full durable event store -- a full permanent archive
// belongs in a real persistence/event-store layer, not the live,
// in-memory match object every single action already has to copy.
const MAX_RECENT_MATCH_EVENTS = 100;
function appendBoundedEvents(previousEvents, newEvents) {
  const combined = [...previousEvents, ...newEvents];
  return combined.length > MAX_RECENT_MATCH_EVENTS ? combined.slice(-MAX_RECENT_MATCH_EVENTS) : combined;
}

// Canonical player-id format for this engine. Defined here (in core, the
// most foundational package) rather than in packages/protocol, so that
// protocol/auth's token issuance can import and reuse this single
// definition instead of maintaining its own copy that could drift out of
// sync -- there is exactly one legitimate shape for a player id, checked
// in exactly one place, at both the point a match is created AND the
// point a token is issued for one.
export const PLAYER_ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
// A real, previously-unvalidated gap found via research into how mature
// game-server engines handle this class of thing: a CALLER-SUPPLIED
// match id (see tools/server/start.mjs's own `body.matchId ||
// \`match-${Date.now()}...\`` -- an arbitrary string straight from an
// HTTP request body) was never checked against any safe-character
// pattern at all, anywhere in the engine, before this. Not yet
// exploitable in THIS codebase today (matchId is never used to build a
// filesystem path anywhere currently), but it is exactly the kind of
// latent gap that turns into a real path-traversal vulnerability the
// moment something DOES use a match id to build a path -- e.g. a
// persistence layer that saves one file per match, keyed by id. Fixed
// at the SAME layer PLAYER_ID_RE already lives at, for the same reason:
// there is exactly one legitimate shape for a match id, checked in
// exactly one place, rather than trusting every future caller to
// remember to validate it themselves.
export const MATCH_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const MAX_PLAYERS = 16;

export function createMatch({ id, game, players = [], options = {}, spectatorPolicy = 'deny' }) {
  if (!game || typeof game.createInitialState !== 'function' || typeof game.getGameStatus !== 'function') {
    throw new TypeError('Game must implement createInitialState and getGameStatus');
  }
  if (id != null && !(typeof id === 'string' && MATCH_ID_RE.test(id))) {
    throw new TypeError(`Match id, when explicitly provided, must be a non-empty string matching ${MATCH_ID_RE}`);
  }
  if (!Array.isArray(players) || players.length < 1) throw new TypeError('Match requires players');
  if (players.length > MAX_PLAYERS) throw new TypeError(`Match players exceeds maximum of ${MAX_PLAYERS}`);
  if (!players.every(p => typeof p === 'string' && PLAYER_ID_RE.test(p))) {
    throw new TypeError(`Every player id must be a non-empty string matching ${PLAYER_ID_RE}`);
  }
  if (new Set(players).size !== players.length) throw new TypeError('Player ids must be unique');
  const SPECTATOR_POLICIES = new Set(['deny', 'public']);
  if (!SPECTATOR_POLICIES.has(spectatorPolicy)) throw new TypeError(`spectatorPolicy must be one of ${[...SPECTATOR_POLICIES].join('|')}`);
  return {
    // Found via a manual, line-by-line code review (not testing): the
    // previous default (`\`match-${Date.now()}\`` alone) had NO
    // collision resistance at all -- confirmed directly, not assumed:
    // 1000 rapid createMatch() calls with no explicit id produced only
    // 7 unique ids (993 collisions), since Date.now()'s millisecond
    // resolution is far coarser than how fast a tight loop (or any
    // reasonably fast real usage -- a batch script, a test suite, a
    // future host implementation) actually runs. The real, shipped
    // admin API (tools/server/start.mjs) happened to be safe already,
    // since its OWN matchId generation independently includes a random
    // suffix -- but this core library's own PUBLIC, documented default
    // was not, meaning any OTHER direct consumer inherited a genuinely
    // broken default. ServerHost.createMatch() does detect a collision
    // (`MATCH_EXISTS`) rather than silently overwriting an existing
    // match, but that just turns the bug into confusing, load-dependent
    // creation failures instead of data corruption -- still a real,
    // now-fixed gap, not an acceptable fallback behavior.
    id: id ?? `match-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    status: 'lobby',
    // Frozen, not just copied: `players` is never reassigned by any
    // lifecycle transition below (startMatch/dispatchMatchAction/
    // abortMatch all shallow-spread `{...match, ...}`, which carries this
    // exact array reference forward, unchanged, across the match's entire
    // lifetime). A caller who mutates a `.players` array obtained from any
    // one returned match object -- `result.match.players.push(...)` --
    // would otherwise silently corrupt every match snapshot ever derived
    // from it, past and future, since they all alias the same array.
    // ServerHost's own external API is already safe (it always returns a
    // fresh structuredClone()), but these core primitives are usable
    // directly, and match participants are immutable for a match's entire
    // lifetime by design (no add/remove-player feature exists) -- so
    // freezing turns an accidental mutation into a loud, immediate
    // TypeError at the mutation site instead of silent, hard-to-trace
    // state corruption.
    players: Object.freeze([...players]),
    // Default deny, not "allow unless configured otherwise": a common,
    // dangerous pattern elsewhere in transport/auth code is "ACL
    // undefined => allow" (see the spectator-access fail-open finding
    // this replaces). Infrastructure code should default the other way --
    // absence of an explicit grant means no access. A match that wants
    // to be spectatable (a public broadcast, a "watch this game" feature)
    // has to say so explicitly at creation time.
    spectatorPolicy,
    state: null,
    result: null,
    version: 0,
    seed: Number(options.seed ?? 0) >>> 0,
    rngState: null,
    // Same reasoning as `players`: never reassigned after creation, so
    // frozen to fail loud rather than silently alias-corrupt every
    // subsequent match snapshot.
    options: Object.freeze(clone(options)),
    events: [{ type: 'MATCH_CREATED' }],
  };
}

// Fields a caller-supplied `context` must never be able to override when
// merged into createInitialState()'s own options -- found via a real
// external audit: the previous unconditional `{...match.options,
// ...context}` spread let `context` (merged LAST) silently override
// even `players` itself, a genuine confused-deputy primitive even
// though NO real caller in this codebase currently passes a non-empty
// context to startMatch() at all (confirmed directly: zero real usages,
// production or test) -- exactly the kind of "not yet exploited, but
// too permissive to leave as-is" gap worth closing at the primitive
// itself rather than trusting every future caller to remember not to.
const RESERVED_START_CONTEXT_FIELDS = new Set(['players', 'matchId', 'id', 'seed', 'version', 'status', 'events', 'options']);

function stripReservedContextFields(context) {
  const safe = {};
  for (const [key, value] of Object.entries(context)) {
    if (!RESERVED_START_CONTEXT_FIELDS.has(key)) safe[key] = value;
  }
  return safe;
}

export function startMatch({ match, game, context = {} }) {
  if (match.status !== 'lobby') return { ok: false, error: { code: 'MATCH_NOT_STARTABLE' }, match };
  const rng = createSeededRng(match.seed);
  // `match.options` is ALSO stripped now, not just `context` -- found
  // via external audit review: `match.options` preserves whatever raw
  // options object the caller originally passed to createMatch()
  // (see its own `options: Object.freeze(clone(options))`), which
  // still contains a real `seed` field if the caller included one
  // there (last-sector's own real usage: `options: {seed: 42, ...}` --
  // `match.seed` itself is DERIVED from `options.seed` at creation
  // time, but the ORIGINAL field survives inside `match.options`
  // regardless). The `context` half of this spread was already
  // stripped; `match.options` was not, leaving the exact same
  // structural leak risk this fix already closed for context alone.
  // Confirmed directly, not assumed: none of this engine's five real
  // games actually put the raw seed value into their returned state
  // today, so this closes a latent, not-yet-exploited gap, the same
  // way the equivalent context fix already did.
  const state = game.createInitialState({ ...stripReservedContextFields(match.options), ...stripReservedContextFields(context), players: match.players });
  const next = { ...match, status: 'running', state, version: match.version + 1, rngState: rng.getState() };
  const events = [{ type: 'MATCH_STARTED', players: [...next.players] }];
  next.events = appendBoundedEvents(match.events, events);
  return { ok: true, match: next, events };
}

export function dispatchMatchAction({ match, game, action, context = {} }) {
  if (match.status !== 'running') return { ok: false, error: { code: 'MATCH_NOT_RUNNING' }, match };
  const rng = createSeededRng(match.seed, match.rngState ?? match.seed);
  // `seed` itself is deliberately NOT included here (an earlier version
  // did: `{ ...context, rng, seed: match.seed }`) -- found via external
  // audit review: nothing in this engine's own production code, nor any
  // of its five real games, ever reads `context.seed` for anything
  // (confirmed directly by searching the whole codebase before removing
  // this). The primitive was structurally too permissive regardless of
  // current non-exploitation: a rule author who spread `context` into a
  // returned event or state (an easy, plausible mistake) would leak the
  // raw seed, letting anyone who saw it predict every future "random"
  // outcome for the rest of the match. `rng` (the actual, correct way
  // rule code should ever need randomness) is unaffected.
  const result = runAction({
    game,
    state: match.state,
    action,
    context: { ...context, rng },
  });
  if (!result.ok) return { ...result, match };
  const next = { ...match, state: result.state, version: match.version + 1, rngState: rng.getState() };
  const status = game.getGameStatus(result.state);
  const lifecycleEvents = [];
  if (status?.finished) {
    next.status = 'finished';
    next.result = { winner: status.winner ?? null };
    lifecycleEvents.push({ type: 'MATCH_FINISHED', result: clone(next.result) });
  }
  const events = [...result.events, ...lifecycleEvents];
  next.events = appendBoundedEvents(match.events, events);
  return { ok: true, match: next, events };
}

export function abortMatch({ match, reason = 'ABORTED' }) {
  if (match.status === 'finished') return { ok: false, error: { code: 'MATCH_ALREADY_FINISHED' }, match };
  const next = { ...match, status: 'aborted', result: { reason }, version: match.version + 1 };
  const events = [{ type: 'MATCH_ABORTED', reason }];
  next.events = appendBoundedEvents(match.events, events);
  return { ok: true, match: next, events };
}
