// Transport + auth layer: opens a socket via `connect()` (a factory the
// page provides, e.g. `() => new Promise(...) => new WebSocket(url)`),
// sends the real HELLO handshake with a signed token, and exposes a
// minimal message in/out interface. Protocol semantics (SYNC_REQUEST,
// ACTION, session/version bookkeeping) live one layer up, in runtime.js
// -- this file only knows how to move JSON messages across a socket and
// authenticate the connection.
//
// Game-agnostic (see runtime.js's module doc comment for why this whole
// package lives here, in packages/browser-client, rather than inside any
// one game's own folder -- it was originally built and placed inside a
// specific game's own directory, a real mistake caught and corrected).
//
// PROTOCOL_VERSION is hardcoded to 1 here rather than imported from
// @tablecore/protocol, because this file is loaded as a plain ES module
// directly by a browser (fetched over HTTP from the launcher/game
// server, not resolved through npm workspaces) -- a browser cannot
// resolve a bare specifier like '@tablecore/protocol' without an import
// map, which nothing in this project currently sets up. If the real
// engine's PROTOCOL_VERSION ever changes, this constant has to be
// updated here too; there is no automatic way to keep the two in sync
// across the npm-package/browser-module boundary today.
const PROTOCOL_VERSION = 1;

export class PlayerClient {
  constructor({ connect, match, principal, token } = {}) {
    if (typeof connect !== 'function') throw new TypeError('PlayerClient requires a connect() factory');
    if (!match) throw new TypeError('PlayerClient requires match');
    this._connect = connect;
    this.match = match;
    this.principal = principal ?? null;
    // A bare `principal` (player id string) is NOT sufficient to
    // authenticate against this engine's real WS protocol --
    // packages/protocol requires a signed token, verified server-side
    // against createTokenAuth() before SYNC_REQUEST/ACTION is even
    // considered (see packages/protocol/src/index.js's HELLO handling).
    // `token` is what a real deployment's admin API issues per player
    // when a match is created (see tools/server/start.mjs) -- the page
    // that instantiates PlayerClient is expected to have gotten one from
    // somewhere (a `?token=` URL parameter is the convention this game's
    // player-ui/tv-ui pages use; see their own source for how they read
    // it) and pass it through here.
    this.token = token ?? null;
    this.socket = null;
    this._onMessage = null;
    this._onClose = null;
    this._stopped = false;
  }

  onMessage(handler) { this._onMessage = handler; }
  onClose(handler) { this._onClose = handler; }

  async open() {
    if (!this.token) throw new Error('PlayerClient: no token supplied -- cannot authenticate without one');
    this.socket = await this._connect();
    this.socket.onmessage = event => {
      if (this._stopped) return;
      let message;
      try { message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data)); }
      catch { return; }
      this._onMessage?.(message);
    };
    this.socket.onclose = () => { if (!this._stopped) this._onClose?.(); };
    this.socket.onerror = () => { if (!this._stopped) this._onClose?.(); };
    // supportsPatch:true opts this connection into delta-sync (see
    // runtime.js's own ClientSessionState.receive(), which knows how to
    // reconstruct a full snapshot from a patch-only UPDATE) -- the
    // server only ever omits the redundant full `snapshot` field for a
    // connection that explicitly declares this, so an older/unaware
    // client (or a future one that hasn't been updated to consume
    // patches) keeps getting the full snapshot on every message exactly
    // as before. Real, measured payload savings on a genuine 9x9 Last
    // Sector board: ~55-64% smaller per-update once a patch baseline
    // exists (see games/last-sector/src/legacy/game.cjs's own comment
    // on the separate, complementary hidden-tile trim -- that shrinks
    // what a snapshot/patch describes in the first place; THIS shrinks
    // how much of it gets sent redundantly on top of the patch).
    this.send({ type: 'HELLO', protocolVersion: PROTOCOL_VERSION, token: this.token, supportsPatch: true });
  }

  send(message) {
    if (!this.socket) return;
    this.socket.send(JSON.stringify(message));
  }

  stop() {
    this._stopped = true;
    try { this.socket?.close(); } catch {}
  }
}
