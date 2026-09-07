export { createTokenAuth, SAFE_PLAYER_ID_RE } from './auth.js';
export { Visibility, resolveAudience, viewerCanSee, filterEventsForViewerWithPolicy } from './visibility.js';
export { FieldVisibility, projectFields, projectPlayerMap } from './stateVisibility.js';
export { diffValues, applyPatch } from './patch.js';
import { filterEventsForViewerWithPolicy } from './visibility.js';
import { diffValues } from './patch.js';

export const PROTOCOL_VERSION = 1;
const clone = (v) => structuredClone(v);

export function makeError(code, extra = {}) { return { type: 'ACTION_REJECTED', protocolVersion: PROTOCOL_VERSION, error: { code, ...extra } }; }

// The other half of P2-PATCH actually saving any bytes on the wire: the
// diff/patch computation itself already existed (see patch.js) and was
// already being attached to every UPDATE -- but the FULL, redundant
// snapshot was ALSO always included regardless, so nothing was ever
// actually saved; a receiving client that ignored `.patch` (every real
// client in this codebase did, until this same change) worked correctly
// either way, and one that used it would still have paid the full
// network cost anyway. Only a connection that explicitly opted in via
// `supportsPatch:true` on its own HELLO (see transport-ws's own comment
// on exactly this) gets the snapshot omitted -- and only when a real,
// applicable patch actually exists (never on a connection's first
// UPDATE for a match, where there is no previous snapshot yet to patch
// FROM at all; that case always needs the real full snapshot regardless
// of what the connection declared support for).
function maybeOmitRedundantSnapshot(message, connection) {
  if (connection.supportsPatch === true && Array.isArray(message.patch)) delete message.snapshot;
  return message;
}

// `snapshot` has always been rebuilt per-viewer via game.getPlayerView(); the
// `events` array that rides along with an UPDATE was, until now, the raw,
// unfiltered result of the action -- broadcast identically to every
// subscriber regardless of what their own snapshot was allowed to show
// them. An event carrying, say, a revealed position or a private resource
// delta bypassed getPlayerView() entirely. `event.audience` closes that:
// omitted/null => public (every current subscriber, including spectators,
// same as before -- this keeps old, already-public events working with no
// changes required); an array of player ids => only those players (never
// spectators, since a spectator's viewerId is null and can never be `in`
// the array); anything else (a malformed audience) fails CLOSED, i.e. the
// event is dropped for everyone rather than risking exposure by falling
// back to "public".
//
// Kept for backward compatibility (existing callers, existing tests) --
// this only ever supports the PUBLIC/PLAYERS cases with no validation
// against real match participants. `filterEventsForViewerWithPolicy`
// (visibility.js), used internally below, is the centrally-validated
// superset: MATCH/SPECTATOR/DENY policies, and array-audience ids are
// checked against the match's actual participant list rather than
// trusted as-is.
export function filterEventsForViewer(events, viewerId) {
  if (!Array.isArray(events)) return events;
  return events.filter(event => {
    if (!event || event.audience == null) return true;
    if (!Array.isArray(event.audience)) return false;
    return viewerId != null && event.audience.includes(viewerId);
  });
}

export function validateProtocolMessage(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return { ok:false, error:{code:'INVALID_MESSAGE'} };
  if (message.protocolVersion !== PROTOCOL_VERSION) return { ok:false, error:{code:'PROTOCOL_MISMATCH'} };
  if (typeof message.type !== 'string') return { ok:false, error:{code:'INVALID_MESSAGE_TYPE'} };
  if (message.type === 'HELLO') {
    if (typeof message.token !== 'string' || message.token.length < 16) return { ok:false, error:{code:'AUTH_REQUIRED'} };
    return {ok:true};
  }
  if (message.type === 'SYNC_REQUEST') {
    if (typeof message.matchId !== 'string' || !message.matchId) return {ok:false,error:{code:'INVALID_MATCH_ID'}};
    return {ok:true};
  }
  if (message.type === 'ACTION') {
    if (typeof message.matchId !== 'string' || !message.matchId) return {ok:false,error:{code:'INVALID_MATCH_ID'}};
    if (!Number.isInteger(message.expectedVersion) || message.expectedVersion < 0) return {ok:false,error:{code:'INVALID_VERSION'}};
    if (!message.action || typeof message.action !== 'object' || typeof message.action.type !== 'string') return {ok:false,error:{code:'INVALID_ACTION'}};
    return {ok:true};
  }
  return {ok:true};
}

export function createProtocolServer(host) {
  // `await` on a plain (non-Promise) return value resolves in the next
  // microtask with no other change in behavior -- so making these async
  // costs nothing for a synchronous host like ServerHost, and is what
  // makes an asynchronous host (packages/worker-pool's MatchWorkerPool,
  // whose methods are real RPC calls to a worker thread) usable through
  // this same protocol layer at all. See transport-ws's processBuffer()
  // for the other half of this: awaiting handle()/buildUpdate() here
  // means the transport's own message loop must guard against
  // reentrancy, since it's no longer guaranteed to run start-to-finish
  // synchronously for one incoming chunk before the next 'data' event
  // could otherwise interleave with it.
  const makeSnapshot = async (connection, matchId) => host.getSnapshot(matchId, connection.role === 'player' ? connection.playerId : null);
  const buildUpdate = async ({ connection, matchId, previousVersion, events }) => {
    if (!connection.subscribedMatches?.has(matchId)) return makeError('MATCH_NOT_SUBSCRIBED');
    const r = await makeSnapshot(connection, matchId);
    if (!r.ok) return makeError(r.error.code);
    const viewer = { id: connection.role === 'player' ? connection.playerId : null, role: connection.role, matchPlayers: r.snapshot.players };
    const message = { type:'UPDATE', protocolVersion:PROTOCOL_VERSION, matchId, previousVersion, snapshot:r.snapshot, events:filterEventsForViewerWithPolicy(clone(events), viewer) };
    // Additive, backward-compatible PATCH delivery: a client that never
    // looks at `message.patch` continues to work exactly as before,
    // applying `message.snapshot` wholesale on every UPDATE. A client
    // that DOES support patches can apply `message.patch` to its own
    // previous snapshot instead, at a cost proportional to what actually
    // changed rather than to the snapshot's total size. The patch is
    // computed here, from `r.snapshot` -- the SAME already-projected,
    // viewer-scoped snapshot that was just built for this exact
    // connection -- diffed against the last one THIS connection was
    // given for THIS match, never from raw authoritative state (see
    // patch.js's module doc comment for why that distinction is a
    // privacy requirement, not an implementation detail).
    connection.lastSnapshotByMatch ??= new Map();
    const previousSnapshot = connection.lastSnapshotByMatch.get(matchId);
    if (previousSnapshot !== undefined) message.patch = diffValues(previousSnapshot, r.snapshot);
    connection.lastSnapshotByMatch.set(matchId, clone(r.snapshot));
    return maybeOmitRedundantSnapshot(message, connection);
  };
  return {
    buildUpdate,
    async handle({ connection, message }) {
      const check = validateProtocolMessage(message);
      if (!check.ok) return [makeError(check.error.code)];
      if (message.type === 'HELLO') return [{ type:'WELCOME', protocolVersion:PROTOCOL_VERSION, role:connection.role, playerId:connection.playerId ?? null }];
      if (message.type === 'SYNC_REQUEST') {
        const r = await makeSnapshot(connection, message.matchId);
        if (!r.ok) return [makeError(r.error.code)];
        if (connection.role === 'player' && !r.snapshot.players.includes(connection.playerId)) return [makeError('NOT_MATCH_PARTICIPANT')];
        if (connection.role !== 'player') {
          // Fail closed, not fail open: the old check was `if
          // (connection.allowedMatches && !connection.allowedMatches.has(...))`
          // -- meaning an unconfigured (absent) allowedMatches ACL meant
          // "allow every spectator into every match that exists", purely
          // because nobody remembered to set the optional field. Any
          // non-player connection now needs an EXPLICIT grant: either the
          // connection was scoped to this specific match (allowedMatches,
          // e.g. a private invite-only viewing link) or the match itself
          // was created with spectatorPolicy:'public' (an intentional
          // broadcast/TV feature). Absence of both denies by default.
          //
          // Deliberately `role !== 'player'`, not `role === 'spectator'`:
          // a deployment that introduces its own additional non-player
          // connection role (a TV/broadcast presentation client, say --
          // see visibility.js's `role:X` audience targeting, added for
          // exactly this use case) must not be able to skip this gate
          // simply because its role string isn't literally 'spectator'.
          // Every viewer that isn't an authenticated match participant is
          // "spectator-like" for the purposes of this ACL, whatever its
          // role is actually called.
          const explicitlyAllowed = connection.allowedMatches?.has(message.matchId) === true;
          const publiclySpectatable = r.snapshot.spectatorPolicy === 'public';
          if (!explicitlyAllowed && !publiclySpectatable) return [makeError('MATCH_ACCESS_DENIED')];
        }
        if (!connection.subscribedMatches) connection.subscribedMatches = new Set();
        connection.subscribedMatches.add(message.matchId);
        // Seed the patch baseline at SYNC time too, not only in
        // buildUpdate() -- otherwise the very first UPDATE this
        // connection receives after syncing would have no previous
        // snapshot to diff against and would (correctly, but needlessly)
        // fall back to snapshot-only delivery for one extra round trip.
        connection.lastSnapshotByMatch ??= new Map();
        connection.lastSnapshotByMatch.set(message.matchId, clone(r.snapshot));
        return [{ type:'SYNC', protocolVersion:PROTOCOL_VERSION, matchId:message.matchId, snapshot:r.snapshot }];
      }
      if (message.type === 'ACTION') {
        if (connection.role !== 'player') return [makeError('ROLE_CANNOT_ACT')];
        if (connection.subscribedMatches && !connection.subscribedMatches.has(message.matchId)) return [makeError('MATCH_NOT_SUBSCRIBED')];
        const r = await host.submitAction({ matchId:message.matchId, connectionPlayerId:connection.playerId, actor:message.action.actor ?? connection.playerId, expectedVersion:message.expectedVersion, action:message.action });
        if (!r.ok) return [makeError(r.error.code, r.snapshot ? { snapshot:r.snapshot } : {})];
        // r.events is the RAW, unfiltered event list. The direct reply below
        // is filtered for the acting connection's own viewerId; the raw list
        // also travels (as _rawEvents, stripped before hitting the wire) so
        // the transport can independently re-filter it per OTHER subscriber
        // in buildUpdate() -- each recipient must see their own view of the
        // same events, not a copy of the actor's.
        //
        // `clone(r.events)` here matters even though it looks redundant:
        // filterEventsForViewer() only filters the ARRAY, it does not clone
        // the individual event objects that pass through, so the actor's
        // own `events` and `_rawEvents` would otherwise share the exact
        // same event object references. Nothing currently mutates an
        // event after this point, but the invariant this is meant to
        // guarantee -- every recipient's event list is independently
        // owned, so no recipient can ever affect what another recipient
        // receives -- should hold structurally, not merely because
        // nothing happens to violate it today.
        const actorUpdate = {
          type:'UPDATE', protocolVersion:PROTOCOL_VERSION, matchId:message.matchId, previousVersion:message.expectedVersion,
          snapshot:r.snapshot,
          events:filterEventsForViewerWithPolicy(clone(r.events), { id:connection.playerId, role:'player', matchPlayers:r.snapshot.players }),
          _broadcast:true,
          _rawEvents:r.events
        };
        // Same additive patch delivery as buildUpdate() -- see its comment
        // for why this is always diffed from the already-projected
        // snapshot, never raw state.
        connection.lastSnapshotByMatch ??= new Map();
        const previousActorSnapshot = connection.lastSnapshotByMatch.get(message.matchId);
        if (previousActorSnapshot !== undefined) actorUpdate.patch = diffValues(previousActorSnapshot, r.snapshot);
        connection.lastSnapshotByMatch.set(message.matchId, clone(r.snapshot));
        return [maybeOmitRedundantSnapshot(actorUpdate, connection)];
      }
      return [makeError('UNKNOWN_MESSAGE_TYPE')];
    }
  };
}

export class ClientSession {
  constructor() { this.snapshot = null; this.matchId = null; this.messages = []; }
  receive(message) {
    if (!message || message.protocolVersion !== PROTOCOL_VERSION) return { applied:false, reason:'PROTOCOL_MISMATCH' };
    if ((message.type === 'SYNC' || message.type === 'UPDATE') && message.snapshot) {
      const incomingMatch = message.matchId ?? message.snapshot.id ?? null;
      if (message.matchId && message.snapshot.id && message.matchId !== message.snapshot.id) return { applied:false, reason:'MATCH_MISMATCH' };
      if (this.matchId && incomingMatch && incomingMatch !== this.matchId) return { applied:false, reason:'MATCH_MISMATCH' };
      if (this.snapshot && message.snapshot.version < this.snapshot.version) return { applied:false, reason:'STALE_UPDATE' };
      if (incomingMatch) this.matchId = incomingMatch;
      this.snapshot = clone(message.snapshot);
      this.messages.push(clone(message));
      return { applied:true };
    }
    this.messages.push(clone(message)); return { applied:true };
  }
  makeAction({ matchId, action }) {
    if (this.matchId && matchId !== this.matchId) throw new Error('Client is bound to a different match');
    if (!this.snapshot || !Number.isInteger(this.snapshot.version)) throw new Error('Client is not synchronized');
    return { type:'ACTION', protocolVersion:PROTOCOL_VERSION, matchId, expectedVersion:this.snapshot.version, action:clone(action) };
  }
  makeSyncRequest(matchId) {
    if (typeof matchId !== 'string' || !matchId) throw new TypeError('matchId is required');
    return { type:'SYNC_REQUEST', protocolVersion:PROTOCOL_VERSION, matchId };
  }
}
