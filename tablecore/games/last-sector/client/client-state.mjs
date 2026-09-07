// Transforms the raw protocol snapshot (`{id,status,players,state,
// result,version,spectatorPolicy,availableActions}` -- see packages/
// server/src/ServerHost.js's getSnapshot()) into the shape games/
// last-sector/player-ui and tv-ui's rendering code actually reads.
//
// This is deliberately a thin pass-through with a few convenience
// aliases, not a real transform: `state.tiles`/`state.units`/
// `state.scores` already arrive in exactly the shape the UI needs
// (arrays of plain objects with the right field names) straight from
// game.js's getPlayerView() -- verified directly against a real
// ServerHost snapshot, not assumed. `active` and top-level `scores` are
// added as convenience aliases for `state.activePlayer`/`state.scores`
// because that's what the existing render() code in player-ui/main.js
// already reads; `availableActions` is passed through as-is (added to
// the snapshot server-side specifically to make this possible -- a
// client cannot safely compute this itself, since it only ever sees the
// projected, not authoritative, state shape).
export function reduceLastSectorEvent(rawSnapshot) {
  const state = rawSnapshot?.state ?? null;
  return {
    ...rawSnapshot,
    state,
    active: state?.activePlayer ?? null,
    scores: state?.scores ?? {},
    availableActions: rawSnapshot?.availableActions ?? [],
  };
}
