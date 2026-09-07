// Game-agnostic camera: applies a CSS transform (translate+scale) to a
// target element based on a sequence of "shots" (`{point, scale,
// duration}`, matching the shape games/last-sector/src/presentation.js's
// sequences already produce under `steps[].camera.shots`), or resets to
// the default view. No opinion on what "point" means -- `resolvePoint`
// (same contract as fx-runtime.js's) converts a game coordinate into a
// `{x, y}` percentage position.
export class PresentationCamera {
  constructor({ target, resolvePoint } = {}) {
    if (!target) throw new TypeError('PresentationCamera requires a target element to transform');
    this.target = target;
    this.resolvePoint = typeof resolvePoint === 'function' ? resolvePoint : (() => ({ x: 50, y: 50 }));
    this._current = { x: 50, y: 50, scale: 1 };
  }

  _applyTransform(x, y, scale, durationMs) {
    this.target.style.setProperty('transition', `transform ${durationMs}ms ease`);
    // Shift the world so the target point is centered under the viewport,
    // then scale -- order matters (scale first, so the translate amount
    // isn't itself scaled).
    this.target.style.setProperty('transform', `scale(${scale}) translate(${50 - x}%, ${50 - y}%)`);
    this._current = { x, y, scale };
  }

  /** Runs a sequence of shots in order, one at a time, resolving once the last one's duration has elapsed. */
  async choreograph(shots) {
    if (!Array.isArray(shots) || !shots.length) return;
    for (const shot of shots) {
      const point = this.resolvePoint(shot.point);
      const duration = shot.duration ?? 300;
      this._applyTransform(point.x, point.y, shot.scale ?? this._current.scale, duration);
      await new Promise(resolve => setTimeout(resolve, duration));
    }
  }

  /** Returns to the default (centered, unscaled) view. */
  async reset(options = {}) {
    const duration = options.duration ?? 400;
    this._applyTransform(50, 50, 1, duration);
    await new Promise(resolve => setTimeout(resolve, duration));
  }

  get current() { return { ...this._current }; }
}
