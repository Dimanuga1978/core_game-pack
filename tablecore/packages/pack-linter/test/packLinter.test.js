import test from 'node:test';
import assert from 'node:assert/strict';
import { lintGamePack, assertGamePackReady, formatDiagnostics } from '../src/index.js';
import { sectorExpeditionPack } from '@tablecore/game-sector-expedition';
import { sectorExpeditionAuthoring } from '@tablecore/game-sector-expedition/authoring';
import { contentCatalog } from '@tablecore/game-sector-expedition';

const validBundle = () => ({
  pack: sectorExpeditionPack,
  content: contentCatalog,
  authoring: sectorExpeditionAuthoring,
});

test('complete Sector Expedition bundle passes preflight lint', () => {
  const diagnostics = lintGamePack(validBundle());
  assert.deepEqual(diagnostics, []);
  assert.equal(assertGamePackReady(validBundle()), true);
});

// Regression test (MIG-04, external migration-derived review request):
// `authoring == null` used to be treated as "authoring API version
// mismatch" instead of "this pack has no authoring bundle" --
// `undefined !== AUTHORING_API_VERSION` is always true, so EVERY
// runtime-only pack (a legitimate, common shape -- see the Last Sector
// migration notes) failed preflight lint unconditionally, for a reason
// that had nothing to do with anything the pack actually did wrong.
test('a runtime-only pack with no authoring bundle passes lint (authoring=null is not an API mismatch)', () => {
  const bundle = validBundle();
  delete bundle.authoring;
  const diagnostics = lintGamePack(bundle);
  assert.ok(!diagnostics.some(d => d.code === 'AUTHORING_API_VERSION_MISMATCH'),
    `runtime-only packs must not be rejected for lacking an authoring bundle: ${JSON.stringify(diagnostics)}`);
});

test('a pack WITH an authoring bundle still gets its authoring API version checked (authoring=null does not silently disable this)', () => {
  const bundle = validBundle();
  bundle.authoring = { manifest: { id: sectorExpeditionPack.manifest.id, authoringApiVersion: 'not-a-real-version' } };
  const diagnostics = lintGamePack(bundle);
  assert.ok(diagnostics.some(d => d.code === 'AUTHORING_API_VERSION_MISMATCH'));
});

test('linter reports cross-layer manifest mismatch without throwing', () => {
  const bundle = validBundle();
  bundle.authoring = structuredClone(sectorExpeditionAuthoring);
  bundle.authoring.manifest.id = 'other-game';
  const diagnostics = lintGamePack(bundle);
  assert.ok(diagnostics.some((d) => d.code === 'PACK_ID_MISMATCH'));
  assert.match(formatDiagnostics(diagnostics), /PACK_ID_MISMATCH/);
});

test('linter catches missing content references', () => {
  const bundle = validBundle();
  bundle.content = structuredClone(contentCatalog);
  bundle.content.maps.demo = { cells: { '0,0': { q: 0, r: 0, terrain: 'missing-terrain', object: 'missing-object' } } };
  const diagnostics = lintGamePack(bundle);
  assert.ok(diagnostics.some((d) => d.code === 'UNKNOWN_TERRAIN_REF'));
  assert.ok(diagnostics.some((d) => d.code === 'UNKNOWN_OBJECT_REF'));
});

test('assertGamePackReady fails closed on incompatible content', () => {
  const bundle = validBundle();
  bundle.content = { terrains: [] };
  assert.throws(() => assertGamePackReady(bundle), /INVALID_CONTENT_CATALOG/);
});

// Regression tests: the linter used to only check manifest/content/authoring
// shape and cross-references. It never looked at the actual rule code at
// all, so a game could call Math.random()/Date.now() directly (silently
// breaking replay determinism) or declare hidden information without
// actually protecting it, and nothing in the pipeline would ever say so.
test('linter rejects rule code that calls Math.random() directly instead of context.rng', () => {
  const bundle = validBundle();
  bundle.pack = {
    ...sectorExpeditionPack,
    game: { ...sectorExpeditionPack.game, applyAction(state) { if (Math.random() > 0.5) {} return { state, events: [] }; } },
  };
  const diagnostics = lintGamePack(bundle);
  assert.ok(diagnostics.some((d) => d.code === 'MATH_RANDOM_IN_RULE_CODE' && d.severity === 'error'));
});

test('linter rejects rule code that reads the wall clock directly', () => {
  const bundle = validBundle();
  bundle.pack = {
    ...sectorExpeditionPack,
    game: { ...sectorExpeditionPack.game, applyAction(state) { const t = Date.now(); return { state, events: [] }; } },
  };
  const diagnostics = lintGamePack(bundle);
  assert.ok(diagnostics.some((d) => d.code === 'WALL_CLOCK_IN_RULE_CODE' && d.severity === 'error'));
});

test('linter rejects async rule code', () => {
  const bundle = validBundle();
  bundle.pack = {
    ...sectorExpeditionPack,
    game: { ...sectorExpeditionPack.game, async applyAction(state) { return { state, events: [] }; } },
  };
  const diagnostics = lintGamePack(bundle);
  assert.ok(diagnostics.some((d) => d.code === 'ASYNC_IN_RULE_CODE' && d.severity === 'error'));
});

test('linter requires getPlayerView when manifest declares hiddenInformation', () => {
  const bundle = validBundle();
  const game = { ...sectorExpeditionPack.game };
  delete game.getPlayerView;
  bundle.pack = { ...sectorExpeditionPack, manifest: { ...sectorExpeditionPack.manifest, hiddenInformation: true }, game };
  const diagnostics = lintGamePack(bundle);
  assert.ok(diagnostics.some((d) => d.code === 'HIDDEN_INFORMATION_WITHOUT_PLAYER_VIEW' && d.severity === 'error'));
});

test('linter warns when getPlayerView exists but hiddenInformation is not declared', () => {
  const bundle = validBundle();
  bundle.pack = { ...sectorExpeditionPack, manifest: { ...sectorExpeditionPack.manifest, hiddenInformation: undefined } };
  const diagnostics = lintGamePack(bundle);
  assert.ok(diagnostics.some((d) => d.code === 'UNDECLARED_HIDDEN_INFORMATION' && d.severity === 'warning'));
});

test('linter warns when a hidden-information game never scopes any event with audience', () => {
  const bundle = validBundle();
  const game = {
    ...sectorExpeditionPack.game,
    applyAction(state) { const events = [{ type: 'SOMETHING_HAPPENED' }]; events.push({ type: 'ANOTHER_THING' }); return { state, events }; },
    applyActionInPlace(state) { const events = [{ type: 'SOMETHING_HAPPENED' }]; events.push({ type: 'ANOTHER_THING' }); return { state, events }; },
  };
  bundle.pack = { ...sectorExpeditionPack, game };
  const diagnostics = lintGamePack(bundle);
  assert.ok(diagnostics.some((d) => d.code === 'HIDDEN_INFORMATION_WITHOUT_EVENT_AUDIENCE' && d.severity === 'warning'));
});

// Regression test: runAction()'s applyActionInPlace path always hands the
// game a live immer draft (see packages/core/src/runAction.js) --
// structuredClone() cannot walk a draft under any circumstances. This is
// exactly the bug this audit found in the shipped sector-expedition game
// itself (fixed since) -- catching it statically here means a pack never
// ships with a rule function that is guaranteed to throw the first time
// its code path actually runs.
test('linter rejects applyActionInPlace that calls structuredClone() on a value read from state', () => {
  const bundle = validBundle();
  const game = {
    ...sectorExpeditionPack.game,
    applyActionInPlace(state, action) {
      const snapshot = structuredClone(state.players[action.actor].position);
      return { state, events: [] };
    },
  };
  bundle.pack = { ...sectorExpeditionPack, game };
  const diagnostics = lintGamePack(bundle);
  assert.ok(diagnostics.some((d) => d.code === 'STRUCTURED_CLONE_ON_DRAFT_IN_APPLY_ACTION_IN_PLACE' && d.severity === 'error'));
});

test('linter rejects applyActionInPlace that calls a local clone() helper on state data', () => {
  const bundle = validBundle();
  const game = {
    ...sectorExpeditionPack.game,
    applyActionInPlace(state, action) {
      const clone = (v) => structuredClone(v);
      const snapshot = clone(state.players[action.actor].position);
      return { state, events: [] };
    },
  };
  bundle.pack = { ...sectorExpeditionPack, game };
  const diagnostics = lintGamePack(bundle);
  assert.ok(diagnostics.some((d) => d.code === 'STRUCTURED_CLONE_ON_DRAFT_IN_APPLY_ACTION_IN_PLACE' && d.severity === 'error'));
});

test('linter does not flag structuredClone() calls outside applyActionInPlace (e.g. in getPlayerView, which only ever sees plain committed state)', () => {
  const bundle = validBundle();
  const game = {
    ...sectorExpeditionPack.game,
    getPlayerView(state, viewer) { return structuredClone(state); }, // plain, committed state -- always safe here
  };
  bundle.pack = { ...sectorExpeditionPack, game };
  const diagnostics = lintGamePack(bundle);
  assert.ok(!diagnostics.some((d) => d.code === 'STRUCTURED_CLONE_ON_DRAFT_IN_APPLY_ACTION_IN_PLACE'));
});

test('static-only (JSON-only) linting never introspects rule code, matching the CLI\'s "never import JS" guarantee', () => {
  const diagnostics = lintGamePack({
    pack: { manifest: { id: 'x', name: 'X', version: '1.0.0', apiVersion: '1.0.0' } },
    staticOnly: true,
  });
  // No RULE-code or hidden-information diagnostics can appear here: there
  // is no `pack.game` at all in static mode, by construction.
  assert.ok(!diagnostics.some((d) => /RULE_CODE|HIDDEN_INFORMATION|STRUCTURED_CLONE/.test(d.code)));
});

// Regression tests for a real, external audit finding (E-02, reproduced
// directly against this engine before this check existed): a
// synchronous applyActionInPlace that schedules deferred work touching
// the immer draft it was handed, after it has already returned --
// runAction()'s own try/catch cannot catch a delayed callback firing on
// a LATER event-loop tick, so the resulting revoked-proxy TypeError is
// an UNCAUGHT exception that terminates the whole process by default
// (confirmed directly: real exit code 1, taking every other in-flight
// match down with it -- not merely a rejected action).

test('linter rejects applyActionInPlace that schedules a setTimeout touching state -- the EXACT pattern a real external audit reproduced as a process-crashing hazard', () => {
  const bundle = validBundle();
  const game = {
    ...sectorExpeditionPack.game,
    applyActionInPlace(state, action) {
      setTimeout(() => { state.value = 999; }, 50);
      return { state, events: [] };
    },
  };
  bundle.pack = { ...sectorExpeditionPack, game };
  const diagnostics = lintGamePack(bundle);
  assert.ok(diagnostics.some((d) => d.code === 'DEFERRED_SCHEDULING_IN_APPLY_ACTION_IN_PLACE' && d.severity === 'error'));
});

test('linter rejects applyActionInPlace that schedules a setInterval', () => {
  const bundle = validBundle();
  const game = {
    ...sectorExpeditionPack.game,
    applyActionInPlace(state, action) {
      setInterval(() => { state.value++; }, 100);
      return { state, events: [] };
    },
  };
  bundle.pack = { ...sectorExpeditionPack, game };
  const diagnostics = lintGamePack(bundle);
  assert.ok(diagnostics.some((d) => d.code === 'DEFERRED_SCHEDULING_IN_APPLY_ACTION_IN_PLACE' && d.severity === 'error'));
});

test('linter rejects applyActionInPlace that builds a Promise/.then chain around state', () => {
  const bundle = validBundle();
  const game = {
    ...sectorExpeditionPack.game,
    applyActionInPlace(state, action) {
      Promise.resolve().then(() => { state.value = 1; });
      return { state, events: [] };
    },
  };
  bundle.pack = { ...sectorExpeditionPack, game };
  const diagnostics = lintGamePack(bundle);
  assert.ok(diagnostics.some((d) => d.code === 'DEFERRED_SCHEDULING_IN_APPLY_ACTION_IN_PLACE' && d.severity === 'error'));
});

test('linter does not flag setTimeout/Promise usage outside applyActionInPlace (e.g. in getPlayerView, an unrelated function this check must not touch)', () => {
  const bundle = validBundle();
  const game = {
    ...sectorExpeditionPack.game,
    getPlayerView(state, viewer) {
      // Nonsensical here in practice, but proves this check is scoped
      // to applyActionInPlace specifically, not every function on the
      // game object.
      setTimeout(() => {}, 0);
      return state;
    },
  };
  bundle.pack = { ...sectorExpeditionPack, game };
  const diagnostics = lintGamePack(bundle);
  assert.ok(!diagnostics.some((d) => d.code === 'DEFERRED_SCHEDULING_IN_APPLY_ACTION_IN_PLACE'));
});

test('linter does not flag a normal, synchronous applyActionInPlace with no deferred scheduling at all', () => {
  const bundle = validBundle();
  const diagnostics = lintGamePack(bundle); // sectorExpeditionPack's own real, unmodified game
  assert.ok(!diagnostics.some((d) => d.code === 'DEFERRED_SCHEDULING_IN_APPLY_ACTION_IN_PLACE'));
});

// Regression test for a real bug found via manual code review (not a
// failing test): assertGamePackReady() used to throw on
// `diagnostics.length` alone -- but lintGamePack() returns BOTH
// 'error' and 'warning' severity diagnostics (see
// UNDECLARED_HIDDEN_INFORMATION, deliberately a warning, not an
// error). A pack with ZERO real errors, only a single advisory
// warning, was incorrectly rejected, defeating the entire purpose of
// having a separate, non-blocking warning severity at all.
test('assertGamePackReady does not throw for a pack with only warning-severity diagnostics, no real errors', () => {
  const bundle = validBundle();
  // sectorExpeditionPack's own real manifest already declares
  // hiddenInformation:true -- adding getPlayerView to IT would not
  // trigger UNDECLARED_HIDDEN_INFORMATION at all. Overriding the
  // manifest field explicitly here so this test's own precondition
  // (a pack that implements getPlayerView while NOT declaring
  // hiddenInformation) is genuinely met.
  const manifest = { ...sectorExpeditionPack.manifest, hiddenInformation: false };
  const game = { ...sectorExpeditionPack.game, getPlayerView(state) { return state; } };
  bundle.pack = { ...sectorExpeditionPack, manifest, game };
  const diagnostics = lintGamePack(bundle);
  assert.ok(diagnostics.some((d) => d.code === 'UNDECLARED_HIDDEN_INFORMATION' && d.severity === 'warning'));
  assert.ok(!diagnostics.some((d) => d.severity === 'error'));
  assert.equal(assertGamePackReady(bundle), true, 'a pack with zero errors, only a warning, must be accepted');
});

test('assertGamePackReady still throws for a pack with a real error, even if it also has warnings', () => {
  assert.throws(() => assertGamePackReady({ pack: { manifest: {} } }), /INVALID_GAME_PACK/);
});
