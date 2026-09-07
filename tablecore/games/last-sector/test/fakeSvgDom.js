// A hand-built fake DOM/SVG element, purpose-built for hex-board.mjs's
// tests -- enough surface (dataset, classList, append/appendChild/
// replaceChildren, setAttribute/getAttribute) to verify REAL STRUCTURE
// (how many tile groups exist, what a polygon's `points` attribute
// actually is, correct parent/child nesting) without a real browser.
// This can't verify anything VISUAL (does it render correctly on
// screen) -- only that the DOM-construction logic produces the right
// tree shape and attribute values a real browser would then paint.
function createFakeElement(tagName) {
  const el = {
    tagName,
    _attrs: {},
    setAttribute(key, value) { this._attrs[key] = String(value); },
    getAttribute(key) { return Object.prototype.hasOwnProperty.call(this._attrs, key) ? this._attrs[key] : null; },
    classList: {
      _set: new Set(),
      add(...names) { for (const n of names) if (n) this._set.add(n); },
      remove(...names) { for (const n of names) this._set.delete(n); },
      contains(name) { return this._set.has(name); },
      toggle(name, on) { const next = on === undefined ? !this._set.has(name) : on; if (next) this._set.add(name); else this._set.delete(name); return next; },
    },
    dataset: {},
    // A real Proxy, not a plain object -- so BOTH direct property
    // assignment (el.style.color = 'red', what hex-board.mjs's own
    // colorForOwner() usage actually does) AND setProperty() calls are
    // observable by tests. A plain `{ _props: {} }` object with only a
    // setProperty() method (this file's own earlier version) silently
    // failed to capture direct assignments at all -- found via a real
    // test that assigned style.color directly and then couldn't observe
    // it, even though the real browser-equivalent assignment works fine.
    style: new Proxy({ _props: {} }, {
      set(target, prop, value) { if (prop === '_props') { target._props = value; return true; } target._props[prop] = value; return true; },
      get(target, prop) {
        if (prop === '_props') return target._props;
        if (prop === 'setProperty') return (key, value) => { target._props[key] = value; };
        if (prop === 'getPropertyValue') return (key) => target._props[key] ?? '';
        return target._props[prop];
      },
    }),
    hidden: false,
    children: [],
    parentNode: null,
    appendChild(child) { this.children.push(child); child.parentNode = this; return child; },
    append(...items) { for (const c of items) this.appendChild(c); },
    replaceChildren(...items) { for (const c of this.children.slice()) c.parentNode = null; this.children = []; for (const c of items) this.appendChild(c); },
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(c => c !== this); this.parentNode = null; },
  };
  return el;
}

export function createFakeSvgDocument() {
  return {
    createElement: (tag) => createFakeElement(tag),
    createElementNS: (_ns, tag) => createFakeElement(tag),
  };
}
