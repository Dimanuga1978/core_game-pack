import { createHash } from 'node:crypto';
import { createSeededRng, RNG_ALGORITHM } from '../rng/SeededRng.js';
import { runAction } from '../runAction.js';
import { ENGINE_VERSION } from '../version.js';

// --- Replay provenance -----------------------------------------------
//
// A `gameVersion` equality check (the previous state of this file) is
// necessary but not sufficient: a replay can depend on more than one
// version string. The engine build itself changes (a rule-execution bug
// fix, an RNG algorithm change -- see the xoshiro128** migration this
// engine already went through once). The game pack's content can change
// independently of its code version. None of that was captured before,
// so "gameVersion matches" could still replay against a subtly different
// engine or content and produce a different, wrong result with no
// warning that the comparison was incomplete.
//
// This header is deliberately built from values this engine can actually
// compute today, not aspirational fields with nothing behind them:
//   - engineVersion / rngAlgorithm: explicit constants (see version.js,
//     SeededRng.js) -- exactly the kind of "this changed silently before"
//     class of bug the RNG-algorithm migration (Mulberry32 -> xoshiro128**)
//     is a real, concrete example of.
//   - gamePackDigest: a hash over the actual *source text* of the game's
//     rule functions (via Function#toString(), the same mechanism
//     pack-linter already uses), not just its `version` string --
//     catches "the code changed but nobody bumped the version" the same
//     way a content/artifact digest would, without requiring a file
//     system or a package manager (this engine has neither for packs
//     today; see PACK_SECURITY-equivalent notes elsewhere in this repo).
//   - contentDigest: a canonical hash over the pack's content catalog.
//   - initialStateDigest: a canonical hash over the recorded initial
//     state, so a replay record's `initialState` field being edited or
//     corrupted independently of the rest of the record is detectable.
//
// `gamePackDigest`/`contentDigest` are only computed/checked when a full
// `pack` (a createGamePack() result, with `.manifest`/`.game`/`.content`)
// is supplied to createReplay()/playReplay() -- both functions remain
// fully backward compatible with the bare `game` parameter for callers
// who don't need or want that.

function sha256Hex(text) { return createHash('sha256').update(text).digest('hex'); }

// Deterministic, key-order-independent JSON serialization -- the same
// requirement pack-signature.js's canonicalPackDescriptor()/trust.js's
// stable() already solve for signing; reimplemented minimally here rather
// than importing across package boundaries (core should not depend on
// pack-linter).
function stableStringify(value) {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function digestValue(value) {
  if (value === undefined) return null;
  return `sha256:${sha256Hex(stableStringify(value))}`;
}

const RULE_FUNCTION_NAMES = ['createInitialState', 'getLegalActions', 'validateAction', 'applyAction', 'applyActionInPlace', 'getGameStatus', 'getPlayerView', 'secrets'];

function digestGameCode(game) {
  if (!game || typeof game !== 'object') return null;
  const parts = RULE_FUNCTION_NAMES.map(name => {
    const fn = game[name];
    return `${name}:${typeof fn === 'function' ? Function.prototype.toString.call(fn) : ''}`;
  });
  return `sha256:${sha256Hex(parts.join('\u0000'))}`;
}

export function createReplay({ gameVersion = 'dev', seed = 0, initialState, actions = [], pack = null, content = null, engineVersion = ENGINE_VERSION } = {}) {
  if (!initialState) throw new TypeError('initialState is required');
  const clonedInitialState = structuredClone(initialState);
  const normalizedSeed = Number(seed) >>> 0;
  return {
    gameVersion,
    seed: normalizedSeed,
    initialState: clonedInitialState,
    actions: structuredClone(actions),
    // Full provenance header (external remediation request, "Replay
    // provenance is incomplete"). `simulationSeed` is the same value as
    // `seed`, exposed under the requested name; `seed` is kept as the
    // primary field so nothing that already reads `replay.seed` breaks.
    // `content` is accepted as its own parameter, matching this
    // codebase's established convention (see pack-linter's
    // `lintGamePack({pack, content, authoring})`) of keeping a pack's
    // content catalog as a sibling concept rather than a nested
    // `pack.content` field -- most shipped packs' own `manifest`/`game`
    // object literal does not carry a `content` key at all.
    engineVersion,
    rngAlgorithm: RNG_ALGORITHM,
    simulationSeed: normalizedSeed,
    gamePackId: pack?.manifest?.id ?? null,
    gamePackVersion: pack?.manifest?.version ?? null,
    gamePackDigest: pack?.game ? digestGameCode(pack.game) : null,
    contentDigest: content !== null ? digestValue(content) : null,
    initialStateDigest: digestValue(clonedInitialState),
  };
}

export function playReplay({ game, pack = null, content = null, replay, ignoreVersionMismatch = false, ignoreProvenanceMismatch = ignoreVersionMismatch }) {
  const effectiveGame = pack?.game ?? game;
  if (!effectiveGame) throw new TypeError('playReplay requires either `game` or `pack`');

  const mismatches = [];
  if (effectiveGame.version != null && replay?.gameVersion != null && String(effectiveGame.version) !== String(replay.gameVersion)) {
    mismatches.push({ field: 'gameVersion', recorded: replay.gameVersion, current: effectiveGame.version });
  }
  if (replay?.engineVersion != null && replay.engineVersion !== ENGINE_VERSION) {
    mismatches.push({ field: 'engineVersion', recorded: replay.engineVersion, current: ENGINE_VERSION });
  }
  if (replay?.rngAlgorithm != null && replay.rngAlgorithm !== RNG_ALGORITHM) {
    mismatches.push({ field: 'rngAlgorithm', recorded: replay.rngAlgorithm, current: RNG_ALGORITHM });
  }
  if (pack && replay?.gamePackDigest != null) {
    const currentDigest = digestGameCode(pack.game);
    if (currentDigest !== replay.gamePackDigest) mismatches.push({ field: 'gamePackDigest', recorded: replay.gamePackDigest, current: currentDigest });
  }
  if (replay?.contentDigest != null) {
    const currentDigest = content !== null ? digestValue(content) : null;
    if (currentDigest !== replay.contentDigest) mismatches.push({ field: 'contentDigest', recorded: replay.contentDigest, current: currentDigest });
  }
  if (replay?.initialStateDigest != null) {
    const currentDigest = digestValue(replay.initialState);
    if (currentDigest !== replay.initialStateDigest) mismatches.push({ field: 'initialStateDigest', recorded: replay.initialStateDigest, current: currentDigest });
  }

  if (!ignoreProvenanceMismatch && mismatches.length) {
    return {
      ok: false,
      state: null,
      results: [],
      error: {
        code: 'REPLAY_PROVENANCE_MISMATCH',
        message: `Replay provenance does not match the current engine/pack/content (${mismatches.map(m => m.field).join(', ')}). Pass ignoreProvenanceMismatch:true to replay anyway.`,
        mismatches,
      },
    };
  }

  const rng = createSeededRng(replay.seed);
  let state = structuredClone(replay.initialState);
  const results = [];
  for (const action of replay.actions) {
    // `seed` is deliberately NOT included here (this used to be
    // `context: { rng, seed: replay.seed }`) -- found via a manual,
    // line-by-line code review specifically checking whether the
    // equivalent fix already applied to dispatchMatchAction() (see
    // packages/core/src/match/createMatch.js's own comment on removing
    // `context.seed` there, in response to an external audit finding)
    // had actually been applied consistently everywhere the engine
    // passes context into a game's rule code -- it had not: this
    // second, separate call site was missed entirely, and none of the
    // regression tests written for the createMatch.js fix covered this
    // file at all, since they only exercised dispatchMatchAction().
    // Same reasoning as before: nothing in this engine's own production
    // code, nor any of its five real games, ever reads context.seed for
    // anything -- `rng` (the actual, correct way rule code should ever
    // need randomness) is unaffected.
    const result = runAction({ game: effectiveGame, state, action, context: { rng } });
    results.push(result);
    if (!result.ok) return { ok: false, state, results, failedAction: structuredClone(action) };
    state = result.state;
  }
  return { ok: true, state, results, rngState: rng.getState() };
}
