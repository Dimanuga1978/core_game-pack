// Generic step-navigation controller for an onboarding/tutorial overlay
// -- next/prev/skip, current-step callback, completion callback. No
// opinion on step CONTENT (title/body text, visual demo scene) at all;
// that's supplied by the caller (e.g. games/last-sector/tutorial.mjs's
// `LastSectorTutorialDemo` drives the actual hex-board simulation shown
// alongside this overlay -- this class only tracks "which step are we
// on" and calls back when it changes).
export class OnboardingRuntime {
  constructor({ steps = [], onStep, onComplete } = {}) {
    this.steps = Array.isArray(steps) ? steps : [];
    this.index = 0;
    this.onStep = typeof onStep === 'function' ? onStep : () => {};
    this.onComplete = typeof onComplete === 'function' ? onComplete : () => {};
    this._completed = false;
  }

  start() {
    this._completed = false;
    this.index = 0;
    if (this.steps.length) this._emit();
    else this.complete();
  }

  next() {
    if (this._completed) return;
    if (this.index < this.steps.length - 1) { this.index++; this._emit(); }
    else this.complete();
  }

  prev() {
    if (this._completed || this.index <= 0) return;
    this.index--;
    this._emit();
  }

  skip() { this.complete(); }

  complete() {
    if (this._completed) return;
    this._completed = true;
    this.onComplete();
  }

  get currentStep() { return this.steps[this.index] ?? null; }
  get isComplete() { return this._completed; }

  _emit() { this.onStep(this.steps[this.index], this.index, this.steps.length); }
}
