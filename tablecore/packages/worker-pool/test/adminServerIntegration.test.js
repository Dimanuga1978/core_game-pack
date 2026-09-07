import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createTableCoreServer } from '../../../tools/server/start.mjs';
import { MatchWorkerPool } from '../src/index.js';
import { infiniteLoopGame } from '../../../games/infinite-loop-test/src/index.js';
import { gridDuel } from '@tablecore/game-grid-duel';
import { createWsClient } from '@tablecore/transport-ws';

const INFINITE_LOOP_URL = new URL('../../../games/infinite-loop-test/src/index.js', import.meta.url).href;
const GRID_DUEL_URL = new URL('../../../games/grid-duel/src/index.js', import.meta.url).href;
const POOL_SIZE = 4;

// The SAME routing formula MatchWorkerPool.js itself uses internally
// (hash(matchId) -> worker index) -- replicated here (not imported,
// since it's a private implementation detail of that module, not part
// of its public API) so this test can pick two matchIds GUARANTEED to
// land on DIFFERENT workers, rather than gambling on it.
function hashToIndex(matchId, poolSize) {
  return createHash('sha256').update(String(matchId)).digest().readUInt32BE(0) % poolSize;
}

/**
 * Finds a matchId (starting from `seedPrefix`) that hashes to a worker
 * index OTHER than any in `avoidIndices` -- deterministic, not random.
 * Exists because a real, genuine issue was found empirically while
 * writing this test: matchId normally includes Date.now() + a random
 * suffix (see tools/server/start.mjs's own matchId generation), so
 * which worker a match lands on is effectively random from this test's
 * own point of view -- roughly a 1-in-poolSize chance, EVERY run, that
 * the "healthy" and "doomed" matches in this test would happen to land
 * on the SAME worker, in which case the healthy one WOULD legitimately
 * also become unavailable when the doomed one hangs (not a bug -- this
 * is exactly the real, documented poolSize/blast-radius tradeoff this
 * whole feature has -- see MatchWorkerPool.js's own class doc comment).
 * An earlier version of this test didn't account for this at all and
 * was genuinely flaky (failed roughly 1 in 4 real runs, matching the
 * 1-in-poolSize collision math exactly) for exactly this reason, not
 * because the underlying fix is unreliable.
 */
function findMatchIdAvoiding(seedPrefix, avoidIndices, poolSize) {
  for (let i = 0; i < 10000; i++) {
    const candidate = `${seedPrefix}-${i}`;
    if (!avoidIndices.includes(hashToIndex(candidate, poolSize))) return candidate;
  }
  throw new Error(`could not find a matchId avoiding worker indices ${avoidIndices} within 10000 attempts`);
}

async function waitFor(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await new Promise(r => setTimeout(r, 20)); }
  return fn();
}

// The real, end-to-end payoff of this session's own worker-pool
// integration work: before `matchHost` existed as an option on
// createTableCoreServer, a real, reproduced finding was that a
// synchronous infinite loop in ANY registered game's own
// applyActionInPlace() permanently froze the ENTIRE admin server
// process -- every match, every player, forever, with zero recovery
// possible short of an external process manager restarting it (and
// nothing would even know to, since the process never crashes/exits at
// all). This test drives the REAL, full stack (a real running admin
// server, a real MatchWorkerPool as its matchHost, a real WS connection
// triggering the actual games/infinite-loop-test fixture) and confirms
// the fix genuinely contains the damage: the doomed match's own worker
// gets retired by the CPU watchdog (rpcTimeoutMs), but a COMPLETELY
// UNRELATED healthy match (and the admin API itself) stays fully
// responsive throughout -- proven by actually syncing it, actually
// submitting a real action to it, and actually getting a real updated
// version back, not just asserting the process "didn't crash".
//
// Uses waitFor() (poll until true, or a generous timeout) at every real
// wait point below, not a fixed setTimeout delay -- an earlier version
// of this test used fixed delays (200ms/300ms/1500ms) and was genuinely
// flaky (found directly: failed 1 of 3 real runs), not because the
// underlying fix is unreliable, but because a fixed delay is a real
// gamble against actual system/thread-scheduling timing variance (4
// real worker threads spinning up, a real CPU watchdog timer, real WS
// round-trips) -- exactly the class of test-authoring mistake this
// project's OWN established waitFor() pattern (already used elsewhere
// in this same file) exists to avoid.
test('a synchronous infinite loop in one match, on a real running admin server backed by MatchWorkerPool, does NOT freeze a different, healthy match or the server process itself', async () => {
  const pool = new MatchWorkerPool({ poolSize: POOL_SIZE, rpcTimeoutMs: 500 });
  const server = createTableCoreServer({
    secret: 'a-perfectly-fine-test-secret-32-chars-plus',
    games: {
      'infinite-loop-test': { game: infiniteLoopGame, gameModuleUrl: INFINITE_LOOP_URL, gameExportName: 'infiniteLoopGame' },
      'grid-duel': { game: gridDuel, gameModuleUrl: GRID_DUEL_URL, gameExportName: 'gridDuel' },
    },
    matchHost: pool,
  });
  try {
    const addr = await server.listen();
    const base = `http://${addr.adminHost}:${addr.adminPort}`;

    // Explicit matchIds, deterministically chosen to land on DIFFERENT
    // workers -- see findMatchIdAvoiding's own doc comment for why this
    // matters (an earlier version of this test let the admin API
    // auto-generate matchIds, which are effectively random from this
    // test's own point of view, and was genuinely flaky as a direct
    // result).
    const doomedMatchId = findMatchIdAvoiding('doomed', [], POOL_SIZE);
    const doomedWorker = hashToIndex(doomedMatchId, POOL_SIZE);
    const healthyMatchId = findMatchIdAvoiding('healthy', [doomedWorker], POOL_SIZE);
    assert.notEqual(hashToIndex(healthyMatchId, POOL_SIZE), doomedWorker, 'test precondition: the two matches must genuinely land on different workers, or this test would be testing the wrong thing (see findMatchIdAvoiding\'s own comment)');

    const healthy = await fetch(`${base}/api/matches`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ matchId: healthyMatchId, gameId: 'grid-duel', players: ['A', 'B'] }) }).then(r => r.json());
    const doomed = await fetch(`${base}/api/matches`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ matchId: doomedMatchId, gameId: 'infinite-loop-test', players: ['A', 'B'] }) }).then(r => r.json());
    assert.equal(healthy.matchId, healthyMatchId);
    assert.equal(doomed.matchId, doomedMatchId);

    const doomedClient = await createWsClient({ port: addr.wsPort, host: '127.0.0.1', hello: { type: 'HELLO', protocolVersion: 1, token: doomed.tokens.A } });
    doomedClient.send({ type: 'SYNC_REQUEST', protocolVersion: 1, matchId: doomed.matchId });
    const doomedSynced = await waitFor(() => doomedClient.messages.some(m => m.type === 'SYNC'));
    assert.ok(doomedSynced, 'test precondition: the doomed match must sync successfully BEFORE the hang, to prove the hang itself (not some earlier setup issue) is what is under test');

    // Trigger the real, actual runaway loop.
    doomedClient.send({ type: 'ACTION', protocolVersion: 1, matchId: doomed.matchId, expectedVersion: 1, action: { type: 'HANG', actor: 'A' } });

    const healthyClient = await createWsClient({ port: addr.wsPort, host: '127.0.0.1', hello: { type: 'HELLO', protocolVersion: 1, token: healthy.tokens.A } });
    healthyClient.send({ type: 'SYNC_REQUEST', protocolVersion: 1, matchId: healthy.matchId });
    // Deliberately started WITHOUT first waiting out the CPU watchdog's
    // own rpcTimeoutMs -- this healthy sync is racing the doomed match's
    // hang on purpose, and must win (or at least not be blocked by it),
    // since the whole point is that a hang on one worker never blocks
    // ANYTHING on a different one, not even something that happens to
    // be in flight at the same moment.
    const healthySynced = await waitFor(() => healthyClient.messages.some(m => m.type === 'SYNC'));
    assert.ok(healthySynced, 'a completely unrelated healthy match must still sync successfully while/after the hang');
    const sync = healthyClient.messages.find(m => m.type === 'SYNC');
    assert.equal(sync.snapshot.version, 1);

    healthyClient.send({ type: 'ACTION', protocolVersion: 1, matchId: healthy.matchId, expectedVersion: 1, action: { type: 'MOVE', direction: 'E', actor: 'A' } });
    const healthyUpdated = await waitFor(() => healthyClient.messages.some(m => m.type === 'UPDATE'));
    assert.ok(healthyUpdated, 'the healthy match must still accept and process a real action after the hang, not just passively still respond to reads');
    const update = healthyClient.messages.find(m => m.type === 'UPDATE');
    assert.equal(update.snapshot?.version, 2);

    const health = await fetch(`${base}/api/games`);
    assert.equal(health.status, 200, 'the admin API itself (a completely unrelated endpoint, not tied to either match) must still be responsive');

    doomedClient.close();
    healthyClient.close();
  } finally {
    await server.close();
    await pool.close();
  }
});
