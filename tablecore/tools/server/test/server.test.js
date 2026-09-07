import test from 'node:test';
import assert from 'node:assert/strict';
import { createTableCoreServer, loadGamesConfig } from '../start.mjs';
import { createWsClient } from '@tablecore/transport-ws';
import { gridDuel } from '@tablecore/game-grid-duel';
import { createLauncherServer } from '../../launcher/server.mjs';
import { fileURLToPath } from 'node:url';

// last-sector is a SEPARATE, optional game pack (see this repo's own
// two-archive split: the engine ships independently of any specific
// game). A minority of THIS file's tests specifically need it (e.g.
// bot-strategy-related ones, since it's the only shipped game with
// real bots -- see bots.test.js's own comment on this); the rest use
// gridDuel (an engine-fixture demo game, always present) and are
// completely unaffected either way. Tried once, dynamically, rather
// than a static top-level import that would fail this WHOLE file (most
// of which doesn't even need last-sector) to even load on an
// engine-only checkout.
let lastSector, lastSectorPack, lastSectorUnavailableReason = null;
try {
  ({ lastSector, lastSectorPack } = await import('@tablecore/game-last-sector'));
} catch (error) {
  lastSectorUnavailableReason = `games/last-sector not present in this checkout (${error.code ?? error.message})`;
}
const skipIfNoLastSector = lastSectorUnavailableReason ? { skip: lastSectorUnavailableReason } : {};
const lastSectorPresent = !lastSectorUnavailableReason;

// Games are supplied explicitly to createTableCoreServer() throughout
// this file -- a TEST referencing a specific game as a fixture is a
// legitimate, different thing from the ENGINE (start.mjs itself, or
// anything under packages/*) knowing about one. See start.mjs's own
// module doc comment for why it no longer imports any game by name, and
// CLIENT_LAYER_FIX.md's "architectural correction" section for the
// broader principle this enforces.

async function postJson(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

test('createTableCoreServer refuses to construct without a real secret', () => {
  assert.throws(() => createTableCoreServer({}), TypeError);
  assert.throws(() => createTableCoreServer({ secret: 'too-short' }), TypeError);
});

// The concrete proof of the actual principle: with no `games` supplied
// at all, the server starts successfully (it is a real, complete,
// runnable server on its own) but knows about precisely zero games --
// not "zero games because a demo list happened to be empty", but because
// nothing in the engine itself ever references any specific game to
// begin with.
test('with no games supplied, the server starts fully functional but has zero games registered', async () => {
  const server = createTableCoreServer({ secret: 'a-perfectly-fine-test-secret-32-chars-plus' });
  try {
    const addr = await server.listen();
    const list = await fetch(`http://${addr.adminHost}:${addr.adminPort}/api/games`).then(r => r.json());
    assert.deepEqual(list.games, []);
    const attempt = await postJson(`http://${addr.adminHost}:${addr.adminPort}/api/matches`, { gameId: 'anything', players: ['A', 'B'] });
    assert.equal(attempt.status, 400);
    assert.equal(attempt.body.error, 'UNKNOWN_GAME_ID');
    assert.deepEqual(attempt.body.knownGames, []);
  } finally {
    await server.close();
  }
});

// loadGamesConfig() is the actual plug-in mechanism: an external config
// file, read at runtime, never imported by start.mjs itself. This test
// uses the real, shipped example config (tools/server/example.config.mjs)
// -- a real file, not a synthetic fixture -- to prove the loader
// actually works end-to-end, matching what TABLECORE_SERVER_CONFIG=...
// would really do.
test('loadGamesConfig() loads a real external config file and returns its games registry', async () => {
  const configPath = fileURLToPath(new URL('../example.config.mjs', import.meta.url));
  const games = await loadGamesConfig(configPath);
  // The four engine-fixture demo games always load (they ship with the
  // engine); last-sector's presence depends on whether the separate,
  // optional game pack has actually been added to this checkout's
  // games/ directory -- the example config itself already handles this
  // gracefully (see its own comment), so this assertion mirrors that
  // same real, on-disk condition rather than assuming last-sector is
  // always there.
  const expectedIds = lastSectorPresent
    ? ['coin-race', 'grid-duel', 'last-sector', 'phase-quest', 'sector-expedition']
    : ['coin-race', 'grid-duel', 'phase-quest', 'sector-expedition'];
  assert.deepEqual(Object.keys(games).sort(), expectedIds);
});

test('loadGamesConfig() returns an empty registry when no path is given', async () => {
  assert.deepEqual(await loadGamesConfig(null), {});
  assert.deepEqual(await loadGamesConfig(undefined), {});
});

test('full real flow: start server with an explicitly-supplied game, create a match via the admin API, connect a real player over the real WS server with the issued token', async () => {
  const server = createTableCoreServer({ secret: 'a-perfectly-fine-test-secret-32-chars-plus', games: { 'grid-duel': gridDuel } });
  try {
    const addr = await server.listen();
    assert.equal(typeof addr.wsPort, 'number');
    assert.ok(addr.wsPort > 0);
    assert.ok(addr.adminPort > 0);
    assert.notEqual(addr.wsPort, addr.adminPort, 'the game connection and the admin API must be on different ports');

    const created = await postJson(`http://${addr.adminHost}:${addr.adminPort}/api/matches`, { gameId: 'grid-duel', players: ['A', 'B'] });
    assert.equal(created.status, 201);
    assert.ok(created.body.matchId);
    assert.ok(created.body.tokens.A);
    assert.ok(created.body.tokens.B);
    assert.equal(created.body.wsUrl, `ws://${addr.wsHost}:${addr.wsPort}`, 'the returned wsUrl must reflect the ACTUAL bound port, not a stale/pre-listen value');

    const client = await createWsClient({ port: addr.wsPort, hello: { type: 'HELLO', protocolVersion: 1, token: created.body.tokens.A } });
    client.send({ type: 'SYNC_REQUEST', protocolVersion: 1, matchId: created.body.matchId });
    const end = Date.now() + 2000;
    while (Date.now() < end && !client.messages.some(m => m.type === 'SYNC')) await new Promise(r => setTimeout(r, 10));
    const sync = client.messages.find(m => m.type === 'SYNC');
    assert.ok(sync, 'the real player connection must actually receive a SYNC for the match the admin API just created');
    assert.equal(sync.snapshot.status, 'running');
    assert.equal(sync.snapshot.version, 1);
    client.close();
  } finally {
    await server.close();
  }
});

test('the admin API rejects an unknown gameId rather than silently doing nothing', async () => {
  const server = createTableCoreServer({ secret: 'a-perfectly-fine-test-secret-32-chars-plus', games: { 'grid-duel': gridDuel } });
  try {
    const addr = await server.listen();
    const r = await postJson(`http://${addr.adminHost}:${addr.adminPort}/api/matches`, { gameId: 'not-a-real-game', players: ['A', 'B'] });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'UNKNOWN_GAME_ID');
    assert.ok(r.body.knownGames.includes('grid-duel'));
  } finally {
    await server.close();
  }
});

test('matches default to spectatorPolicy:deny unless the caller explicitly requests public', async () => {
  const server = createTableCoreServer({ secret: 'a-perfectly-fine-test-secret-32-chars-plus', games: { 'grid-duel': gridDuel } });
  try {
    const addr = await server.listen();
    const created = await postJson(`http://${addr.adminHost}:${addr.adminPort}/api/matches`, { gameId: 'grid-duel', players: ['A', 'B'] });
    const snapshot = server.matchHost.getSnapshot(created.body.matchId).snapshot;
    assert.equal(snapshot.spectatorPolicy, 'deny');

    const publicMatch = await postJson(`http://${addr.adminHost}:${addr.adminPort}/api/matches`, { gameId: 'grid-duel', players: ['A', 'B'], spectatorPolicy: 'public' });
    const publicSnapshot = server.matchHost.getSnapshot(publicMatch.body.matchId).snapshot;
    assert.equal(publicSnapshot.spectatorPolicy, 'public');
  } finally {
    await server.close();
  }
});

// Hardening tests, added after a hard adversarial audit before real
// people were given access to a running server.

test('adminKey, when configured, is enforced -- a request without it (or with the wrong one) is rejected', async () => {
  const server = createTableCoreServer({ secret: 'a-perfectly-fine-test-secret-32-chars-plus', games: { 'grid-duel': gridDuel }, adminKey: 'correct-key-value' });
  try {
    const addr = await server.listen();
    const noKey = await fetch(`http://${addr.adminHost}:${addr.adminPort}/api/games`);
    assert.equal(noKey.status, 401);
    const wrongKey = await fetch(`http://${addr.adminHost}:${addr.adminPort}/api/games`, { headers: { 'x-admin-key': 'wrong' } });
    assert.equal(wrongKey.status, 401);
    const rightKey = await fetch(`http://${addr.adminHost}:${addr.adminPort}/api/games`, { headers: { 'x-admin-key': 'correct-key-value' } });
    assert.equal(rightKey.status, 200);
  } finally {
    await server.close();
  }
});

test('without adminKey configured (the default), the admin API works with no header -- backward compatible', async () => {
  const server = createTableCoreServer({ secret: 'a-perfectly-fine-test-secret-32-chars-plus', games: { 'grid-duel': gridDuel } });
  try {
    const addr = await server.listen();
    const r = await fetch(`http://${addr.adminHost}:${addr.adminPort}/api/games`);
    assert.equal(r.status, 200);
  } finally {
    await server.close();
  }
});

test('the admin API rate-limits repeated requests from the same client, per configured window', async () => {
  const server = createTableCoreServer({ secret: 'a-perfectly-fine-test-secret-32-chars-plus', games: { 'grid-duel': gridDuel }, adminMaxRequestsPerMinute: 3 });
  try {
    const addr = await server.listen();
    const base = `http://${addr.adminHost}:${addr.adminPort}/api/games`;
    const statuses = [];
    for (let i = 0; i < 6; i++) statuses.push((await fetch(base)).status);
    assert.deepEqual(statuses.slice(0, 3), [200, 200, 200], 'the first N (the configured limit) must succeed');
    assert.ok(statuses.slice(3).every(s => s === 429), `requests beyond the limit must be rejected with 429, got ${JSON.stringify(statuses)}`);
  } finally {
    await server.close();
  }
});

test('maxMatches is a real, enforced ceiling -- match creation stops once reached instead of growing forever', async () => {
  const server = createTableCoreServer({ secret: 'a-perfectly-fine-test-secret-32-chars-plus', games: { 'grid-duel': gridDuel }, maxMatches: 2, adminMaxRequestsPerMinute: 100 });
  try {
    const addr = await server.listen();
    const base = `http://${addr.adminHost}:${addr.adminPort}`;
    const r1 = await postJson(`${base}/api/matches`, { gameId: 'grid-duel', players: ['A', 'B'] });
    const r2 = await postJson(`${base}/api/matches`, { gameId: 'grid-duel', players: ['A', 'B'] });
    const r3 = await postJson(`${base}/api/matches`, { gameId: 'grid-duel', players: ['A', 'B'] });
    assert.equal(r1.status, 201);
    assert.equal(r2.status, 201);
    assert.equal(r3.status, 503);
    assert.equal(r3.body.error, 'MATCH_CAPACITY_REACHED');
  } finally {
    await server.close();
  }
});

test('a game validation error (a game\'s own createInitialState() throwing) does not leak its raw exception message to the caller, and produces a clean 400 (not a crash-shaped 500)', async () => {
  // Force an internal error by supplying a game whose createInitialState
  // itself throws -- proves the response body stays generic while the
  // real error still reaches the server logs (not asserted here, but the
  // code path is the same for both). safeStartMatch() (see start.mjs's
  // own comment on it) catches this and turns it into a clean 400
  // GAME_VALIDATION_ERROR instead of letting it fall through to the
  // generic 500 ADMIN_API_ERROR handler -- found and fixed via this
  // project's own lobby-system work (an easy real-world way to hit this:
  // a lobby whose seat count a given game's own rules don't support).
  // The message-suppression behavior this test exists to guard is
  // unchanged either way -- what changed is only the status code
  // (400, a real validation response, not 500, a crash-shaped one).
  const throwingGame = { ...gridDuel, createInitialState() { throw new Error('some sensitive internal detail'); } };
  const server = createTableCoreServer({ secret: 'a-perfectly-fine-test-secret-32-chars-plus', games: { 'throwing-game': throwingGame } });
  try {
    const addr = await server.listen();
    const r = await postJson(`http://${addr.adminHost}:${addr.adminPort}/api/matches`, { gameId: 'throwing-game', players: ['A', 'B'] });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'GAME_VALIDATION_ERROR');
    assert.equal('message' in r.body && r.body.message !== undefined, false, 'the raw exception message must not be echoed back to the caller');
  } finally {
    await server.close();
  }
});

// Join-code tests -- the short /j/<code> redirect system that lets the
// create-match page's QR codes stay small (see packages/qrcode's own
// module doc comments for why a full ~350-character join link with a
// real token embedded needed this instead of being encoded directly).

test('without launcherUrl configured, /api/matches still works but returns no joinLinks -- purely additive, nothing breaks', async () => {
  const server = createTableCoreServer({ secret: 'a-perfectly-fine-test-secret-32-chars-plus', games: { 'grid-duel': gridDuel } });
  try {
    const addr = await server.listen();
    const r = await postJson(`http://${addr.adminHost}:${addr.adminPort}/api/matches`, { gameId: 'grid-duel', players: ['A', 'B'] });
    assert.equal(r.status, 201);
    assert.deepEqual(r.body.joinLinks, {});
  } finally {
    await server.close();
  }
});

test('with launcherUrl configured, /api/matches returns a real join code per human player, not per bot', async () => {
  const server = createTableCoreServer({ secret: 'a-perfectly-fine-test-secret-32-chars-plus', games: { 'grid-duel': gridDuel }, launcherUrl: 'http://192.168.1.42:4170' });
  try {
    const addr = await server.listen();
    const r = await postJson(`http://${addr.adminHost}:${addr.adminPort}/api/matches`, { gameId: 'grid-duel', players: ['A', 'B'] });
    assert.equal(r.status, 201);
    assert.ok(r.body.joinLinks.A.code);
    assert.ok(r.body.joinLinks.A.shortUrl.startsWith('http://192.168.1.42:4170/j/'));
    assert.ok(r.body.joinLinks.A.fullUrl.includes('token='));
    assert.ok(r.body.joinLinks.B.code);
    assert.notEqual(r.body.joinLinks.A.code, r.body.joinLinks.B.code, 'each player must get a distinct code');
  } finally {
    await server.close();
  }
});

test('a bot-controlled player never gets a join link, even with launcherUrl configured', skipIfNoLastSector, async () => {
  const server = createTableCoreServer({ secret: 'a-perfectly-fine-test-secret-32-chars-plus', games: { 'last-sector': { game: lastSector, bots: lastSectorPack.bots } }, launcherUrl: 'http://192.168.1.42:4170' });
  try {
    const addr = await server.listen();
    const r = await postJson(`http://${addr.adminHost}:${addr.adminPort}/api/matches`, { gameId: 'last-sector', players: ['A', 'B'], bots: { B: 'aggressive' } });
    assert.equal(r.status, 201);
    assert.ok(r.body.joinLinks.A);
    assert.equal(r.body.joinLinks.B, undefined, 'B is bot-controlled, must not get a join link (it has no human token to embed)');
  } finally {
    await server.close();
  }
});

test('GET /api/join-codes/:code resolves a real code to its exact registered URL, and 404s for an unknown one', async () => {
  const server = createTableCoreServer({ secret: 'a-perfectly-fine-test-secret-32-chars-plus', games: { 'grid-duel': gridDuel }, launcherUrl: 'http://192.168.1.42:4170' });
  try {
    const addr = await server.listen();
    const created = await postJson(`http://${addr.adminHost}:${addr.adminPort}/api/matches`, { gameId: 'grid-duel', players: ['A', 'B'] });
    const code = created.body.joinLinks.A.code;
    const resolved = await fetch(`http://${addr.adminHost}:${addr.adminPort}/api/join-codes/${code}`).then(r => r.json());
    assert.equal(resolved.url, created.body.joinLinks.A.fullUrl);
    const missing = await fetch(`http://${addr.adminHost}:${addr.adminPort}/api/join-codes/NOTREAL`);
    assert.equal(missing.status, 404);
  } finally {
    await server.close();
  }
});

test('POST /api/spectator-tokens with matchId+gameId also returns a join link (TV board), without them returns just the token', async () => {
  const server = createTableCoreServer({ secret: 'a-perfectly-fine-test-secret-32-chars-plus', games: { 'grid-duel': gridDuel }, launcherUrl: 'http://192.168.1.42:4170' });
  try {
    const addr = await server.listen();
    const bare = await postJson(`http://${addr.adminHost}:${addr.adminPort}/api/spectator-tokens`, {});
    assert.equal(bare.status, 201);
    assert.ok(bare.body.token);
    assert.equal(bare.body.joinLink, null);

    const withMatch = await postJson(`http://${addr.adminHost}:${addr.adminPort}/api/spectator-tokens`, { matchId: 'm1', gameId: 'grid-duel' });
    assert.ok(withMatch.body.joinLink.shortUrl.includes('/j/'));
    assert.ok(withMatch.body.joinLink.fullUrl.includes('tv-ui'));
  } finally {
    await server.close();
  }
});

// Regression test for a real bug found by live-testing this exact server
// via start.sh (which binds 0.0.0.0 by default for real LAN reachability):
// join links / the wsUrl field used to embed the literal bind host
// ('0.0.0.0') instead of a real, connectable address -- '0.0.0.0' is
// valid to BIND to but not something a browser can ever open a
// WebSocket connection TO. This test can't exercise real LAN-IP
// detection deterministically (depends on the actual test machine's
// network interfaces), but it DOES verify the one thing that must never
// regress regardless of environment: a join link's embedded `ws=` value
// must never literally be '0.0.0.0'.
test('when bound to 0.0.0.0, join links and wsUrl never embed the literal unconnectable "0.0.0.0" host', async () => {
  const server = createTableCoreServer({ secret: 'a-perfectly-fine-test-secret-32-chars-plus', games: { 'grid-duel': gridDuel }, host: '0.0.0.0', launcherUrl: 'http://192.168.1.42:4170' });
  try {
    const addr = await server.listen();
    const created = await postJson(`http://${addr.adminHost}:${addr.adminPort}/api/matches`, { gameId: 'grid-duel', players: ['A', 'B'] });
    assert.equal(created.status, 201);
    assert.doesNotMatch(created.body.wsUrl, /0\.0\.0\.0/, `wsUrl must never contain the unconnectable bind address, got: ${created.body.wsUrl}`);
    assert.doesNotMatch(created.body.joinLinks.A.fullUrl, /0\.0\.0\.0/, `join link must never embed the unconnectable bind address, got: ${created.body.joinLinks.A.fullUrl}`);
  } finally {
    await server.close();
  }
});

test('a bot still connects and plays correctly when the server is bound to 0.0.0.0, using loopback internally regardless', skipIfNoLastSector, async () => {
  const server = createTableCoreServer({ secret: 'a-perfectly-fine-test-secret-32-chars-plus', games: { 'last-sector': { game: lastSector, bots: lastSectorPack.bots } }, host: '0.0.0.0' });
  try {
    const addr = await server.listen();
    const created = await postJson(`http://${addr.adminHost}:${addr.adminPort}/api/matches`, { gameId: 'last-sector', players: ['A', 'B'], options: { seed: 5 }, bots: { B: 'aggressive' } });
    assert.equal(created.status, 201);
    const client = await createWsClient({ port: addr.wsPort, host: '127.0.0.1', hello: { type: 'HELLO', protocolVersion: 1, token: created.body.tokens.A } });
    client.send({ type: 'SYNC_REQUEST', protocolVersion: 1, matchId: created.body.matchId });
    const end = Date.now() + 2000;
    while (Date.now() < end && !client.messages.some(m => m.type === 'SYNC')) await new Promise(r => setTimeout(r, 10));
    const sync = client.messages.find(m => m.type === 'SYNC');
    client.send({ type: 'ACTION', protocolVersion: 1, matchId: created.body.matchId, expectedVersion: sync.snapshot.version, action: { type: 'END_TURN', actor: 'A' } });
    const end2 = Date.now() + 3000;
    while (Date.now() < end2 && !(client.messages.filter(m => m.type === 'UPDATE').at(-1)?.snapshot?.state?.activePlayer === 'A' && client.messages.filter(m => m.type === 'UPDATE').at(-1)?.snapshot?.version > sync.snapshot.version + 1)) await new Promise(r => setTimeout(r, 10));
    const lastUpdate = client.messages.filter(m => m.type === 'UPDATE').at(-1);
    assert.ok(lastUpdate && lastUpdate.snapshot.version > sync.snapshot.version + 1, 'the bot must still actually play its turn when the server is bound to 0.0.0.0');
    client.close();
  } finally {
    await server.close();
  }
});

// Regression tests for a real, reported issue: opening a join link for a
// game with no player-ui (e.g. grid-duel, a bare backend rules-testing
// fixture that never had one) 404s for every player -- but nothing
// warned the organizer beforehand, since /api/games previously had no
// concept of "does this game have a UI" at all. GET /api/games now
// cross-checks with the real launcher (server-to-server, using the
// already-configured launcherUrl) and annotates each game with `hasPlay`.

test('GET /api/games annotates hasPlay via a real, live cross-check with the launcher', skipIfNoLastSector, async () => {
  const launcher = createLauncherServer({ port: 0 });
  const launcherAddr = await launcher.listen();
  const server = createTableCoreServer({
    secret: 'a-perfectly-fine-test-secret-32-chars-plus',
    games: { 'grid-duel': gridDuel, 'last-sector': lastSector },
    launcherUrl: `http://127.0.0.1:${launcherAddr.port}`,
  });
  try {
    const addr = await server.listen();
    const data = await fetch(`http://${addr.adminHost}:${addr.adminPort}/api/games`).then(r => r.json());
    const gridDuelEntry = data.games.find(g => g.id === 'grid-duel');
    const lastSectorEntry = data.games.find(g => g.id === 'last-sector');
    // grid-duel declares `internal: true` in its own manifest.json (an
    // engine dev fixture, never meant to be offered to a real player --
    // see packages/launcher/src/catalog.js's own comment on this), so
    // the real launcher's own catalog correctly excludes it entirely --
    // this cross-check genuinely cannot find it there anymore, which is
    // why `null` ("the launcher doesn't know/report anything about
    // this") is now the accurate answer, not `false` (which would
    // wrongly claim certainty the launcher no longer has any basis for).
    assert.equal(gridDuelEntry.hasPlay, null, 'grid-duel is internal:true and excluded from the launcher\'s own catalog entirely -- hasPlay must honestly reflect "the launcher does not report on this game" (null), not a false claim of confirmed absence');
    assert.equal(lastSectorEntry.hasPlay, true, 'last-sector genuinely has a real player-ui -- confirmed via the real launcher, not assumed');
  } finally {
    await server.close();
    await launcher.close();
  }
});

test('GET /api/games returns hasPlay:null (not false, not a crash) when launcherUrl is not configured at all', async () => {
  const server = createTableCoreServer({ secret: 'a-perfectly-fine-test-secret-32-chars-plus', games: { 'grid-duel': gridDuel } });
  try {
    const addr = await server.listen();
    const data = await fetch(`http://${addr.adminHost}:${addr.adminPort}/api/games`).then(r => r.json());
    assert.equal(data.games[0].hasPlay, null, 'unknown must be represented as null, not silently guessed as true or false');
  } finally {
    await server.close();
  }
});

test('GET /api/games returns hasPlay:null gracefully (not a hang, not a 500) when launcherUrl points at an unreachable address', async () => {
  const server = createTableCoreServer({ secret: 'a-perfectly-fine-test-secret-32-chars-plus', games: { 'grid-duel': gridDuel }, launcherUrl: 'http://127.0.0.1:1' });
  try {
    const addr = await server.listen();
    const start = Date.now();
    const res = await fetch(`http://${addr.adminHost}:${addr.adminPort}/api/games`);
    const elapsed = Date.now() - start;
    assert.equal(res.status, 200, 'an unreachable launcher must not turn a working /api/games into a failure');
    const data = await res.json();
    assert.equal(data.games[0].hasPlay, null);
    assert.ok(elapsed < 3000, `must fail fast, not hang waiting for a dead launcher, took ${elapsed}ms`);
  } finally {
    await server.close();
  }
});

// The create-match page itself (served at GET /) supports a `?game=`
// query param to preselect a game -- this is what makes the launcher's
// own "Создать матч" per-game button actually land on the right game
// instead of always the default selection. Tested here at the page-
// content level (the page's own client JS logic is covered more
// directly by a live simulation in this project's own manual
// verification -- see CLIENT_LAYER_FIX.md-style project history for that
// pattern; this confirms the page actually serves and that the JS file
// it depends on for this exists and is wired up).
test('the create-match page is served with its create.js, which reads params.get(\'game\') for preselection', async () => {
  const server = createTableCoreServer({ secret: 'a-perfectly-fine-test-secret-32-chars-plus', games: { 'grid-duel': gridDuel } });
  try {
    const addr = await server.listen();
    const page = await fetch(`http://${addr.adminHost}:${addr.adminPort}/?game=grid-duel`);
    assert.equal(page.status, 200, 'the page itself must load fine regardless of the ?game= query param');
    const js = await fetch(`http://${addr.adminHost}:${addr.adminPort}/create.js`).then(r => r.text());
    assert.match(js, /params\.get\('game'\)/, 'create.js must actually read the game query param for preselection');
  } finally {
    await server.close();
  }
});

test('the create-game page never shows a flash of the empty game selector -- game-select-block is hidden by DEFAULT in the served HTML, not only hidden later by JS after an async fetch resolves', async () => {
  // Real, reported confusion: an organizer arriving here already having
  // picked a game on the launcher's own catalog page used to briefly
  // see a second, EMPTY game dropdown (no <option>s yet) for however
  // long GET /api/games took to resolve -- a real flash of confusing UI,
  // not a hypothetical one, since browsers paint the initial HTML before
  // any deferred <script type="module"> runs at all. Fixed by defaulting
  // to hidden in the markup itself and only un-hiding it in the one case
  // that genuinely needs a picker (no ?game= at all).
  const server = createTableCoreServer({ secret: 'a-perfectly-fine-test-secret-32-chars-plus', games: { 'grid-duel': gridDuel } });
  try {
    const addr = await server.listen();
    const html = await fetch(`http://${addr.adminHost}:${addr.adminPort}/?game=grid-duel`).then(r => r.text());
    assert.match(html, /id="game-select-block"\s+hidden/, 'game-select-block must be hidden by default in the raw served HTML, before any JS runs at all');
  } finally {
    await server.close();
  }
});

test('GET /api/games includes name/description/minPlayers/maxPlayers from the real launcher catalog, not just id/bots/hasPlay -- needed so the create-game page can show a real game title instead of a second, redundant picker', skipIfNoLastSector, async () => {
  const server = createTableCoreServer({ secret: 'a-perfectly-fine-test-secret-32-chars-plus', games: { 'last-sector': { game: lastSector, bots: lastSectorPack.bots } }, launcherUrl: 'http://192.168.1.42:4170' });
  try {
    const addr = await server.listen();
    // No real launcher reachable at that URL in this test -- the point
    // here is just that the RESPONSE SHAPE includes these fields (even
    // as sensible defaults when the launcher fetch fails), not that a
    // real launcher's data flows through (server.test.js's OTHER hasPlay
    // tests already cover that end-to-end with a real launcher).
    const data = await fetch(`http://${addr.adminHost}:${addr.adminPort}/api/games`).then(r => r.json());
    const entry = data.games.find(g => g.id === 'last-sector');
    assert.ok('name' in entry);
    assert.ok('description' in entry);
    assert.ok('minPlayers' in entry);
    assert.ok('maxPlayers' in entry);
  } finally {
    await server.close();
  }
});

// Real, live end-to-end test of the whole lifecycle-cleanup chain: a
// real running server, driven exactly the way a real client would,
// confirming a match that gets permanently stuck at status:'lobby'
// (createMatch succeeds, startMatch fails -- see
// ServerHost.sweepExpiredMatches's own doc comment for why this is the
// one REAL, live path to that status today, now that both real
// creation flows -- /api/matches and the lobby system -- always start
// a match immediately after creating it) actually gets swept away by
// the real periodic sweep this server now runs, confirmed via a real
// WS SYNC_REQUEST that genuinely can no longer find it afterward.
test('a match permanently stuck in lobby status (createMatch ok, startMatch failed due to real game validation) is actually removed by the real, running periodic sweep -- confirmed end-to-end over a real WS connection', skipIfNoLastSector, async () => {
  const { lastSector } = await import('@tablecore/game-last-sector');
  const realServer = createTableCoreServer({
    secret: 'a-perfectly-fine-test-secret-32-chars-plus',
    games: { 'last-sector': { game: lastSector } },
    matchSweepIntervalMs: 40,
    matchFinishedGraceMs: 30 * 60 * 1000,
    matchAbandonedLobbyGraceMs: 60, // 60ms -- short enough for a real, fast test; real deployments use the (much longer) default
  });
  try {
    const addr = await realServer.listen();
    const base = `http://${addr.adminHost}:${addr.adminPort}`;
    const stuckMatchId = 'stuck-lobby-real-test';
    // last-sector genuinely requires 2-4 players (see its own
    // manifest.json) -- a single player triggers a real
    // GAME_VALIDATION_ERROR from createInitialState(), leaving the
    // match stuck at status:'lobby' forever without this sweep.
    const created = await fetch(`${base}/api/matches`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ matchId: stuckMatchId, gameId: 'last-sector', players: ['A'], spectatorPolicy: 'public' }) });
    assert.equal(created.status, 400);
    assert.equal((await created.json()).error, 'GAME_VALIDATION_ERROR');

    // Confirm it genuinely exists right now, stuck at 'lobby' -- a real
    // spectator connection, not a guess, since this specific match's
    // player token was never issued (creation itself failed).
    const spectatorToken = await fetch(`${base}/api/spectator-tokens`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) }).then(r => r.json());
    const before = await createWsClient({ port: addr.wsPort, host: '127.0.0.1', hello: { type: 'HELLO', protocolVersion: 1, token: spectatorToken.token } });
    before.send({ type: 'SYNC_REQUEST', protocolVersion: 1, matchId: stuckMatchId });
    const beforeEnd = Date.now() + 2000;
    while (Date.now() < beforeEnd && !before.messages.some(m => m.type === 'SYNC' || m.type === 'ACTION_REJECTED')) await new Promise(r => setTimeout(r, 10));
    const beforeSync = before.messages.find(m => m.type === 'SYNC');
    assert.ok(beforeSync, 'the stuck match must genuinely still exist right after the failed creation, before any sweep has had a chance to run');
    assert.equal(beforeSync.snapshot.status, 'lobby');
    before.close();

    // Wait for the REAL periodic sweep (running inside realServer, on
    // its own real setInterval) to actually fire and remove it.
    await new Promise(r => setTimeout(r, 400));

    const after = await createWsClient({ port: addr.wsPort, host: '127.0.0.1', hello: { type: 'HELLO', protocolVersion: 1, token: spectatorToken.token } });
    after.send({ type: 'SYNC_REQUEST', protocolVersion: 1, matchId: stuckMatchId });
    const afterEnd = Date.now() + 2000;
    while (Date.now() < afterEnd && !after.messages.some(m => m.type === 'SYNC' || m.type === 'ACTION_REJECTED')) await new Promise(r => setTimeout(r, 10));
    const rejection = after.messages.find(m => m.type === 'ACTION_REJECTED');
    assert.ok(rejection, 'the match must genuinely be gone after the real sweep ran -- no SYNC should succeed for it anymore');
    assert.equal(rejection.error.code, 'MATCH_NOT_FOUND');
    after.close();
  } finally {
    await realServer.close();
  }
});

test('POST /api/matches with an unsafe matchId (e.g. path-traversal characters) returns a clean 400 INVALID_MATCH_CONFIG, not a generic 500 -- a real gap found and fixed: this used to be an uncaught throw surfacing as a bare 500 ADMIN_API_ERROR', async () => {
  const server = createTableCoreServer({ secret: 'a-perfectly-fine-test-secret-32-chars-plus', games: { 'grid-duel': gridDuel } });
  try {
    const addr = await server.listen();
    const res = await fetch(`http://${addr.adminHost}:${addr.adminPort}/api/matches`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ matchId: '../../../etc/passwd', gameId: 'grid-duel', players: ['A', 'B'] }) });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, 'INVALID_MATCH_CONFIG');
    assert.match(body.message, /match id/i);
  } finally {
    await server.close();
  }
});

// Regression test for a real bug found via an aggressive audit pass: an
// oversized request body used to call `req.destroy()` (destroying the
// underlying SOCKET, not just the request-reading direction -- req/res
// share one connection in Node's http module), which meant the server's
// own top-level catch-all correctly logged and attempted a clean error
// response, but that write silently failed against an already-destroyed
// socket -- a real caller just saw a bare network-level failure, not
// any HTTP response at all, unlike every OTHER error this API returns.
test('POST /api/matches with an oversized body returns a real, clean 413 BODY_TOO_LARGE response, not a bare connection failure', async () => {
  const server = createTableCoreServer({ secret: 'a-perfectly-fine-test-secret-32-chars-plus', games: { 'grid-duel': gridDuel } });
  try {
    const addr = await server.listen();
    const hugePayload = JSON.stringify({ gameId: 'grid-duel', players: ['A', 'B'], options: { junk: 'x'.repeat(200000) } });
    const res = await fetch(`http://${addr.adminHost}:${addr.adminPort}/api/matches`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: hugePayload });
    assert.equal(res.status, 413);
    assert.equal((await res.json()).error, 'BODY_TOO_LARGE');
    // The connection/server itself must still be fully usable afterward.
    const health = await fetch(`http://${addr.adminHost}:${addr.adminPort}/api/games`);
    assert.equal(health.status, 200);
  } finally {
    await server.close();
  }
});

// Regression test for a real gap found via manual code review (not a
// failing test): `options: null` used to crash deep inside
// @tablecore/core's own createMatch() with a raw, confusing "Cannot
// read properties of null (reading 'seed')" -- already safely caught
// by ServerHost's own try/catch (no process crash), but leaking a raw
// internal JS error message instead of a clean API error, and other
// nonsensical types (a string, a number, an array) were silently
// ACCEPTED instead of rejected at all.
test('POST /api/matches rejects a non-object options value (string, number, array, null) with a clean INVALID_OPTIONS, not a raw internal error message or silent acceptance', async () => {
  const server = createTableCoreServer({ secret: 'a-perfectly-fine-test-secret-32-chars-plus', games: { 'grid-duel': gridDuel } });
  try {
    const addr = await server.listen();
    const base = `http://${addr.adminHost}:${addr.adminPort}`;
    for (const options of ['a weird string', 42, true, [1, 2, 3], null]) {
      const res = await fetch(`${base}/api/matches`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ gameId: 'grid-duel', players: ['A', 'B'], options }) });
      assert.equal(res.status, 400, `options=${JSON.stringify(options)} must be rejected`);
      assert.equal((await res.json()).error, 'INVALID_OPTIONS');
    }
    // A real, valid object (or omitting options entirely) must still work.
    const ok1 = await fetch(`${base}/api/matches`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ gameId: 'grid-duel', players: ['A', 'B'], options: { seed: 1 } }) });
    assert.equal(ok1.status, 201);
    const ok2 = await fetch(`${base}/api/matches`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ gameId: 'grid-duel', players: ['A', 'B'] }) });
    assert.equal(ok2.status, 201);
  } finally {
    await server.close();
  }
});
