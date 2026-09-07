// --- Centralized information-flow policy (state) ------------------------
//
// `getPlayerView()` remains a Game Pack-owned function -- and honestly,
// for anything involving conditional visibility (fog-of-war: "this
// player's position is visible only if this specific tile has been
// revealed"), it has to be, because that's genuine game semantics no
// generic engine mechanism can know about. What CAN be centralized is
// the common case underneath most of that: "this field is visible only
// to its owner" / "this field is always public" / "this field is never
// visible to anyone but the server". Most of a typical getPlayerView()
// implementation is exactly this pattern, hand-written imperatively over
// and over in every game pack.
//
// `projectFields()` is that centralized primitive: a declarative rule set
// a pack can apply to an object (typically one player's own state slice)
// instead of writing the same `if (id !== viewer) delete obj[field]`
// imperative code by hand. It does not replace getPlayerView() -- a pack
// still owns the function and decides how/where to apply this -- but the
// actual REDACTION DECISION for the common cases becomes an engine-
// validated declaration instead of ad hoc code, and is independently
// testable/reusable across packs.
export const FieldVisibility = Object.freeze({
  PUBLIC: 'ENGINE_FIELD_PUBLIC',       // always visible to every viewer
  OWNER_ONLY: 'ENGINE_FIELD_OWNER_ONLY', // visible only when viewer === the object's owner id
  HIDDEN: 'ENGINE_FIELD_HIDDEN',        // never visible to any viewer (server-internal only)
});

/**
 * `rules`: `{ [fieldName]: FieldVisibility.* | (value, viewer, owner) => boolean }`
 * Fields not listed in `rules` default to FieldVisibility.OWNER_ONLY --
 * fail closed, not fail open: a field a pack forgot to classify is hidden
 * from everyone but its owner rather than silently exposed to everyone,
 * which is the opposite of what plain `{...obj}`/`JSON.parse(JSON.
 * stringify(obj))`-style copying does by default.
 *
 * `owner`: the id this object belongs to (e.g. a player id), or `null`
 * for objects with no single owner (public/shared state) -- OWNER_ONLY
 * fields on an ownerless object are never visible to anyone.
 */
export function projectFields(obj, viewer, owner, rules = {}) {
  if (obj == null || typeof obj !== 'object') return obj;
  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    const rule = Object.prototype.hasOwnProperty.call(rules, key) ? rules[key] : FieldVisibility.OWNER_ONLY;
    let visible;
    if (typeof rule === 'function') visible = !!rule(value, viewer, owner);
    else if (rule === FieldVisibility.PUBLIC) visible = true;
    else if (rule === FieldVisibility.HIDDEN) visible = false;
    else visible = owner != null && viewer != null && viewer === owner; // OWNER_ONLY, including an unrecognized rule value -- fail closed
    if (visible) out[key] = value;
  }
  return out;
}

/**
 * Convenience for the extremely common shape "a map of playerId -> that
 * player's own state slice, where each slice should be field-projected
 * per the SAME rules, owner being the map key". This is precisely what
 * several games' own `getPlayerView()` implementations hand-write today
 * -- offered here as the reusable primitive their imperative code could
 * be (but is not required to be) rewritten in terms of.
 */
export function projectPlayerMap(playersById, viewer, rules = {}) {
  if (playersById == null || typeof playersById !== 'object') return playersById;
  const out = {};
  for (const [id, playerState] of Object.entries(playersById)) out[id] = projectFields(playerState, viewer, id, rules);
  return out;
}
