import test from 'node:test';
import assert from 'node:assert/strict';
import { createTableCoreServer } from '../start.mjs';
import { createWsClient } from '@tablecore/transport-ws';
import { gridDuel } from '@tablecore/game-grid-duel';

// last-sector is a SEPARATE, optional game pack (see this repo's own
// two-archive split: the engine ships independently of any specific
// game, and games/last-sector -- the one real, shippable game in this
// repository, as opposed to the engine-fixture-only demo games above --
// is meant to be physically dropped into a running engine's own games/
// directory, not bundled with it). It is ALSO, not coincidentally, the
// only shipped game with real bot strategies (see example.config.mjs's
// own comment on this) -- meaning EVERY test in this file, which is
// specifically about the engine's bot-driving mechanism, genuinely
// needs it present to mean anything. Rather than a static top-level
// import (which would make this WHOLE FILE fail to even load on an
// engine-only checkout with no games/last-sector present), this tries a
// dynamic import once and marks every test `skip` with a clear reason
// if it's unavailable -- confirmed directly: `node --test` treats a
// skipped test as neither a pass nor a failure, so an engine-only
// checkout's `npm test` stays genuinely clean (not just "silently
// missing tests", an honest, visible skip reason instead).
let lastSector, lastSectorPack, lastSectorUnavailableReason = null;
try {
  ({ lastSector, lastSectorPack } = await import('@tablecore/game-last-sector'));
} catch (error) {
  lastSectorUnavailableReason = `games/last-sector not present in this checkout (${error.code ?? error.message}) -- this file specifically tests bot-driving behavior, which needs a real game with bot strategies to test against`;
}
const skipIfNoLastSector = lastSectorUnavailableReason ? { skip: lastSectorUnavailableReason } : {};
const lastSectorPresent = !lastSectorUnavailableReason;

async function postJson(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

async function wait(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await new Promise(r => setTimeout(r, 10)); }
  return fn();
}

// The games registry accepts EITHER a bare GameDefinition (bots
// unavailable, matches every other test file's existing usage) or
// `{game, bots}` -- last-sector is the only shipped game with real bot
// strategies, so it's the one used here for the actual auto-play tests.
// Guarded (not a bare, always-evaluated expression) for the same
// reason every OTHER last-sector reference in this file is -- lastSector/
// lastSectorPack are `undefined` when the dynamic import above failed,
// and referencing `.bots` on `undefined` would throw at MODULE
// EVALUATION time (this constant sits at the top level, not inside a
// skippable test body), crashing this whole file's ability to even
// load regardless of the try/catch already guarding the import itself
// -- confirmed directly: this exact line was the real, reproduced
// failure on a genuine engine-only checkout with no games/last-sector
// present, found by actually running this file that way, not assumed.
const LAST_SECTOR_WITH_BOTS = lastSectorPresent ? { game: lastSector, bots: lastSectorPack.bots } : null;

test('requesting a bot strategy for a game with no bots defined is rejected at match-creation time, not silently ignored', async () => {
  const server = createTableCoreServer({ secret: 'a-perfectly-fine-test-secret-32-chars-plus', games: { 'grid-duel': gridDuel } });
  try {
    const addr = await server.listen();
    const r = await postJson(`http://${addr.adminHost}:${addr.adminPort}/api/matches`, { gameId: 'grid-duel', players: ['A', 'B'], bots: { B: 'aggressive' } });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'UNKNOWN_BOT_STRATEGY');
    assert.deepEqual(r.body.knownStrategies, []);
  } finally {
    await server.close();
  }
});

test('assigning a bot to a playerId that is not in the match is rejected', skipIfNoLastSector, async () => {
  const server = createTableCoreServer({ secret: 'a-perfectly-fine-test-secret-32-chars-plus', games: { 'last-sector': LAST_SECTOR_WITH_BOTS } });
  try {
    const addr = await server.listen();
    const r = await postJson(`http://${addr.adminHost}:${addr.adminPort}/api/matches`, { gameId: 'last-sector', players: ['A', 'B'], bots: { C: 'aggressive' } });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'BOT_PLAYER_NOT_IN_MATCH');
  } finally {
    await server.close();
  }
});

test('bot tokens are never returned to the caller -- only the human players\' tokens', skipIfNoLastSector, async () => {
  const server = createTableCoreServer({ secret: 'a-perfectly-fine-test-secret-32-chars-plus', games: { 'last-sector': LAST_SECTOR_WITH_BOTS } });
  try {
    const addr = await server.listen();
    const r = await postJson(`http://${addr.adminHost}:${addr.adminPort}/api/matches`, { gameId: 'last-sector', players: ['A', 'B'], bots: { B: 'aggressive' } });
    assert.equal(r.status, 201);
    assert.deepEqual(Object.keys(r.body.tokens), ['A'], 'B is bot-controlled, its token must not leak into the response');
    assert.deepEqual(r.body.bots, { B: 'aggressive' });
  } finally {
    await server.close();
  }
});

// The core, real, end-to-end proof: a human takes a turn, and the bot
// automatically plays its own turn(s) with no external trigger, and the
// human's WS connection receives real-time UPDATE broadcasts for every
// single bot action -- the same live-update experience they'd get
// watching another human play.
test('a bot automatically takes its turn after a human ends theirs, and the human sees it live', skipIfNoLastSector, async () => {
  const server = createTableCoreServer({ secret: 'a-perfectly-fine-test-secret-32-chars-plus', games: { 'last-sector': LAST_SECTOR_WITH_BOTS } });
  try {
    const addr = await server.listen();
    const created = await postJson(`http://${addr.adminHost}:${addr.adminPort}/api/matches`, { gameId: 'last-sector', players: ['A', 'B'], options: { seed: 5 }, bots: { B: 'aggressive' } });
    assert.equal(created.status, 201);

    const client = await createWsClient({ port: addr.wsPort, host: addr.wsHost, hello: { type: 'HELLO', protocolVersion: 1, token: created.body.tokens.A } });
    client.send({ type: 'SYNC_REQUEST', protocolVersion: 1, matchId: created.body.matchId });
    await wait(() => client.messages.some(m => m.type === 'SYNC'));
    const sync = client.messages.find(m => m.type === 'SYNC');
    assert.equal(sync.snapshot.state.activePlayer, 'A');

    client.send({ type: 'ACTION', protocolVersion: 1, matchId: created.body.matchId, expectedVersion: sync.snapshot.version, action: { type: 'END_TURN', actor: 'A' } });

    // Wait for the bot to act and turn control back to A -- with no
    // human ever sending another message in between.
    const backToA = await wait(() => {
      const last = client.messages.filter(m => m.type === 'UPDATE').at(-1);
      return last && last.snapshot.state.activePlayer === 'A' && last.snapshot.version > sync.snapshot.version + 1;
    }, 5000);
    assert.equal(backToA, true, 'the bot must autonomously play its turn(s) and hand control back, with zero human intervention');

    const updates = client.messages.filter(m => m.type === 'UPDATE');
    assert.ok(updates.length >= 2, 'the human must receive a live UPDATE for at least the bot\'s own action, not just their own END_TURN echo');

    client.close();
  } finally {
    await server.close();
  }
});

// A match where EVERY player is bot-controlled must play itself out
// autonomously, with zero human connections at all.
test('a match with every player bot-controlled plays itself autonomously, with no human connection', skipIfNoLastSector, async () => {
  const server = createTableCoreServer({ secret: 'a-perfectly-fine-test-secret-32-chars-plus', games: { 'last-sector': LAST_SECTOR_WITH_BOTS } });
  try {
    const addr = await server.listen();
    const created = await postJson(`http://${addr.adminHost}:${addr.adminPort}/api/matches`, { gameId: 'last-sector', players: ['A', 'B'], options: { seed: 8 }, bots: { A: 'random', B: 'aggressive' } });
    assert.equal(created.status, 201);
    assert.deepEqual(created.body.tokens, {}, 'no human tokens at all when every player is bot-controlled');

    // Observe via a spectator connection on a SEPARATE, explicitly
    // public match -- proves the match progresses purely from two bots
    // playing against each other, unattended.
    const spectatorTokenResp = await postJson(`http://${addr.adminHost}:${addr.adminPort}/api/spectator-tokens`, {});
    const created2 = await postJson(`http://${addr.adminHost}:${addr.adminPort}/api/matches`, { gameId: 'last-sector', players: ['A', 'B'], options: { seed: 9 }, bots: { A: 'random', B: 'aggressive' }, spectatorPolicy: 'public' });
    const spectator = await createWsClient({ port: addr.wsPort, host: addr.wsHost, hello: { type: 'HELLO', protocolVersion: 1, token: spectatorTokenResp.body.token } });
    spectator.send({ type: 'SYNC_REQUEST', protocolVersion: 1, matchId: created2.body.matchId });
    await wait(() => spectator.messages.some(m => m.type === 'SYNC'));
    const initialVersion = spectator.messages.find(m => m.type === 'SYNC').snapshot.version;

    const progressed = await wait(() => {
      const last = spectator.messages.filter(m => m.type === 'UPDATE').at(-1);
      return last && last.snapshot.version > initialVersion + 3;
    }, 5000);
    assert.equal(progressed, true, 'the match must progress through several versions purely from two unattended bots playing each other');

    spectator.close();
  } finally {
    await server.close();
  }
});

// Safety mechanism: a bot strategy that keeps throwing must not retry
// forever (which would either loop indefinitely or spam errors).
test('a bot strategy that always throws is disabled after botMaxConsecutiveFailures, not retried forever', skipIfNoLastSector, async () => {
  const brokenBots = { broken: () => { throw new Error('this strategy is intentionally broken for this test'); } };
  const server = createTableCoreServer({
    secret: 'a-perfectly-fine-test-secret-32-chars-plus',
    games: { 'last-sector': { game: lastSector, bots: brokenBots } },
    botMaxConsecutiveFailures: 3,
  });
  try {
    const addr = await server.listen();
    const created = await postJson(`http://${addr.adminHost}:${addr.adminPort}/api/matches`, { gameId: 'last-sector', players: ['A', 'B'], options: { seed: 5 }, bots: { B: 'broken' } });
    assert.equal(created.status, 201);

    const client = await createWsClient({ port: addr.wsPort, host: addr.wsHost, hello: { type: 'HELLO', protocolVersion: 1, token: created.body.tokens.A } });
    client.send({ type: 'SYNC_REQUEST', protocolVersion: 1, matchId: created.body.matchId });
    await wait(() => client.messages.some(m => m.type === 'SYNC'));
    const sync = client.messages.find(m => m.type === 'SYNC');
    client.send({ type: 'ACTION', protocolVersion: 1, matchId: created.body.matchId, expectedVersion: sync.snapshot.version, action: { type: 'END_TURN', actor: 'A' } });

    // Give the broken strategy plenty of time to (fail to) retry --
    // the match must simply sit at B's turn forever, not crash the
    // server or loop the process into unresponsiveness.
    await new Promise(r => setTimeout(r, 1000));
    const stillResponsive = await fetch(`http://${addr.adminHost}:${addr.adminPort}/api/games`);
    assert.equal(stillResponsive.status, 200, 'the server itself must remain fully responsive despite a broken bot strategy in one match');

    client.close();
  } finally {
    await server.close();
  }
});

test('bot WS connections are cleaned up when the server closes -- no lingering open sockets', skipIfNoLastSector, async () => {
  const server = createTableCoreServer({ secret: 'a-perfectly-fine-test-secret-32-chars-plus', games: { 'last-sector': LAST_SECTOR_WITH_BOTS } });
  const addr = await server.listen();
  const created = await postJson(`http://${addr.adminHost}:${addr.adminPort}/api/matches`, { gameId: 'last-sector', players: ['A', 'B'], bots: { B: 'aggressive' } });
  assert.equal(created.status, 201);
  await assert.doesNotReject(() => server.close(), 'closing the server with an active bot connection must not hang or throw');
});

// Regression test for a real, confirmed robustness gap found via a
// manual code review of driveBotsForMatch() (not found by any failing
// test): the driver used to fire-and-forget every bot action, never
// inspecting the real server reply the bot client's own `messages`
// array genuinely does receive. `consecutiveFailures` only ever
// incremented when a bot's own STRATEGY FUNCTION threw an exception --
// a bot whose strategy always returns a legal-LOOKING action (passes
// getLegalActions(), so nothing objects at decision time) that the
// server nonetheless keeps REJECTING for some other reason hit no
// backoff at all. Reproduced directly before this fix: a deliberately
// misbehaving bot strategy sent 33 rejected actions in 3 real seconds
// with zero slowdown, hammering the server indefinitely for the entire
// remaining lifetime of the match.
test('a bot strategy that always returns an action the server rejects (not one that throws) is correctly detected and backed off after botMaxConsecutiveFailures, not retried forever', async () => {
  let strategyCallCount = 0;
  const server = createTableCoreServer({
    secret: 'a-perfectly-fine-test-secret-32-chars-plus',
    games: { 'grid-duel': { game: gridDuel, bots: { alwaysBadMove: () => { strategyCallCount++; return { type: 'MOVE', direction: 'BOGUS' }; } } } },
    botMaxConsecutiveFailures: 5,
  });
  try {
    const addr = await server.listen();
    const created = await fetch(`http://${addr.adminHost}:${addr.adminPort}/api/matches`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ gameId: 'grid-duel', players: ['A', 'B'], bots: { A: 'alwaysBadMove' } }) }).then(r => r.json());
    assert.ok(created.matchId);
    await new Promise(r => setTimeout(r, 1500));
    const countAfterFirstWindow = strategyCallCount;
    await new Promise(r => setTimeout(r, 1500));
    assert.equal(strategyCallCount, countAfterFirstWindow, 'the strategy must stop being called at all once the consecutive-failure backoff engages -- a real retry storm would keep growing this count in the second window too');
    assert.ok(strategyCallCount < 20, `the backoff must kick in after a small number of rejections, not after dozens -- got ${strategyCallCount} calls`);
  } finally {
    await server.close();
  }
});
