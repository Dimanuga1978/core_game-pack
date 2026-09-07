import { Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const WORKER_SCRIPT = fileURLToPath(new URL('./worker.js', import.meta.url));

function hashToIndex(matchId, poolSize) {
  const digest = createHash('sha256').update(String(matchId)).digest();
  // Deterministic, evenly-distributed routing from an arbitrary-length
  // hash to [0, poolSize) -- consistent for the lifetime of a given
  // matchId, which is exactly what "one match, one consistent worker for
  // its entire lifetime" (sequential action ordering within a match)
  // requires. Not cryptographic; this is routing, not security.
  return digest.readUInt32BE(0) % poolSize;
}

/**
 * Routes matches across a fixed-size pool of worker_threads, each hosting
 * its own subset of matches (see worker.js). `hash(matchId) -> worker`
 * affinity keeps one match's actions strictly ordered (always the same
 * worker, so always processed in the order they arrive) while unrelated
 * matches on different workers run fully independently -- including
 * surviving each other's crashes. See worker.js's header comment for the
 * concrete crash this exists to contain.
 *
 * --- Resource limits: real, honest scope ---------------------------
 *
 * `resourceLimits` (memory) and `rpcTimeoutMs` (CPU runaway) below are
 * REAL, load-bearing controls -- not decorative. `resourceLimits` maps
 * directly to `worker_threads`'s own `resourceLimits` option, enforced by
 * V8 itself: a worker whose heap exceeds `maxOldGenerationSizeMb` is
 * killed by the engine, not by anything this code has to detect.
 * `rpcTimeoutMs` is this pool's own CPU watchdog: if a worker's synchronous
 * rule code runs so long that it never gets back to its message loop to
 * respond, the pool treats that as equivalent to a crash (terminate,
 * mark affected matches lost, respawn) rather than hanging every caller
 * of that worker forever.
 *
 * What this does NOT provide, on purpose, stated plainly rather than
 * implied: filesystem access, network access, environment variable
 * access, and `require`/`import` of arbitrary Node built-ins are all
 * completely unrestricted inside a worker -- `worker_threads` shares the
 * same process-wide capabilities as the main thread by default, and
 * Node's own `vm` module documentation explicitly states it "is not a
 * security mechanism" and must not be used to run untrusted code, so
 * this deliberately does not pretend to wrap pack code in one. Real
 * capability restriction (no fs/network/env access unless explicitly
 * granted) needs OS-level process isolation -- a child process running
 * with reduced OS privileges, a container, or a WASM sandbox -- which is
 * a genuinely different, larger engineering effort than what a
 * worker_thread can provide, and is explicitly out of scope here. A
 * signed pack, or a pack run through this pool, is process-crash-isolated
 * and resource-bounded; it is still not safe to treat as untrusted code
 * with malicious intent behind it. See PACK_SECURITY-equivalent notes
 * elsewhere in this repo for the same distinction applied to signatures.
 */
export class MatchWorkerPool {
  constructor({ poolSize = 4, resourceLimits = null, rpcTimeoutMs = null } = {}) {
    if (!Number.isInteger(poolSize) || poolSize < 1) throw new TypeError('poolSize must be a positive integer');
    this.poolSize = poolSize;
    this.resourceLimits = resourceLimits;
    this.rpcTimeoutMs = rpcTimeoutMs;
    this.workers = new Array(poolSize).fill(null);
    this.pending = new Array(poolSize).fill(null).map(() => new Map()); // per-worker: rpc id -> {resolve,reject,timer}
    this.nextRpcId = 0;
    // matchId -> worker index, so a match keeps affinity even if the pool
    // is resized in a future version; today this is derived fresh from
    // hashToIndex() each call since poolSize is fixed for the pool's
    // lifetime, but kept as an explicit map (not recomputed inline
    // everywhere) so a crashed-and-respawned worker can still be found
    // for matches that were routed to it.
    this.matchWorker = new Map();
    this.crashedMatches = new Set(); // matchId -> set for matches lost to a worker crash, surfaced via wasLostToCrash()
    this.lossReason = new Map(); // matchId -> 'crash' | 'memory-limit' | 'cpu-timeout'
    for (let i = 0; i < poolSize; i++) this._spawnWorker(i);
  }

  _spawnWorker(index) {
    const worker = new Worker(WORKER_SCRIPT, this.resourceLimits ? { resourceLimits: this.resourceLimits } : undefined);
    this.workers[index] = worker;
    worker.on('message', message => {
      const waiter = this.pending[index].get(message.id);
      if (!waiter) return;
      if (waiter.timer) clearTimeout(waiter.timer);
      this.pending[index].delete(message.id);
      waiter.resolve(message);
    });
    worker.on('error', error => {
      // This is the actual isolation boundary: an uncaught exception
      // inside the worker (including a DEFERRED one, like the time-bomb
      // setTimeout pattern -- see worker.js's header comment), OR the
      // worker being killed by V8 for exceeding `resourceLimits` (memory),
      // surfaces here as an 'error' event, not as an exception in THIS
      // (main) thread. Node terminates the worker after this fires. Every
      // in-flight RPC to this worker is rejected (never left hanging),
      // every match that was hosted on this worker is marked lost (no
      // persistence layer exists to recover its state -- see the
      // "Known limitation" note in the class doc comment below), and a
      // fresh replacement worker is spawned so this pool slot keeps
      // serving whatever NEW matches hash to it. The main process, and
      // every match on every OTHER worker, are completely unaffected --
      // this is the property under test in MatchWorkerPool.test.js.
      this._retireWorker(index, 'crash', error);
    });
  }

  _retireWorker(index, reason, error) {
    for (const matchId of this.matchWorker.keys()) {
      if (this.matchWorker.get(matchId) === index) { this.crashedMatches.add(matchId); this.lossReason.set(matchId, reason); this.matchWorker.delete(matchId); }
    }
    for (const waiter of this.pending[index].values()) {
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.reject(new Error(`worker ${index} retired (${reason}): ${error?.message ?? error ?? ''}`));
    }
    this.pending[index].clear();
    try { this.workers[index].terminate(); } catch {}
    if (!this._closing) this._spawnWorker(index);
  }

  _rpc(index, type, payload) {
    return new Promise((resolve, reject) => {
      const id = this.nextRpcId++;
      // CPU watchdog: if `rpcTimeoutMs` is set and the worker never gets
      // back to its message loop in time to respond -- the signature of a
      // runaway synchronous loop in rule code, which nothing can
      // preemptively interrupt from outside short of terminating the
      // thread -- treat it exactly like a crash: retire the worker,
      // reject every other in-flight call to it, mark its matches lost,
      // respawn. Without this, one pack's infinite loop would silently
      // hang every future call to that worker forever, with no crash
      // event to react to.
      let timer = null;
      if (this.rpcTimeoutMs) {
        timer = setTimeout(() => {
          // Do NOT delete this waiter from `this.pending[index]` here:
          // `_retireWorker` below rejects and clears every waiter still
          // in that map, INCLUDING this one -- deleting it first was the
          // actual bug this comment replaces (found by hand while this
          // exact test hung indefinitely instead of rejecting): the one
          // RPC whose timeout just fired got silently excluded from its
          // own rejection loop, so its promise was never settled at all
          // and `await` on it hung forever, even though the worker really
          // was retired correctly. Let `_retireWorker` own the full
          // cleanup of this map.
          this._retireWorker(index, 'cpu-timeout', new Error(`no response within ${this.rpcTimeoutMs}ms`));
        }, this.rpcTimeoutMs);
        timer.unref?.();
      }
      this.pending[index].set(id, { resolve, reject, timer });
      // Found via a manual code review, not a failing test:
      // postMessage() throws SYNCHRONOUSLY for a payload
      // structuredClone/the postMessage transfer algorithm cannot
      // handle (a function, a Symbol -- confirmed directly, not
      // assumed) -- and a synchronous throw inside this Promise
      // executor DOES correctly reject the promise this method
      // returns (JS's own Promise constructor auto-rejects on an
      // executor throw), but that happens via the CONSTRUCTOR's own
      // internal mechanism, entirely bypassing the explicit `reject`
      // captured above -- meaning the `pending[index]` entry just set
      // is never looked up (the worker never received this message,
      // so it can never reply with this id) and never cleaned up.
      // Confirmed directly: `pending[index].size` was 1, permanently,
      // after exactly this scenario, before this fix. Without
      // `rpcTimeoutMs` configured, this leaks unboundedly on repeated
      // bad calls; WITH it configured, the leaked entry eventually
      // fires the CPU-timeout watchdog and retires the entire worker
      // over one caller's bad payload, needlessly losing every OTHER
      // match hosted there too. Caught here instead, cleaning up
      // immediately and rejecting directly -- this worker and its
      // other matches are completely unaffected by one caller's
      // unserializable payload.
      try {
        this.workers[index].postMessage({ id, type, payload });
      } catch (error) {
        if (timer) clearTimeout(timer);
        this.pending[index].delete(id);
        reject(error);
      }
    });
  }

  _indexFor(matchId) {
    return this.matchWorker.get(matchId) ?? hashToIndex(matchId, this.poolSize);
  }

  /** True if this matchId's worker crashed and its (in-memory-only) state was lost. See the class doc comment's "Known limitation". */
  wasLostToCrash(matchId) { return this.crashedMatches.has(matchId); }

  /** 'crash' | 'memory-limit' | 'cpu-timeout' | undefined -- the reason a match was lost, when known. `resourceLimits`-driven memory kills surface as 'crash' via V8's own uncaught-exception-equivalent worker termination (Node does not distinguish the two at the 'error' event level), so this is best-effort classification, not a hard guarantee of which of the two occurred. */
  lossReasonFor(matchId) { return this.lossReason.get(matchId); }

  async createMatch({ id, gameModuleUrl, gameExportName = null, players, options, spectatorPolicy }) {
    const index = hashToIndex(id, this.poolSize);
    const result = await this._rpc(index, 'CREATE_MATCH', { matchId: id, gameModuleUrl, gameExportName, players, options, spectatorPolicy });
    if (result.ok) this.matchWorker.set(id, index);
    return result;
  }

  async startMatch({ matchId, actor }) {
    const index = this._indexFor(matchId);
    return this._rpc(index, 'START_MATCH', { matchId, actor });
  }

  async getSnapshot(matchId, viewer = null) {
    const index = this._indexFor(matchId);
    return this._rpc(index, 'GET_SNAPSHOT', { matchId, viewer });
  }

  async submitAction({ matchId, connectionPlayerId, actor, expectedVersion, action }) {
    const index = this._indexFor(matchId);
    return this._rpc(index, 'SUBMIT_ACTION', { matchId, connectionPlayerId, actor, expectedVersion, action });
  }

  async abortMatch({ matchId, reason }) {
    const index = this._indexFor(matchId);
    return this._rpc(index, 'ABORT_MATCH', { matchId, reason });
  }

  /** Raw, unprojected authoritative state -- see worker.js's own GET_AUTHORITATIVE_STATE comment for exactly why this exists (this engine's bot driver needs it directly, bypassing per-viewer projection). Matches ServerHost.getAuthoritativeState()'s own {ok, state, version} shape exactly. */
  async getAuthoritativeState(matchId) {
    const index = this._indexFor(matchId);
    return this._rpc(index, 'GET_AUTHORITATIVE_STATE', { matchId });
  }

  async close() {
    this._closing = true;
    await Promise.all(this.workers.map(w => w?.terminate()));
  }
}

// Known limitation (documented rather than silently glossed over): this
// pool provides PROCESS/THREAD isolation, not state durability. There is
// no persistence/checkpoint layer anywhere in this engine (see the
// external remediation request's own P1-MATCH failure-model requirement:
// "restored from a checkpoint; terminated and reported; replayed from a
// deterministic action log; rescheduled" -- this implementation is the
// "terminated and reported" case only). A crashed worker's matches are
// gone; `wasLostToCrash(matchId)` lets a caller detect and report that,
// not recover it. Adding checkpoint/replay-based recovery is future work
// building on top of this, not something this change silently promises.
