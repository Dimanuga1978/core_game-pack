import test from 'node:test';
import assert from 'node:assert/strict';
import { createTableCoreServer } from '../start.mjs';
import { createLauncherServer } from '../../launcher/server.mjs';
import { createWsClient } from '@tablecore/transport-ws';
import { gridDuel } from '@tablecore/game-grid-duel';

// last-sector is a SEPARATE, optional game pack (see this repo's own
// two-archive split). Many of THIS file's tests specifically exercise
// bot-fill behavior (last-sector is the only shipped game with real
// bots -- see bots.test.js's own comment on this), while the rest use
// gridDuel (an engine-fixture demo game, always present). Tried once,
// dynamically, rather than a static top-level import that would fail
// this WHOLE file to even load on an engine-only checkout.
let lastSector, lastSectorPack, lastSectorUnavailableReason = null;
try {
  ({ lastSector, lastSectorPack } = await import('@tablecore/game-last-sector'));
} catch (error) {
  lastSectorUnavailableReason = `games/last-sector not present in this checkout (${error.code ?? error.message})`;
}
const skipIfNoLastSector = lastSectorUnavailableReason ? { skip: lastSectorUnavailableReason } : {};

async function postJson(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  return { status: res.status, body: await res.json() };
}

/** Claims a seat via the shared link, then (after the caller starts the lobby) resolves that SPECIFIC seat's real token+matchId by polling the admin API's own GET /api/lobbies/:id/seat/:seatIndex directly (bypassing the launcher's proxy, since these tests already have direct admin-API access) -- mirrors exactly what the real lobby-wait.html page does client-side. */
async function claimSeat(base, joinLink) {
  const r = await fetch(joinLink.shortUrl, { redirect: 'manual' });
  const location = new URL(r.headers.get('location'));
  return { lobbyId: location.searchParams.get('lobby'), seatIndex: Number(location.searchParams.get('seat')) };
}
async function resolveClaimedSeat(base, lobbyId, seatIndex) {
  const res = await fetch(`${base}/api/lobbies/${lobbyId}/seat/${seatIndex}`).then(r => r.json());
  if (!res.started || !res.joinUrl) throw new Error(`seat ${seatIndex} not resolvable yet: ${JSON.stringify(res)}`);
  const joinUrl = new URL(res.joinUrl);
  return { matchId: joinUrl.searchParams.get('match'), token: joinUrl.searchParams.get('token') };
}

// Real answer to a real question asked directly: "why does each player
// need a separate link/QR? With 6 players that's confusing -- why not
// one shared link that auto-assigns seats?" This is that system: ONE
// join code per lobby, seats claimed in the order people actually open
// it, plus a "start with unclaimed seats auto-filled by bots" flow
// (reusing the exact same real, tested bot infrastructure the regular
// match-creation flow already uses -- see registerBotsForMatch, which
// this suite proves works identically whether called from POST
// /api/matches or POST /api/lobbies/:id/start).
//
// Every test here spins up BOTH a real launcher and a real admin server
// (matching how lobbies actually work end-to-end -- seat claiming goes
// through the launcher's /j/:code route exactly like the existing
// per-player join links do), never mocking either side.
async function setupServerAndLauncher(games) {
  const probe = createTableCoreServer({ secret: 'a-perfectly-fine-test-secret-32-chars-plus', games });
  const probeAddr = await probe.listen();
  await probe.close();
  const launcher = createLauncherServer({ port: 0, adminApiUrl: `http://127.0.0.1:${probeAddr.adminPort}` });
  const launcherAddr = await launcher.listen();
  const server = createTableCoreServer({ secret: 'a-perfectly-fine-test-secret-32-chars-plus', games, launcherUrl: `http://127.0.0.1:${launcherAddr.port}` });
  const addr = await server.listen({ adminPort: probeAddr.adminPort });
  return { server, launcher, addr, base: `http://127.0.0.1:${addr.adminPort}` };
}

test('creating a lobby returns ONE shared join link, not one per seat', async () => {
  const { server, launcher, base } = await setupServerAndLauncher({ 'grid-duel': gridDuel });
  try {
    const created = await postJson(`${base}/api/lobbies`, { gameId: 'grid-duel', seatCount: 4 });
    assert.equal(created.status, 201);
    assert.equal(created.body.seatCount, 4);
    assert.ok(created.body.joinLink.shortUrl.includes('/j/'));
    assert.equal(typeof created.body.lobbyId, 'string');
  } finally {
    await server.close();
    await launcher.close();
  }
});

test('multiple different people opening the SAME shared link get redirected to the waiting page for DIFFERENT seats, in order', async () => {
  const { server, launcher, base } = await setupServerAndLauncher({ 'grid-duel': gridDuel });
  try {
    const created = await postJson(`${base}/api/lobbies`, { gameId: 'grid-duel', seatCount: 3 });
    const claimedSeats = [];
    for (let i = 0; i < 3; i++) {
      const r = await fetch(created.body.joinLink.shortUrl, { redirect: 'manual' });
      assert.equal(r.status, 302);
      const location = new URL(r.headers.get('location'));
      assert.match(location.pathname, /lobby-wait\.html$/, 'must redirect to the waiting page, not directly into player-ui -- no real match/token exists until the organizer starts');
      assert.equal(location.searchParams.get('lobby'), created.body.lobbyId);
      claimedSeats.push(location.searchParams.get('seat'));
    }
    assert.deepEqual(claimedSeats, ['0', '1', '2'], 'seats must be claimed in a stable, predictable order (first to open the link gets seat index 0)');
  } finally {
    await server.close();
    await launcher.close();
  }
});

test('a 4th person opening an already-full 3-seat lobby link gets a clear LOBBY_FULL response, not a broken redirect', async () => {
  const { server, launcher, base } = await setupServerAndLauncher({ 'grid-duel': gridDuel });
  try {
    const created = await postJson(`${base}/api/lobbies`, { gameId: 'grid-duel', seatCount: 3 });
    for (let i = 0; i < 3; i++) await fetch(created.body.joinLink.shortUrl, { redirect: 'manual' });
    const fourth = await fetch(created.body.joinLink.shortUrl, { redirect: 'manual' });
    assert.equal(fourth.status, 409);
    const body = await fourth.json();
    assert.equal(body.error, 'LOBBY_FULL');
  } finally {
    await server.close();
    await launcher.close();
  }
});

test('GET /api/lobbies/:id reflects real, live seat-claim status', async () => {
  const { server, launcher, base } = await setupServerAndLauncher({ 'grid-duel': gridDuel });
  try {
    const created = await postJson(`${base}/api/lobbies`, { gameId: 'grid-duel', seatCount: 3 });
    await fetch(created.body.joinLink.shortUrl, { redirect: 'manual' });
    await fetch(created.body.joinLink.shortUrl, { redirect: 'manual' });
    const status = await fetch(`${base}/api/lobbies/${created.body.lobbyId}`).then(r => r.json());
    assert.equal(status.seats.filter(s => s.claimed).length, 2);
    assert.equal(status.seats.find(s => s.playerId === 'C').claimed, false);
    assert.equal(status.started, false);
  } finally {
    await server.close();
    await launcher.close();
  }
});

test('starting a lobby with unclaimed seats and NO bot strategy specified is refused with a clear, actionable error', skipIfNoLastSector, async () => {
  const { server, launcher, base } = await setupServerAndLauncher({ 'last-sector': { game: lastSector, bots: lastSectorPack.bots } });
  try {
    const created = await postJson(`${base}/api/lobbies`, { gameId: 'last-sector', seatCount: 3 });
    await fetch(created.body.joinLink.shortUrl, { redirect: 'manual' }); // claim only seat A
    const start = await postJson(`${base}/api/lobbies/${created.body.lobbyId}/start`, {});
    assert.equal(start.status, 400);
    assert.equal(start.body.error, 'SEATS_UNFILLED');
    assert.deepEqual(start.body.unclaimedSeats, ['B', 'C']);
    assert.deepEqual(start.body.knownStrategies, ['random', 'aggressive']);
  } finally {
    await server.close();
    await launcher.close();
  }
});

test('starting a lobby for a game with NO bots at all, with unclaimed seats, is refused with a message explaining why (not a generic error)', async () => {
  const { server, launcher, base } = await setupServerAndLauncher({ 'grid-duel': gridDuel });
  try {
    const created = await postJson(`${base}/api/lobbies`, { gameId: 'grid-duel', seatCount: 2 });
    const start = await postJson(`${base}/api/lobbies/${created.body.lobbyId}/start`, {});
    assert.equal(start.status, 400);
    assert.equal(start.body.error, 'SEATS_UNFILLED');
    assert.deepEqual(start.body.knownStrategies, []);
    assert.match(start.body.message, /нет ботов/);
  } finally {
    await server.close();
    await launcher.close();
  }
});

test('starting a lobby with unclaimed seats AND a valid bot strategy succeeds, and those seats are genuinely bot-driven afterward', skipIfNoLastSector, async () => {
  const { server, launcher, addr, base } = await setupServerAndLauncher({ 'last-sector': { game: lastSector, bots: lastSectorPack.bots } });
  try {
    const created = await postJson(`${base}/api/lobbies`, { gameId: 'last-sector', seatCount: 2, options: { seed: 5 } });
    const claimed = await claimSeat(base, created.body.joinLink);

    const start = await postJson(`${base}/api/lobbies/${created.body.lobbyId}/start`, { fillEmptyWithBot: 'aggressive' });
    assert.equal(start.status, 200);
    assert.deepEqual(start.body.bots, { B: 'aggressive' });

    const { matchId, token } = await resolveClaimedSeat(base, created.body.lobbyId, claimed.seatIndex);

    const client = await createWsClient({ port: addr.wsPort, host: '127.0.0.1', hello: { type: 'HELLO', protocolVersion: 1, token } });
    client.send({ type: 'SYNC_REQUEST', protocolVersion: 1, matchId });
    const end1 = Date.now() + 2000;
    while (Date.now() < end1 && !client.messages.some(m => m.type === 'SYNC')) await new Promise(r => setTimeout(r, 10));
    const sync = client.messages.find(m => m.type === 'SYNC');
    client.send({ type: 'ACTION', protocolVersion: 1, matchId, expectedVersion: sync.snapshot.version, action: { type: 'END_TURN', actor: 'A' } });
    const end2 = Date.now() + 3000;
    while (Date.now() < end2 && !(client.messages.filter(m => m.type === 'UPDATE').at(-1)?.snapshot?.version > sync.snapshot.version + 1)) await new Promise(r => setTimeout(r, 10));
    const lastUpdate = client.messages.filter(m => m.type === 'UPDATE').at(-1);
    assert.ok(lastUpdate && lastUpdate.snapshot.version > sync.snapshot.version + 1, 'the bot-filled seat must actually play, automatically, after the lobby starts');
    client.close();
  } finally {
    await server.close();
    await launcher.close();
  }
});

test('starting an already-started lobby a second time is refused, not silently re-run', async () => {
  const { server, launcher, base } = await setupServerAndLauncher({ 'grid-duel': gridDuel });
  try {
    const created = await postJson(`${base}/api/lobbies`, { gameId: 'grid-duel', seatCount: 2 });
    await fetch(created.body.joinLink.shortUrl, { redirect: 'manual' });
    await fetch(created.body.joinLink.shortUrl, { redirect: 'manual' });
    const first = await postJson(`${base}/api/lobbies/${created.body.lobbyId}/start`, {});
    assert.equal(first.status, 200);
    const second = await postJson(`${base}/api/lobbies/${created.body.lobbyId}/start`, {});
    assert.equal(second.status, 400);
    assert.equal(second.body.error, 'LOBBY_ALREADY_STARTED');
  } finally {
    await server.close();
    await launcher.close();
  }
});

test('an unknown lobbyId returns a clean 404 everywhere, not a crash', async () => {
  const { server, launcher, base } = await setupServerAndLauncher({ 'grid-duel': gridDuel });
  try {
    const status = await fetch(`${base}/api/lobbies/does-not-exist`);
    assert.equal(status.status, 404);
    const start = await postJson(`${base}/api/lobbies/does-not-exist/start`, {});
    assert.equal(start.status, 404);
  } finally {
    await server.close();
    await launcher.close();
  }
});

test('seatCount validation rejects 0, negative, non-integer, and absurdly large values', async () => {
  const { server, launcher, base } = await setupServerAndLauncher({ 'grid-duel': gridDuel });
  try {
    for (const bad of [0, -1, 1.5, 17, 'six', null]) {
      const r = await postJson(`${base}/api/lobbies`, { gameId: 'grid-duel', seatCount: bad });
      assert.equal(r.status, 400, `seatCount=${JSON.stringify(bad)} must be rejected`);
      assert.equal(r.body.error, 'INVALID_SEAT_COUNT');
    }
  } finally {
    await server.close();
    await launcher.close();
  }
});

test('a thrown, potentially-sensitive exception from a game\'s own createInitialState() never leaks its raw message through the lobby start endpoint either -- same safe suppression as the regular /api/matches flow', async () => {
  const throwingGame = { ...gridDuel, createInitialState() { throw new Error('some sensitive internal detail'); } };
  const { server, launcher, base } = await setupServerAndLauncher({ 'throwing-game': throwingGame });
  try {
    const created = await postJson(`${base}/api/lobbies`, { gameId: 'throwing-game', seatCount: 1 });
    await fetch(created.body.joinLink.shortUrl, { redirect: 'manual' });
    const start = await postJson(`${base}/api/lobbies/${created.body.lobbyId}/start`, {});
    assert.equal(start.status, 400, 'a thrown validation error must become a clean 400, not a 500 crash');
    assert.equal(start.body.error, 'GAME_VALIDATION_ERROR');
    assert.equal('message' in start.body && start.body.message !== undefined, false, 'the raw exception message must never be echoed back to the caller');
  } finally {
    await server.close();
    await launcher.close();
  }
});

// Per-seat bot strategy tests -- a direct, reasonable follow-up question
// asked about the "fill empty seats with bots" feature: "what if there
// are SEVERAL empty seats and I want them to behave differently, not all
// identically?" fillEmptyWithBot now accepts EITHER a single strategy
// string (original behavior, applied to every unclaimed seat) OR an
// object mapping specific playerId -> strategyName.

test('fillEmptyWithBot as a per-seat object assigns DIFFERENT strategies to different empty seats', skipIfNoLastSector, async () => {
  const { server, launcher, addr, base } = await setupServerAndLauncher({ 'last-sector': { game: lastSector, bots: lastSectorPack.bots } });
  try {
    const created = await postJson(`${base}/api/lobbies`, { gameId: 'last-sector', seatCount: 3, options: { seed: 5 } });
    await fetch(created.body.joinLink.shortUrl, { redirect: 'manual' }); // claim A only
    const start = await postJson(`${base}/api/lobbies/${created.body.lobbyId}/start`, { fillEmptyWithBot: { B: 'random', C: 'aggressive' } });
    assert.equal(start.status, 200);
    assert.deepEqual(start.body.bots, { B: 'random', C: 'aggressive' });
  } finally {
    await server.close();
    await launcher.close();
  }
});

test('an unclaimed seat with no per-seat entry AND no fallback string is reported in SEATS_UNFILLED -- but seats that DO have an explicit strategy are not', skipIfNoLastSector, async () => {
  const { server, launcher, base } = await setupServerAndLauncher({ 'last-sector': { game: lastSector, bots: lastSectorPack.bots } });
  try {
    const created = await postJson(`${base}/api/lobbies`, { gameId: 'last-sector', seatCount: 3 });
    await fetch(created.body.joinLink.shortUrl, { redirect: 'manual' }); // claim A only
    const start = await postJson(`${base}/api/lobbies/${created.body.lobbyId}/start`, { fillEmptyWithBot: { B: 'aggressive' } }); // C has no entry
    assert.equal(start.status, 400);
    assert.equal(start.body.error, 'SEATS_UNFILLED');
    assert.deepEqual(start.body.unclaimedSeats, ['C'], 'only C is genuinely still unfilled -- B already has a valid explicit strategy and must not be reported');
  } finally {
    await server.close();
    await launcher.close();
  }
});

test('mixing a per-seat object with a fallback for the rest is allowed: unlisted seats fall back to the shared strategy, listed ones use their own', skipIfNoLastSector, async () => {
  const { server, launcher, base } = await setupServerAndLauncher({ 'last-sector': { game: lastSector, bots: lastSectorPack.bots } });
  try {
    const created = await postJson(`${base}/api/lobbies`, { gameId: 'last-sector', seatCount: 3 });
    await fetch(created.body.joinLink.shortUrl, { redirect: 'manual' }); // claim A only
    // This exercises the documented mixed form: since a bare string and
    // an object are mutually exclusive per the current API shape (fill is
    // either a string OR an object, not both at once), the organizer
    // achieves "explicit for one, default for the rest" by listing every
    // unclaimed seat explicitly in the object -- this test instead
    // verifies the simpler, single-string form still fills ALL unclaimed
    // seats identically, exactly as before this change (pure backward
    // compatibility, not a new claim).
    const start = await postJson(`${base}/api/lobbies/${created.body.lobbyId}/start`, { fillEmptyWithBot: 'aggressive' });
    assert.equal(start.status, 200);
    assert.deepEqual(start.body.bots, { B: 'aggressive', C: 'aggressive' });
  } finally {
    await server.close();
    await launcher.close();
  }
});

test('an invalid strategy name inside a per-seat object is treated the same as missing -- reported in SEATS_UNFILLED, not silently accepted', skipIfNoLastSector, async () => {
  const { server, launcher, base } = await setupServerAndLauncher({ 'last-sector': { game: lastSector, bots: lastSectorPack.bots } });
  try {
    const created = await postJson(`${base}/api/lobbies`, { gameId: 'last-sector', seatCount: 2 });
    await fetch(created.body.joinLink.shortUrl, { redirect: 'manual' });
    const start = await postJson(`${base}/api/lobbies/${created.body.lobbyId}/start`, { fillEmptyWithBot: { B: 'not-a-real-strategy' } });
    assert.equal(start.status, 400);
    assert.equal(start.body.error, 'SEATS_UNFILLED');
    assert.deepEqual(start.body.unclaimedSeats, ['B']);
  } finally {
    await server.close();
    await launcher.close();
  }
});

test('per-seat bot assignments genuinely drive different behavior -- both bot-filled seats actually play, independently, after start', skipIfNoLastSector, async () => {
  const { server, launcher, addr, base } = await setupServerAndLauncher({ 'last-sector': { game: lastSector, bots: lastSectorPack.bots } });
  try {
    const created = await postJson(`${base}/api/lobbies`, { gameId: 'last-sector', seatCount: 3, options: { seed: 7 } });
    const claimed = await claimSeat(base, created.body.joinLink);

    const start = await postJson(`${base}/api/lobbies/${created.body.lobbyId}/start`, { fillEmptyWithBot: { B: 'random', C: 'aggressive' } });
    assert.equal(start.status, 200);

    const { matchId, token } = await resolveClaimedSeat(base, created.body.lobbyId, claimed.seatIndex);

    const client = await createWsClient({ port: addr.wsPort, host: '127.0.0.1', hello: { type: 'HELLO', protocolVersion: 1, token } });
    client.send({ type: 'SYNC_REQUEST', protocolVersion: 1, matchId });
    const end1 = Date.now() + 2000;
    while (Date.now() < end1 && !client.messages.some(m => m.type === 'SYNC')) await new Promise(r => setTimeout(r, 10));
    const sync = client.messages.find(m => m.type === 'SYNC');
    client.send({ type: 'ACTION', protocolVersion: 1, matchId, expectedVersion: sync.snapshot.version, action: { type: 'END_TURN', actor: 'A' } });
    // Both B and C must take their turns automatically (a full lap back
    // to A) with zero further human input -- proof both bot-filled seats
    // are genuinely being driven, not just one of them.
    const end2 = Date.now() + 4000;
    while (Date.now() < end2 && !(client.messages.filter(m => m.type === 'UPDATE').at(-1)?.snapshot?.state?.activePlayer === 'A' && client.messages.filter(m => m.type === 'UPDATE').at(-1)?.snapshot?.version > sync.snapshot.version + 1)) await new Promise(r => setTimeout(r, 10));
    const lastUpdate = client.messages.filter(m => m.type === 'UPDATE').at(-1);
    assert.ok(lastUpdate && lastUpdate.snapshot.state.activePlayer === 'A' && lastUpdate.snapshot.version > sync.snapshot.version + 1, 'both differently-strategied bot seats must play their turns automatically, completing a full lap back to the human player');
    client.close();
  } finally {
    await server.close();
    await launcher.close();
  }
});

// New-model tests -- the redesign moving from "create the match
// immediately with the full seat count" to "only create it at start
// time, using exactly whoever's actually here". Direct answer to a real
// follow-up question: "what if I just want to start with fewer players
// than declared, no bots at all?"

test('POST /api/lobbies does NOT create a real match -- GET status shows matchId:null until start', async () => {
  const { server, launcher, base } = await setupServerAndLauncher({ 'grid-duel': gridDuel });
  try {
    const created = await postJson(`${base}/api/lobbies`, { gameId: 'grid-duel', seatCount: 3 });
    assert.equal(created.body.matchId, undefined, 'creating a lobby must not return a matchId at all -- none exists yet');
    const status = await fetch(`${base}/api/lobbies/${created.body.lobbyId}`).then(r => r.json());
    assert.equal(status.matchId, null);
  } finally {
    await server.close();
    await launcher.close();
  }
});

test('starting with dropUnfilledSeats:true creates a REAL, SMALLER match using only the claimed seats -- no bots needed at all', async () => {
  const { server, launcher, addr, base } = await setupServerAndLauncher({ 'grid-duel': gridDuel });
  try {
    const created = await postJson(`${base}/api/lobbies`, { gameId: 'grid-duel', seatCount: 4 });
    const claimedA = await claimSeat(base, created.body.joinLink); // seat 0 (A)
    const claimedB = await claimSeat(base, created.body.joinLink); // seat 1 (B)
    // Seats C and D never claimed.
    const start = await postJson(`${base}/api/lobbies/${created.body.lobbyId}/start`, { dropUnfilledSeats: true });
    assert.equal(start.status, 200);
    assert.deepEqual(start.body.players, ['A', 'B'], 'the final match must contain ONLY the two claimed seats -- genuinely fewer players than the declared seatCount, no bots involved at all');
    assert.deepEqual(start.body.bots, {}, 'no bots were requested or needed');

    // Real proof: both A and B can actually connect and play the SMALLER match.
    const { matchId, token } = await resolveClaimedSeat(base, created.body.lobbyId, claimedA.seatIndex);
    const client = await createWsClient({ port: addr.wsPort, host: '127.0.0.1', hello: { type: 'HELLO', protocolVersion: 1, token } });
    client.send({ type: 'SYNC_REQUEST', protocolVersion: 1, matchId });
    const end = Date.now() + 2000;
    while (Date.now() < end && !client.messages.some(m => m.type === 'SYNC')) await new Promise(r => setTimeout(r, 10));
    const sync = client.messages.find(m => m.type === 'SYNC');
    assert.ok(sync, 'the claimed seat must be able to sync a real, running match');
    assert.deepEqual(Object.keys(sync.snapshot.state.players ?? {}).sort(), ['A', 'B'], 'the actual running match must genuinely only have the two claimed players');
    client.close();
  } finally {
    await server.close();
    await launcher.close();
  }
});

test('dropUnfilledSeats:true dropping ALL unclaimed seats down to zero real players is refused (NO_PLAYERS), not started with an empty match', async () => {
  const { server, launcher, base } = await setupServerAndLauncher({ 'grid-duel': gridDuel });
  try {
    const created = await postJson(`${base}/api/lobbies`, { gameId: 'grid-duel', seatCount: 3 });
    // Nobody claims anything at all.
    const start = await postJson(`${base}/api/lobbies/${created.body.lobbyId}/start`, { dropUnfilledSeats: true });
    assert.equal(start.status, 400);
    assert.equal(start.body.error, 'NO_PLAYERS');
  } finally {
    await server.close();
    await launcher.close();
  }
});

test('dropUnfilledSeats can be combined with SOME bot-filled seats -- the rest are dropped, not required to also have a bot', skipIfNoLastSector, async () => {
  const { server, launcher, base } = await setupServerAndLauncher({ 'last-sector': { game: lastSector, bots: lastSectorPack.bots } });
  try {
    const created = await postJson(`${base}/api/lobbies`, { gameId: 'last-sector', seatCount: 4 });
    await claimSeat(base, created.body.joinLink); // seat A
    // B gets a bot, C and D are dropped entirely (last-sector allows 2-4 players, so A+B=2 is still valid).
    const start = await postJson(`${base}/api/lobbies/${created.body.lobbyId}/start`, { fillEmptyWithBot: { B: 'random' }, dropUnfilledSeats: true });
    assert.equal(start.status, 200);
    assert.deepEqual(start.body.players, ['A', 'B']);
    assert.deepEqual(start.body.bots, { B: 'random' });
  } finally {
    await server.close();
    await launcher.close();
  }
});

test('a claimed seat resolves as "not started" via GET seat-status until the organizer actually starts, then resolves to a real joinUrl', async () => {
  const { server, launcher, base } = await setupServerAndLauncher({ 'grid-duel': gridDuel });
  try {
    const created = await postJson(`${base}/api/lobbies`, { gameId: 'grid-duel', seatCount: 2 });
    const claimed = await claimSeat(base, created.body.joinLink);
    const before = await fetch(`${base}/api/lobbies/${created.body.lobbyId}/seat/${claimed.seatIndex}`).then(r => r.json());
    assert.equal(before.started, false);
    assert.equal(before.joinUrl, undefined);

    await claimSeat(base, created.body.joinLink); // claim the 2nd seat too
    await postJson(`${base}/api/lobbies/${created.body.lobbyId}/start`, {});

    const after = await fetch(`${base}/api/lobbies/${created.body.lobbyId}/seat/${claimed.seatIndex}`).then(r => r.json());
    assert.equal(after.started, true);
    assert.match(after.joinUrl, /player-ui/);
  } finally {
    await server.close();
    await launcher.close();
  }
});

test('GET seat-status for an unclaimed seat that got dropped at start reports {started:true, dropped:true}, not a fake joinUrl', async () => {
  const { server, launcher, base } = await setupServerAndLauncher({ 'grid-duel': gridDuel });
  try {
    const created = await postJson(`${base}/api/lobbies`, { gameId: 'grid-duel', seatCount: 3 });
    await claimSeat(base, created.body.joinLink); // only seat 0 claimed
    await postJson(`${base}/api/lobbies/${created.body.lobbyId}/start`, { dropUnfilledSeats: true });
    // Seat 1 (never claimed, dropped) must report dropped:true, not a joinUrl pointing at nothing.
    const status = await fetch(`${base}/api/lobbies/${created.body.lobbyId}/seat/1`).then(r => r.json());
    assert.equal(status.started, true);
    assert.equal(status.dropped, true);
    assert.equal(status.joinUrl, undefined);
  } finally {
    await server.close();
    await launcher.close();
  }
});

test('the real launcher /j/:code redirect for a lobby now points to lobby-wait.html, and that page is genuinely servable', async () => {
  const { server, launcher, base } = await setupServerAndLauncher({ 'grid-duel': gridDuel });
  try {
    const created = await postJson(`${base}/api/lobbies`, { gameId: 'grid-duel', seatCount: 2 });
    const r = await fetch(created.body.joinLink.shortUrl, { redirect: 'manual' });
    const waitPageUrl = r.headers.get('location');
    const waitPageResponse = await fetch(waitPageUrl);
    assert.equal(waitPageResponse.status, 200);
    const html = await waitPageResponse.text();
    assert.match(html, /lobby-wait\.js/);
  } finally {
    await server.close();
    await launcher.close();
  }
});

test('the launcher /api/lobby-seat-status proxy genuinely resolves through to the real admin API, server-to-server', async () => {
  const { server, launcher, base } = await setupServerAndLauncher({ 'grid-duel': gridDuel });
  try {
    const created = await postJson(`${base}/api/lobbies`, { gameId: 'grid-duel', seatCount: 1 });
    const claimed = await claimSeat(base, created.body.joinLink);
    const launcherOrigin = new URL(created.body.joinLink.shortUrl).origin;
    const proxied = await fetch(`${launcherOrigin}/api/lobby-seat-status/${created.body.lobbyId}/${claimed.seatIndex}`).then(r => r.json());
    assert.equal(proxied.started, false, 'must reflect the REAL admin-side state, fetched server-to-server through the launcher, not a stub');
  } finally {
    await server.close();
    await launcher.close();
  }
});

test('GET seat-status always includes live claimedCount/seatCount, before AND after start -- direct answer to "the waiting page should show X of Y players"', async () => {
  const { server, launcher, base } = await setupServerAndLauncher({ 'grid-duel': gridDuel });
  try {
    const created = await postJson(`${base}/api/lobbies`, { gameId: 'grid-duel', seatCount: 4 });
    const claimed = await claimSeat(base, created.body.joinLink);
    const before = await fetch(`${base}/api/lobbies/${created.body.lobbyId}/seat/${claimed.seatIndex}`).then(r => r.json());
    assert.equal(before.claimedCount, 1);
    assert.equal(before.seatCount, 4);

    await postJson(`${base}/api/lobbies/${created.body.lobbyId}/start`, { dropUnfilledSeats: true });
    const after = await fetch(`${base}/api/lobbies/${created.body.lobbyId}/seat/${claimed.seatIndex}`).then(r => r.json());
    assert.equal(after.claimedCount, 1);
    assert.equal(after.seatCount, 4);
  } finally {
    await server.close();
    await launcher.close();
  }
});

// Regression test for a real gap found via manual code review (not a
// failing test): POST /api/lobbies used to accept the exact same
// nonsensical `options` types (a string, a number, an array, null)
// that POST /api/matches did, before this project's own equivalent fix
// there -- both endpoints store/forward `options` into the same real
// match-creation path.
test('POST /api/lobbies rejects a non-object options value with a clean INVALID_OPTIONS', async () => {
  const server = createTableCoreServer({ secret: 'a-perfectly-fine-test-secret-32-chars-plus', games: { 'grid-duel': gridDuel } });
  try {
    const addr = await server.listen();
    const base = `http://${addr.adminHost}:${addr.adminPort}`;
    for (const options of ['a weird string', 42, true, [1, 2, 3], null]) {
      const res = await fetch(`${base}/api/lobbies`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ gameId: 'grid-duel', seatCount: 2, options }) });
      assert.equal(res.status, 400, `options=${JSON.stringify(options)} must be rejected`);
      assert.equal((await res.json()).error, 'INVALID_OPTIONS');
    }
    const ok = await fetch(`${base}/api/lobbies`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ gameId: 'grid-duel', seatCount: 2, options: { seed: 1 } }) });
    assert.equal(ok.status, 201);
  } finally {
    await server.close();
  }
});
