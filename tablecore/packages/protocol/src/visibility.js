// --- Centralized information-flow policy (events) ----------------------
//
// Before this, "who can see this event" was purely a Game Pack
// convention: `event.audience` was either `null`/omitted (public) or an
// array of player ids the pack itself typed out, trusted as-is. Nothing
// validated that those ids were real match participants; nothing offered
// a way to say "match participants only, not spectators" or "spectators
// only" without a pack hand-rolling it from the full player list; and a
// pack forgetting `audience` entirely, or a typo in a player id, failed
// silently rather than being flagged.
//
// This does not replace `event.audience` -- it is the same field, given
// a richer, centrally-validated vocabulary:
//   - omitted / null              -> PUBLIC (unchanged, fully backward compatible)
//   - an array of player ids      -> those specific players (unchanged
//                                     shape, but now validated against
//                                     the match's actual participant list)
//   - an array entry `'role:X'`   -> any viewer whose connection role is
//                                     exactly `X` (see below -- this is
//                                     what makes a non-player, non-generic
//                                     -spectator viewer class, like a TV/
//                                     broadcast presentation client,
//                                     expressible at all). Mixable with
//                                     player ids in the same array:
//                                     `['role:tv', 'A']` reaches TV
//                                     viewers AND player A.
//   - Visibility.MATCH            -> every current match participant (not spectators)
//   - Visibility.SPECTATOR        -> spectators only (previously inexpressible)
//   - Visibility.DENY             -> nobody, ever (useful for
//                                     server-internal/debug events a
//                                     pack wants recorded but never sent)
//   - anything else               -> MALFORMED, fails closed (dropped for
//                                     everyone), exactly as before
//
// The validation step -- checking that every id in an array-audience is
// an actual match participant -- is the concrete "engine validates the
// request against the viewer and connection capabilities" requirement
// (external remediation request, "Information-flow security must be
// centralized"). A pack cannot grant visibility to an id that was never a
// real participant; unrecognized ids are dropped and surfaced as
// `invalidIds` for callers that want to log/flag a pack bug instead of
// silently ignoring it.
//
// `role:X` targeting deliberately has NO equivalent participant-list
// validation (there is no "list of all possible roles" to validate
// against the way there is a match's player list) -- it matches
// `viewer.role` by exact string equality, whatever that role is. This is
// intentionally generic rather than hardcoding a fixed enum of roles,
// because the set of connection roles a deployment supports (player,
// spectator, tv, ...) is not something the engine's core protocol layer
// should need to know in advance. What the engine DOES enforce is that
// any role OTHER than 'player' goes through the same fail-closed
// SYNC_REQUEST ACL gate that 'spectator' already does (see
// packages/protocol/src/index.js) -- a deployment inventing a new
// non-player role does not get to skip that gate by construction, not by
// remembering to update a role check by hand.
export const Visibility = Object.freeze({
  MATCH: 'ENGINE_VISIBILITY_MATCH',
  SPECTATOR: 'ENGINE_VISIBILITY_SPECTATOR',
  DENY: 'ENGINE_VISIBILITY_DENY',
});

/**
 * Resolves a raw `event.audience` value into a validated policy decision.
 * `matchPlayers` is the match's authoritative participant list (from the
 * snapshot/match object, never from the pack) -- the source of truth an
 * array-of-ids audience is checked against.
 */
export function resolveAudience(audience, matchPlayers) {
  const players = Array.isArray(matchPlayers) ? matchPlayers : [];
  if (audience == null) return { policy: 'PUBLIC' };
  if (audience === Visibility.MATCH) return { policy: 'MATCH', ids: players };
  if (audience === Visibility.SPECTATOR) return { policy: 'SPECTATOR' };
  if (audience === Visibility.DENY) return { policy: 'DENY' };
  if (Array.isArray(audience)) {
    const ids = [];
    const invalidIds = [];
    const roles = [];
    for (const entry of audience) {
      if (typeof entry !== 'string') return { policy: 'MALFORMED' };
      if (entry.startsWith('role:')) {
        const role = entry.slice(5);
        if (!role) return { policy: 'MALFORMED' }; // 'role:' with nothing after it is not a valid target, not "matches no role"
        roles.push(role);
      } else if (players.includes(entry)) {
        ids.push(entry);
      } else {
        invalidIds.push(entry);
      }
    }
    return { policy: 'PLAYERS', ids, invalidIds, roles };
  }
  return { policy: 'MALFORMED' };
}

/**
 * `viewer`: `{ id: string|null, role: string, matchPlayers: string[] }`.
 * A player's own `id` is always included in `matchPlayers` when they are
 * a real participant, so PLAYERS/MATCH policies naturally include "can I
 * see my own event" without a special case.
 */
export function viewerCanSee(event, viewer) {
  if (!event) return true;
  const resolved = resolveAudience(event.audience, viewer?.matchPlayers);
  switch (resolved.policy) {
    case 'PUBLIC': return true;
    case 'DENY': return false;
    case 'MALFORMED': return false; // fail closed, same as before
    case 'MATCH': return viewer?.role === 'player' && viewer.id != null && resolved.ids.includes(viewer.id);
    case 'SPECTATOR': return viewer?.role === 'spectator';
    case 'PLAYERS': {
      if (viewer?.role === 'player' && viewer.id != null && resolved.ids.includes(viewer.id)) return true;
      if (viewer?.role != null && resolved.roles.includes(viewer.role)) return true;
      return false;
    }
    default: return false;
  }
}

/**
 * Policy-aware event filter. Supersedes the older, simpler
 * `filterEventsForViewer(events, viewerId)` (still exported from
 * packages/protocol/src/index.js for backward compatibility -- it only
 * ever supported the PUBLIC/PLAYERS cases, unchanged behavior for those).
 * This version additionally validates PLAYERS-policy ids against real
 * match participants and supports the MATCH/SPECTATOR/DENY/role: policies.
 */
export function filterEventsForViewerWithPolicy(events, viewer) {
  if (!Array.isArray(events)) return events;
  return events.filter(event => viewerCanSee(event, viewer));
}
