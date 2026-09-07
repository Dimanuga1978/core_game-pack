'use strict';
const fs = require('node:fs');
const path = require('node:path');
const cache = new Map();
const SCENARIOS_DIR = __dirname;
// A user-controlled scenario id (this reaches here directly from
// createInitialState(options) -- and from there, directly from whatever
// a caller passes to ServerHost.createMatch()/an admin API's `options`
// field, with zero prior sanitization) used to flow straight into
// `path.join(__dirname, key + '.json')` and `fs.readFileSync`. `path.join`
// does NOT contain `..` traversal within a base directory -- that is a
// common misconception; it only NORMALIZES the path, and normalizing
// `../../../package.json` still walks outside `__dirname`. Confirmed
// directly, not theoretically: `{scenario: '../../../package'}` reads
// this repo's own root `package.json` and its contents end up inside the
// returned game state -- a real, severe arbitrary-file-read vulnerability
// reachable by anyone able to create a match with custom options (which,
// before this audit, included anyone who could reach the reference admin
// API at all). Fixed with the same two-part discipline used elsewhere in
// this project for exactly this class of bug (see tools/launcher/
// server.mjs's safePath()): (1) a strict allowlist format for the id
// itself (no dots, slashes, or anything but a short identifier), and (2)
// a real containment check on the resolved path as defense in depth,
// so even if the format check were ever loosened by a future edit, the
// containment check alone would still stop a traversal.
const SCENARIO_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
function loadScenario(id) {
  if (!id) return null;
  const key = String(id);
  if (!SCENARIO_ID_RE.test(key)) throw Object.assign(new Error(`invalid-scenario-id:${key}`), { code:'invalid-scenario-id' });
  if (cache.has(key)) return cache.get(key);
  const file = path.join(SCENARIOS_DIR, `${key}.json`);
  const resolved = path.resolve(file);
  if (resolved !== SCENARIOS_DIR && !resolved.startsWith(SCENARIOS_DIR + path.sep)) {
    throw Object.assign(new Error(`invalid-scenario-id:${key}`), { code:'invalid-scenario-id' });
  }
  if (!fs.existsSync(resolved)) throw Object.assign(new Error(`scenario-not-found:${key}`), { code:'scenario-not-found' });
  const value = JSON.parse(fs.readFileSync(resolved,'utf8'));
  cache.set(key, Object.freeze(value));
  return value;
}
module.exports = { loadScenario };
