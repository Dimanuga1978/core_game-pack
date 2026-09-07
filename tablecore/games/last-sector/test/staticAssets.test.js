import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Regression test for a real bug found by a real person testing this
// game: both player-ui/index.html and tv-ui/index.html linked a
// stylesheet (`../../../design-system/index.css`) that never existed
// anywhere in the repository -- not a cosmetic 404, either: the pages'
// OWN stylesheets define zero of the ~40 --ls-* custom properties
// (colors, typography, radius, motion, spacing) they use, so without
// that missing file both pages rendered essentially unstyled (browser
// default colors), not just "missing a nice-to-have". Fixed by moving
// the real design tokens into games/last-sector/client/design-system.css
// (the same already-public, already-allowlisted location as this game's
// other shared client assets) and pointing both pages at it.
//
// This test scans every local (relative, non-http) href/src attribute
// in every HTML file this game ships and verifies the file it points at
// genuinely exists on disk -- generically, so any future reference like
// this (a new stylesheet, script, or image link that's added but never
// actually created) fails the test suite immediately instead of only
// being discovered by someone opening the page in a real browser.
const GAME_ROOT = fileURLToPath(new URL('..', import.meta.url));
const LOCAL_REF_RE = /(?:href|src)\s*=\s*["']([^"']+)["']/g;
// The gap that let the actual bug through: staticAssets's original
// version only scanned HTML href/src attributes -- a broken reference
// living inside a CSS file's OWN `@import url(...)` (exactly what
// player-ui/style.css and tv-ui/style.css each had, pointing at a path
// that was already fixed in the HTML's <link> tag but left stale inside
// the CSS itself) was invisible to it. Real people testing this game
// saw the resulting 404 in their browser console; this test did not
// catch it because it never looked inside .css files at all.
const CSS_IMPORT_RE = /@import\s+url\(\s*["']?([^"')]+)["']?\s*\)/g;

async function findHtmlFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'test') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await findHtmlFiles(full));
    else if (entry.name.endsWith('.html')) files.push(full);
  }
  return files;
}

async function findCssFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'test') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await findCssFiles(full));
    else if (entry.name.endsWith('.css')) files.push(full);
  }
  return files;
}

function isLocalRef(ref) {
  if (!ref) return false;
  if (/^(https?:)?\/\//.test(ref)) return false; // absolute/external URL
  if (ref.startsWith('#')) return false; // in-page anchor
  if (ref.startsWith('data:')) return false; // inline data URI
  if (ref.startsWith('mailto:')) return false;
  return true;
}

async function fileExists(p) {
  try { await access(p); return true; } catch { return false; }
}

test('every local stylesheet/script/image reference in this game\'s HTML files points at a file that actually exists', async () => {
  const htmlFiles = await findHtmlFiles(GAME_ROOT);
  assert.ok(htmlFiles.length >= 3, `expected to find at least player-ui/preview/tv-ui index.html, found ${htmlFiles.length}`);

  const missing = [];
  for (const htmlFile of htmlFiles) {
    const content = await readFile(htmlFile, 'utf8');
    const htmlDir = path.dirname(htmlFile);
    for (const match of content.matchAll(LOCAL_REF_RE)) {
      const ref = match[1];
      if (!isLocalRef(ref)) continue;
      // Absolute-from-server-root paths (e.g. /engine-client/*,
      // /presentation-client/*) are resolved by the launcher, not the
      // filesystem directly -- skip those here, they're covered by the
      // launcher's own real-HTTP tests instead.
      if (ref.startsWith('/')) continue;
      const resolved = path.resolve(htmlDir, ref.split('?')[0].split('#')[0]);
      if (!(await fileExists(resolved))) {
        missing.push(`${path.relative(GAME_ROOT, htmlFile)} references "${ref}" -> ${resolved} (does not exist)`);
      }
    }
  }
  assert.deepEqual(missing, [], `broken local references found:\n${missing.join('\n')}`);
});

// Regression test for the exact gap that let the real bug through: the
// HTML-only scan above would never have caught a broken `@import
// url(...)` living INSIDE a CSS file (which is precisely what happened
// here -- both player-ui/style.css and tv-ui/style.css had one pointing
// at a path that had already been fixed in the HTML's own <link> tag,
// but was never removed from the CSS itself). Scans every .css file
// this game ships for @import references the same way the HTML scan
// checks href/src.
test('every local @import in this game\'s CSS files points at a file that actually exists', async () => {
  const cssFiles = await findCssFiles(GAME_ROOT);
  assert.ok(cssFiles.length >= 1, 'expected to find at least one .css file');

  const missing = [];
  for (const cssFile of cssFiles) {
    const rawContent = await readFile(cssFile, 'utf8');
    // Strip /* ... */ comments before scanning -- otherwise a comment
    // that merely MENTIONS `@import url(...)` as explanatory text (e.g.
    // documenting a past fix, exactly like this file's own history)
    // would be misread as a real import statement. Real CSS comments
    // don't nest, so a non-greedy match is sufficient and correct.
    const content = rawContent.replace(/\/\*[\s\S]*?\*\//g, '');
    const cssDir = path.dirname(cssFile);
    for (const match of content.matchAll(CSS_IMPORT_RE)) {
      const ref = match[1];
      if (!isLocalRef(ref)) continue;
      if (ref.startsWith('/')) continue;
      const resolved = path.resolve(cssDir, ref.split('?')[0].split('#')[0]);
      if (!(await fileExists(resolved))) {
        missing.push(`${path.relative(GAME_ROOT, cssFile)} @imports "${ref}" -> ${resolved} (does not exist)`);
      }
    }
  }
  assert.deepEqual(missing, [], `broken @import references found:\n${missing.join('\n')}`);
});

test('the shared design-system.css actually defines every custom property both player-ui and tv-ui stylesheets use', async () => {
  const designSystemPath = path.join(GAME_ROOT, 'client', 'design-system.css');
  const designSystemCss = await readFile(designSystemPath, 'utf8');
  const definedVars = new Set([...designSystemCss.matchAll(/^\s*(--ls-[a-zA-Z0-9-]+)\s*:/gm)].map(m => m[1]));

  const stylesheets = [
    path.join(GAME_ROOT, 'player-ui', 'style.css'),
    path.join(GAME_ROOT, 'tv-ui', 'style.css'),
  ];
  const undefinedVars = new Set();
  for (const sheetPath of stylesheets) {
    const css = await readFile(sheetPath, 'utf8');
    for (const match of css.matchAll(/var\((--ls-[a-zA-Z0-9-]+)/g)) {
      const varName = match[1];
      // Variables set dynamically per-instance by JS (fx.js positioning,
      // player-ui's own small local :root block) are not design tokens
      // and are legitimately not part of the shared design system.
      if (varName.startsWith('--ls-fx-')) continue;
      if (varName === '--ls-player-map-min' || varName === '--ls-player-max') continue;
      if (!definedVars.has(varName)) undefinedVars.add(varName);
    }
  }
  assert.deepEqual([...undefinedVars], [], `design-system.css is missing definitions for: ${[...undefinedVars].join(', ')}`);
});

// Regression test for a real bug found by a real person testing this
// game: player-ui/main.js and tv-ui/main.js both defaulted their WS
// connection URL to port 8080 when no `?ws=` query parameter was
// supplied -- but the real server's own actual default port (see
// tools/server/start.mjs's TABLECORE_SERVER_PORT default) is 4180.
// Combined with the launcher's "Play" button not supplying `?ws=` at
// all (a documented, separate limitation -- see ADMIN.md), this meant a
// page opened without every query param explicitly supplied would try
// to connect to a port nothing was listening on. Checked at the source
// level (not just "does the page load"), since the actual symptom (an
// empty game board with no console error at all) is not something a
// pure-Node test can observe without a real browser.
test('player-ui and tv-ui default their WS port to the real server\'s actual default (4180), not a stale/wrong one', async () => {
  const files = ['player-ui/main.js', 'tv-ui/main.js'];
  for (const file of files) {
    const content = await readFile(path.join(GAME_ROOT, file), 'utf8');
    assert.match(content, /:4180`/, `${file} must default to the real server's actual port (4180)`);
    assert.doesNotMatch(content, /:8080`/, `${file} must not default to the old, wrong port (8080)`);
  }
});

// Regression test for the OTHER half of the same real bug report: with
// no token, the board silently stayed empty forever with no on-page
// explanation at all (the connection failure was correct and intentional
// -- see player-client.js's own comment on why a missing token must
// refuse to connect -- but nothing communicated WHY the board was empty).
test('player-ui and tv-ui show a visible on-page notice when opened without a token, not just silent emptiness', async () => {
  const files = ['player-ui/main.js', 'tv-ui/main.js'];
  for (const file of files) {
    const content = await readFile(path.join(GAME_ROOT, file), 'utf8');
    assert.match(content, /no-match-notice/, `${file} must render a visible notice when there is no token`);
  }
  for (const file of ['player-ui/style.css', 'tv-ui/style.css']) {
    const content = await readFile(path.join(GAME_ROOT, file), 'utf8');
    assert.match(content, /#no-match-notice/, `${file} must style the no-match notice`);
  }
});

// Regression tests for the object-icon sprite sheet (assets.svg) --
// ported from the pre-engine game's own src/board.js iconMarkup()
// function, with real, concrete correctness stakes: a single malformed
// XML comment (this file's own first draft used "--" inside a comment,
// invalid per the XML spec, which breaks EVERY icon on the page at
// once, not just one) or a mismatch between assets.mjs's ASSETS map and
// the sprite sheet's actual <symbol> ids would silently degrade to the
// generic 'object-default' fallback for whichever kind was affected.

test('games/last-sector/assets.svg is well-formed XML', async () => {
  const { DOMParser } = await import('@xmldom/xmldom').catch(() => ({ DOMParser: null }));
  const content = await readFile(path.join(GAME_ROOT, 'client/assets.svg'), 'utf8');
  if (DOMParser) {
    const errors = [];
    const parser = new DOMParser({ errorHandler: (level, msg) => errors.push(`${level}: ${msg}`) });
    parser.parseFromString(content, 'text/xml');
    assert.deepEqual(errors, [], `assets.svg must be well-formed XML: ${errors.join('; ')}`);
  } else {
    // No XML parser dependency available in this environment -- fall
    // back to the specific, real failure mode this test exists to catch:
    // XML comments can never contain a literal "--" anywhere in their
    // body (only at the immediate start/end delimiters), which a prose
    // comment using "--" as an em-dash (this project's own house style
    // elsewhere) would violate and break the ENTIRE sprite sheet.
    const commentBodies = [...content.matchAll(/<!--([\s\S]*?)-->/g)].map(m => m[1]);
    for (const body of commentBodies) {
      assert.doesNotMatch(body, /--/, 'an XML comment body must never contain "--" (only allowed as the literal <!-- / --> delimiters) -- this breaks the ENTIRE sprite sheet\'s XML parsing, not just one icon');
    }
  }
});

test('every kind assets.mjs maps in ASSETS has a real, matching <symbol id="..."> in assets.svg', async () => {
  const assetsMjs = await readFile(path.join(GAME_ROOT, 'client/assets.mjs'), 'utf8');
  const svg = await readFile(path.join(GAME_ROOT, 'client/assets.svg'), 'utf8');
  const symbolIds = new Set([...svg.matchAll(/<symbol id="([^"]+)"/g)].map(m => m[1]));
  const assetEntries = [...assetsMjs.matchAll(/(\w+):\s*'([\w-]+)'/g)];
  assert.ok(assetEntries.length > 15, `sanity: expected a real, populated ASSETS map, found ${assetEntries.length} entries`);
  for (const [, kind, symbolId] of assetEntries) {
    assert.ok(symbolIds.has(symbolId), `ASSETS['${kind}'] = '${symbolId}', but no <symbol id="${symbolId}"> exists in assets.svg`);
  }
});

test('every real tile kind the engine\'s own board generation can actually produce has an ASSETS entry -- not just the ones that happened to be ported first', async () => {
  const legacyGame = await readFile(path.join(GAME_ROOT, 'src/legacy/game.cjs'), 'utf8');
  const assetsMjs = await readFile(path.join(GAME_ROOT, 'client/assets.mjs'), 'utf8');
  // Pulled directly from createBoard()'s own tile-kind pool (the
  // `.fill('kind')` calls that populate real generated tiles), plus the
  // handful of kinds set outside that pool (base/center at board setup,
  // glitch from spawnGlitch, anomaly from a global event) -- these are
  // the actual, real kinds a client can be asked to render, not a
  // hand-guessed list.
  const poolKinds = [...legacyGame.matchAll(/\.fill\('([\w]+)'\)/g)].map(m => m[1]);
  const literalKinds = [...legacyGame.matchAll(/kind\s*=\s*'([\w]+)'/g)].map(m => m[1]);
  const realKinds = new Set([...poolKinds, ...literalKinds, 'base', 'center']);
  realKinds.delete('empty'); // the one real kind that deliberately has no icon at all -- an undiscovered/blank tile
  realKinds.delete('hidden'); // not a real board-generation kind -- a client-side "not yet discovered" projection value, not something createBoard() ever assigns
  assert.ok(realKinds.size > 10, `sanity: expected a real, non-trivial set of tile kinds, found ${realKinds.size}`);
  const missing = [...realKinds].filter(kind => !new RegExp(`\\b${kind}:\\s*'`).test(assetsMjs));
  assert.deepEqual(missing, [], `these real, engine-generatable tile kinds have no ASSETS entry at all, so they would render as bare 'object-default': ${missing.join(', ')}`);
});

test('every id="..." attribute in assets.svg is unique across the whole document -- a real, serious risk when multiple hand-crafted ship symbols (each originally its own standalone svg file, each free to reuse short local ids like id="g") get merged into one shared sprite sheet', async () => {
  const svg = await readFile(path.join(GAME_ROOT, 'client/assets.svg'), 'utf8');
  const ids = [...svg.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
  assert.ok(ids.length > 20, `sanity: expected a real, populated set of ids, found ${ids.length}`);
  const seen = new Map();
  const duplicates = [];
  for (const id of ids) {
    if (seen.has(id)) duplicates.push(id);
    seen.set(id, (seen.get(id) || 0) + 1);
  }
  assert.deepEqual(duplicates, [], `duplicate SVG ids found (each of these appears more than once): ${duplicates.join(', ')} -- a duplicate id/url(#...) reference means one symbol's CSS class, gradient, or filter can silently apply to a DIFFERENT symbol too, since SVG ids and <style> rules are document-wide, not scoped to their containing <symbol>`);
});

test('every CSS class name and @keyframes name inside a per-ship <style> block in assets.svg is uniquely prefixed to that ship -- style blocks are NOT symbol-scoped, so an unprefixed class like .ink would silently leak across every ship using it', async () => {
  const svg = await readFile(path.join(GAME_ROOT, 'client/assets.svg'), 'utf8');
  const shipPrefixes = { 'ship-scout-detailed': 'sc-', 'ship-transport-detailed': 'tr-', 'ship-warship-detailed': 'wa-', 'ship-tanker-detailed': 'tk-' };
  for (const [symbolId, prefix] of Object.entries(shipPrefixes)) {
    const symbolMatch = svg.match(new RegExp(`<symbol id="${symbolId}"[^>]*>([\\s\\S]*?)<\\/symbol>`));
    assert.ok(symbolMatch, `expected to find a <symbol id="${symbolId}"> block`);
    const body = symbolMatch[1];
    const styleMatch = body.match(/<style>[\s\S]*?<!\[CDATA\[([\s\S]*?)\]\]>/);
    assert.ok(styleMatch, `expected ${symbolId} to have its own <style><![CDATA[...]]> block`);
    const styleBody = styleMatch[1];
    const classNames = [...styleBody.matchAll(/\.([a-zA-Z][\w-]*)\s*\{/g)].map(m => m[1]);
    const keyframeNames = [...styleBody.matchAll(/@keyframes\s+([\w-]+)/g)].map(m => m[1]);
    assert.ok(classNames.length > 0, `expected ${symbolId} to define at least one CSS class`);
    for (const name of classNames) assert.ok(name.startsWith(prefix), `${symbolId}'s CSS class ".${name}" must start with its own prefix "${prefix}" to avoid leaking into other ships' style rules`);
    for (const name of keyframeNames) assert.ok(name.startsWith(prefix), `${symbolId}'s @keyframes "${name}" must start with its own prefix "${prefix}"`);
  }
});

test('no CSS rule under .ship-mark in player-ui or tv-ui sets an explicit "color" property -- a real bug found live: an explicit color there silently overrides the real per-owner color hex-board.mjs sets as an inline style on the ship\'s own <g> element, since inline styles always win, making colorForOwner()\'s whole point (distinct colors per real opponent) never actually take visible effect', async () => {
  for (const file of ['player-ui/style.css', 'tv-ui/style.css']) {
    const rawCss = await readFile(path.join(GAME_ROOT, file), 'utf8');
    // Strip comments first -- a prose comment mentioning ".ship-mark"
    // (e.g. explaining a design decision, exactly like the one right
    // above this very check) is real text in this project's own
    // comment-heavy style, not a CSS selector. An earlier version of
    // this test didn't strip comments and got a real false positive:
    // its regex latched onto ".ship-mark" INSIDE a comment, then
    // greedily consumed everything up to the next unrelated `{` in the
    // file (an entirely different rule, #no-match-notice), reporting a
    // fabricated violation.
    const css = rawCss.replace(/\/\*[\s\S]*?\*\//g, '');
    const ruleBlocks = [...css.matchAll(/\.ship-mark[^{}]*\{([^}]*)\}/g)].map(m => m[1]);
    assert.ok(ruleBlocks.length > 0, `sanity: expected to find real .ship-mark rules in ${file}`);
    for (const body of ruleBlocks) {
      assert.doesNotMatch(body, /(?:^|[;\s])color\s*:/, `${file} has a .ship-mark rule that sets an explicit color property, which silently defeats colorForOwner()'s per-player color assignment: "${body.trim()}"`);
    }
  }
});
