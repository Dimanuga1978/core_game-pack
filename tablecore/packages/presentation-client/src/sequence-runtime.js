// Orchestrates named "lanes" of cinematic sequences (matching the shape
// games/last-sector/src/presentation.js's `sequences` produce: `{key,
// lane, priority, replace, steps}`), each lane processing its own queue
// of steps SEQUENTIALLY, while DIFFERENT lanes run fully in parallel
// (e.g. a 'ship' lane's move animation and a 'combat' lane's explosion
// can play at the same time without blocking each other -- exactly what
// "lanes" exist to allow).
//
// Priority/replace semantics (a real design decision made here, not
// specified in more detail by the underlying game data than `priority`/
// `replace` fields existing): a higher-`priority` sequence for the same
// lane can INTERRUPT one that's currently mid-playback if the new one
// declares `replace:true` AND its priority is >= the running one's --
// a low-priority sequence (e.g. a routine SCAN_RESOLVED pulse) must
// never be able to cut off a high-priority one (e.g. a PLAYER_SHIP_
// DESTROYED sequence) just because it happened to arrive with
// replace:true. Queued (not-yet-running) sequences for a lane are kept
// sorted by priority (higher first), not plain arrival order -- so if
// several presentation events for the same lane arrive in a burst (real
// possibility: several bot moves in a row, each broadcasting its own
// SHIP_MOVED sequence), the most important one plays next regardless of
// exact arrival order.
export class PresentationSequenceRuntime {
  constructor({ fxRuntime, camera } = {}) {
    this.fxRuntime = fxRuntime ?? null;
    this.camera = camera ?? null;
    this.lanes = new Map(); // laneName -> { current: {cancelled, priority}|null, queue: [{spec, resolve}] }
  }

  _laneState(lane) {
    let state = this.lanes.get(lane);
    if (!state) { state = { current: null, queue: [] }; this.lanes.set(lane, state); }
    return state;
  }

  /**
   * Queues (or immediately runs, if the lane is idle) one sequence spec.
   * Resolves once that specific sequence has finished playing (or been
   * cancelled by a higher-or-equal-priority replace).
   */
  run(spec) {
    if (!spec || !Array.isArray(spec.steps)) return Promise.resolve();
    const lane = spec.lane || 'default';
    const priority = spec.priority ?? 0;
    const state = this._laneState(lane);

    return new Promise(resolve => {
      if (spec.replace && state.current && priority >= state.current.priority) {
        state.current.cancelled = true;
        // Actually stop whatever effect is playing RIGHT NOW, not just
        // stop the step loop from proceeding to its next step -- without
        // this, an in-flight fx.play() (e.g. a long WAAPI animation)
        // would keep running to its own natural completion underneath
        // the new, supposedly-replacing sequence, which defeats the
        // whole point of `replace`. See fx-runtime.js's own module doc
        // comment for why play() returns {promise, cancel} instead of a
        // bare Promise -- this is exactly what that shape is for.
        state.current.currentCancel?.();
        // `replace` on this NEW spec also clears whatever was already
        // queued behind the interrupted one -- it supersedes the whole
        // pending burst for this lane, not just the one in flight.
        for (const queued of state.queue) queued.resolve();
        state.queue.length = 0;
      }
      state.queue.push({ spec, priority, resolve });
      state.queue.sort((a, b) => b.priority - a.priority);
      this._pump(lane);
    });
  }

  async _pump(lane) {
    const state = this._laneState(lane);
    if (state.current) return; // already running something in this lane -- it will call _pump again when it finishes
    const next = state.queue.shift();
    if (!next) return;
    const token = { cancelled: false, priority: next.priority, currentCancel: null };
    state.current = token;
    try {
      await this._runSteps(next.spec.steps, token);
    } catch (error) {
      // A throwing nodeFactory/descriptor/camera call (found via a real
      // integration test against the actual game presentation data, not
      // a hypothetical: an SVG-building nodeFactory calling
      // document.createElementNS threw when driven by an incomplete
      // test DOM stub) used to propagate out of this async function as
      // an UNHANDLED REJECTION -- `_pump()` is called fire-and-forget
      // (`this._pump(lane)` below and in run(), neither awaited nor
      // .catch()-ed), so nothing upstream was ever positioned to catch
      // it. One bad presentation event should never be able to crash or
      // warn-spam a real TV board; it now just logs and the lane
      // recovers to process whatever's queued next.
      console.error('[presentation-client] a step in this lane threw and was skipped:', error);
    } finally {
      state.current = null;
      next.resolve();
      this._pump(lane);
    }
  }

  async _runSteps(steps, token) {
    for (const step of steps) {
      if (token.cancelled) return;
      if (step?.camera && this.camera) {
        if (step.camera.choreograph) await this.camera.choreograph(step.camera.shots);
        else if (step.camera.reset) await this.camera.reset(step.camera.options);
      }
      if (token.cancelled) return;
      if (step?.descriptor && this.fxRuntime) {
        const handle = this.fxRuntime.play(step.descriptor);
        token.currentCancel = handle.cancel ?? null;
        await handle.promise;
        token.currentCancel = null;
      }
      if (token.cancelled) return;
      if (step?.hold) await new Promise(resolve => setTimeout(resolve, step.hold));
    }
  }
}
