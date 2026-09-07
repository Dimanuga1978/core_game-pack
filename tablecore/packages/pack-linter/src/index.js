/**
 * Static validation boundary for complete Game Packs.
 * This layer validates compatibility between runtime, content and authoring
 * declarations before a pack is launched. It never executes game actions.
 */
import { validateContentCatalog } from '@tablecore/content-sdk';
import { validateGamePack, PACK_API_VERSION } from '@tablecore/game-pack';
import { validateAuthoringBundle, AUTHORING_API_VERSION } from '@tablecore/authoring-sdk';
import { verifyTrustedPackDescriptor } from './trust.js';

const clone = (value) => structuredClone(value);
const ID_RE = /^[a-z][a-z0-9._-]*$/;

function push(diagnostics, severity, code, message, path = null) {
  diagnostics.push({ severity, code, message, ...(path ? { path } : {}) });
}

function checkId(id, label, diagnostics, path) {
  if (typeof id !== 'string' || !ID_RE.test(id)) {
    push(diagnostics, 'error', 'INVALID_ID', `Invalid ${label} id: ${String(id)}`, path);
    return false;
  }
  return true;
}

function checkObject(value, label, diagnostics, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    push(diagnostics, 'error', 'INVALID_OBJECT', `${label} must be an object`, path);
    return false;
  }
  return true;
}

function safeValidate(fn, value, diagnostics, code) {
  try {
    fn(value);
    return true;
  } catch (error) {
    push(diagnostics, 'error', code, error instanceof Error ? error.message : String(error));
    return false;
  }
}

function lintManifestParity(pack, authoring, diagnostics) {
  if (!checkObject(pack?.manifest, 'pack manifest', diagnostics, 'pack.manifest')) return;
  if (pack.manifest.apiVersion !== PACK_API_VERSION) {
    push(diagnostics, 'error', 'PACK_API_VERSION_MISMATCH', `Expected pack apiVersion ${PACK_API_VERSION}, got ${String(pack.manifest.apiVersion)}`, 'pack.manifest.apiVersion');
  }
  if (!authoring) return;
  if (pack.manifest.id !== authoring.manifest.id) {
    push(diagnostics, 'error', 'PACK_ID_MISMATCH', `Pack id ${pack.manifest.id} does not match authoring id ${authoring.manifest.id}`, 'manifest.id');
  }
  if (authoring.manifest.gamePackApiVersion && authoring.manifest.gamePackApiVersion !== pack.manifest.apiVersion) {
    push(diagnostics, 'error', 'GAME_API_VERSION_MISMATCH', `Authoring targets gamePackApiVersion ${authoring.manifest.gamePackApiVersion}, pack provides ${pack.manifest.apiVersion}`, 'manifest.gamePackApiVersion');
  }
}

function lintContentReferences(content, diagnostics) {
  if (!content || typeof content !== 'object') return;
  const objects = content.objects ?? {};
  const terrains = content.terrains ?? {};
  const terrainIds = new Set(Object.keys(terrains));
  const objectIds = new Set(Object.keys(objects));
  for (const [mapId, map] of Object.entries(content.maps ?? {})) {
    for (const [cellKey, cell] of Object.entries(map.cells ?? {})) {
      if (!terrainIds.has(cell.terrain)) push(diagnostics, 'error', 'UNKNOWN_TERRAIN_REF', `Map ${mapId}.${cellKey} references missing terrain ${cell.terrain}`, `content.maps.${mapId}.cells.${cellKey}.terrain`);
      if (cell.object != null && !objectIds.has(cell.object)) push(diagnostics, 'error', 'UNKNOWN_OBJECT_REF', `Map ${mapId}.${cellKey} references missing object ${cell.object}`, `content.maps.${mapId}.cells.${cellKey}.object`);
    }
  }
}

// These two checks require introspecting the *live* game.game function
// objects (via Function#toString), so they only run when a real `pack.game`
// was actually provided -- i.e. never in `staticOnly` mode, where the CLI
// deliberately refuses to import/execute any JavaScript at all (see
// tools/tablecore-pack-lint.js). Before this, nothing anywhere in the pack
// pipeline checked for non-deterministic rule code or for a pack declaring
// hidden information without actually implementing (or correctly using)
// the mechanisms that protect it -- both classes of bug an audit found in
// the one example game that used hidden information at all.
const DETERMINISM_SMELLS = [
  [/\basync\s*(function)?\b|\basync\s+[A-Za-z_$][\w$]*\s*=>|\basync\s*\(/, 'ASYNC_IN_RULE_CODE'],
  [/\bawait\b/, 'AWAIT_IN_RULE_CODE'],
  [/\bMath\.random\s*\(/, 'MATH_RANDOM_IN_RULE_CODE'],
  [/\bDate\.now\s*\(/, 'WALL_CLOCK_IN_RULE_CODE'],
  [/\bnew\s+Date\s*\(/, 'WALL_CLOCK_DATE_IN_RULE_CODE'],
];
const RULE_FUNCTION_NAMES = ['applyAction', 'applyActionInPlace', 'validateAction', 'getLegalActions', 'createInitialState', 'getGameStatus'];

function functionSource(fn) {
  try { return Function.prototype.toString.call(fn); } catch { return null; }
}

function lintRuleCodeDeterminism(pack, diagnostics) {
  if (!pack?.game || typeof pack.game !== 'object') return;
  for (const name of RULE_FUNCTION_NAMES) {
    const fn = pack.game[name];
    if (typeof fn !== 'function') continue;
    const src = functionSource(fn);
    if (src == null) continue;
    for (const [pattern, code] of DETERMINISM_SMELLS) {
      if (pattern.test(src)) {
        push(diagnostics, 'error', code,
          `game.${name} appears to use a non-deterministic input (matched ${code}). Randomness must flow through the provided context.rng, and wall-clock time must never influence rule outcomes, or replay() and dispatchMatchAction() will diverge between the original run and any later replay.`,
          `pack.game.${name}`);
      }
    }
  }
}

// runAction.js hands `applyActionInPlace` a live immer draft, never a
// plain object (see the long comment there for why this is a mandatory
// engine contract, not an opt-in). structuredClone() -- and this
// codebase's common `const clone = v => structuredClone(v)` convention --
// cannot walk an immer draft under any circumstances (verified directly:
// it throws DataCloneError whether the draft is live or already
// finalized). A call to either inside `applyActionInPlace`'s own source
// is therefore always a bug, not a style choice: it will throw at runtime
// the moment that code path is exercised, converted into
// GAME_EXECUTION_ERROR by runAction's fail-closed handling, but far
// better to catch it here, before the pack ever ships, than to discover
// it from every affected action silently failing in play.
const STRUCTURAL_SHARING_HAZARD = /\bstructuredClone\s*\(|\bclone\s*\(/;

function lintStructuralSharingCompatibility(pack, diagnostics) {
  if (!pack?.game || typeof pack.game !== 'object') return;
  const fn = pack.game.applyActionInPlace;
  if (typeof fn !== 'function') return; // only this entry point is ever drafted
  const src = functionSource(fn);
  if (src == null) return;
  if (STRUCTURAL_SHARING_HAZARD.test(src)) {
    push(diagnostics, 'error', 'STRUCTURED_CLONE_ON_DRAFT_IN_APPLY_ACTION_IN_PLACE',
      "game.applyActionInPlace appears to call structuredClone()/clone() on a value derived from `state`. `state` here is a live immer draft (see packages/core/src/runAction.js), and structuredClone() cannot clone an immer draft under any circumstances -- this will throw GAME_EXECUTION_ERROR at runtime the first time this code path runs. Use a plain spread ({...draft.thing}) or immer's own current() instead.",
      'pack.game.applyActionInPlace');
  }
}

// A real, external audit reproduced this exact failure mode directly
// against this engine: a synchronous applyActionInPlace that schedules
// deferred work (setTimeout/setInterval/a Promise/.then chain) touching
// the draft it was handed AFTER the recipe returns. runAction()'s own
// try/catch only wraps the SYNCHRONOUS produce() call -- by the time a
// setTimeout callback fires, produce() has already returned and revoked
// the draft's proxy, so the resulting TypeError ("Cannot perform 'set'
// on a proxy that has been revoked") happens on a LATER, independent
// event-loop tick, entirely outside that try/catch's own call stack.
// Confirmed directly, not assumed: an unguarded deferred write like this
// is an UNCAUGHT exception that terminates the whole Node process by
// default (verified: real exit code 1, every other in-flight match on
// the same in-process ServerHost lost with it) -- not merely a rejected
// action. This regex only catches the OBVIOUS, textually-visible form of
// the mistake (a determined author could still schedule deferred work
// indirectly, e.g. through a helper function this pack itself defines
// elsewhere) -- it is a real, meaningful backstop, not a complete
// guarantee, which is exactly why the OTHER layers of this same
// mitigation (documented rule-code contract, MatchWorkerPool isolation
// for untrusted packs in production) matter too, not this check alone.
const DEFERRED_SCHEDULING_HAZARD = /\bsetTimeout\s*\(|\bsetInterval\s*\(|\bqueueMicrotask\s*\(|\bnew\s+Promise\s*\(|\.then\s*\(|\bsetImmediate\s*\(/;

function lintDeferredSchedulingInApplyActionInPlace(pack, diagnostics) {
  if (!pack?.game || typeof pack.game !== 'object') return;
  const fn = pack.game.applyActionInPlace;
  if (typeof fn !== 'function') return; // only this entry point is ever drafted
  const src = functionSource(fn);
  if (src == null) return;
  if (DEFERRED_SCHEDULING_HAZARD.test(src)) {
    push(diagnostics, 'error', 'DEFERRED_SCHEDULING_IN_APPLY_ACTION_IN_PLACE',
      "game.applyActionInPlace appears to schedule deferred work (setTimeout/setInterval/queueMicrotask/setImmediate/a Promise/.then chain). `state` here is a live immer draft that gets revoked the instant this function returns -- any deferred callback that later reads or writes it throws a TypeError on an independent event-loop tick, entirely outside runAction()'s own synchronous error boundary, which by default TERMINATES THE WHOLE PROCESS (every other in-flight match lost with it), not just this one action. Rule code must never retain a reference to `state`/`draft` beyond the synchronous call to applyActionInPlace -- if part of the recipe genuinely needs to run later, capture only the specific PLAIN VALUES it needs (a spread, or immer's own current()) before scheduling, never the draft itself.",
      'pack.game.applyActionInPlace');
  }
}

function lintHiddenInformationVisibility(pack, diagnostics) {  if (!pack?.game || typeof pack.game !== 'object') return;
  const hasPlayerView = typeof pack.game.getPlayerView === 'function';
  const declaresHiddenInfo = pack.manifest?.hiddenInformation === true;
  if (declaresHiddenInfo && !hasPlayerView) {
    push(diagnostics, 'error', 'HIDDEN_INFORMATION_WITHOUT_PLAYER_VIEW',
      'manifest.hiddenInformation is true but game.getPlayerView is not implemented -- every viewer (including spectators) would receive the full, unredacted authoritative state via ServerHost.getSnapshot.',
      'pack.manifest.hiddenInformation');
  }
  if (hasPlayerView && !declaresHiddenInfo) {
    push(diagnostics, 'warning', 'UNDECLARED_HIDDEN_INFORMATION',
      'game.getPlayerView is implemented but manifest.hiddenInformation is not set to true. Declare it explicitly so tooling/reviewers know this pack has a privacy boundary that needs checking.',
      'pack.manifest.hiddenInformation');
  }
  if (!hasPlayerView) return;
  // Best-effort static nudge, not enforcement: the real protection is the
  // `audience` field on events plus filterEventsForViewer() at the
  // protocol/transport layer. A game whose state is correctly redacted by
  // getPlayerView but that never once scopes an event with `audience` is
  // exactly the shape of the bug this exists to catch: state.hidden info,
  // events.everything.
  let pushesEvents = false, usesAudience = false;
  for (const name of ['applyAction', 'applyActionInPlace']) {
    const src = functionSource(pack.game[name]);
    if (src == null) continue;
    if (/events\.push\s*\(/.test(src)) pushesEvents = true;
    if (/\baudience\s*:/.test(src)) usesAudience = true;
  }
  if (pushesEvents && !usesAudience) {
    push(diagnostics, 'warning', 'HIDDEN_INFORMATION_WITHOUT_EVENT_AUDIENCE',
      "game.getPlayerView redacts state per-viewer, but no event anywhere sets an 'audience' field -- events are broadcast to every subscriber unfiltered by default, which can leak exactly what getPlayerView hides. See packages/protocol's filterEventsForViewer.",
      'pack.game');
  }
}

export function lintGamePack({ pack, content = null, authoring = null, staticOnly = false, trustStore = null, requireSignature = false } = {}) {
  const diagnostics = [];
  if (staticOnly) {
    if (!checkObject(pack?.manifest, 'pack manifest', diagnostics, 'pack.manifest')) return Object.freeze(diagnostics.map(clone));
    if (pack.manifest.apiVersion !== PACK_API_VERSION) push(diagnostics, 'error', 'PACK_API_VERSION_MISMATCH', `Expected pack apiVersion ${PACK_API_VERSION}, got ${String(pack.manifest.apiVersion)}`, 'pack.manifest.apiVersion');
  } else {
    safeValidate(validateGamePack, pack, diagnostics, 'INVALID_GAME_PACK');
    lintRuleCodeDeterminism(pack, diagnostics);
    lintStructuralSharingCompatibility(pack, diagnostics);
    lintDeferredSchedulingInApplyActionInPlace(pack, diagnostics);
    lintHiddenInformationVisibility(pack, diagnostics);
  }
  if (content != null) {
    safeValidate(validateContentCatalog, content, diagnostics, 'INVALID_CONTENT_CATALOG');
    lintContentReferences(content, diagnostics);
  }
  if (authoring != null) safeValidate(validateAuthoringBundle, authoring, diagnostics, 'INVALID_AUTHORING_BUNDLE');
  lintManifestParity(pack, authoring, diagnostics);
  if (requireSignature) {
    const trust = verifyTrustedPackDescriptor(pack, trustStore ?? {});
    if (!trust.ok) push(diagnostics, 'error', trust.code, `Trusted pack verification failed: ${trust.code}`, 'trust');
  }
  // `authoring == null` means "this pack has no authoring bundle attached"
  // (a legitimate, common shape -- runtime-only packs), NOT "the
  // authoring API version is wrong". The unconditional check here used to
  // treat every runtime-only pack as an API-version mismatch, because
  // `undefined !== AUTHORING_API_VERSION` is always true -- rejecting
  // every pack that never had an authoring bundle to begin with. Only
  // check the API version when an authoring bundle is actually present.
  if (authoring != null && authoring?.manifest?.authoringApiVersion !== AUTHORING_API_VERSION) {
    push(diagnostics, 'error', 'AUTHORING_API_VERSION_MISMATCH', `Expected authoring API ${AUTHORING_API_VERSION}, got ${String(authoring?.manifest?.authoringApiVersion)}`, 'authoring.manifest.authoringApiVersion');
  }
  return Object.freeze(diagnostics.map(clone));
}

export function assertGamePackReady(bundle) {
  const diagnostics = lintGamePack(bundle);
  // Found via a manual code review, not a failing test (nothing in this
  // codebase's own real, shipped paths currently calls this exported
  // function): this used to throw on `diagnostics.length` alone --
  // but lintGamePack() returns BOTH 'error' and 'warning' severity
  // diagnostics (see lintHiddenInformationVisibility()'s own
  // UNDECLARED_HIDDEN_INFORMATION/HIDDEN_INFORMATION_WITHOUT_EVENT_AUDIENCE,
  // both deliberately warnings, not errors, per their own comments).
  // Confirmed directly: a pack with ZERO real errors, only a single
  // advisory warning, was incorrectly REJECTED here -- defeating the
  // entire purpose of having a separate, non-blocking warning severity
  // at all. Only 'error'-severity diagnostics are grounds to throw;
  // warnings remain visible in the returned/thrown message's own
  // absence (a caller wanting to see warnings too should call
  // lintGamePack() directly, as this project's own GAME_PACK_RIDER.md
  // §12 already recommends).
  const errors = diagnostics.filter((d) => d.severity === 'error');
  if (errors.length) {
    const message = errors.map((d) => `${d.code}: ${d.message}`).join('\n');
    throw new Error(message);
  }
  return true;
}

export function formatDiagnostics(diagnostics) {
  if (!Array.isArray(diagnostics) || diagnostics.length === 0) return 'PASS: Game Pack is valid';
  return diagnostics.map((d) => `${d.severity.toUpperCase()} ${d.code}${d.path ? ` [${d.path}]` : ''}: ${d.message}`).join('\n');
}

export { canonicalPackDescriptor, signPackDescriptor, verifyPackDescriptor, verifyTrustedPackDescriptor, readAndVerifyTrustedPack, readAndVerifyTrustedPackWithArtifact } from './trust.js';
export { computeArtifactManifest, verifyArtifactManifest, readDirectoryFileEntries } from './artifactDigest.js';
