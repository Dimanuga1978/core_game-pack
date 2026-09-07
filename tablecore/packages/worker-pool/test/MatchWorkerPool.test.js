import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { MatchWorkerPool } from '../src/index.js';

const GRID_DUEL_URL = new URL('../../../games/grid-duel/src/index.js', import.meta.url).href;
const TIME_BOMB_URL = new URL('../../../games/timebomb-test/src/index.js', import.meta.url).href;
const MEMORY_HOG_URL = new URL('../../../games/memory-hog-test/src/index.js', import.meta.url).href;
const INFINITE_LOOP_URL = new URL('../../../games/infinite-loop-test/src/index.js', import.meta.url).href;

function hashToIndex(matchId, poolSize) {
  return createHash('sha256').update(String(matchId)).digest().readUInt32BE(0) % poolSize;
}

async function waitFor(fn, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await new Promise(r => setTimeout(r, 20)); }
  return fn();
}

// Find real match ids that land on distinct worker indices for a given
// pool size, rather than hardcoding ids that happen to work today --
// this stays correct if the hash function's exact distribution ever
// changes.
function idsOnDistinctWorkers(poolSize, count) {
  const found = new Map();
  for (let i = 0; found.size < count && i < 100000; i++) {
    const id = `match-${i}`;
    const idx = hashToIndex(id, poolSize);
    if (!found.has(idx)) found.set(idx, id);
  }
  if (found.size < count) throw new Error('could not find enough distinct-worker ids');
  return [...found.values()];
}

test('createMatch/startMatch/submitAction work correctly end-to-end through the pool', async () => {
  const pool = new MatchWorkerPool({ poolSize: 2 });
  try {
    const created = await pool.createMatch({ id: 'm1', gameModuleUrl: GRID_DUEL_URL, gameExportName: 'gridDuel', players: ['A', 'B'] });
    assert.equal(created.ok, true);
    const started = await pool.startMatch({ matchId: 'm1', actor: 'A' });
    assert.equal(started.ok, true);
    assert.equal(started.match.status, 'running');
    const snap = await pool.getSnapshot('m1', 'A');
    assert.equal(snap.ok, true);
    const r = await pool.submitAction({ matchId: 'm1', connectionPlayerId: 'A', actor: 'A', expectedVersion: snap.snapshot.version, action: { type: 'MOVE', direction: 'E' } });
    assert.equal(r.ok, true);
    assert.deepEqual(r.snapshot.state.players.A.position, { x: 1, y: 0 });
  } finally {
    await pool.close();
  }
});

test('a match consistently routes to the same worker across every call (required for in-match action ordering)', async () => {
  const pool = new MatchWorkerPool({ poolSize: 4 });
  try {
    await pool.createMatch({ id: 'consistent-routing', gameModuleUrl: GRID_DUEL_URL, gameExportName: 'gridDuel', players: ['A', 'B'] });
    const expected = pool._indexFor('consistent-routing');
    // Every subsequent lookup for the same matchId must agree, including
    // ones happening after other matches have been created (which must
    // not perturb existing routing).
    await pool.createMatch({ id: 'other-match-1', gameModuleUrl: GRID_DUEL_URL, gameExportName: 'gridDuel', players: ['A', 'B'] });
    await pool.createMatch({ id: 'other-match-2', gameModuleUrl: GRID_DUEL_URL, gameExportName: 'gridDuel', players: ['A', 'B'] });
    assert.equal(pool._indexFor('consistent-routing'), expected);
  } finally {
    await pool.close();
  }
});

test('actor spoofing and non-participant access are rejected the same way as ServerHost', async () => {
  const pool = new MatchWorkerPool({ poolSize: 1 });
  try {
    await pool.createMatch({ id: 'm1', gameModuleUrl: GRID_DUEL_URL, gameExportName: 'gridDuel', players: ['A', 'B'] });
    await pool.startMatch({ matchId: 'm1', actor: 'A' });
    const snap = await pool.getSnapshot('m1', 'A');
    const spoofed = await pool.submitAction({ matchId: 'm1', connectionPlayerId: 'A', actor: 'B', expectedVersion: snap.snapshot.version, action: { type: 'MOVE', direction: 'E' } });
    assert.equal(spoofed.ok, false);
    assert.equal(spoofed.error.code, 'ACTOR_SPOOFING');
    const outsider = await pool.submitAction({ matchId: 'm1', connectionPlayerId: 'X', actor: 'X', expectedVersion: snap.snapshot.version, action: { type: 'MOVE', direction: 'E' } });
    assert.equal(outsider.ok, false);
    assert.equal(outsider.error.code, 'NOT_MATCH_PARTICIPANT');
  } finally {
    await pool.close();
  }
});

// The core property this whole package exists for (P1-MATCH, external
// remediation request section 23; and the concrete PoC from the audit
// that motivated it): a rule that schedules a deferred mutation of its
// own state throws an uncaught exception once the timer fires (the
// immer draft is already finalized/revoked by then) -- run in-process,
// this crashes the ENTIRE server. Run inside a worker, it must only
// crash that one worker.
test('a match whose rule code crashes its worker (deferred mutation of a revoked draft) does not affect a match on a different worker, or the main process', async () => {
  const pool = new MatchWorkerPool({ poolSize: 4 });
  try {
    const [bombId, safeId] = idsOnDistinctWorkers(4, 2);
    assert.notEqual(hashToIndex(bombId, 4), hashToIndex(safeId, 4), 'test precondition: these two ids must land on different workers');

    await pool.createMatch({ id: bombId, gameModuleUrl: TIME_BOMB_URL, gameExportName: 'timeBombGame', players: ['A', 'B'] });
    await pool.startMatch({ matchId: bombId, actor: 'A' });
    await pool.createMatch({ id: safeId, gameModuleUrl: GRID_DUEL_URL, gameExportName: 'gridDuel', players: ['A', 'B'] });
    await pool.startMatch({ matchId: safeId, actor: 'A' });

    const bombSnap = await pool.getSnapshot(bombId, 'A');
    const armed = await pool.submitAction({ matchId: bombId, connectionPlayerId: 'A', actor: 'A', expectedVersion: bombSnap.snapshot.version, action: { type: 'ARM' } });
    assert.equal(armed.ok, true, 'arming the bomb is itself a normal, successful action -- the crash is deferred');

    // Give the timer time to fire and crash the bomb's worker.
    await new Promise(r => setTimeout(r, 300));

    assert.equal(pool.wasLostToCrash(bombId), true, 'the bomb match must be reported as lost to a crash');
    assert.equal(pool.wasLostToCrash(safeId), false, 'the safe match, on a different worker, must not be affected at all');

    // The real proof: the safe match keeps working normally AFTER the
    // other worker crashed. If this test process itself had crashed,
    // nothing below this line would ever run at all.
    const safeSnap = await pool.getSnapshot(safeId, 'A');
    assert.equal(safeSnap.ok, true);
    const r = await pool.submitAction({ matchId: safeId, connectionPlayerId: 'A', actor: 'A', expectedVersion: safeSnap.snapshot.version, action: { type: 'MOVE', direction: 'E' } });
    assert.equal(r.ok, true);
    assert.deepEqual(r.snapshot.state.players.A.position, { x: 1, y: 0 });
  } finally {
    await pool.close();
  }
});

test('the pool respawns a replacement worker after a crash, so new matches can still be routed to that pool slot', async () => {
  const pool = new MatchWorkerPool({ poolSize: 4 });
  try {
    const [bombId] = idsOnDistinctWorkers(4, 1);
    const crashedWorkerIndex = hashToIndex(bombId, 4);

    await pool.createMatch({ id: bombId, gameModuleUrl: TIME_BOMB_URL, gameExportName: 'timeBombGame', players: ['A', 'B'] });
    await pool.startMatch({ matchId: bombId, actor: 'A' });
    const snap = await pool.getSnapshot(bombId, 'A');
    await pool.submitAction({ matchId: bombId, connectionPlayerId: 'A', actor: 'A', expectedVersion: snap.snapshot.version, action: { type: 'ARM' } });
    await new Promise(r => setTimeout(r, 300));
    assert.equal(pool.wasLostToCrash(bombId), true);

    // A brand new match that hashes to the SAME slot must work on the
    // freshly-spawned replacement worker, not hang forever waiting on a
    // dead one.
    let freshId = null;
    for (let i = 0; i < 100000; i++) {
      const candidate = `fresh-${i}`;
      if (hashToIndex(candidate, 4) === crashedWorkerIndex) { freshId = candidate; break; }
    }
    assert.ok(freshId, 'test precondition: found an id routing to the crashed slot');
    const created = await pool.createMatch({ id: freshId, gameModuleUrl: GRID_DUEL_URL, gameExportName: 'gridDuel', players: ['A', 'B'] });
    assert.equal(created.ok, true, 'the respawned worker must serve new matches routed to its slot');
  } finally {
    await pool.close();
  }
});

// P0-SANDBOX (external remediation request): "a valid signature does not
// make an executable Game Pack safe... CPU overrun terminates the pack
// execution without taking down the gateway; memory overrun terminates/
// restarts the pack worker." These two tests are the honest, real,
// verifiable subset of that: V8-enforced memory ceilings via
// worker_threads' own `resourceLimits`, and this pool's own CPU watchdog
// (`rpcTimeoutMs`) for a runaway synchronous loop. See MatchWorkerPool.js's
// class doc comment for what this explicitly does NOT provide (filesystem/
// network/env capability restriction -- that needs real OS-level process
// isolation, out of scope for a worker_thread).

test('a match that keeps allocating memory is killed once it exceeds resourceLimits, without affecting a match on a different worker', async () => {
  const pool = new MatchWorkerPool({ poolSize: 4, resourceLimits: { maxOldGenerationSizeMb: 48, maxYoungGenerationSizeMb: 16 } });
  try {
    const [hogId, safeId] = idsOnDistinctWorkers(4, 2);
    await pool.createMatch({ id: hogId, gameModuleUrl: MEMORY_HOG_URL, gameExportName: 'memoryHogGame', players: ['A', 'B'] });
    await pool.startMatch({ matchId: hogId, actor: 'A' });
    await pool.createMatch({ id: safeId, gameModuleUrl: GRID_DUEL_URL, gameExportName: 'gridDuel', players: ['A', 'B'] });
    await pool.startMatch({ matchId: safeId, actor: 'A' });

    // Keep allocating until the worker gets killed (or give up after a
    // generous cap so a misconfigured limit can't hang the test forever).
    let lost = false;
    for (let i = 0; i < 60 && !lost; i++) {
      const snap = await pool.getSnapshot(hogId, 'A').catch(() => null);
      if (!snap || !snap.ok) { lost = true; break; }
      const r = await pool.submitAction({ matchId: hogId, connectionPlayerId: 'A', actor: 'A', expectedVersion: snap.snapshot.version, action: { type: 'ALLOCATE' } }).catch(() => ({ ok: false }));
      if (!r.ok) lost = true;
    }

    assert.equal(await waitFor(() => pool.wasLostToCrash(hogId), 5000), true, 'the memory-hogging match must eventually be lost once its worker is killed for exceeding resourceLimits');
    assert.equal(pool.wasLostToCrash(safeId), false, 'a match on a different worker must be completely unaffected by the memory kill');

    const safeSnap = await pool.getSnapshot(safeId, 'A');
    const r = await pool.submitAction({ matchId: safeId, connectionPlayerId: 'A', actor: 'A', expectedVersion: safeSnap.snapshot.version, action: { type: 'MOVE', direction: 'E' } });
    assert.equal(r.ok, true, 'the safe match keeps working normally after the other worker was killed for memory overrun');
  } finally {
    await pool.close();
  }
});

test('a match whose rule code runs a synchronous infinite loop is retired by the CPU watchdog (rpcTimeoutMs), without affecting a match on a different worker', async () => {
  const pool = new MatchWorkerPool({ poolSize: 4, rpcTimeoutMs: 300 });
  try {
    const [hangId, safeId] = idsOnDistinctWorkers(4, 2);
    await pool.createMatch({ id: hangId, gameModuleUrl: INFINITE_LOOP_URL, gameExportName: 'infiniteLoopGame', players: ['A', 'B'] });
    await pool.startMatch({ matchId: hangId, actor: 'A' });
    await pool.createMatch({ id: safeId, gameModuleUrl: GRID_DUEL_URL, gameExportName: 'gridDuel', players: ['A', 'B'] });
    await pool.startMatch({ matchId: safeId, actor: 'A' });

    const hangSnap = await pool.getSnapshot(hangId, 'A');
    // This call itself never resolves normally -- the watchdog rejects it
    // once rpcTimeoutMs elapses, which is the actual behavior under test.
    await assert.rejects(() => pool.submitAction({ matchId: hangId, connectionPlayerId: 'A', actor: 'A', expectedVersion: hangSnap.snapshot.version, action: { type: 'HANG' } }));

    assert.equal(pool.wasLostToCrash(hangId), true, 'the hung match must be marked lost once the watchdog fires');
    assert.equal(pool.lossReasonFor(hangId), 'cpu-timeout');
    assert.equal(pool.wasLostToCrash(safeId), false, 'a match on a different worker must be completely unaffected by the CPU watchdog firing elsewhere');

    const safeSnap = await pool.getSnapshot(safeId, 'A');
    const r = await pool.submitAction({ matchId: safeId, connectionPlayerId: 'A', actor: 'A', expectedVersion: safeSnap.snapshot.version, action: { type: 'MOVE', direction: 'E' } });
    assert.equal(r.ok, true, 'the safe match keeps working normally after the other worker was retired for a CPU timeout');
  } finally {
    await pool.close();
  }
});

// Regression test for a real parity gap found and fixed via code review
// (not testing already, until now): ServerHost's own getSnapshot() has
// included `availableActions` for a while (a client cannot safely
// derive "what can I do right now" itself), but this worker's own
// snapshot construction was never updated to match -- meaning any
// client relying on it would have silently gotten `undefined` the
// moment a match ran on this pool instead of ServerHost.
test('MatchWorkerPool snapshots include availableActions, matching ServerHost\'s own real snapshot shape field-for-field (not just "some fields")', async () => {
  const { ServerHost } = await import('@tablecore/server');
  const { gridDuel } = await import(GRID_DUEL_URL);

  const host = new ServerHost();
  host.createMatch({ id: 'm', game: gridDuel, players: ['A', 'B'] });
  host.startMatch({ matchId: 'm', actor: 'A' });
  const inProcessSnapshot = host.getSnapshot('m', 'A').snapshot;

  const pool = new MatchWorkerPool({ poolSize: 1 });
  try {
    await pool.createMatch({ id: 'm', gameModuleUrl: GRID_DUEL_URL, gameExportName: 'gridDuel', players: ['A', 'B'] });
    await pool.startMatch({ matchId: 'm', actor: 'A' });
    const workerResult = await pool.getSnapshot('m', 'A');
    const workerSnapshot = workerResult.snapshot;

    assert.ok(Array.isArray(workerSnapshot.availableActions), 'MatchWorkerPool snapshot must include a real availableActions array, not be missing the field entirely');
    assert.deepEqual(workerSnapshot.availableActions, inProcessSnapshot.availableActions, 'the SAME match/viewer must get the SAME availableActions from either host -- proving genuine parity, not just "some array exists"');
    assert.ok(workerSnapshot.availableActions.length > 0, 'sanity: a real, just-started match must have at least one real legal action for the active player');
  } finally {
    await pool.close();
  }
});

test('MatchWorkerPool snapshot availableActions is empty for a spectator (viewer=null), matching ServerHost\'s own behavior', async () => {
  const pool = new MatchWorkerPool({ poolSize: 1 });
  try {
    await pool.createMatch({ id: 'm2', gameModuleUrl: GRID_DUEL_URL, gameExportName: 'gridDuel', players: ['A', 'B'] });
    await pool.startMatch({ matchId: 'm2', actor: 'A' });
    const result = await pool.getSnapshot('m2', null);
    assert.deepEqual(result.snapshot.availableActions, []);
  } finally {
    await pool.close();
  }
});

// Real gap found while investigating what a genuine drop-in replacement
// for ServerHost would need: this engine's own bot driver (see
// tools/server/start.mjs) calls matchHost.getAuthoritativeState()
// directly, bypassing the protocol layer entirely, for the SAME reason
// getSnapshot() computes availableActions from raw state -- a bot's own
// decision-making needs the real internal shape, not a per-viewer
// projection. MatchWorkerPool had no equivalent method at all before
// this.
test('MatchWorkerPool.getAuthoritativeState matches ServerHost.getAuthoritativeState()\'s own {ok,state,version} shape exactly, for the SAME real match', async () => {
  const { ServerHost } = await import('@tablecore/server');
  const { gridDuel } = await import(GRID_DUEL_URL);

  const host = new ServerHost();
  host.createMatch({ id: 'm3', game: gridDuel, players: ['A', 'B'] });
  host.startMatch({ matchId: 'm3', actor: 'A' });
  host.submitAction({ matchId: 'm3', connectionPlayerId: 'A', actor: 'A', expectedVersion: 1, action: { type: 'MOVE', direction: 'E' } });
  const inProcessResult = host.getAuthoritativeState('m3');

  const pool = new MatchWorkerPool({ poolSize: 1 });
  try {
    await pool.createMatch({ id: 'm3', gameModuleUrl: GRID_DUEL_URL, gameExportName: 'gridDuel', players: ['A', 'B'] });
    await pool.startMatch({ matchId: 'm3', actor: 'A' });
    await pool.submitAction({ matchId: 'm3', connectionPlayerId: 'A', actor: 'A', expectedVersion: 1, action: { type: 'MOVE', direction: 'E' } });
    const workerResult = await pool.getAuthoritativeState('m3');

    assert.equal(workerResult.ok, true);
    assert.deepEqual(workerResult.state, inProcessResult.state, 'the SAME real actions against the SAME real game must produce IDENTICAL raw state on either host -- genuine parity, not coincidental similarity');
    assert.equal(workerResult.version, inProcessResult.version);
  } finally {
    await pool.close();
  }
});

test('MatchWorkerPool.getAuthoritativeState returns MATCH_NOT_FOUND for a genuinely unknown match, matching ServerHost\'s own behavior', async () => {
  const pool = new MatchWorkerPool({ poolSize: 1 });
  try {
    const result = await pool.getAuthoritativeState('never-created');
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'MATCH_NOT_FOUND');
  } finally {
    await pool.close();
  }
});

// Regression test for a real resource leak found via manual code
// review (not a failing test): postMessage() throws SYNCHRONOUSLY for
// a payload structuredClone/the postMessage transfer algorithm cannot
// handle (a function, a Symbol) -- and while that synchronous throw
// DOES correctly reject the promise _rpc() returns (JS's own Promise
// constructor auto-rejects on an executor throw), that happens via the
// constructor's own internal mechanism, entirely bypassing the
// explicit `reject` this code had already stored in `pending[index]`
// -- leaving that entry permanently orphaned (the worker never
// received the message, so it can never reply to clean it up).
// Confirmed directly before this fix: pending[index].size stayed at 1
// forever after exactly this scenario. Without rpcTimeoutMs configured
// this leaks unboundedly; WITH it configured, the leaked entry
// eventually fires the CPU-timeout watchdog and retires the entire
// worker over one caller's bad payload, needlessly losing every OTHER
// match hosted there too.
test('a call with a non-cloneable payload (e.g. options containing a function) is cleanly rejected without leaking a pending RPC entry or affecting the worker\'s other matches', async () => {
  const pool = new MatchWorkerPool({ poolSize: 1 });
  try {
    await assert.rejects(() => pool.createMatch({ id: 'bad-payload-match', gameModuleUrl: GRID_DUEL_URL, gameExportName: 'gridDuel', players: ['A', 'B'], options: { cb: () => {} } }));
    assert.equal(pool.pending[0].size, 0, 'the pending RPC map entry must be cleaned up immediately, not orphaned');
    // The worker itself, and its ability to host OTHER real matches, must be completely unaffected.
    const real = await pool.createMatch({ id: 'real-match-after-bad-payload', gameModuleUrl: GRID_DUEL_URL, gameExportName: 'gridDuel', players: ['A', 'B'] });
    assert.equal(real.ok, true);
  } finally {
    await pool.close();
  }
});
