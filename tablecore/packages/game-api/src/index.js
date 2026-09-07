/** Contract documentation package: a GameDefinition exposes createInitialState, getLegalActions, applyAction, getGameStatus. */
export const GAME_API_VERSION = '2.0.0-alpha.1';

// --- Real engineCompatibility checking --------------------------------
//
// A pack's manifest can declare `engineCompatibility: ">=2.0.0-alpha.1
// <3.0.0"` -- but until now, nothing anywhere in the engine ever actually
// read or checked this field against anything. It looked exactly like a
// real compatibility guarantee (a pack author declaring "I was written
// against this range of the game-authoring contract") while being pure
// decoration -- the same class of "field exists, nobody reads it" gap
// already found and fixed twice in this codebase (replay.gameVersion,
// pack-linter's authoring==null handling). Notably, an EARLIER version
// of this engine (before the v2 rewrite) had a real, working
// `compatible(range, engineVersion)` semver-range checker in its
// pack-host.js; it was dropped somewhere in the rewrite, leaving only
// the manifest field's shape behind.
//
// `engineCompatibility` is checked against `GAME_API_VERSION` (this
// file's own constant), not against a raw engine build string -- that is
// the actual semver-shaped contract a pack is written against (the
// createInitialState/getLegalActions/applyAction/getGameStatus shape
// this file documents), which is what "engine compatibility" means in
// practice: matches how a shipped manifest's own engineCompatibility
// value (e.g. ">=2.0.0-alpha.1 <3.0.0") was clearly always meant to be
// compared against this constant.
function parseSemver(value) {
  const m = String(value ?? '').trim().match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], prerelease: m[4] ?? null };
}

// -1 / 0 / 1, per semver precedence rules (a version WITHOUT a
// prerelease tag is greater than the same major.minor.patch WITH one;
// prerelease identifiers compare numerically when both sides are
// numeric, lexically otherwise).
function compareSemver(a, b) {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  if (a.prerelease == null && b.prerelease == null) return 0;
  if (a.prerelease == null) return 1;
  if (b.prerelease == null) return -1;
  const ap = a.prerelease.split('.'), bp = b.prerelease.split('.');
  const len = Math.max(ap.length, bp.length);
  for (let i = 0; i < len; i++) {
    const av = ap[i], bv = bp[i];
    if (av === undefined) return -1;
    if (bv === undefined) return 1;
    const an = Number(av), bn = Number(bv);
    const aIsNum = av !== '' && !Number.isNaN(an), bIsNum = bv !== '' && !Number.isNaN(bn);
    if (aIsNum && bIsNum) { if (an !== bn) return an < bn ? -1 : 1; }
    else if (aIsNum) return -1;
    else if (bIsNum) return 1;
    else if (av !== bv) return av < bv ? -1 : 1;
  }
  return 0;
}

/**
 * `range`: space-separated comparator clauses, ANDed together --
 * `">=2.0.0-alpha.1 <3.0.0"`, `"=1.2.3"`, a bare `"1.2.3"` (implicit
 * `=`), etc. `null`/`undefined` (no declared requirement) is always
 * compatible -- a pack that never declared a range makes no claim to
 * check.
 */
export function isEngineCompatible(range, version = GAME_API_VERSION) {
  if (range == null) return true;
  const v = parseSemver(version);
  if (!v) return false;
  const clauses = String(range).trim().split(/\s+/).filter(Boolean);
  if (!clauses.length) return true;
  for (const clause of clauses) {
    const m = clause.match(/^(>=|<=|>|<|=)?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/);
    if (!m) throw new TypeError(`Invalid engineCompatibility clause: "${clause}"`);
    const op = m[1] || '=';
    const bound = parseSemver(m[2]);
    const cmp = compareSemver(v, bound);
    const ok = op === '>=' ? cmp >= 0 : op === '<=' ? cmp <= 0 : op === '>' ? cmp > 0 : op === '<' ? cmp < 0 : cmp === 0;
    if (!ok) return false;
  }
  return true;
}
