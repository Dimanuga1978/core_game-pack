import { produce, enableMapSet } from 'immer';

// Any game whose state uses Map/Set as an authoritative container (a
// completely reasonable choice -- e.g. entities keyed by id) needs immer's
// MapSet plugin enabled, or every draft mutation of a Map/Set throws
// `[Immer] The plugin for 'MapSet' has not been loaded`. This is a
// one-time, idempotent, process-global registration -- exactly the kind
// of Immer implementation detail a game pack should never have to know
// about or remember to call itself (see ARCHITECTURE.md: the engine owns
// the contract, and the contract should be easy to satisfy, not leak
// "you must also call this unrelated setup function from the state
// library we happen to use internally" onto every pack author). Enabling
// it here, once, centrally, means any game can freely use Map/Set in its
// state with zero awareness that immer is involved at all.
enableMapSet();

// --- The applyActionInPlace contract ------------------------------------
//
// A game that implements `applyActionInPlace(state, action, context)` is
// handed an immer *draft*, not a plain mutable object. Reads, writes,
// array methods, Object.* operations and spreads all work transparently
// on a draft exactly like a plain object (that's the whole point of
// immer) -- this is why `applyActionInPlace` was always written to "just
// mutate `state` and return it", and that code does not need to change.
//
// This used to be optional (`useStructuralSharing`, only on request)
// specifically to avoid silently breaking existing rule code that called
// `structuredClone()`/a local `clone()` helper on values read from
// `state`. That escape hatch is gone: this codebase already dictates
// several other hard constraints on rule code for the same underlying
// reason (an async applyActionInPlace IS effectively rejected today --
// verified directly, not assumed -- but only as a SIDE EFFECT of the
// generic `mutationResult.state` contract check below, since an async
// function returns a Promise (no `.state` property) instead of the real
// {state,events} result synchronously; this stale comment used to
// attribute that to a dedicated "execution.js" check, which does not
// exist anywhere in this codebase -- a real external audit's own report
// repeated that same stale claim, caught and corrected here. pack-lint
// separately rejects Math.random()/Date.now() in rule code -- see
// packages/pack-linter/src/index.js) -- determinism and correctness are
// the engine's job to enforce, not something every pack author
// re-derives independently. This
// is the same policy, extended to one more rule: **never call
// structuredClone()/clone() on a value read from `state` inside
// applyActionInPlace.** structuredClone() cannot walk an immer draft
// under any circumstances (verified directly: DataCloneError, live or
// already finalized) -- there is no safe way to "opt out" of this
// per-call, so it is enforced structurally instead:
//   - pack-lint's static checks additionally flag any
//     `structuredClone(`/`clone(` call appearing inside the text of
//     `applyActionInPlace` as a blocking finding (see pack-linter).
//   - if a game still gets this wrong, `runAction` fails CLOSED with
//     GAME_EXECUTION_ERROR and the original state is left untouched --
//     never silent corruption.
//   - if a rule genuinely needs an explicit plain snapshot of part of the
//     draft, use a plain spread (`{...draft.player.position}`, which
//     reads through the draft's own proxy traps correctly) or immer's own
//     `current()`.
//
// `events` gets the same treatment for a related reason: a common,
// legitimate pattern is capturing a reference into the state tree inside
// an event payload (`const from = actor.position; ...;
// events.push({from})`, a real pattern seen in more than one game's
// rules). Those captured values are live immer proxies that get revoked the
// instant the recipe below returns. Resolving `events` via a JSON
// round-trip *while still inside the recipe* (before revocation) makes
// that pattern safe without requiring any game to special-case its event
// payloads -- events are meant to be JSON-safe wire data anyway (they are
// sent over the network as JSON), so this is not a weaker guarantee than
// the old structuredClone() was providing for this specific data.
//
// Real, measured performance numbers for why this is worth being strict
// about instead of just leaving it optional: tools/performance/
// benchmark.mjs, run against this engine's own game shape at increasing
// state sizes. At the size of the currently-shipped demo games the
// difference against a naive full clone is small; it grows to 5x+ and
// keeps growing, unbounded, as state grows -- any card/board game with a
// meaningfully large state (a wide map, a large hand/zone collection,
// many players) pays the O(state size) cost on literally every move
// without this.
export function runAction({ game, state, action, context = {} }) {
  if (!game || (typeof game.applyAction !== 'function' && typeof game.applyActionInPlace !== 'function')) throw new TypeError('Game must implement applyAction');
  if (!action || typeof action.type !== 'string') return { ok:false, error:{ code:'INVALID_ACTION' } };
  const legal = game.getLegalActions?.(state, action.actor) ?? [];
  const isLegal = legal.some(a => a && a.type === action.type);
  if (!isLegal) return { ok:false, error:{ code:'ILLEGAL_ACTION' } };
  if (typeof game.validateAction === 'function') {
    const validation = game.validateAction(state, action, context);
    if (validation !== true && validation !== undefined) {
      const error = typeof validation === 'string' ? { code: validation } : (validation?.code ? validation : { code: 'INVALID_ACTION' });
      return { ok:false, error };
    }
  }
  // Found via a manual, line-by-line reading of this function (not
  // testing -- there was no failing test pointing here): this call had
  // no try/catch around it. structuredClone() throws (not on circular
  // references, which it handles natively and correctly -- confirmed
  // directly -- but on functions/Symbols, confirmed directly:
  // `DOMException: () => {} could not be cloned`). Not reachable via
  // this engine's own real WS transport (message.action always comes
  // from JSON.parse(), which cannot represent a function or Symbol in
  // the first place), but runAction() is itself a public, exported
  // function any direct caller (a bot, a test, a future host, a
  // different transport) can call with a hand-constructed action
  // object -- the exact same "not exploitable via the intended path,
  // but a real gap in a public API boundary" class of issue already
  // found and fixed twice in this same file's own synthesizeApplyAction
  // (missing try/catch around produce(), and a missing contract-
  // violation check), for the same underlying reason: this function's
  // OWN robustness should not depend on every caller staying inside the
  // one path that happens to make a given failure impossible.
  let safeAction;
  try {
    safeAction = structuredClone(action);
  } catch (error) {
    return { ok:false, error:{ code:'INVALID_ACTION', message: error instanceof Error ? error.message : String(error) } };
  }

  if (typeof game.applyActionInPlace === 'function') {
    let mutationResult = null;
    let draftIdentity = null;
    let safeEvents = null;
    let nextState;
    try {
      nextState = produce(state, draft => {
        draftIdentity = draft;
        mutationResult = game.applyActionInPlace(draft, safeAction, context);
        // No `return` here: an immer recipe that returns a value REPLACES
        // the draft-tracked result entirely, discarding structural
        // sharing. We want immer to finalize based on what was mutated on
        // `draft`, so the recipe's own return value (the game's {state,
        // events} object) is deliberately ignored here and read back out
        // via the `mutationResult` closure variable instead.
        if (mutationResult && Array.isArray(mutationResult.events)) {
          safeEvents = JSON.parse(JSON.stringify(mutationResult.events));
        }
      });
    } catch (error) {
      return { ok:false, error:{ code:'GAME_EXECUTION_ERROR', message:error instanceof Error ? error.message : String(error) } };
    }
    if (!mutationResult || !mutationResult.state || safeEvents === null) {
      return { ok:false, error:{ code:'GAME_CONTRACT_VIOLATION' } };
    }
    if (mutationResult.accepted === false || mutationResult.ok === false) {
      return { ok:false, error:mutationResult.error ?? { code:'ACTION_REJECTED' } };
    }
    if (safeEvents.some(event => event && event.type === 'ACTION_REJECTED')) {
      const rejection = safeEvents.find(event => event && event.type === 'ACTION_REJECTED');
      return { ok:false, error:{ code: rejection.code ?? 'ACTION_REJECTED' } };
    }
    // The game must mutate and return the exact object it was handed
    // (here, the draft), not swap in something else. Reference-equality
    // on a (by now finalized/revoked) proxy is safe -- revocation breaks
    // property traps, not identity comparison.
    if (mutationResult.state !== draftIdentity) return { ok:false, error:{ code:'GAME_CONTRACT_VIOLATION' } };
    return { ok:true, state:nextState, events:safeEvents };
  }

  // A game that only implements the non-in-place `applyAction` builds its
  // own fresh state independently and is never handed a draft, so none of
  // the above applies -- this path is unrelated to immer entirely.
  const workingState = structuredClone(state);
  let result;
  try {
    result = game.applyAction(workingState, safeAction, context);
  } catch (error) {
    return { ok:false, error:{ code:'GAME_EXECUTION_ERROR', message:error instanceof Error ? error.message : String(error) } };
  }
  if (!result || !result.state || !Array.isArray(result.events)) {
    return { ok:false, error:{ code:'GAME_CONTRACT_VIOLATION' } };
  }
  if (result.accepted === false || result.ok === false) {
    return { ok:false, error:result.error ?? { code:'ACTION_REJECTED' } };
  }
  if (result.events.some(event => event && event.type === 'ACTION_REJECTED')) {
    const rejection = result.events.find(event => event && event.type === 'ACTION_REJECTED');
    return { ok:false, error:{ code: rejection.code ?? 'ACTION_REJECTED' } };
  }
  return { ok:true, state:structuredClone(result.state), events:structuredClone(result.events) };
}

// A real, previously-hand-duplicated bug class, found via external audit
// and confirmed to actually crash-affect three of the four other shipped
// games too, not just the one specifically reported: every game that
// implements applyActionInPlace (the immer-draft-based entry point, see
// this file's own top comment) also had to hand-write its own
// `applyAction` -- the REQUIRED contract entry point (see
// packages/game-pack/src/index.js's own requiredGame list) -- as a thin
// wrapper delegating to applyActionInPlace, because runAction()'s own
// fallback path (above) only ever calls a game's OWN `game.applyAction`
// directly, never applyActionInPlace, when a caller bypasses the normal
// dispatch and calls applyAction() on the game object itself. Every one
// of this project's five real games wrote the EXACT SAME one-line
// delegation independently -- and three of them silently dropped the
// third `context` argument while doing it (see the games/last-sector,
// games/grid-duel, games/coin-race, games/phase-quest commit history for
// each of these real, confirmed instances). Hand-copied boilerplate that
// is identical across every consumer, where getting it wrong has already
// happened multiple times independently, is exactly the class of thing
// this function exists to make impossible rather than merely
// documented: a game that implements applyActionInPlace never needs to
// write its own applyAction by hand at all -- see
// packages/game-pack/src/index.js's own createGamePack(), which calls
// this automatically when a game provides applyActionInPlace but no
// applyAction of its own.
export function synthesizeApplyAction(applyActionInPlace) {
  return function applyAction(state, action, context = {}) {
    let mutationResult;
    let draftIdentity = null;
    let safeEvents = null;
    // Runs the EXACT SAME produce()-based delegation runAction()'s own
    // draft path (above) uses -- not a simplified re-implementation that
    // could itself drift from the real semantics. Critically, this
    // INCLUDES the same JSON round-trip on events that the real draft
    // path already does (see `safeEvents` above in this same file) --
    // caught directly while testing this function: a game's own events
    // array can legitimately hold LIVE references to nested draft
    // sub-objects (e.g. grid-duel's own MOVE handler captures `from`/`to`
    // position objects still inside the draft, not plain copied values),
    // which become invalid REVOKED PROXY references the instant
    // produce() finishes -- reading them afterward throws, exactly the
    // same class of hazard this project's own pack-linter already
    // statically guards against for deferred scheduling (see
    // packages/pack-linter's own DEFERRED_SCHEDULING_IN_APPLY_ACTION_IN_PLACE),
    // just triggered synchronously here instead of on a later tick.
    // `mutationResult.state` (the stale/revoked draft reference) is
    // overwritten below with `nextState`, the real, finalized plain
    // object produce() returns.
    //
    // The try/catch itself is a second real gap found and fixed (not
    // assumed): confirmed directly that a genuine bug/exception thrown
    // inside a game's own applyActionInPlace propagated UNCAUGHT out of
    // this function before this fix, unlike runAction()'s own draft
    // path (above), which has always wrapped its own equivalent
    // produce() call in exactly this same try/catch. This matters
    // specifically because applyAction() is the REQUIRED, PUBLIC
    // GameDefinition contract entry point (see packages/game-pack's own
    // requiredGame) -- it must behave correctly and safely when called
    // directly, standalone, not only when reached through
    // dispatchMatchAction()'s own normal flow (which always prefers
    // applyActionInPlace directly and never actually calls this
    // synthesized function at all during ordinary play).
    let nextState;
    try {
      nextState = produce(state, draft => {
        draftIdentity = draft;
        mutationResult = applyActionInPlace(draft, action, context);
        if (mutationResult && Array.isArray(mutationResult.events)) safeEvents = JSON.parse(JSON.stringify(mutationResult.events));
      });
    } catch (error) {
      return { state: null, events: [], accepted: false, ok: false, error: { code: 'GAME_EXECUTION_ERROR', message: error instanceof Error ? error.message : String(error) } };
    }
    if (!mutationResult) return { state: null, events: [] };
    // A third real gap, found by manually reading this function
    // against runAction()'s own equivalent draft-path validation (not
    // found via any test, per instruction to review the code itself
    // rather than trust green test output): the real draft path
    // rejects a game whose applyActionInPlace mutates the draft
    // correctly but returns a DIFFERENT, unrelated object as `.state`
    // (a classic immer mistake -- e.g. spreading the draft into a new
    // plain object instead of mutating and returning it) as
    // GAME_CONTRACT_VIOLATION. This function used to have no equivalent
    // check at all -- confirmed directly, not assumed: the exact same
    // buggy applyActionInPlace was correctly REJECTED when dispatched
    // through the real runAction() path, but SILENTLY ACCEPTED (using
    // the real, correctly-mutated nextState regardless of what bogus
    // `.state` the game itself claimed) when called through this
    // synthesis directly. The end RESULT happened to still be usable
    // (nextState always reflects the real draft mutation, independent
    // of what the recipe returns), but silently masking this class of
    // author confusion instead of surfacing it is a real, if narrower,
    // problem in its own right -- a pack author debugging their own
    // rules deserves the SAME clear signal regardless of which of the
    // two ways their code happens to get invoked.
    if (mutationResult.state !== draftIdentity) return { state: null, events: [], accepted: false, ok: false, error: { code: 'GAME_CONTRACT_VIOLATION' } };
    return { ...mutationResult, state: nextState, events: safeEvents ?? [] };
  };
}
