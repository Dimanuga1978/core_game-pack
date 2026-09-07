// Game-agnostic: consumes the exact descriptor shapes a game's own
// presentation module produces (see e.g. games/last-sector/src/
// presentation.js's createLastSectorFx()) -- no game-specific logic here
// at all, just three real descriptor SHAPES this runtime knows how to
// render, using the standard Web Animations API:
//
//   1. Keyframe-based: {className, duration, style, keyframes} -- a
//      single positioned node (via `style`'s CSS custom properties, see
//      resolvePoint below), animated directly via the given keyframes.
//      Used by combat/teleport/scan/discovery/trap/destroyed.
//
//   2. From/to tween: {className, duration, nodeFactory, from, to,
//      startOpacity, peakOpacity, startScale, endScale, style} -- no
//      explicit keyframes; this runtime builds a 3-keyframe fade/move
//      tween itself (start -> mid(peak) -> end) between two resolved
//      points. Used by move/projectile.
//
//   3. Path-based: {path: [coord, coord, ...]} -- highlights a sequence
//      of BOARD CELLS directly (not a floating node) by toggling CSS
//      classes on the real cell elements for the coordinates in `path`,
//      matching the `.cell.route-active`/`.cell.route-end` classes/
//      keyframes a game's own stylesheet already defines (see e.g.
//      games/last-sector/tv-ui/style.css's `ls-route-pulse`/
//      `ls-route-end` @keyframes) -- this runtime does not invent new
//      visual design, it drives whatever classes/animations the game's
//      CSS already ships.
//
// `resolvePoint(coord)` is supplied by the caller (see tv-ui/main.js) --
// this runtime has no opinion on how a game coordinate maps to screen
// position; the caller decides (in practice: reading the real, already-
// rendered DOM cell's bounding box, so this works correctly regardless
// of board size/layout without this runtime hardcoding any grid math).
export class FxRuntime {
  constructor({ container, resolvePoint, getCellElement } = {}) {
    if (!container) throw new TypeError('FxRuntime requires a container element to render effects into');
    this.container = container;
    this.resolvePoint = typeof resolvePoint === 'function' ? resolvePoint : (() => ({ x: 50, y: 50 }));
    this.getCellElement = typeof getCellElement === 'function' ? getCellElement : (() => null);
  }

  /**
   * Plays one descriptor. Returns `{ promise, cancel }`: `promise`
   * resolves once the animation (or its timeout fallback) finishes and
   * the node is removed; `cancel()` stops it IMMEDIATELY (cancels the
   * underlying WAAPI animation / clears the pending timeout, removes the
   * node right away) and resolves the same promise early. This shape --
   * not a bare Promise -- is what makes real interruption possible:
   * PresentationSequenceRuntime needs to be able to actually stop a
   * currently-playing effect the instant a higher-priority one
   * preempts it, not just stop WAITING for it while it keeps animating
   * underneath. Never rejects -- a malformed/unsupported descriptor
   * resolves immediately with a no-op cancel.
   */
  play(descriptor) {
    if (!descriptor) return { promise: Promise.resolve(), cancel() {} };
    if (Array.isArray(descriptor.path)) return this._playPath(descriptor);
    if (descriptor.from && descriptor.to) return this._playTween(descriptor);
    if (Array.isArray(descriptor.keyframes) && descriptor.keyframes.length) return this._playKeyframes(descriptor);
    return { promise: Promise.resolve(), cancel() {} };
  }

  _applyStyle(node, style) {
    if (!style) return;
    for (const [key, value] of Object.entries(style)) node.style.setProperty(key, String(value));
  }

  _makeNode(descriptor) {
    const doc = this.container.ownerDocument ?? (typeof document !== 'undefined' ? document : null);
    const node = typeof descriptor.nodeFactory === 'function' ? descriptor.nodeFactory(doc) : doc.createElement('div');
    if (descriptor.className) for (const cls of String(descriptor.className).split(' ').filter(Boolean)) node.classList.add(cls);
    this._applyStyle(node, descriptor.style);
    return node;
  }

  /** Shared animate-a-node-then-remove-it machinery for both the keyframe and from/to-tween cases -- identical lifecycle, only the keyframes differ. */
  _animateNode(node, keyframes, duration, easing) {
    this.container.appendChild(node);
    let cancelled = false;
    let settle;
    const promise = new Promise(resolve => { settle = resolve; });
    const cleanup = () => { if (cancelled) return; cancelled = true; node.remove(); settle(); };
    if (typeof node.animate === 'function') {
      const anim = node.animate(keyframes, { duration: duration ?? 400, easing: easing ?? 'ease', fill: 'forwards' });
      anim.onfinish = cleanup;
      anim.oncancel = cleanup;
      return { promise, cancel: () => { anim.cancel?.(); cleanup(); } };
    }
    const timer = setTimeout(cleanup, duration ?? 400);
    return { promise, cancel: () => { clearTimeout(timer); cleanup(); } };
  }

  _playKeyframes(descriptor) {
    const node = this._makeNode(descriptor);
    return this._animateNode(node, descriptor.keyframes, descriptor.duration, descriptor.easing);
  }

  _playTween(descriptor) {
    const node = this._makeNode(descriptor);
    const from = this.resolvePoint(descriptor.from);
    const to = this.resolvePoint(descriptor.to);
    const startOpacity = descriptor.startOpacity ?? 0;
    const peakOpacity = descriptor.peakOpacity ?? 1;
    const startScale = descriptor.startScale ?? 0.6;
    const endScale = descriptor.endScale ?? 1;
    const keyframes = [
      { offset: 0, opacity: startOpacity, transform: `translate(${from.x}%, ${from.y}%) scale(${startScale})` },
      { offset: 0.5, opacity: peakOpacity, transform: `translate(${(from.x + to.x) / 2}%, ${(from.y + to.y) / 2}%) scale(1)` },
      { offset: 1, opacity: 0, transform: `translate(${to.x}%, ${to.y}%) scale(${endScale})` },
    ];
    return this._animateNode(node, keyframes, descriptor.duration, descriptor.easing);
  }

  _playPath(descriptor) {
    const cells = descriptor.path.map(coord => this.getCellElement(coord)).filter(Boolean);
    if (!cells.length) return { promise: Promise.resolve(), cancel() {} };
    for (const cell of cells) cell.classList.add('route-active');
    const last = cells[cells.length - 1];
    last.classList.add('route-end');
    const duration = descriptor.duration ?? 720;
    let cancelled = false;
    let settle;
    const promise = new Promise(resolve => { settle = resolve; });
    const cleanup = () => {
      if (cancelled) return;
      cancelled = true;
      for (const cell of cells) cell.classList.remove('route-active');
      last.classList.remove('route-end');
      settle();
    };
    const timer = setTimeout(cleanup, duration);
    return { promise, cancel: () => { clearTimeout(timer); cleanup(); } };
  }
}
