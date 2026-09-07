// A minimal, real game module (not a mock) used specifically to
// demonstrate worker-crash isolation with the exact "ordinary programmer
// mistake" pattern found during the audit: a rule that schedules a
// deferred mutation of its own draft state. This throws once the timer
// fires (the draft is already finalized/revoked by then) -- an uncaught
// exception that, run in-process, would take the entire server down. Run
// inside a MatchWorkerPool worker, it only takes down that one worker.
export const timeBombGame = {
  version: 'timebomb-test@1',
  createInitialState({ players = ['A', 'B'] } = {}) {
    return { activePlayer: players[0], value: 1, phase: 'playing', winner: null };
  },
  getLegalActions(state, actor) {
    return actor === state.activePlayer ? [{ type: 'ARM' }] : [];
  },
  getGameStatus() { return { finished: false, winner: null }; },
  applyActionInPlace(state, action) {
    if (action.type === 'ARM') {
      // The exact bug: fires after this function returns and immer has
      // already finalized/revoked the draft.
      setTimeout(() => { state.value = 999; }, 30);
    }
    return { state, events: [{ type: 'ARMED' }] };
  },
};
