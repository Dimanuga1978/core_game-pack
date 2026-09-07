// Test fixture (not a real game) for MatchWorkerPool.test.js's memory
// resourceLimits test. See games/timebomb-test/README.md for why a test
// fixture lives under games/ instead of alongside the test file: it must
// be a real, dynamically-importable ES module reachable from a worker
// thread by file URL.
export const memoryHogGame = {
  version: 'memory-hog-test@1',
  createInitialState({ players = ['A', 'B'] } = {}) {
    return { activePlayer: players[0], phase: 'playing', winner: null, blobs: [] };
  },
  getLegalActions(state, actor) { return actor === state.activePlayer ? [{ type: 'ALLOCATE' }] : []; },
  getGameStatus() { return { finished: false, winner: null }; },
  applyActionInPlace(state, action) {
    if (action.type === 'ALLOCATE') {
      // Keeps growing on every call -- a pack that leaks memory (or does
      // this on purpose) should hit the worker's resourceLimits ceiling
      // and be killed by V8, not slowly take down the whole process.
      state.blobs.push(new Array(2_000_000).fill(7)); // ~16MB per call (8 bytes/slot)
    }
    return { state, events: [{ type: 'ALLOCATED', count: state.blobs.length }] };
  },
};
