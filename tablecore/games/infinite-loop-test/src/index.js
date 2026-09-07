// Test fixture (not a real game) for MatchWorkerPool.test.js's CPU
// watchdog (rpcTimeoutMs) test. See games/timebomb-test/README.md for why
// a test fixture lives under games/ instead of alongside the test file.
export const infiniteLoopGame = {
  version: 'infinite-loop-test@1',
  createInitialState({ players = ['A', 'B'] } = {}) {
    return { activePlayer: players[0], phase: 'playing', winner: null };
  },
  getLegalActions(state, actor) { return actor === state.activePlayer ? [{ type: 'HANG' }] : []; },
  getGameStatus() { return { finished: false, winner: null }; },
  applyActionInPlace(state, action) {
    if (action.type === 'HANG') {
      // A synchronous runaway loop -- nothing can preempt this from
      // outside except terminating the thread. This never returns, so
      // this worker never gets back to its message loop to respond.
      // eslint-disable-next-line no-constant-condition
      while (true) { /* spin forever */ }
    }
    return { state, events: [] };
  },
};
