#!/usr/bin/env node
// The real, previously-missing "how do I actually run this" entry point.
// Every piece this ties together (ServerHost, createProtocolServer,
// createTokenAuth, createWsServer) already existed and was already
// tested extensively throughout this project's history -- what did NOT
// exist anywhere in this repo was a single script assembling them into
// something an admin could actually start with one command. This is
// that script.
//
// This file contains ZERO references to any specific game, on purpose --
// found and corrected after being asked directly: "the engine shouldn't
// know anything about games at all; games should just plug in." An
// earlier version of this script statically imported five specific
// games and hardcoded a DEFAULT_GAMES registry -- exactly the kind of
// engine-code-that-knows-about-content coupling that principle rules
// out, even though it "only" lived in a reference/example tool rather
// than in packages/* itself. `createTableCoreServer()`'s own `games`
// option defaults to `{}` (empty); nothing is registered unless the
// caller explicitly provides it. The CLI bootstrap at the bottom loads
// a games registry from an EXTERNAL config file (a plain path, read at
// runtime via dynamic import()) instead of importing any game package
// by name -- see loadGamesConfig() below, and
// tools/server/example.config.mjs for a real, working example of such a
// config (which DOES reference this repo's demo games, but lives
// entirely outside this file and is never imported by it automatically).
//
// Two HTTP surfaces, deliberately on separate ports:
//   - the ADMIN API (adminPort): creates/starts matches and issues
//     player/spectator tokens. This is a trust-sensitive surface (anyone
//     who can call it can create matches and mint valid tokens) and is
//     NOT meant to be exposed the same way the game connection is -- in
//     a real deployment this should sit behind your own authentication/
//     reverse-proxy layer, or simply not be reachable from the public
//     internet at all (e.g. only from your own game-lobby/matchmaking
//     backend). Separate ports make it easy to firewall independently
//     rather than accidentally exposing both the same way.
//   - the WS GAME SERVER (port): what players actually connect to with
//     the tokens the admin API issued them.
//
// Structured as an exported `createTableCoreServer()` (options in,
// `{listen, close, host, protocol, auth}` out) plus a thin "run directly"
// CLI bootstrap at the bottom that reads environment variables -- the
// same shape packages/launcher's createLauncherServer() already uses,
// for the same reason: an exported function is directly testable (real
// HTTP requests against a real instance, no need to spawn a child
// process just to exercise the server), while the CLI wrapper is what
// `npm run server` / `node tools/server/start.mjs` actually invokes.
import { ServerHost } from '@tablecore/server';
import { createProtocolServer, createTokenAuth } from '@tablecore/protocol';
import { createWsServer, createWsClient } from '@tablecore/transport-ws';
import { createSeededRng } from '@tablecore/core';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findLanIp } from '../lan-ip.mjs';
import fs from 'node:fs/promises';

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let tooLarge = false;
    // Found via an aggressive audit pass: this used to call
    // `req.destroy()` the instant the size limit was exceeded -- which
    // destroys the underlying SOCKET, not just the request-reading
    // direction (req/res share one connection in Node's http module).
    // Confirmed directly: a real oversized request got the server's own
    // top-level catch-all to correctly log and attempt
    // `sendJson(res, 500, ...)`, but that write silently failed against
    // an already-destroyed socket -- the real caller just saw a bare
    // network-level "fetch failed", not any HTTP response at all,
    // unlike every OTHER error this API returns. Fixed by no longer
    // destroying the connection: once the limit is hit, further chunks
    // are simply not accumulated (bounding memory the same as before),
    // but the stream is still allowed to drain and end normally, so a
    // real 413 response (see this function's own callers) can still
    // actually reach the client.
    req.on('data', chunk => {
      if (tooLarge) return;
      data += chunk;
      if (data.length > 65536) tooLarge = true;
    });
    req.on('end', () => {
      if (tooLarge) { reject(Object.assign(new Error('body too large'), { code: 'BODY_TOO_LARGE' })); return; }
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}
function sendJson(res, status, body) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); }

// Found via a manual code review, not a failing test: `options: null`
// (an explicit, valid JSON value, distinct from simply omitting the
// field) crashed deep inside @tablecore/core's own createMatch() with
// a raw, confusing `Cannot read properties of null (reading 'seed')` --
// already safely caught by ServerHost's own try/catch (no process
// crash, no uncaught exception), but leaking a raw internal JS error
// message instead of a clean, intentional API error, and other
// nonsensical types (a string, a number, an array) were silently
// ACCEPTED instead of rejected at all. `options` genuinely has no
// sensible non-object shape -- validating it explicitly here, before
// it ever reaches match creation, replaces both failure modes with one
// clean, explicit error.
function isPlainObjectOrUndefined(value) {
  return value === undefined || (typeof value === 'object' && value !== null && !Array.isArray(value));
}

// Same static-serving helpers as tools/launcher/server.mjs's own (kept
// as a second small copy rather than a shared import -- these two files
// serve genuinely different, narrow purposes: the launcher serves game
// content broadly, this admin server serves exactly one page (the
// create-match UI) plus its one real dependency, @tablecore/qrcode's
// browser-facing files; a shared abstraction for two call sites this
// small and this different in what they're allowed to serve would add
// more indirection than it would save).
function safePath(base, relative) {
  const abs = path.resolve(base, relative);
  if (abs !== base && !abs.startsWith(base + path.sep)) return null;
  return abs;
}
function contentType(file) {
  const ext = path.extname(file).toLowerCase();
  return { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' }[ext] || 'application/octet-stream';
}
async function sendFile(res, file) {
  if (!file) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); return void res.end('Not found'); }
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile()) throw new Error('not-file');
    res.writeHead(200, { 'content-type': contentType(file), 'cache-control': 'no-cache' });
    res.end(await fs.readFile(file));
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const QRCODE_DIR = path.resolve(REPO_ROOT, 'packages/qrcode/src');
const CREATE_PAGE_DIR = path.resolve(REPO_ROOT, 'tools/server/public');

// Same sliding-window-per-key shape as packages/transport-ws's own
// createRateLimiter() (see its module for the WS-message-level version
// of the identical pattern), keyed by remote IP instead of a persistent
// connection object -- each admin API HTTP request is otherwise
// independent, with nothing to hang a rate-tracking field off of the way
// a long-lived WS connection object can.
function createIpRateLimiter({ maxRequests = 20, windowMs = 60000 } = {}) {
  const windows = new Map(); // ip -> {startedAt, count}
  return {
    consume(ip) {
      const now = Date.now();
      let w = windows.get(ip);
      if (!w || now - w.startedAt >= windowMs) { w = { startedAt: now, count: 0 }; windows.set(ip, w); }
      w.count += 1;
      // Opportunistic cleanup so `windows` doesn't grow forever across a
      // long-running server's lifetime -- cheap (O(1) amortized, only
      // runs occasionally) rather than a separate timer.
      if (windows.size > 10000) {
        for (const [key, entry] of windows) if (now - entry.startedAt >= windowMs) windows.delete(key);
      }
      return w.count <= maxRequests;
    },
  };
}

// --- Bots -----------------------------------------------------------
//
// A registered game entry can be either a bare GameDefinition (backward
// compatible with every existing test/example -- `bots` is simply
// unavailable for it) or `{game, bots}` where `bots` is the same
// `{strategyName: (state, actor, {rng}) => action}` shape a pack's own
// `.bots` export already uses (see e.g. a game pack with bot strategies
// for the real shape). This file still contains zero references to any
// specific game or strategy name -- `example.config.mjs` is where any
// concrete wiring (which games have which bot strategies) actually
// lives, same as the games registry itself.
function normalizeGameEntry(entry) {
  // gameModuleUrl/gameExportName are additive, optional fields -- see
  // this file's own createTableCoreServer() doc comment on `matchHost`
  // for why: a MatchWorkerPool-backed host needs a real module
  // reference to load its own independent copy of the game inside each
  // worker thread (a worker cannot receive a live object reference from
  // the main thread -- separate V8 isolate). The live `game` object is
  // STILL required either way, worker-pool mode or not, since this
  // engine's own bot driver (see driveBotsForMatch below) needs it
  // directly in the main thread for local legal-action/strategy
  // computation regardless of which host actually executes the match.
  if (entry && typeof entry === 'object' && entry.game) {
    return { game: entry.game, bots: entry.bots ?? {}, gameModuleUrl: entry.gameModuleUrl ?? null, gameExportName: entry.gameExportName ?? null };
  }
  return { game: entry, bots: {}, gameModuleUrl: null, gameExportName: null };
}

export function createTableCoreServer({
  secret,
  games = {}, // empty by default -- see this file's own module doc comment for why
  host: bindHost = '127.0.0.1',
  adminHost: bindAdminHost = bindHost,
  tokenTtlSeconds = 3600,
  adminKey = null, // optional but strongly recommended defense-in-depth layer -- see ADMIN.md. Not required by default so a purely local/trusted-network deployment doesn't need to manage a second secret just to run `npm run server:demo`.
  adminMaxRequestsPerMinute = 20, // per-IP; found necessary during a hard adversarial audit -- nothing previously stopped unlimited /api/matches calls from a single client exhausting server memory via unbounded match creation
  maxMatches = 1000, // hard ceiling on total matches this process will ever create -- found necessary during a hard adversarial audit, before sweepExpiredMatches (see below) existed to free up capacity from old ones automatically; kept as a defense-in-depth ceiling regardless, since a sweep only runs periodically, not on every single creation
  botMaxConsecutiveFailures = 5, // a bot strategy that keeps proposing illegal actions (a bug in that strategy, not a server problem) stops being driven after this many REJECTED actions in a row, rather than retrying forever
  launcherUrl = null, // e.g. 'http://192.168.1.42:4170' -- the LAN-reachable base URL of a running launcher (packages/launcher). Optional: when set, POST /api/matches also returns a short `/j/<code>` join link per human player, resolvable by the launcher's own /j/:code route (see tools/launcher/server.mjs). When not set, join-code features are simply unavailable -- everything else about creating a match still works exactly as before.
  matchSweepIntervalMs = 5 * 60 * 1000, // how often ServerHost.sweepExpiredMatches() runs -- see its own doc comment for the real, previously-missing lifecycle gap this closes (matches used to accumulate in memory forever, finished or not). 0 disables the periodic sweep entirely (matches still only ever get removed if something else calls sweepExpiredMatches() directly).
  matchFinishedGraceMs = 30 * 60 * 1000, // how long a finished/aborted match stays viewable (its final board/result) before being swept
  matchAbandonedLobbyGraceMs = 60 * 60 * 1000, // how long a created-but-never-started match stays around before being swept as abandoned
  // Real, confirmed severity, not a theoretical worry: a synchronous
  // infinite loop in ANY registered game's own applyActionInPlace()
  // (an honest bug, not necessarily malice) permanently freezes this
  // ENTIRE process -- every match, every player, forever, with no crash
  // event at all for a process supervisor to react to (Node is single-
  // threaded; the frozen event loop can't even respond to an unrelated
  // request on a completely different match). Reproduced directly
  // against games/infinite-loop-test. `matchHost`, when provided,
  // REPLACES the default in-process ServerHost entirely -- e.g. a real
  // `new MatchWorkerPool({ poolSize, rpcTimeoutMs })` (see
  // @tablecore/worker-pool) genuinely contains that same freeze to just
  // the one worker hosting the runaway match (bounded blast radius:
  // matches on every OTHER worker, and the process itself, stay fully
  // responsive), at the cost of matches on that SAME worker being lost
  // (no persistence/checkpoint layer exists yet to recover them) and
  // real per-call message-passing overhead. Left as an explicit,
  // OPT-IN choice, defaulting to the current in-process host (zero
  // behavior change for every existing deployment) rather than a
  // breaking default swap, because a worker-pool host needs games
  // registered with a real gameModuleUrl/gameExportName (a worker
  // cannot receive a live object reference from the main thread), which
  // existing TABLECORE_SERVER_CONFIG files don't provide -- see
  // normalizeGameEntry's own comment on why the live `game` object is
  // STILL required alongside gameModuleUrl either way (this engine's own
  // bot driver needs it directly, regardless of which host runs the
  // match itself). Must implement the same interface ServerHost does
  // (createMatch/startMatch/getSnapshot/submitAction/abortMatch/
  // getAuthoritativeState) -- sync or async, createProtocolServer()
  // already awaits every call either way.
  matchHost: providedMatchHost = null,
} = {}) {
  // Fail loud, not fail open: a caller who forgets to set a real secret
  // gets a clear refusal to start, not a server quietly running with a
  // weak/predictable/shared-across-deployments default. This mirrors
  // createTokenAuth()'s own >=32-character requirement -- enforced here
  // too, before that constructor's own error would otherwise be the
  // first sign anything was wrong.
  if (typeof secret !== 'string' || secret.length < 32) {
    throw new TypeError('createTableCoreServer requires `secret`, a random string of at least 32 characters. Refusing to start with no secret or a weak one.');
  }
  const matchHost = providedMatchHost ?? new ServerHost();
  // Real, periodic lifecycle cleanup (P2-LIFECYCLE) -- before this,
  // NOTHING ever removed a match from matchHost's own memory, finished
  // or not; matches accumulated forever until process restart. See
  // ServerHost's own sweepExpiredMatches() doc comment for the exact,
  // deliberately conservative removal policy (only finished/aborted
  // matches past a grace period, and abandoned never-started lobbies --
  // never a running match, regardless of idle time). Runs here, in the
  // real server process, rather than as an internal timer inside
  // ServerHost itself -- matching this file's own existing convention
  // for scheduling concerns (see closeBotClients/scheduleBotCheck's own
  // setTimeout-based pattern above) and keeping ServerHost itself pure/
  // synchronous/timer-free, which matters because 38+ existing call
  // sites across this whole test suite construct a ServerHost directly
  // and never call any kind of dispose/stop on it -- there isn't one to
  // forget, and an internal timer here would have made that a real leak
  // risk for every one of them.
  const matchSweepOptions = { finishedGraceMs: matchFinishedGraceMs, abandonedLobbyGraceMs: matchAbandonedLobbyGraceMs };
  const matchSweepTimer = matchSweepIntervalMs > 0 ? setInterval(async () => {
    // Optional chaining, not a plain call: sweepExpiredMatches() is a
    // real ServerHost-specific method (see its own doc comment) --
    // MatchWorkerPool (an alternative `matchHost` a deployment can opt
    // into, see this file's own comment on that option) has no
    // equivalent yet. A genuinely honest, documented limitation, not
    // silently glossed over: worker-pool mode gets NO automatic match
    // cleanup at all today, only whatever `maxMatches` enforces as a
    // hard ceiling. Optional chaining here means this simply does
    // nothing (rather than throwing and killing the whole interval)
    // when the active host doesn't support it, instead of crashing.
    const removed = await matchHost.sweepExpiredMatches?.(Date.now(), matchSweepOptions) ?? [];
    if (removed.length) console.log(`[tablecore] swept ${removed.length} expired match(es): ${removed.map(r => `${r.id} (${r.reason})`).join(', ')}`);
  }, matchSweepIntervalMs) : null;
  if (matchSweepTimer?.unref) matchSweepTimer.unref(); // never keeps the process alive on its own -- a real deployment's own explicit listen()/other work does that
  const auth = createTokenAuth({ secret, ttlSeconds: tokenTtlSeconds });
  const protocol = createProtocolServer(matchHost);
  const adminRateLimiter = createIpRateLimiter({ maxRequests: adminMaxRequestsPerMinute, windowMs: 60000 });
  let matchesCreated = 0;
  let actualWsHost = bindHost, actualWsPort = null;
  // The address CLIENTS should actually use to connect -- differs from
  // `actualWsHost` (which stays as whatever was literally passed to
  // bind(), e.g. '0.0.0.0') specifically when bound to all interfaces:
  // '0.0.0.0' is a valid BIND address but not something a browser can
  // ever connect a WebSocket TO. Found as a real, concrete bug while
  // live-testing this exact server via start.sh (which binds 0.0.0.0 by
  // default for real LAN reachability -- see start.sh's own comment):
  // the join links /api/matches returns had `ws=ws://0.0.0.0:4180`
  // embedded in them, which would fail for every real player's browser.
  // Computed once, when listen() resolves, using the exact same LAN-IP
  // substitution the console startup banner already correctly applies
  // for its own display purposes -- this is that same fix, applied to
  // the ACTUAL URLs handed to real clients, not just what gets printed.
  let publicWsHost = bindHost;
  let closing = false;

  // matchId -> { gameId, botClients: {playerId: wsClientHandle}, consecutiveFailures: number, driving: bool }
  // `driving` guards against overlapping invocations of driveBotsForMatch
  // for the same match (each check reschedules itself via setImmediate
  // once it's done, never calls itself synchronously/recursively -- this
  // is what keeps a chain of bot turns from blocking the event loop:
  // every single bot action goes through at least one full event-loop
  // turn before the next one is even considered, so pending human WS
  // messages, other matches' bot turns, and HTTP requests all get a fair
  // chance to run in between).
  const matchBots = new Map();

  // Short, phone-friendly redirect codes for the create-match page's QR
  // codes (see packages/qrcode) -- a full player join link is ~350
  // characters once a real signed token is embedded in it (see
  // packages/qrcode/src/encoder.js's own module doc comment on exactly
  // this, and why encoding that directly would have needed the FULL
  // 40-version/multi-block QR spec instead of the much smaller, safer
  // subset actually implemented). Registering a short code here and
  // having the LAUNCHER resolve+redirect it (server-to-server, since the
  // launcher runs on the same machine and can reach this loopback-only
  // admin API) keeps the QR-encoded payload down to ~30 characters.
  const JOIN_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // excludes 0/O/1/I/L -- ambiguous when read off a screen/printout by a human as a manual-entry fallback
  // codes -> either {type:'static', url, createdAt} (existing behavior:
  // resolves to a fixed, already-known URL, e.g. an individually-named
  // player's join link) or {type:'lobby', lobbyId, createdAt} (new: ONE
  // shared code for an entire lobby -- see the lobby system below --
  // where resolving the code is itself the act of claiming the next
  // open seat, decided dynamically at resolve time, not fixed up front).
  const joinCodes = new Map();
  function generateJoinCode() {
    let code;
    do {
      code = Array.from({ length: 6 }, () => JOIN_CODE_ALPHABET[crypto.randomInt(JOIN_CODE_ALPHABET.length)]).join('');
    } while (joinCodes.has(code));
    return code;
  }
  function opportunisticCodeCleanup() {
    // Same pattern as the admin rate limiter's own window map -- a join
    // code past the token TTL is useless anyway (the token it points to,
    // or would issue, has already/would-immediately expire).
    if (joinCodes.size > 5000) {
      const cutoff = Date.now() - tokenTtlSeconds * 1000;
      for (const [code, entry] of joinCodes) if (entry.createdAt < cutoff) joinCodes.delete(code);
    }
  }
  function registerJoinCode(fullUrl) {
    opportunisticCodeCleanup();
    const code = generateJoinCode();
    joinCodes.set(code, { type: 'static', url: fullUrl, createdAt: Date.now() });
    return code;
  }
  function registerLobbyJoinCode(lobbyId) {
    opportunisticCodeCleanup();
    const code = generateJoinCode();
    joinCodes.set(code, { type: 'lobby', lobbyId, createdAt: Date.now() });
    return code;
  }

  // Lobbies: ONE shared join link/QR code for a match with N seats,
  // instead of a separate link per named player -- direct answer to a
  // real question asked about this project: "why does every player need
  // their own link/QR? With 6 players that's 6 codes, confusing -- why
  // not one link that auto-assigns seats as people join?" Seats are
  // claimed strictly in the order people actually open the shared link
  // (first to open it gets seat 0, etc.) -- see resolveLobbySeat() below,
  // which is also where a full lobby is detected and reported cleanly
  // rather than as a generic 404.
  //
  // The underlying match is deliberately NOT created at lobby-creation
  // time at all -- rather than always
  // creating the match up front with the full declared seat count (this
  // project's FIRST lobby design, since replaced), a claimed seat before
  // start is just a recorded intent ("this browser has seat B"), with no
  // real match/token/WS connection at all yet. The claiming browser is
  // redirected to a plain, game-agnostic WAITING page (served by the
  // launcher, see packages/launcher/public/lobby-wait.html) that just
  // polls an HTTP status endpoint -- no protocol/WS involved during the
  // wait, which is what makes this design meaningfully simpler than the
  // alternative considered and rejected in ROADMAP.md's original entry
  // on this (extending ClientRuntime to gracefully wait for a
  // not-yet-existing match, or migrating an already-open WS connection
  // to a new matchId). Only at START time does a REAL match actually get
  // created, using EXACTLY the claimed seats' player ids (in their
  // original letters -- A, B, D, ... whatever actually got claimed, no
  // renumbering, so a real-but-not-yet-issued relationship between "seat
  // B" and "player B" never has to change) plus whichever unclaimed
  // seats the organizer explicitly chooses to bot-fill. This is also
  // what makes "just start with fewer players, no bots" fall out for
  // free: since the match is only ever created once, at start time, with
  // whichever players actually showed up, "shrink to fit" isn't a
  // special case needing its own machinery -- it's just what happens
  // when the organizer doesn't ask for any unclaimed seats to be
  // bot-filled (see the `dropUnfilledSeats` option on the start
  // endpoint).
  const lobbies = new Map(); // lobbyId -> {gameId, seatCount, options, spectatorPolicy, claimedSeats: Map(seatIndex -> {claimedAt}), started, matchId, seatResults: Map(seatIndex -> {playerId, token, joinUrl})}
  function generateLobbyId() {
    return `lobby-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  }
  function seatPlayerName(index) {
    let n = index, name = '';
    do { name = String.fromCharCode(65 + (n % 26)) + name; n = Math.floor(n / 26) - 1; } while (n >= 0);
    return name;
  }
  /** Claims the next open seat in a lobby -- records intent only, issues no token/match yet. Returns {ok:true, seatIndex} or {ok:false, reason:'LOBBY_NOT_FOUND'|'LOBBY_FULL'}. */
  function claimNextLobbySeat(lobbyId) {
    const lobby = lobbies.get(lobbyId);
    if (!lobby) return { ok: false, reason: 'LOBBY_NOT_FOUND' };
    const seatIndex = Array.from({ length: lobby.seatCount }, (_, i) => i).find(i => !lobby.claimedSeats.has(i));
    if (seatIndex === undefined) return { ok: false, reason: 'LOBBY_FULL' };
    lobby.claimedSeats.set(seatIndex, { claimedAt: Date.now() });
    return { ok: true, seatIndex };
  }

  /** Builds a real player join URL (player-ui page, real token embedded) -- the one piece of URL construction shared between the regular /api/matches flow and the lobby seat-claim flow below. */
  function buildPlayerJoinUrl(gameId, matchId, playerId, token) {
    return `${launcherUrl}/games/${encodeURIComponent(gameId)}/player-ui/index.html?match=${encodeURIComponent(matchId)}&player=${encodeURIComponent(playerId)}&token=${encodeURIComponent(token)}&ws=${encodeURIComponent(`ws://${publicWsHost}:${actualWsPort}`)}`;
  }

  /** Wraps matchHost.startMatch() so a thrown error from the underlying GAME's own validation (e.g. "Last Sector supports 2-4 unique players", from createInitialState()) becomes a clean {ok:false} result -- same shape as every OTHER validation failure in this admin API -- instead of falling through to the generic 500 ADMIN_API_ERROR handler. Found via this project's own lobby-system tests (an easy-to-hit real case: a lobby whose seat count a given game's own rules simply don't support), and confirmed to be a PRE-EXISTING gap in the regular (non-lobby) /api/matches flow too, not something the lobby system introduced -- fixed for both call sites at once here. Async (not the plain function it used to be) so this works correctly against EITHER a synchronous matchHost (ServerHost, `await` on a plain value just resolves next microtask, zero behavior change) or an asynchronous one (MatchWorkerPool) -- `await matchHost.startMatch(...)` throwing (a rejected promise) is caught by this same try/catch exactly like a synchronous throw would be. */
  async function safeStartMatch({ matchId, actor }) {
    try {
      return await matchHost.startMatch({ matchId, actor });
    } catch (error) {
      return { ok: false, error: { code: 'GAME_VALIDATION_ERROR', message: error instanceof Error ? error.message : String(error) } };
    }
  }

  async function closeBotClients(matchId) {
    const entry = matchBots.get(matchId);
    if (!entry) return;
    matchBots.delete(matchId);
    for (const client of Object.values(entry.botClients)) { try { client.close(); } catch {} }
  }

  // Extracted from what used to be inline-only inside the POST
  // /api/matches handler, so the exact same real, tested bot-connection
  // logic (a bot is "just another WS client", reusing 100% of the real
  // broadcast pathway -- see the block below its own comment for the
  // full reasoning) can ALSO be reused by the lobby "start with
  // unclaimed seats auto-filled by bots" flow (see POST
  // /api/lobbies/:id/start), instead of a second, drifting copy of the
  // same logic.
  async function registerBotsForMatch(matchId, gameId, botAssignments, tokens) {
    if (!botAssignments || !Object.keys(botAssignments).length) return;
    const botClients = {};
    for (const playerId of Object.keys(botAssignments)) {
      const client = await createWsClient({ port: actualWsPort, host: '127.0.0.1', hello: { type: 'HELLO', protocolVersion: 1, token: tokens[playerId] } });
      client.send({ type: 'SYNC_REQUEST', protocolVersion: 1, matchId });
      botClients[playerId] = client;
    }
    matchBots.set(matchId, {
      gameId,
      strategies: botAssignments,
      botClients,
      consecutiveFailures: 0,
      driving: false,
      rng: createSeededRng(crypto.randomBytes(4).readUInt32LE(0)),
      // Real, found-and-fixed gap: this driver used to fire-and-forget
      // every bot action (`client.send(...)` below, never inspecting
      // the real reply the server actually sends back on
      // client.messages -- confirmed directly, not assumed: this array
      // genuinely does receive the server's ACTION_REJECTED/UPDATE
      // reply, transport-ws's own createWsClient() already pushes every
      // real incoming message into it). `consecutiveFailures` only ever
      // incremented when a bot's own STRATEGY FUNCTION threw an
      // exception -- a bot whose strategy always returns a
      // legal-LOOKING action (passes getLegalActions(), so nothing
      // here objects) that the server nonetheless keeps REJECTING for
      // some OTHER reason (a subtler validateAction()/
      // applyActionInPlace() rejection getLegalActions itself doesn't
      // catch) hit no backoff at all. Reproduced directly: a
      // deliberately misbehaving bot strategy sent 33 rejected actions
      // in 3 seconds with zero slowdown, hammering the server
      // indefinitely for the entire remaining lifetime of the match.
      // `lastCheckedMessageCountByPlayer` tracks how far into each bot
      // client's own `messages` array this driver has already scanned,
      // so the very next scheduled pass (see scheduleBotCheck below)
      // can check whether the PREVIOUS action actually succeeded before
      // deciding a new one, without needing to await the reply
      // synchronously in the middle of sending it.
      lastCheckedMessageCountByPlayer: {},
    });
    scheduleBotCheck(matchId);
  }

  function scheduleBotCheck(matchId) {
    if (closing) return;
    setImmediate(() => { driveBotsForMatch(matchId).catch(error => console.error(`[bots] match ${matchId}:`, error)); });
  }

  async function driveBotsForMatch(matchId) {
    const entry = matchBots.get(matchId);
    if (!entry || entry.driving) return;
    entry.driving = true;
    try {
      const snap = await matchHost.getSnapshot(matchId);
      if (!snap.ok || snap.snapshot.status !== 'running') { await closeBotClients(matchId); return; }
      const gameEntry = normalizeGameEntry(games[entry.gameId]);
      const raw = await matchHost.getAuthoritativeState(matchId);
      if (!raw.ok) { await closeBotClients(matchId); return; }

      // Decision-making happens on the RAW, authoritative state -- never
      // the projected/client-facing one. Bot strategy functions expect
      // the same internal shape applyActionInPlace()/getLegalActions()
      // operate on (this is the exact same reason ServerHost.getSnapshot()
      // computes `availableActions` from raw state too, not the projected
      // view -- see its own comment for the concrete example of why the
      // two shapes can genuinely differ).
      for (const [playerId, strategyName] of Object.entries(entry.strategies)) {
        if (entry.consecutiveFailures >= botMaxConsecutiveFailures) continue; // this match's bots are disabled after too many rejected actions -- see below
        const client = entry.botClients[playerId];
        // Check whether this bot's own PREVIOUS action (if any) was
        // actually accepted or rejected by the server, before deciding
        // a new one -- see this match's own lastCheckedMessageCountByPlayer
        // comment above for why this check exists at all.
        if (client) {
          const checkedCount = entry.lastCheckedMessageCountByPlayer[playerId] ?? 0;
          const newMessages = client.messages.slice(checkedCount);
          entry.lastCheckedMessageCountByPlayer[playerId] = client.messages.length;
          const rejection = newMessages.find(m => m && m.type === 'ACTION_REJECTED');
          if (rejection) {
            console.error(`[bots] match ${matchId} player ${playerId} strategy "${strategyName}"'s action was rejected by the server:`, rejection.error);
            entry.consecutiveFailures++;
            continue;
          }
        }
        const legal = gameEntry.game.getLegalActions(raw.state, playerId);
        if (!legal.length) continue; // not this bot's turn (or it has nothing legal to do right now)
        const strategyFn = gameEntry.bots?.[strategyName];
        if (typeof strategyFn !== 'function') continue; // shouldn't happen (validated at match-creation time), but never crash the driver loop over it
        let action;
        try {
          action = strategyFn(raw.state, playerId, { rng: entry.rng });
        } catch (error) {
          console.error(`[bots] match ${matchId} player ${playerId} strategy "${strategyName}" threw while deciding an action:`, error);
          entry.consecutiveFailures++;
          continue;
        }
        if (!client) continue;
        const beforeVersion = raw.version;
        client.send({ type: 'ACTION', protocolVersion: 1, matchId, expectedVersion: beforeVersion, action: { ...action, actor: playerId } });
        // One bot action per pass through this loop, then reschedule --
        // deliberately not looping further synchronously here even if
        // MULTIPLE bots could theoretically act in the same instant,
        // to keep each individual bot decision's cost bounded and this
        // function's own runtime short and predictable.
        scheduleBotCheck(matchId);
        entry.driving = false;
        return;
      }
    } finally {
      entry.driving = false;
    }
    // No bot had a legal action this pass (nobody's turn, or the match
    // just isn't ready) -- check again shortly. This also naturally
    // covers "waiting for a human player's turn to end" without needing
    // to know anything about turn structure.
    if (matchBots.has(matchId)) setTimeout(() => scheduleBotCheck(matchId), 200);
  }

  const adminServer = http.createServer(async (req, res) => {
    try {
      const clientIp = req.socket.remoteAddress || 'unknown';
      if (!adminRateLimiter.consume(clientIp)) return sendJson(res, 429, { error: 'RATE_LIMITED' });
      const url = new URL(req.url || '/', 'http://admin');
      // Static assets (the create-match page itself, its JS, and the
      // @tablecore/qrcode files it needs) are exempt from the adminKey
      // gate below on purpose: they contain no sensitive data on their
      // own, and gating them would make the page itself unloadable via
      // plain browser navigation when adminKey IS configured (a simple
      // GET navigation cannot set a custom X-Admin-Key header). The
      // page's own JS reads a `?key=` query parameter from its own URL
      // instead, and sends THAT as the header on its own API calls --
      // the CLI banner prints a ready-to-use link with the key already
      // embedded when one is configured, so this stays a real security
      // boundary for the API itself without making the page unusable.
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/create')) {
        return sendFile(res, path.join(CREATE_PAGE_DIR, 'index.html'));
      }
      if (req.method === 'GET' && url.pathname === '/create.js') {
        return sendFile(res, path.join(CREATE_PAGE_DIR, 'create.js'));
      }
      if (req.method === 'GET' && url.pathname === '/style.css') {
        return sendFile(res, path.join(CREATE_PAGE_DIR, 'style.css'));
      }
      if (req.method === 'GET' && url.pathname.startsWith('/qrcode/')) {
        const rel = decodeURIComponent(url.pathname.slice('/qrcode/'.length));
        return sendFile(res, safePath(QRCODE_DIR, rel));
      }
      // Constant-time-ish comparison isn't critical here the way it is
      // for the actual token signatures (createTokenAuth already does
      // real timingSafeEqual comparisons for those) -- this is a coarser,
      // optional defense-in-depth layer, not the primary security
      // boundary (that's still "don't expose this port publicly").
      if (adminKey != null && req.headers['x-admin-key'] !== adminKey) {
        return sendJson(res, 401, { error: 'UNAUTHORIZED' });
      }
      if (req.method === 'GET' && url.pathname === '/api/games') {
        // Best-effort: if launcherUrl is configured, ask the launcher
        // (server-to-server -- this admin server already knows where it
        // is, for join-code purposes) which of these registered games
        // actually have a real browser UI (`hasPlay`/`hasPreview`).
        // This engine's own registered-games list has NO concept of
        // "does this have a UI" at all (deliberately -- see this file's
        // own module doc comment on why it knows nothing about specific
        // games or their content); that information genuinely belongs
        // to the launcher, which is what actually discovers/serves
        // player-ui/tv-ui files. Found necessary after a real report:
        // creating a match for a game with no player-ui (e.g. grid-duel,
        // a bare backend rules-testing fixture that never had one) used
        // to silently generate a join link that 404s for every player,
        // with nothing warning the organizer beforehand. Gracefully
        // degrades to `hasPlay: null` ("unknown") if launcherUrl isn't
        // configured or the launcher isn't reachable -- never blocks
        // /api/games itself from responding.
        let launcherCatalog = null;
        if (launcherUrl) {
          try {
            const res2 = await fetch(`${launcherUrl}/api/games`, { signal: AbortSignal.timeout(2000) });
            if (res2.ok) launcherCatalog = (await res2.json()).games;
          } catch { /* launcher unreachable -- hasPlay stays null below, not a hard failure */ }
        }
        return sendJson(res, 200, {
          games: Object.entries(games).map(([id, entry]) => {
            const normalized = normalizeGameEntry(entry);
            const launcherEntry = launcherCatalog?.find(g => g.id === id);
            // name/description are ALSO pulled from this same launcher
            // catalog fetch (already happening above for hasPlay, at no
            // extra cost) -- lets the create-game page show a real game
            // title/blurb instead of the bare technical id, once an
            // organizer arrives here with a game already chosen on the
            // launcher (see tools/server/public/create.js's own
            // preselectedGame handling).
            return {
              id, bots: Object.keys(normalized.bots), hasPlay: launcherEntry ? launcherEntry.hasPlay : null,
              name: launcherEntry?.name || id,
              description: launcherEntry?.description || '',
              minPlayers: launcherEntry?.minPlayers ?? null,
              maxPlayers: launcherEntry?.maxPlayers ?? null,
            };
          }),
        });
      }
      if (req.method === 'POST' && url.pathname === '/api/matches') {
        if (matchesCreated >= maxMatches) return sendJson(res, 503, { error: 'MATCH_CAPACITY_REACHED' });
        const body = await readJsonBody(req);
        const gameEntry = games[body.gameId] != null ? normalizeGameEntry(games[body.gameId]) : null;
        if (!gameEntry) return sendJson(res, 400, { error: 'UNKNOWN_GAME_ID', knownGames: Object.keys(games) });
        if (!Array.isArray(body.players) || body.players.length < 1) return sendJson(res, 400, { error: 'PLAYERS_REQUIRED' });
        if (!isPlainObjectOrUndefined(body.options)) return sendJson(res, 400, { error: 'INVALID_OPTIONS', message: 'options, if provided, must be a plain object' });
        // `body.bots`: optional `{playerId: strategyName}` -- every key
        // must be one of the requested players (a bot can't control a
        // player nobody asked to create), and every value must be a
        // strategy this game's pack actually declares, checked BEFORE
        // creating anything so a typo'd strategy name fails loudly at
        // match-creation time instead of the bot silently never moving.
        const botAssignments = body.bots && typeof body.bots === 'object' ? body.bots : null;
        if (botAssignments) {
          for (const [playerId, strategyName] of Object.entries(botAssignments)) {
            if (!body.players.includes(playerId)) return sendJson(res, 400, { error: 'BOT_PLAYER_NOT_IN_MATCH', playerId });
            if (typeof gameEntry.bots?.[strategyName] !== 'function') {
              return sendJson(res, 400, { error: 'UNKNOWN_BOT_STRATEGY', playerId, strategyName, knownStrategies: Object.keys(gameEntry.bots ?? {}) });
            }
          }
        }
        const matchId = body.matchId || `match-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const created = await matchHost.createMatch({ id: matchId, game: gameEntry.game, gameModuleUrl: gameEntry.gameModuleUrl, gameExportName: gameEntry.gameExportName, players: body.players, options: body.options, spectatorPolicy: body.spectatorPolicy || 'deny' });
        if (!created.ok) return sendJson(res, 400, { error: created.error?.code || 'CREATE_FAILED', message: created.error?.message });
        matchesCreated++;
        const started = await safeStartMatch({ matchId, actor: body.players[0] });
        if (!started.ok) {
          // Only the GAME_VALIDATION_ERROR case (safeStartMatch's own
          // caught-exception marker) is genuinely risky to echo a message
          // for -- an arbitrary game's createInitialState() could throw
          // literally anything, including something sensitive (this is
          // exactly what a real test in this project's own suite checks
          // stays suppressed). Every OTHER error code here comes from
          // ServerHost's own small, fixed, safe vocabulary (MATCH_NOT_FOUND
          // etc.), never from arbitrary game code, so passing THEIR message
          // through (when they have one) is fine.
          const code = started.error?.code || 'START_FAILED';
          const message = code === 'GAME_VALIDATION_ERROR' ? undefined : started.error?.message;
          return sendJson(res, 400, { error: code, message });
        }
        // Issue one token per requested player -- these are what get
        // handed to each actual (human) player's client to connect over
        // the WS game server. Bot-controlled players ALSO get a real
        // token here (needed below to open their own internal WS
        // connection), but it is not returned to the caller -- nothing
        // outside this server should ever need a bot's own token.
        const tokens = {};
        for (const playerId of body.players) tokens[playerId] = auth.issueToken({ playerId });

        await registerBotsForMatch(matchId, body.gameId, botAssignments, tokens);

        // Bot tokens are deliberately excluded from the response --
        // never returned to the caller, only used internally above.
        const humanTokens = Object.fromEntries(Object.entries(tokens).filter(([id]) => !botAssignments?.[id]));

        // Short join-code links, one per human player -- only when the
        // caller told us where the launcher is (launcherUrl). Gracefully
        // absent otherwise: everything else about match creation still
        // works, this is purely additive.
        const joinLinks = {};
        if (launcherUrl) {
          for (const playerId of Object.keys(humanTokens)) {
            const fullUrl = buildPlayerJoinUrl(body.gameId, matchId, playerId, humanTokens[playerId]);
            const code = registerJoinCode(fullUrl);
            joinLinks[playerId] = { code, shortUrl: `${launcherUrl}/j/${code}`, fullUrl };
          }
        }

        return sendJson(res, 201, { matchId, gameId: body.gameId, players: body.players, bots: botAssignments ?? {}, tokens: humanTokens, joinLinks, wsUrl: `ws://${publicWsHost}:${actualWsPort}` });
      }
      if (req.method === 'POST' && url.pathname === '/api/spectator-tokens') {
        const body = await readJsonBody(req);
        const token = auth.issueToken({ role: 'spectator' });
        let joinLink = null;
        // A spectator join code needs a specific match+game to point the
        // TV board at -- optional (`{matchId, gameId}` in the request
        // body), since a bare spectator token is still useful on its own
        // (e.g. for something that doesn't use the join-code/QR flow).
        if (launcherUrl && body.matchId && body.gameId) {
          const fullUrl = `${launcherUrl}/games/${encodeURIComponent(body.gameId)}/tv-ui/index.html?match=${encodeURIComponent(body.matchId)}&token=${encodeURIComponent(token)}&ws=${encodeURIComponent(`ws://${publicWsHost}:${actualWsPort}`)}`;
          const code = registerJoinCode(fullUrl);
          joinLink = { code, shortUrl: `${launcherUrl}/j/${code}`, fullUrl };
        }
        return sendJson(res, 201, { token, joinLink });
      }
      if (req.method === 'GET' && url.pathname.startsWith('/api/join-codes/')) {
        // Called BY the launcher (server-to-server, both on the same
        // machine -- this admin API stays loopback-only regardless of
        // what the launcher itself is bound to) to resolve a short `/j/`
        // code back into the real join URL for a 302 redirect.
        const code = decodeURIComponent(url.pathname.slice('/api/join-codes/'.length));
        const entry = joinCodes.get(code);
        if (!entry) return sendJson(res, 404, { error: 'JOIN_CODE_NOT_FOUND' });
        if (entry.type === 'static') return sendJson(res, 200, { url: entry.url });
        if (entry.type === 'lobby') {
          // Resolving a lobby code IS the act of claiming a seat -- each
          // fresh GET to this same shared code claims the NEXT open seat,
          // in the order people actually open it. See claimNextLobbySeat's
          // own comment for why seats are assigned this way. Redirects to
          // the WAITING page (not player-ui directly) -- see the lobby
          // data model's own comment above (`const lobbies = new Map()`)
          // for why the real match/token don't exist yet at claim time.
          const claim = claimNextLobbySeat(entry.lobbyId);
          if (!claim.ok && claim.reason === 'LOBBY_FULL') return sendJson(res, 409, { error: 'LOBBY_FULL' });
          if (!claim.ok) return sendJson(res, 404, { error: 'JOIN_CODE_NOT_FOUND' });
          const waitUrl = `${launcherUrl}/lobby-wait.html?lobby=${encodeURIComponent(entry.lobbyId)}&seat=${claim.seatIndex}`;
          return sendJson(res, 200, { url: waitUrl });
        }
        return sendJson(res, 404, { error: 'JOIN_CODE_NOT_FOUND' });
      }
      if (req.method === 'GET' && url.pathname.match(/^\/api\/lobbies\/[^/]+\/seat\/\d+$/)) {
        // Polled repeatedly by the waiting page (via the launcher's own
        // proxy route -- this admin API stays loopback-only, a remote
        // player's browser can never reach it directly) -- idempotent,
        // never claims or changes anything. Reports whether the organizer
        // has started the match yet and, once they have, this specific
        // seat's real join URL. Always includes the LIVE claimed/total
        // seat counts too -- a real, direct request: the waiting page
        // should show "2 из 4 игроков подключились", not just a bare
        // spinner with no indication of progress.
        const parts = url.pathname.split('/');
        const lobbyId = decodeURIComponent(parts[3]);
        const seatIndex = Number(parts[5]);
        const lobby = lobbies.get(lobbyId);
        if (!lobby) return sendJson(res, 404, { error: 'LOBBY_NOT_FOUND' });
        const claimedCount = lobby.claimedSeats.size;
        if (!lobby.started) return sendJson(res, 200, { started: false, claimedCount, seatCount: lobby.seatCount });
        const result = lobby.seatResults.get(seatIndex);
        if (!result) return sendJson(res, 200, { started: true, dropped: true, claimedCount, seatCount: lobby.seatCount }); // the match started, but this specific seat was never claimed and wasn't bot-filled either -- see dropUnfilledSeats on the start endpoint
        return sendJson(res, 200, { started: true, joinUrl: result.joinUrl, claimedCount, seatCount: lobby.seatCount });
      }
      if (req.method === 'POST' && url.pathname === '/api/lobbies') {
        const body = await readJsonBody(req);
        const gameEntry = games[body.gameId] != null ? normalizeGameEntry(games[body.gameId]) : null;
        if (!gameEntry) return sendJson(res, 400, { error: 'UNKNOWN_GAME_ID', knownGames: Object.keys(games) });
        const seatCount = Number(body.seatCount);
        if (!Number.isInteger(seatCount) || seatCount < 1 || seatCount > 16) return sendJson(res, 400, { error: 'INVALID_SEAT_COUNT', message: 'seatCount must be an integer from 1 to 16' });
        if (!isPlainObjectOrUndefined(body.options)) return sendJson(res, 400, { error: 'INVALID_OPTIONS', message: 'options, if provided, must be a plain object' });
        // No match is created here at all -- see the lobby data model's
        // own comment above (`const lobbies = new Map()`) for the full
        // reasoning. A claimed seat before start is just a recorded
        // intent, nothing more.
        const lobbyId = generateLobbyId();
        lobbies.set(lobbyId, {
          gameId: body.gameId, seatCount, options: body.options, spectatorPolicy: body.spectatorPolicy || 'deny',
          claimedSeats: new Map(), started: false, matchId: null, seatResults: new Map(), createdAt: Date.now(),
        });
        let joinLink = null;
        if (launcherUrl) {
          const code = registerLobbyJoinCode(lobbyId);
          joinLink = { code, shortUrl: `${launcherUrl}/j/${code}` };
        }
        return sendJson(res, 201, { lobbyId, gameId: body.gameId, seatCount, joinLink });
      }
      if (req.method === 'GET' && url.pathname.startsWith('/api/lobbies/') && !url.pathname.endsWith('/start')) {
        const lobbyId = decodeURIComponent(url.pathname.slice('/api/lobbies/'.length));
        const lobby = lobbies.get(lobbyId);
        if (!lobby) return sendJson(res, 404, { error: 'LOBBY_NOT_FOUND' });
        // seatPlayerName(i) here is purely a DISPLAY label ("Seat A",
        // "Seat B", ...) for the organizer's own status view -- it is NOT
        // yet a real match player id (no match exists until start), so
        // showing it doesn't imply any commitment about what the FINAL
        // match's actual player list will be.
        const seats = Array.from({ length: lobby.seatCount }, (_, i) => ({
          index: i, playerId: seatPlayerName(i),
          claimed: lobby.claimedSeats.has(i),
          claimedAt: lobby.claimedSeats.get(i)?.claimedAt ?? null,
        }));
        return sendJson(res, 200, { lobbyId, gameId: lobby.gameId, matchId: lobby.matchId, seats, started: lobby.started });
      }
      if (req.method === 'POST' && url.pathname.match(/^\/api\/lobbies\/[^/]+\/start$/)) {
        const lobbyId = decodeURIComponent(url.pathname.slice('/api/lobbies/'.length, -'/start'.length));
        const lobby = lobbies.get(lobbyId);
        if (!lobby) return sendJson(res, 404, { error: 'LOBBY_NOT_FOUND' });
        if (lobby.started) return sendJson(res, 400, { error: 'LOBBY_ALREADY_STARTED' });
        if (matchesCreated >= maxMatches) return sendJson(res, 503, { error: 'MATCH_CAPACITY_REACHED' }); // moved here from POST /api/lobbies -- that endpoint no longer creates a match at all, this is the only place a lobby ever actually does
        const body = await readJsonBody(req);
        const gameEntry = normalizeGameEntry(games[lobby.gameId]);
        const claimedSeatIndices = Array.from({ length: lobby.seatCount }, (_, i) => i).filter(i => lobby.claimedSeats.has(i));
        const unclaimedSeatIndices = Array.from({ length: lobby.seatCount }, (_, i) => i).filter(i => !lobby.claimedSeats.has(i));

        const botAssignments = {};
        if (unclaimedSeatIndices.length) {
          // `fillEmptyWithBot` accepts EITHER a single strategy name
          // (applied to every unclaimed seat) OR an object mapping
          // specific playerId -> strategyName (different empty seats can
          // get different bot behavior). `dropUnfilledSeats:true` is the
          // OTHER real option for an unclaimed seat with no bot
          // assigned: rather than refusing to start, simply EXCLUDE that
          // seat from the final match entirely -- direct answer to the
          // original question this whole feature came from: "what if
          // not everyone who wanted to play shows up, and I don't want
          // to use a bot, just start with whoever's actually here".
          // Without dropUnfilledSeats, the SAFE default from before is
          // preserved: an unclaimed seat with no bot assigned refuses to
          // start (SEATS_UNFILLED) rather than silently either dropping
          // it OR leaving a seat nobody will ever act for.
          const fill = body.fillEmptyWithBot;
          const perSeatMap = (fill && typeof fill === 'object' && !Array.isArray(fill)) ? fill : {};
          const fallbackStrategy = typeof fill === 'string' ? fill : null;
          const stillUnfilled = [];
          for (const i of unclaimedSeatIndices) {
            const playerId = seatPlayerName(i);
            const strategyName = perSeatMap[playerId] ?? fallbackStrategy;
            const strategyFn = strategyName ? gameEntry.bots?.[strategyName] : null;
            if (strategyFn) { botAssignments[playerId] = strategyName; continue; }
            if (!body.dropUnfilledSeats) stillUnfilled.push(playerId);
          }
          if (stillUnfilled.length) {
            return sendJson(res, 400, {
              error: 'SEATS_UNFILLED',
              unclaimedSeats: stillUnfilled,
              knownStrategies: Object.keys(gameEntry.bots ?? {}),
              message: gameEntry.bots && Object.keys(gameEntry.bots).length
                ? 'Есть незанятые места без выбранной стратегии бота. Укажите fillEmptyWithBot для каждого из них, либо dropUnfilledSeats:true, чтобы начать без них.'
                : 'Есть незанятые места, а у этой игры нет ботов, которыми можно было бы их заполнить. Дождитесь, пока подключатся все игроки, либо начните с dropUnfilledSeats:true.',
            });
          }
        }

        const finalPlayers = [...claimedSeatIndices, ...unclaimedSeatIndices.filter(i => botAssignments[seatPlayerName(i)])]
          .sort((a, b) => a - b)
          .map(i => seatPlayerName(i));
        if (!finalPlayers.length) {
          return sendJson(res, 400, { error: 'NO_PLAYERS', message: 'Нельзя начать матч без единого игрока -- ни один человек не подключился, и ни одно место не заполнено ботом.' });
        }

        const matchId = body.matchId || `match-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const created = await matchHost.createMatch({ id: matchId, game: gameEntry.game, gameModuleUrl: gameEntry.gameModuleUrl, gameExportName: gameEntry.gameExportName, players: finalPlayers, options: lobby.options, spectatorPolicy: lobby.spectatorPolicy });
        if (!created.ok) return sendJson(res, 400, { error: created.error?.code || 'CREATE_FAILED', message: created.error?.message });
        matchesCreated++;

        const started = await safeStartMatch({ matchId, actor: finalPlayers[0] });
        if (!started.ok) {
          // Only the GAME_VALIDATION_ERROR case (safeStartMatch's own
          // caught-exception marker) is genuinely risky to echo a message
          // for -- an arbitrary game's createInitialState() could throw
          // literally anything, including something sensitive (this is
          // exactly what a real test in this project's own suite checks
          // stays suppressed). Every OTHER error code here comes from
          // ServerHost's own small, fixed, safe vocabulary (MATCH_NOT_FOUND
          // etc.), never from arbitrary game code, so passing THEIR message
          // through (when they have one) is fine.
          const code = started.error?.code || 'START_FAILED';
          const message = code === 'GAME_VALIDATION_ERROR' ? undefined : started.error?.message;
          return sendJson(res, 400, { error: code, message });
        }

        // Real tokens issued NOW, for the first time -- only for the
        // CLAIMED (human) seats; bot-filled seats get their own tokens
        // inside registerBotsForMatch, same as the non-lobby flow, never
        // exposed to any caller.
        const humanTokens = {};
        for (const i of claimedSeatIndices) {
          const playerId = seatPlayerName(i);
          const token = auth.issueToken({ playerId });
          humanTokens[playerId] = token;
          lobby.seatResults.set(i, { playerId, token, joinUrl: buildPlayerJoinUrl(lobby.gameId, matchId, playerId, token) });
        }
        const botTokens = {};
        for (const playerId of Object.keys(botAssignments)) botTokens[playerId] = auth.issueToken({ playerId });
        await registerBotsForMatch(matchId, lobby.gameId, botAssignments, { ...humanTokens, ...botTokens });

        lobby.started = true;
        lobby.matchId = matchId;
        return sendJson(res, 200, { lobbyId, matchId, players: finalPlayers, bots: botAssignments });
      }
      return sendJson(res, 404, { error: 'NOT_FOUND' });
    } catch (error) {
      // Deliberately generic in the response body, not the raw error
      // message -- an admin API reachable by anyone (even behind "don't
      // expose this publicly" advice, defense in depth matters) should
      // not echo internal exception text, which can leak implementation
      // details. The real message still goes to the server's own logs.
      console.error('[admin api]', error);
      if (error?.code === 'BODY_TOO_LARGE') return sendJson(res, 413, { error: 'BODY_TOO_LARGE' });
      return sendJson(res, 500, { error: 'ADMIN_API_ERROR' });
    }
  });

  const ws = createWsServer({
    protocol,
    auth,
    resolveConnection: ({ claims }) => ({ role: claims.role, playerId: claims.playerId ?? null }),
  });

  return {
    matchHost, auth, protocol, ws, adminServer,
    async listen({ port = 0, adminPort = 0 } = {}) {
      await new Promise((resolve, reject) => { adminServer.once('error', reject); adminServer.listen(adminPort, bindAdminHost, resolve); });
      actualWsPort = await ws.listen(port, bindHost);
      if (bindHost === '0.0.0.0') { const lanIp = findLanIp(); if (lanIp) publicWsHost = lanIp; }
      return { wsHost: actualWsHost, wsPort: actualWsPort, adminHost: bindAdminHost, adminPort: adminServer.address().port };
    },
    async close() {
      closing = true;
      if (matchSweepTimer) clearInterval(matchSweepTimer);
      for (const matchId of [...matchBots.keys()]) await closeBotClients(matchId);
      await Promise.all([ws.close(), new Promise(resolve => adminServer.close(() => resolve()))]);
    },
  };
}

/**
 * Loads a `{ games: { [id]: GameDefinition } }` registry from an
 * EXTERNAL config file (a real filesystem path, resolved and imported at
 * runtime) -- this is the actual plug-in mechanism: whoever deploys this
 * server writes their own config file listing whichever @tablecore/game-*
 * (or any other, third-party) packages they want to host, and this
 * function dynamically imports exactly that, and nothing this file
 * itself had to know about in advance. Returns `{}` if no path is given.
 */
export async function loadGamesConfig(configPath) {
  if (!configPath) return {};
  const resolved = path.isAbsolute(configPath) ? configPath : path.resolve(process.cwd(), configPath);
  const mod = await import(pathToFileURL(resolved).href);
  return mod.games ?? mod.default?.games ?? {};
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const secret = process.env.TABLECORE_SERVER_SECRET;
  if (typeof secret !== 'string' || secret.length < 32) {
    console.error('TABLECORE_SERVER_SECRET must be set to a random string of at least 32 characters. Refusing to start with no secret or a weak one.');
    console.error('Generate one, e.g.: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
    process.exit(1);
  }
  const configPath = process.env.TABLECORE_SERVER_CONFIG || null;
  let games = {};
  try {
    games = await loadGamesConfig(configPath);
  } catch (error) {
    console.error(`Failed to load games config from "${configPath}": ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  if (Object.keys(games).length === 0) {
    console.warn('No games registered (TABLECORE_SERVER_CONFIG not set, or its config exports no games). The server will start, but every /api/matches call will be rejected with UNKNOWN_GAME_ID until you register some.');
    console.warn('See tools/server/example.config.mjs for a working example, or write your own config file exporting `{ games: { <id>: <GameDefinition> } }`.');
  }
  // Computed BEFORE createTableCoreServer() (not after server.listen()
  // resolves, the way the rest of this banner's addressing info is)
  // because `launcherUrl` needs to be passed IN as an option -- it's
  // what makes /api/matches actually return real join-code links (see
  // createTableCoreServer()'s own comment on the `launcherUrl` option).
  // An explicit TABLECORE_LAUNCHER_URL always wins; otherwise this
  // guesses the launcher's default port at whatever host this server
  // itself is reachable at (correct for the common case: both started
  // together by start.sh/start.cmd on the same machine).
  const bindHostForLauncherGuess = process.env.TABLECORE_SERVER_HOST || '127.0.0.1';
  const lanIpForLauncherGuess = findLanIp();
  const launcherDisplayHost = (bindHostForLauncherGuess === '0.0.0.0' && lanIpForLauncherGuess) ? lanIpForLauncherGuess : bindHostForLauncherGuess;
  const launcherUrl = process.env.TABLECORE_LAUNCHER_URL || `http://${launcherDisplayHost}:${process.env.TABLECORE_LAUNCHER_PORT || 4170}`;
  const server = createTableCoreServer({
    secret,
    games,
    host: bindHostForLauncherGuess,
    adminHost: process.env.TABLECORE_SERVER_ADMIN_HOST || process.env.TABLECORE_SERVER_HOST || '127.0.0.1',
    tokenTtlSeconds: Number(process.env.TABLECORE_SERVER_TOKEN_TTL_SECONDS || 3600),
    adminKey: process.env.TABLECORE_SERVER_ADMIN_KEY || null,
    adminMaxRequestsPerMinute: Number(process.env.TABLECORE_SERVER_ADMIN_RATE_LIMIT || 20),
    maxMatches: Number(process.env.TABLECORE_SERVER_MAX_MATCHES || 1000),
    launcherUrl,
  });
  if (!process.env.TABLECORE_SERVER_ADMIN_KEY) {
    console.warn('TABLECORE_SERVER_ADMIN_KEY is not set -- the admin API has no request-level authentication. Fine for a purely local/trusted-network deployment; set this before exposing the admin port to anyone you don\'t fully trust.');
  }
  server.listen({
    port: Number(process.env.TABLECORE_SERVER_PORT || 4180),
    adminPort: Number(process.env.TABLECORE_SERVER_ADMIN_PORT || 4181),
  }).then(addr => {
    const lanIp = lanIpForLauncherGuess;
    // The bind host itself ('0.0.0.0', '127.0.0.1', or a specific IP) is
    // what the server is actually listening on; `displayHost` is what a
    // browser/another machine should actually navigate to -- these
    // genuinely differ when bound to 0.0.0.0. If bound to a specific,
    // already-real IP or to loopback, that value is already correct to
    // show as-is.
    const displayHost = (addr.wsHost === '0.0.0.0' && lanIp) ? lanIp : addr.wsHost;
    const gameIds = Object.keys(games);

    console.log('');
    console.log('=== TableCore server is running ===');
    console.log('');
    console.log(`Admin API   (create matches, tokens):  http://${displayHost}:${addr.adminPort}`);
    console.log(`Game server (players/bots connect):    ws://${displayHost}:${addr.wsPort}`);
    if (lanIp && addr.wsHost === '0.0.0.0') console.log(`(bound to 0.0.0.0 -- reachable from other machines on this network at ${lanIp}, and locally at 127.0.0.1)`);
    console.log('');
    console.log(`Registered games: ${gameIds.length ? gameIds.join(', ') : '(none -- set TABLECORE_SERVER_CONFIG)'}`);
    for (const id of gameIds) {
      const normalized = normalizeGameEntry(games[id]);
      const strategies = Object.keys(normalized.bots ?? {});
      if (strategies.length) console.log(`  - ${id}: bots available -> ${strategies.join(', ')}`);
    }
    console.log('');
    console.log('--- Создать матч без единой команды ---');
    const adminBase = `http://${displayHost}:${addr.adminPort}`;
    const keyParam = process.env.TABLECORE_SERVER_ADMIN_KEY ? `?key=${encodeURIComponent(process.env.TABLECORE_SERVER_ADMIN_KEY)}` : '';
    console.log(`  ${adminBase}/${keyParam}`);
    console.log('  Откройте эту ссылку в браузере -- выберите игру, добавьте игроков, получите готовые ссылки и QR-коды.');
    console.log('');
    console.log('--- Player client & TV board ---');
    console.log(`These are served by the SEPARATE launcher tool (a different process --`);
    console.log(`run \`npm run launcher\` alongside this server), not by this admin API itself:`);
    console.log(`  Launcher (game library / picks up player-ui & tv-ui for any registered game): ${launcherUrl}`);
    console.log(`  Player join link pattern (fill in from a real /api/matches response below):`);
    console.log(`    ${launcherUrl}/games/<gameId>/player-ui/index.html?match=<matchId>&player=<playerId>&token=<token>&ws=ws://${displayHost}:${addr.wsPort}`);
    console.log(`  TV/spectator board pattern (needs a spectator token, and the game's own tv-ui -- see ADMIN.md for which games actually have one working today):`);
    console.log(`    ${launcherUrl}/games/<gameId>/tv-ui/index.html?match=<matchId>&ws=ws://${displayHost}:${addr.wsPort}&token=<spectator-token>`);
    console.log('');
    console.log('--- Testing: create a match (curl) ---');
    const exampleGameId = gameIds[0] ?? '<gameId>';
    console.log(`  curl -X POST http://${displayHost}:${addr.adminPort}/api/matches \\`);
    console.log(`    -H "content-type: application/json" \\`);
    console.log(`    -d '{"gameId":"${exampleGameId}","players":["A","B"],"spectatorPolicy":"public"}'`);
    console.log('');
    console.log('--- Testing: create a match with a bot opponent (curl) ---');
    const exampleBotGameId = gameIds.find(id => Object.keys(normalizeGameEntry(games[id]).bots ?? {}).length > 0);
    if (exampleBotGameId) {
      const exampleStrategy = Object.keys(normalizeGameEntry(games[exampleBotGameId]).bots)[0];
      console.log(`  curl -X POST http://${displayHost}:${addr.adminPort}/api/matches \\`);
      console.log(`    -H "content-type: application/json" \\`);
      console.log(`    -d '{"gameId":"${exampleBotGameId}","players":["A","B"],"bots":{"B":"${exampleStrategy}"}}'`);
    } else {
      console.log('  (no registered game currently has bot strategies -- see ADMIN.md, "Игра против бота")');
    }
    console.log('');
    if (!process.env.TABLECORE_SERVER_ADMIN_KEY) {
      console.log('NOTE: TABLECORE_SERVER_ADMIN_KEY is not set -- see the warning above. Fine for local testing, set it before exposing this beyond a trusted network.');
      console.log('');
    }
  }).catch(error => { console.error(error); process.exitCode = 1; });
  const shutdown = () => { console.log('\nShutting down...'); server.close().finally(() => process.exit(0)); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
