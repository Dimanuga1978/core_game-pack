import { createMatch, startMatch, dispatchMatchAction } from '@tablecore/core';
import { createMetricsRegistry } from '@tablecore/observability';

const clone = (v) => structuredClone(v);

export class ServerHost {
  constructor() {
    this.matches = new Map();
    // Game-category metrics (P2-OPS): before this, ServerHost tracked
    // nothing about its own match-lifecycle activity at all -- no way to
    // answer "how many matches has this process handled" or "how many
    // actions are being rejected" without instrumenting call sites
    // externally. `activeMatches` is deliberately NOT tracked as an
    // inc/dec counter here (easy to get out of sync if any code path
    // removes a match without going through a single choke point) -- it
    // is computed fresh from `this.matches.size` in getMetrics() instead,
    // which can never drift from the truth.
    this.metrics = createMetricsRegistry({
      matchesCreated: 0,
      matchesStarted: 0,
      matchesFinished: 0,
      matchesExpired: 0,
      actionsAccepted: 0,
      actionsRejected: 0,
    });
    this.startedAt = Date.now();
  }

  /** Game-category metrics snapshot, plus a live (not incrementally-tracked) activeMatches gauge. See packages/observability for the shared registry this uses and buildStructuredMetrics() for combining this with a transport's network metrics into the full {server,game,network,resource} shape. */
  getMetrics() { return Object.freeze({ ...this.metrics.snapshot(), activeMatches: this.matches.size }); }

  createMatch({ id, game, players, options, spectatorPolicy }) {
    if (this.matches.has(id)) return { ok:false, error:{ code:'MATCH_EXISTS' } };
    // Real, confirmed gap found via direct testing: @tablecore/core's own
    // createMatch() THROWS (a plain TypeError, synchronous) for any
    // invalid configuration -- bad player ids, too many players, and
    // (as of the MATCH_ID_RE addition above) an unsafe match id -- but
    // nothing here ever caught that throw. It never crashed the whole
    // server process (some outer catch-all in the real admin API
    // happened to prevent that), but it DID surface as a generic,
    // unhelpful 500 ADMIN_API_ERROR instead of a clean, specific 400
    // validation error, unlike literally every OTHER validation failure
    // in this same admin API. Fixed the same way safeStartMatch()
    // already handles the analogous case for startMatch()/a game's own
    // createInitialState() throwing -- except the message here is safe
    // to pass straight through (these are always this engine's own
    // fixed, controlled validation messages, never arbitrary text from
    // third-party game code the way a game's own createInitialState()
    // exception could be).
    let match;
    try {
      match = createMatch({ id, game, players, options, spectatorPolicy });
    } catch (error) {
      return { ok:false, error:{ code:'INVALID_MATCH_CONFIG', message: error instanceof Error ? error.message : String(error) } };
    }
    const now = Date.now();
    // createdAt/lastActivityAt live HERE, on ServerHost's own wrapper
    // entry, deliberately not added to @tablecore/core's own Match
    // schema (createMatch.js) -- that shape is used broadly across the
    // engine and has its own careful, already-settled design; a
    // real, lasting lifecycle-cleanup concern that's genuinely specific
    // to a LONG-RUNNING SERVER PROCESS (a test harness creating a match
    // in memory and discarding it a moment later has no need for this
    // at all) belongs at the layer that actually has that concern, not
    // baked into the core data structure every consumer of the engine
    // has to carry around regardless of whether they ever run a real,
    // persistent server.
    this.matches.set(match.id, { game, match, snapshotCache: new Map(), createdAt: now, lastActivityAt: now });
    this.metrics.inc('matchesCreated');
    return { ok:true, match: clone(match) };
  }

  startMatch({ matchId, actor }) {
    const entry = this.matches.get(matchId);
    if (!entry) return { ok:false, error:{ code:'MATCH_NOT_FOUND' } };
    if (actor != null && !entry.match.players.includes(actor)) return { ok:false, error:{ code:'NOT_MATCH_PARTICIPANT' } };
    const result = startMatch({ match: entry.match, game: entry.game });
    if (result.ok) { entry.match = result.match; entry.snapshotCache.clear(); entry.lastActivityAt = Date.now(); this.metrics.inc('matchesStarted'); }
    return result.ok ? { ...result, match: clone(result.match) } : result;
  }

  getSnapshot(matchId, viewer = null) {
    const entry = this.matches.get(matchId);
    if (!entry) return { ok:false, error:{ code:'MATCH_NOT_FOUND' } };
    // Prefixed, not bare `String(viewer)`: a player id is caller-supplied
    // data (see createMatch's own validation below for the current
    // constraints on it, but this must hold regardless of what player ids
    // are ever allowed to be). A bare sentinel like '__spectator__' for
    // the anonymous-viewer slot can collide with an actual player who
    // happens to be named that -- confirmed directly: a player literally
    // named '__spectator__' populates the spectator cache slot with their
    // OWN correctly-scoped view, which a REAL anonymous spectator then
    // received verbatim on the next request at the same version, leaking
    // that player's own-position data to a spectator who should have seen
    // it redacted. Prefixing with a type tag makes the two key spaces
    // disjoint no matter what a player id string is.
    const viewerKey = viewer == null ? 'spectator:' : `player:${String(viewer)}`;
    const cached = entry.snapshotCache.get(viewerKey);
    if (cached && cached.version === entry.match.version) return { ok:true, snapshot: clone(cached.snapshot) };
    const { id, status, players, state, result, version, spectatorPolicy } = entry.match;
    const projectedState = state == null ? null : (typeof entry.game.getPlayerView === 'function'
      ? entry.game.getPlayerView(state, viewer)
      : state);
    // Computed on the RAW, authoritative `state` (never the projected
    // one) -- getLegalActions() expects the same internal shape
    // applyActionInPlace() itself operates on, which is not necessarily
    // the same shape getPlayerView() produces for a client (some games'
    // internal state uses richer structures like Map/Set that get
    // converted to plain arrays/objects in the projected view). Only
    // meaningful for a real player viewer; spectators can never act, and
    // getLegalActions() already correctly returns [] for a non-active-
    // player/non-participant actor regardless, so this is safe for any
    // viewer value without a special case. Found missing while wiring up
    // a real game's browser client -- a client cannot safely
    // derive "what can I do right now" itself (it only ever sees the
    // projected, not authoritative, state shape), so the server has to
    // tell it.
    const availableActions = (viewer != null && state != null && typeof entry.game.getLegalActions === 'function')
      ? entry.game.getLegalActions(state, viewer).map(a => a.type)
      : [];
    const snapshot = { id, status, players, state: projectedState, result, version, spectatorPolicy, availableActions };
    entry.snapshotCache.set(viewerKey, { version, snapshot });
    return { ok:true, snapshot: clone(snapshot) };
  }

  submitAction({ matchId, connectionPlayerId, actor, expectedVersion, action }) {
    const entry = this.matches.get(matchId);
    if (!entry) { this.metrics.inc('actionsRejected'); return { ok:false, error:{ code:'MATCH_NOT_FOUND' } }; }
    if (!entry.match.players.includes(connectionPlayerId)) { this.metrics.inc('actionsRejected'); return { ok:false, error:{ code:'NOT_MATCH_PARTICIPANT' } }; }
    if (actor !== connectionPlayerId) { this.metrics.inc('actionsRejected'); return { ok:false, error:{ code:'ACTOR_SPOOFING' } }; }
    if (expectedVersion !== entry.match.version) { this.metrics.inc('actionsRejected'); return { ok:false, error:{ code:'STALE_VERSION' }, snapshot:this.getSnapshot(matchId, connectionPlayerId).snapshot }; }
    // Found via a manual, line-by-line reading of this method (not
    // testing): `clone(action)` (structuredClone) had no try/catch
    // around it, same as the equivalent, already-fixed gap in
    // packages/core/src/runAction.js's own `structuredClone(action)`
    // call -- structuredClone() throws on functions/Symbols in `action`
    // (confirmed directly), not reachable via this engine's own real WS
    // transport (message.action always comes from JSON.parse(), which
    // cannot represent either), but this is itself a public method any
    // direct caller (a different host wiring, a future integration)
    // could call with a hand-constructed action.
    let normalized;
    try {
      normalized = { ...clone(action), actor: connectionPlayerId };
    } catch (error) {
      this.metrics.inc('actionsRejected');
      return { ok:false, error:{ code:'INVALID_ACTION', message: error instanceof Error ? error.message : String(error) } };
    }
    const wasFinished = entry.match.status === 'finished';
    const result = dispatchMatchAction({ match: entry.match, game: entry.game, action: normalized });
    if (!result.ok) { this.metrics.inc('actionsRejected'); return { ok:false, error:result.error, snapshot:this.getSnapshot(matchId, connectionPlayerId).snapshot }; }
    entry.match = result.match;
    entry.snapshotCache.clear();
    entry.lastActivityAt = Date.now();
    this.metrics.inc('actionsAccepted');
    if (!wasFinished && entry.match.status === 'finished') this.metrics.inc('matchesFinished');
    return { ok:true, version:entry.match.version, events:clone(result.events), snapshot:this.getSnapshot(matchId, connectionPlayerId).snapshot };
  }

  getAuthoritativeState(matchId) {
    const entry = this.matches.get(matchId);
    if (!entry) return { ok:false, error:{ code:'MATCH_NOT_FOUND' } };
    return { ok:true, state:clone(entry.match.state), version:entry.match.version };
  }

  /**
   * Real lifecycle gap this closes: before this method existed, nothing
   * in the engine ever removed a match from `this.matches` -- a match,
   * once created, stayed in memory for the entire lifetime of the
   * process, finished or not. `maxMatches` (see tools/server/start.mjs)
   * only ever stopped NEW matches from being created once that ceiling
   * was hit; it never freed capacity back up from old ones.
   *
   * Deliberately conservative in scope -- removes only:
   *   - a 'finished' or 'aborted' match, once `finishedGraceMs` has
   *     passed since its last real activity (safe: the match is
   *     genuinely, permanently over; the only real loss is the ability
   *     to keep viewing its final board/result after that window).
   *   - a 'lobby' match that was created but never actually started,
   *     once `abandonedLobbyGraceMs` has passed since creation (safe:
   *     nobody ever put real time into it).
   * Deliberately NEVER removes a 'running' match, no matter how idle --
   * "how long is too long for a real game to sit paused" is a genuine
   * product/deployment judgment call (a multi-day async game is
   * legitimate for some deployments, a 10-minute stall might already be
   * "abandoned" for others), not something this shared engine class
   * should silently decide on every consumer's behalf.
   *
   * Pure and deterministic: takes `now` as an explicit parameter rather
   * than reading Date.now() internally, so real elapsed-time behavior is
   * directly testable without waiting on a real clock, and this class
   * itself owns no timer at all -- a real deployment calls this
   * periodically via its own setInterval (matching this project's
   * existing convention of keeping scheduling concerns at the
   * "real server process" layer, e.g. tools/server/start.mjs's own bot-
   * check scheduling, not inside the engine's core, timer-free classes).
   * Returns the list of {id, reason} removed, for logging/observability.
   */
  sweepExpiredMatches(now = Date.now(), { finishedGraceMs = 30 * 60 * 1000, abandonedLobbyGraceMs = 60 * 60 * 1000 } = {}) {
    const removed = [];
    for (const [id, entry] of this.matches) {
      const status = entry.match.status;
      let reason = null;
      if ((status === 'finished' || status === 'aborted') && now - entry.lastActivityAt > finishedGraceMs) reason = 'finished-expired';
      else if (status === 'lobby' && now - entry.createdAt > abandonedLobbyGraceMs) reason = 'abandoned-lobby';
      if (reason) {
        this.matches.delete(id);
        removed.push({ id, reason });
        this.metrics.inc('matchesExpired');
      }
    }
    return removed;
  }
}
