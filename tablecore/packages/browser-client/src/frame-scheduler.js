// Debounces render work to at most once per animation frame. Falls back
// to setTimeout when requestAnimationFrame isn't available (Node test
// environments, which have no DOM) -- this is what makes the rest of
// this client library's LOGIC (not the DOM-manipulating parts of
// player-ui/main.js itself, which genuinely do need a real browser)
// directly unit-testable without a browser or a headless-DOM dependency.
const raf = typeof globalThis.requestAnimationFrame === 'function'
  ? (cb) => globalThis.requestAnimationFrame(cb)
  : (cb) => setTimeout(cb, 16);
const cancelRaf = typeof globalThis.cancelAnimationFrame === 'function'
  ? (id) => globalThis.cancelAnimationFrame(id)
  : (id) => clearTimeout(id);

export class FrameScheduler {
  constructor(callback) {
    this.callback = callback;
    this._handle = null;
  }
  schedule() {
    if (this._handle != null) return; // already pending -- coalesce
    this._handle = raf(() => { this._handle = null; this.callback(); });
  }
  cancelPending() {
    if (this._handle == null) return;
    cancelRaf(this._handle);
    this._handle = null;
  }
}
