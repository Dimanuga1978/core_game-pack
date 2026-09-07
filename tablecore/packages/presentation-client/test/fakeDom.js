// A hand-built, minimal fake DOM element -- just enough surface
// (classList, style, appendChild/remove, animate) for the presentation
// runtimes to exercise their real CONTROL FLOW (right methods called
// with right arguments, promises resolving at the right time, correct
// ordering/priority/cancellation logic) without a real browser. This
// cannot verify anything VISUAL (does it look right) -- only that the
// logic driving a real browser would do the right thing.
export function createFakeElement() {
  const el = {
    tagName: 'div',
    classList: {
      _set: new Set(),
      add(...names) { for (const n of names) if (n) this._set.add(n); },
      remove(...names) { for (const n of names) this._set.delete(n); },
      contains(name) { return this._set.has(name); },
    },
    style: {
      _props: {},
      setProperty(key, value) { this._props[key] = value; },
    },
    _attrs: {},
    setAttribute(key, value) { this._attrs[key] = value; },
    getAttribute(key) { return this._attrs[key] ?? null; },
    children: [],
    parentNode: null,
    appendChild(child) { this.children.push(child); child.parentNode = this; return child; },
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(c => c !== this); this.parentNode = null; },
    // Simulates the Web Animations API closely enough for control-flow
    // testing: resolves onfinish after `options.duration` ms (via a real
    // setTimeout, so tests can await real elapsed time), and exposes
    // .cancel() for tests that need to verify cancellation behavior.
    animate(keyframes, options) {
      const anim = { keyframes, options, onfinish: null, oncancel: null, _timer: null, cancelled: false };
      anim._timer = setTimeout(() => { if (!anim.cancelled) anim.onfinish?.(); }, options?.duration ?? 0);
      anim.cancel = () => { anim.cancelled = true; clearTimeout(anim._timer); anim.oncancel?.(); };
      return anim;
    },
    ownerDocument: { createElement: () => createFakeElement(), createElementNS: () => createFakeElement() },
  };
  return el;
}
