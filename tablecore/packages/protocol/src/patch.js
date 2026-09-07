// --- Viewer-specific PATCH delivery (P2-PATCH) --------------------------
//
// A UPDATE message has always carried the full, freshly re-projected
// snapshot on every single action, even when only a tiny part of it
// changed -- proportional to snapshot size, not to what actually changed,
// on every broadcast to every subscriber.
//
// The tempting shortcut is to reuse the Immer patches `runAction.js`'s
// draft-based path could produce "for free" via `produceWithPatches()`.
// That would be a privacy bug, not just an implementation detail: those
// patches describe changes to the RAW AUTHORITATIVE state, before
// getPlayerView()/event-audience projection ever runs. A patch computed
// that way could describe, say, an opponent's hand changing -- exactly
// the information those mechanisms exist to hide -- and hand it to a
// viewer who was never supposed to see it, on a code path that never
// goes anywhere near the actual privacy boundary.
//
// This diffs two ALREADY-PROJECTED, viewer-scoped snapshots instead --
// the same `getPlayerView()` output that already goes into a full
// snapshot today. The patch inherits exactly the same privacy guarantee
// the full snapshot already had, because it is computed FROM that
// snapshot, after projection, never from raw state. See patch.test.js's
// "patches never contain data the projected snapshot didn't already
// contain" test for this proven directly, not just asserted.
//
// Deliberately NOT using Immer's `produceWithPatches` at all here, for
// exactly that reason -- this operates on two independent PLAIN objects
// (the previous and current projected snapshot), which is a generic
// diffing problem, not a draft-mutation-tracking one.

function jsonPointerEscape(key) { return String(key).replace(/~/g, '~0').replace(/\//g, '~1'); }
function jsonPointerUnescape(token) { return token.replace(/~1/g, '/').replace(/~0/g, '~'); }

function clone(v) { return v === undefined ? v : structuredClone(v); }

/**
 * Structural diff between two JSON-compatible values, as an array of
 * RFC 6902-style operations (`{op:'add'|'remove'|'replace', path, value?}`,
 * JSON Pointer paths). Favors correctness over minimality: an array whose
 * LENGTH changed is emitted as a single whole-array `replace` rather than
 * per-index add/remove ops, specifically to avoid the classic bug where
 * sequential index-based removes shift later indices out from under
 * themselves when applied in order. Same-length arrays are diffed
 * element-wise.
 */
export function diffValues(oldValue, newValue, path = '') {
  if (oldValue === newValue) return [];
  const oldIsObj = oldValue !== null && typeof oldValue === 'object';
  const newIsObj = newValue !== null && typeof newValue === 'object';
  if (!oldIsObj || !newIsObj || Array.isArray(oldValue) !== Array.isArray(newValue)) {
    return [{ op: 'replace', path: path || '', value: clone(newValue) }];
  }
  if (Array.isArray(newValue)) {
    if (oldValue.length !== newValue.length) return [{ op: 'replace', path: path || '', value: clone(newValue) }];
    const ops = [];
    for (let i = 0; i < newValue.length; i++) ops.push(...diffValues(oldValue[i], newValue[i], `${path}/${i}`));
    return ops;
  }
  const ops = [];
  for (const key of Object.keys(oldValue)) {
    if (!Object.prototype.hasOwnProperty.call(newValue, key)) ops.push({ op: 'remove', path: `${path}/${jsonPointerEscape(key)}` });
  }
  for (const key of Object.keys(newValue)) {
    const childPath = `${path}/${jsonPointerEscape(key)}`;
    if (!Object.prototype.hasOwnProperty.call(oldValue, key)) ops.push({ op: 'add', path: childPath, value: clone(newValue[key]) });
    else ops.push(...diffValues(oldValue[key], newValue[key], childPath));
  }
  return ops;
}

/** Applies a `diffValues()`-produced patch to `value`, reconstructing the diffed-against `newValue`. Does not mutate `value`. */
export function applyPatch(value, patch) {
  let result = clone(value);
  for (const op of patch) {
    const segments = op.path === '' ? [] : op.path.split('/').slice(1).map(jsonPointerUnescape);
    if (segments.length === 0) { result = op.op === 'remove' ? undefined : clone(op.value); continue; }
    let target = result;
    for (let i = 0; i < segments.length - 1; i++) target = target?.[segments[i]];
    if (target == null) continue; // path no longer exists (shouldn't happen for a patch generated against this exact base, but never throw on a malformed/stale one)
    const lastKey = segments[segments.length - 1];
    if (op.op === 'remove') delete target[lastKey];
    else target[lastKey] = clone(op.value);
  }
  return result;
}
