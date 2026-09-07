// --- @tablecore/browser-client ------------------------------------------
//
// Game-agnostic. This file, player-client.js, and frame-scheduler.js
// contain zero game-specific logic -- no game id, no action types, no
// state shape assumptions beyond the engine's own SYNC/UPDATE/
// ACTION_REJECTED protocol envelope. Any game's player-facing UI can use
// these directly; the only game-specific hook is the `stateReducer`
// option passed into ClientRuntime below, which a game supplies to
// transform the raw protocol snapshot into whatever shape ITS OWN UI
// code wants to read.
//
// This package was originally built and placed inside one specific
// game's own directory, while fixing that game's broken player client --
// a real architectural mistake, caught and corrected after being asked
// directly "are we rewriting the engine for one game, or does this
// actually apply to all of them?": genuinely game-agnostic engine
// infrastructure does not belong inside one game's folder, even if that
// game was the first, or only, concrete consumer of it so far. Moved
// here, as a real
// `packages/*` engine package, once that was noticed.
//
// Same cross-boundary constraint as player-client.js: this file is
// loaded directly by a browser (no bundler, no import map), so it cannot
// `import` the real `ClientSession`/`PROTOCOL_VERSION` from
// @tablecore/protocol (a bare specifier a browser cannot resolve on its
// own). `ClientSessionState` below is a small, deliberately minimal,
// faithful mirror of packages/protocol/src/index.js's `ClientSession` --
// version/staleness/match-binding bookkeeping only, nothing else. If
// that class's behavior ever changes, this needs a matching update; it
// is intentionally kept tiny and stable-shaped to keep that risk low
// (this is the same class of engine/browser-module duplication tradeoff
// as PROTOCOL_VERSION being hardcoded in player-client.js, not a new
// kind of risk).
const PROTOCOL_VERSION = 1;

function clone(v) { return typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v)); }

// A browser-compatible copy of packages/protocol/src/patch.js's own
// applyPatch() -- same cross-boundary duplication as PROTOCOL_VERSION/
// ClientSessionState above (this file is loaded directly by a browser,
// no bundler, so it cannot `import` the real one from @tablecore/
// protocol). Only applyPatch is needed here, not diffValues -- the
// CLIENT only ever needs to APPLY a patch the server already computed,
// never to compute one of its own.
function jsonPointerUnescape(token) { return token.replace(/~1/g, '/').replace(/~0/g, '~'); }
function applyPatch(value, patch) {
  let result = clone(value);
  for (const op of patch) {
    const segments = op.path === '' ? [] : op.path.split('/').slice(1).map(jsonPointerUnescape);
    if (segments.length === 0) { result = op.op === 'remove' ? undefined : clone(op.value); continue; }
    let target = result;
    for (let i = 0; i < segments.length - 1; i++) target = target?.[segments[i]];
    if (target == null) continue;
    const lastKey = segments[segments.length - 1];
    if (op.op === 'remove') delete target[lastKey];
    else target[lastKey] = clone(op.value);
  }
  return result;
}

class ClientSessionState {
  constructor() { this.snapshot = null; this.matchId = null; }
  receive(message) {
    if (!message || message.protocolVersion !== PROTOCOL_VERSION) return { applied: false, reason: 'PROTOCOL_MISMATCH' };
    // A patch-only UPDATE (see packages/protocol/src/index.js's own
    // maybeOmitRedundantSnapshot() -- the server only ever omits
    // `.snapshot` for a connection that itself declared supportsPatch,
    // see player-client.js's own HELLO construction) needs to be
    // reconstructed from the LAST snapshot this session actually has
    // before any of the usual snapshot-shaped checks below can run at
    // all, since there is no `message.snapshot` to read `.id`/`.version`
    // from directly.
    if (!message.snapshot && Array.isArray(message.patch) && this.snapshot) {
      const reconstructed = applyPatch(this.snapshot, message.patch);
      message = { ...message, snapshot: reconstructed };
    }
    if ((message.type === 'SYNC' || message.type === 'UPDATE') && message.snapshot) {
      const incomingMatch = message.matchId ?? message.snapshot.id ?? null;
      if (message.matchId && message.snapshot.id && message.matchId !== message.snapshot.id) return { applied: false, reason: 'MATCH_MISMATCH' };
      if (this.matchId && incomingMatch && incomingMatch !== this.matchId) return { applied: false, reason: 'MATCH_MISMATCH' };
      if (this.snapshot && message.snapshot.version < this.snapshot.version) return { applied: false, reason: 'STALE_UPDATE' };
      if (incomingMatch) this.matchId = incomingMatch;
      this.snapshot = clone(message.snapshot);
      return { applied: true };
    }
    return { applied: true };
  }
  makeAction({ matchId, action }) {
    if (this.matchId && matchId !== this.matchId) throw new Error('Client is bound to a different match');
    if (!this.snapshot || !Number.isInteger(this.snapshot.version)) throw new Error('Client is not synchronized');
    return { type: 'ACTION', protocolVersion: PROTOCOL_VERSION, matchId, expectedVersion: this.snapshot.version, action: clone(action) };
  }
  makeSyncRequest(matchId) {
    if (typeof matchId !== 'string' || !matchId) throw new TypeError('matchId is required');
    return { type: 'SYNC_REQUEST', protocolVersion: PROTOCOL_VERSION, matchId };
  }
}

const RECONNECT_DELAYS_MS = [500, 1000, 2000, 4000, 8000]; // bounded backoff, not an infinite tight retry loop

/**
 * Orchestrates a PlayerClient (transport+auth) against the real
 * SYNC_REQUEST/ACTION protocol, with automatic bounded-retry reconnect
 * and a small, EventTarget-free pub/sub (`.on(name, handler)`) matching
 * what a real browser UI drives rendering from.
 *
 * Events emitted:
 *   'state'    (name: 'connecting'|'transport-connected'|'session-ready'
 *               |'connected'|'resumed'|'disconnected'|'connect-error'|'stopped')
 *   'error'    (error: {code?, message?})
 *   'snapshot' ()  -- fired whenever `.snapshot` has a new value ready
 *   'events'   (events: array, message: the raw SYNC/UPDATE that carried them)
 */
export class ClientRuntime {
  constructor(client, { stateReducer } = {}) {
    if (!client) throw new TypeError('ClientRuntime requires a client');
    this.client = client;
    this.stateReducer = typeof stateReducer === 'function' ? stateReducer : (raw => raw);
    this._session = new ClientSessionState();
    this._handlers = new Map();
    this._everConnected = false;
    this._stopped = false;
    this._reconnectAttempt = 0;
    this._reconnectTimer = null;
    this.snapshot = null; // the REDUCED, UI-facing snapshot (see stateReducer), not the raw protocol one
  }

  on(name, handler) {
    if (!this._handlers.has(name)) this._handlers.set(name, new Set());
    this._handlers.get(name).add(handler);
    return () => this._handlers.get(name)?.delete(handler);
  }

  _emit(name, ...args) {
    for (const handler of this._handlers.get(name) ?? []) {
      try { handler(...args); } catch (error) { console.error(`[ClientRuntime] handler for "${name}" threw`, error); }
    }
  }

  /**
   * Optional early-trigger hook (used by this game's own device-test
   * harness -- see player-ui/main.js's `?deviceTest=1&autoReady=1`
   * handling). Normal play does not depend on this being called: `.start()`
   * already proceeds through the whole connect -> authenticate -> sync
   * flow on its own. Calling `.ready(true)` before the first sync has
   * happened just makes that flow proceed immediately instead of
   * whatever future gating a specific deployment might otherwise add
   * (there is none today) -- kept as a real, callable no-op-or-nudge
   * rather than removed, so existing callers of it don't break.
   */
  ready(value) {
    if (value && !this._session.snapshot && this._connected) this._sendSyncRequest();
  }

  command(action) {
    if (!this._session.snapshot) { this._emit('error', { code: 'NOT_SYNCED' }); return { ok: false, error: 'NOT_SYNCED' }; }
    try {
      const message = this._session.makeAction({ matchId: this.client.match, action });
      this.client.send(message);
      return { ok: true };
    } catch (error) {
      this._emit('error', { code: 'COMMAND_FAILED', message: error instanceof Error ? error.message : String(error) });
      return { ok: false };
    }
  }

  async start() {
    this._stopped = false;
    await this._connectOnce();
  }

  stop() {
    this._stopped = true;
    if (this._reconnectTimer != null) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    this.client.stop();
    this._emit('state', 'stopped');
  }

  async _connectOnce() {
    this._connected = false;
    this._emit('state', 'connecting');
    this.client.onMessage(message => this._handleMessage(message));
    this.client.onClose(() => this._handleClose());
    try {
      await this.client.open();
    } catch (error) {
      this._emit('state', 'connect-error');
      this._emit('error', { code: 'CONNECT_FAILED', message: error instanceof Error ? error.message : String(error) });
      this._scheduleReconnect();
      return;
    }
    this._emit('state', 'transport-connected');
  }

  _handleMessage(message) {
    if (message.type === 'WELCOME') {
      this._connected = true;
      this._reconnectAttempt = 0;
      this._emit('state', 'session-ready');
      this._sendSyncRequest();
      return;
    }
    if (message.type === 'ACTION_REJECTED') {
      this._emit('error', message.error ?? { code: 'ACTION_REJECTED' });
      return;
    }
    const result = this._session.receive(message);
    if (!result.applied) {
      if (result.reason && result.reason !== 'STALE_UPDATE') this._emit('error', { code: result.reason });
      return;
    }
    if ((message.type === 'SYNC' || message.type === 'UPDATE') && this._session.snapshot) {
      this.snapshot = this.stateReducer(this._session.snapshot);
      this._emit('snapshot');
      this._emit('state', this._everConnected ? 'resumed' : 'connected');
      this._everConnected = true;
    }
    if (Array.isArray(message.events) && message.events.length) {
      this._emit('events', message.events, message);
    }
  }

  _sendSyncRequest() {
    if (!this.client.match) return;
    this.client.send(this._session.makeSyncRequest(this.client.match));
  }

  _handleClose() {
    if (this._stopped) return;
    this._connected = false;
    this._emit('state', 'disconnected');
    this._scheduleReconnect();
  }

  _scheduleReconnect() {
    if (this._stopped) return;
    const delay = RECONNECT_DELAYS_MS[Math.min(this._reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
    this._reconnectAttempt += 1;
    this._reconnectTimer = setTimeout(() => { this._reconnectTimer = null; if (!this._stopped) this._connectOnce(); }, delay);
  }
}
