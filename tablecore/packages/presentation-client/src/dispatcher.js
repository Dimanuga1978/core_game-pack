// Routes an incoming presentation-stream event to either a full
// choreographed sequence (if the game's presentation module declares
// one for this event type, via `sequences`/`sequenceAliases`) or a
// single-shot FX descriptor (via `handlers`), matching the exact shape
// games/last-sector/src/presentation.js's createLastSectorPresentation()
// already produces: `{handlers, sequences, sequenceAliases}`. Contains
// no game-specific event-type names itself -- entirely driven by
// whatever the supplied `presentation` object declares.
export class PresentationDispatcher {
  constructor({ presentation, sequenceRuntime, fxRuntime } = {}) {
    this.presentation = presentation ?? {};
    this.sequenceRuntime = sequenceRuntime ?? null;
    this.fxRuntime = fxRuntime ?? null;
  }

  /** Resolves once the chosen sequence/handler has finished playing. Never rejects -- an event with no matching sequence or handler simply resolves immediately (nothing to show for it). */
  dispatch(event, ctx = {}) {
    const type = event?.type;
    if (!type) return Promise.resolve();

    const sequenceKey = this.presentation.sequenceAliases?.[type] ?? type;
    const sequenceFactory = this.presentation.sequences?.[sequenceKey];
    if (typeof sequenceFactory === 'function' && this.sequenceRuntime) {
      let spec;
      try { spec = sequenceFactory(event, ctx); } catch { return Promise.resolve(); }
      return this.sequenceRuntime.run(spec);
    }

    const handlerFactory = this.presentation.handlers?.[type] ?? this.presentation.handlers?.default;
    if (typeof handlerFactory === 'function' && this.fxRuntime) {
      let descriptor;
      try { descriptor = handlerFactory(event, ctx); } catch { return Promise.resolve(); }
      // fxRuntime.play() can throw SYNCHRONOUSLY (e.g. a descriptor's
      // nodeFactory throwing while building an SVG node -- a real case
      // found via an integration test against the actual game
      // presentation data, not hypothetical). dispatch() is not an
      // `async` function, so an uncaught synchronous throw here would
      // propagate directly to dispatch()'s own caller as a thrown
      // exception instead of the promise-rejection shape this method's
      // whole contract promises ("never rejects") -- wrapped so a single
      // bad descriptor can never crash whatever's driving this
      // dispatcher (e.g. a live TV board's event handler).
      try { return this.fxRuntime.play(descriptor).promise; } catch { return Promise.resolve(); }
    }

    return Promise.resolve();
  }
}
