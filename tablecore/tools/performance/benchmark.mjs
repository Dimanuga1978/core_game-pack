// --- Methodology note (read before trusting any number this prints) -----
//
// Two real code paths inside runAction() (packages/core/src/runAction.js),
// both exercised exactly as shipped, no hand-copied stand-ins:
//   - the "non-in-place" path: a game exposing only `applyAction` (no
//     `applyActionInPlace`) -- what any pack that doesn't implement the
//     in-place entry point pays today: structuredClone() of the whole
//     state, on every single action.
//   - the "in-place" path: a game implementing `applyActionInPlace`. This
//     is no longer an opt-in "structural sharing" flag -- runAction()
//     always hands an `applyActionInPlace` game a live immer draft and
//     structurally shares whatever a given action didn't touch. See the
//     long comment at the top of runAction.js for why this became the
//     mandatory contract instead of an opt-in, and
//     packages/core/test/runAction.structuralSharing.test.js for the
//     tests proving every shipped game is compliant.
//
// This script contains ZERO references to any specific game -- it is a
// generic runner over a pluggable "target" module (see --target below and
// tools/performance/targets/ for a real, worked example). An earlier
// version imported one specific game directly and hardcoded its map-
// building/action shape throughout; found and corrected after being
// asked directly whether ANY of this engine's own tooling should know
// about specific games. A benchmark still needs SOME real, complex
// workload to be meaningful -- what changed is that the workload is now
// supplied externally, the same "plug in, don't hardcode" pattern used
// by tools/server/start.mjs (games via TABLECORE_SERVER_CONFIG) and
// tools/launcher/generate-manifests.mjs (games via directory scanning).
//
// Usage: node tools/performance/benchmark.mjs --target=./targets/<name>.mjs
import { runAction } from '@tablecore/core';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const targetArg = process.argv.find(a => a.startsWith('--target='));
if (!targetArg) {
  console.error('Usage: node tools/performance/benchmark.mjs --target=<path to a target module>');
  console.error('A target module must export: { label, createState(scale), createAction(state), game }');
  console.error('See tools/performance/targets/ for a real, worked example against one of this repo\'s own games.');
  process.exit(1);
}
const targetPath = targetArg.slice('--target='.length);
const resolved = path.isAbsolute(targetPath) ? targetPath : path.resolve(process.cwd(), targetPath);
const target = await import(pathToFileURL(resolved).href);
const { label: targetLabel, createState, createAction, game } = target;
if (!createState || !createAction || !game) throw new Error(`Target module ${targetPath} must export { createState, createAction, game }`);

function inPlaceCapableGame() {
  return game; // as shipped -- if it implements applyActionInPlace, runAction() takes the structural-sharing path
}

function nonInPlaceOnlyGame() {
  // Same rules, but only the non-in-place entry point is exposed, so
  // runAction() is forced down its other real code path.
  const { applyActionInPlace, ...rest } = game;
  return { ...rest, applyAction: (state, action, context) => game.applyActionInPlace(structuredClone(state), action, context) };
}

function bench(g, state, n) {
  const start = process.hrtime.bigint();
  for (let i = 0; i < n; i++) {
    const action = createAction(state);
    const r = runAction({ game: g, state, action, context: { rng: null } });
    if (!r.ok) throw new Error('benchmark action failed: ' + JSON.stringify(r.error));
    state = r.state;
  }
  return Number(process.hrtime.bigint() - start) / 1e6;
}

// This is NOT a code path that exists in runAction.js anymore -- the
// plain-structuredClone in-place branch was removed entirely once
// structural sharing became mandatory for applyActionInPlace games (see
// the long comment at the top of runAction.js for why). It is reproduced
// here, standalone, purely to answer "what changed for a game that
// already implemented applyActionInPlace, compared to before this work":
// one structuredClone() of the whole state per action, then the same
// mutation, matching exactly what the removed branch used to do.
function benchHistoricalPlainCloneInPlace(state, n) {
  const start = process.hrtime.bigint();
  for (let i = 0; i < n; i++) {
    const action = createAction(state);
    const workingState = structuredClone(state);
    const result = game.applyActionInPlace(workingState, action, { rng: null });
    if (!result || result.state !== workingState) throw new Error('benchmark action failed');
    state = result.state;
  }
  return Number(process.hrtime.bigint() - start) / 1e6;
}

function run(label, scale, n) {
  const warmup = Math.max(50, Math.floor(n / 10));
  bench(nonInPlaceOnlyGame(), createState(scale), warmup);
  bench(inPlaceCapableGame(), createState(scale), warmup);
  benchHistoricalPlainCloneInPlace(createState(scale), warmup);
  const baseline = bench(nonInPlaceOnlyGame(), createState(scale), n);
  const inPlace = bench(inPlaceCapableGame(), createState(scale), n);
  const historicalPlainClone = benchHistoricalPlainCloneInPlace(createState(scale), n);
  return {
    label, scale, actions: n,
    nonInPlaceBaselineMs: baseline,
    historicalPlainCloneInPlaceMs: historicalPlainClone,
    inPlaceStructuralSharingMs: inPlace,
    speedupVsNonInPlace: baseline / inPlace,
    speedupVsHistoricalInPlace: historicalPlainClone / inPlace,
  };
}

console.log(`Benchmark target: ${targetLabel}\n`);
const results = [
  run('small scale', 2, 5000),
  run('large scale', 20, 3000),
  run('huge scale', 35, 800),
];

console.log(JSON.stringify(results, null, 2));
console.log('\nspeedupVsHistoricalInPlace is the actual before/after for a game that already implemented applyActionInPlace:');
console.log('it grows with scale instead of staying flat, because the historical path was O(total state size) per action');
console.log('regardless of what changed, and the current mandatory path only copies what a given action actually mutated.');
console.log('speedupVsNonInPlace is the separate, larger question of "why implement applyActionInPlace at all".');
