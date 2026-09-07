import test from 'node:test';
import assert from 'node:assert/strict';
import { Visibility, resolveAudience, viewerCanSee, filterEventsForViewerWithPolicy } from '../src/visibility.js';

// P0-IFLOW (external remediation request): "the security-sensitive
// metadata originates in executable Game Pack code" -- these tests prove
// the specific centralization requirements from that request directly
// against the policy primitives, not just end-to-end through one game.

test('resolveAudience: array-audience ids are validated against real match participants, not trusted as-is', () => {
  const r = resolveAudience(['A', 'GHOST'], ['A', 'B']);
  assert.equal(r.policy, 'PLAYERS');
  assert.deepEqual(r.ids, ['A']);
  assert.deepEqual(r.invalidIds, ['GHOST'], 'a pack cannot grant visibility to an id that was never a real participant -- surfaced, not silently trusted');
});

test('resolveAudience: null/omitted is PUBLIC, unchanged from before', () => {
  assert.deepEqual(resolveAudience(null, ['A', 'B']), { policy: 'PUBLIC' });
  assert.deepEqual(resolveAudience(undefined, ['A', 'B']), { policy: 'PUBLIC' });
});

test('resolveAudience: Visibility.MATCH resolves to every current participant', () => {
  const r = resolveAudience(Visibility.MATCH, ['A', 'B', 'C']);
  assert.equal(r.policy, 'MATCH');
  assert.deepEqual(r.ids, ['A', 'B', 'C']);
});

test('resolveAudience: Visibility.SPECTATOR and Visibility.DENY are distinct, previously-inexpressible policies', () => {
  assert.equal(resolveAudience(Visibility.SPECTATOR, ['A']).policy, 'SPECTATOR');
  assert.equal(resolveAudience(Visibility.DENY, ['A']).policy, 'DENY');
});

test('resolveAudience: a malformed audience value fails closed, same as before', () => {
  assert.equal(resolveAudience('not-an-array-or-symbol', ['A']).policy, 'MALFORMED');
  assert.equal(resolveAudience(42, ['A']).policy, 'MALFORMED');
});

test('viewerCanSee: PUBLIC events reach players and spectators alike', () => {
  const event = { type: 'X' };
  assert.equal(viewerCanSee(event, { id: 'A', role: 'player', matchPlayers: ['A', 'B'] }), true);
  assert.equal(viewerCanSee(event, { id: null, role: 'spectator', matchPlayers: ['A', 'B'] }), true);
});

test('viewerCanSee: Visibility.MATCH reaches players in the match, never spectators', () => {
  const event = { type: 'X', audience: Visibility.MATCH };
  assert.equal(viewerCanSee(event, { id: 'A', role: 'player', matchPlayers: ['A', 'B'] }), true);
  assert.equal(viewerCanSee(event, { id: 'B', role: 'player', matchPlayers: ['A', 'B'] }), true);
  assert.equal(viewerCanSee(event, { id: null, role: 'spectator', matchPlayers: ['A', 'B'] }), false);
});

test('viewerCanSee: Visibility.SPECTATOR reaches spectators only, never any player -- even one who happens to also be a match participant', () => {
  const event = { type: 'X', audience: Visibility.SPECTATOR };
  assert.equal(viewerCanSee(event, { id: null, role: 'spectator', matchPlayers: ['A', 'B'] }), true);
  assert.equal(viewerCanSee(event, { id: 'A', role: 'player', matchPlayers: ['A', 'B'] }), false);
});

test('viewerCanSee: Visibility.DENY reaches nobody, including the actor who presumably caused the event', () => {
  const event = { type: 'X', audience: Visibility.DENY };
  assert.equal(viewerCanSee(event, { id: 'A', role: 'player', matchPlayers: ['A', 'B'] }), false);
  assert.equal(viewerCanSee(event, { id: null, role: 'spectator', matchPlayers: ['A', 'B'] }), false);
});

test('viewerCanSee: a player-array audience naming an id that is not a real participant reaches nobody claiming that id (fails closed on the invalid entry, not open)', () => {
  const event = { type: 'X', audience: ['GHOST'] };
  // Nobody in the match is 'GHOST', so nobody should see it -- this also
  // guards against a future connection somehow claiming a non-participant
  // id and matching a stale/buggy audience entry by coincidence.
  assert.equal(viewerCanSee(event, { id: 'A', role: 'player', matchPlayers: ['A', 'B'] }), false);
});

test('filterEventsForViewerWithPolicy: end-to-end mix of every policy for one viewer', () => {
  const events = [
    { type: 'PUBLIC_EVENT' },
    { type: 'MATCH_EVENT', audience: Visibility.MATCH },
    { type: 'SPECTATOR_EVENT', audience: Visibility.SPECTATOR },
    { type: 'DENY_EVENT', audience: Visibility.DENY },
    { type: 'PLAYERS_EVENT', audience: ['A'] },
    { type: 'OTHER_PLAYERS_EVENT', audience: ['B'] },
  ];
  const forA = filterEventsForViewerWithPolicy(events, { id: 'A', role: 'player', matchPlayers: ['A', 'B'] }).map(e => e.type);
  assert.deepEqual(forA, ['PUBLIC_EVENT', 'MATCH_EVENT', 'PLAYERS_EVENT']);

  const forSpectator = filterEventsForViewerWithPolicy(events, { id: null, role: 'spectator', matchPlayers: ['A', 'B'] }).map(e => e.type);
  assert.deepEqual(forSpectator, ['PUBLIC_EVENT', 'SPECTATOR_EVENT']);
});

// `role:X` targeting (external audit request, "role-scoped event
// visibility" -- Last Sector's TV presentation channel needs cinematic
// events visible to a TV client but not to a player client, which plain
// PUBLIC/player-id-array/MATCH/SPECTATOR could not express).
test('resolveAudience: role:X entries in an array target any viewer whose role matches exactly', () => {
  const r = resolveAudience(['role:tv'], ['A', 'B']);
  assert.equal(r.policy, 'PLAYERS');
  assert.deepEqual(r.roles, ['tv']);
  assert.deepEqual(r.ids, []);
});

test('resolveAudience: role:X and player ids can be mixed in the same audience array', () => {
  const r = resolveAudience(['role:tv', 'A'], ['A', 'B']);
  assert.deepEqual(r.roles, ['tv']);
  assert.deepEqual(r.ids, ['A']);
});

test('resolveAudience: a bare "role:" with nothing after the colon is malformed, not "matches no role"', () => {
  assert.equal(resolveAudience(['role:'], ['A']).policy, 'MALFORMED');
});

test('resolveAudience: a non-string array entry fails the WHOLE event closed, not just that entry', () => {
  assert.equal(resolveAudience([42], ['A']).policy, 'MALFORMED');
  assert.equal(resolveAudience([null], ['A']).policy, 'MALFORMED');
});

test('viewerCanSee: role:tv reaches a tv-role viewer, not a player or a generic spectator', () => {
  const event = { type: 'CINEMATIC', audience: ['role:tv'] };
  assert.equal(viewerCanSee(event, { id: null, role: 'tv', matchPlayers: ['A', 'B'] }), true);
  assert.equal(viewerCanSee(event, { id: 'A', role: 'player', matchPlayers: ['A', 'B'] }), false);
  assert.equal(viewerCanSee(event, { id: null, role: 'spectator', matchPlayers: ['A', 'B'] }), false);
});

test('viewerCanSee: a private-to-player event is not accidentally exposed to a tv-role viewer', () => {
  const event = { type: 'PRIVATE', audience: ['A'] };
  assert.equal(viewerCanSee(event, { id: null, role: 'tv', matchPlayers: ['A', 'B'] }), false);
});

test('viewerCanSee: role:X targeting is exact-match, not a prefix/substring match (role:tv does not also match role:tv2)', () => {
  const event = { type: 'X', audience: ['role:tv'] };
  assert.equal(viewerCanSee(event, { id: null, role: 'tv2', matchPlayers: [] }), false);
});
