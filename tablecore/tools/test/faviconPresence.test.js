import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Regression test for a real, reported issue: a browser automatically
// requests `/favicon.ico` for any page with no explicit `<link rel=
// "icon">` -- harmless functionally, but shows up as a 404 in the
// console for anyone testing this project for real, which (like the
// earlier index.css 404 report) can look like something is broken even
// when it isn't. `<link rel="icon" href="data:,">` is the standard,
// well-known fix: an explicit empty data URI tells the browser "there
// really is no icon", so it never issues the automatic request at all --
// no new binary asset file needed. Applied to every real HTML entry
// point in the repository; this test makes sure a future page can't
// silently reintroduce the same gap.
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SKIP_DIRS = new Set(['node_modules', '.git']);

async function findHtmlFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await findHtmlFiles(full));
    else if (entry.name.endsWith('.html')) files.push(full);
  }
  return files;
}

test('every real HTML page in the repository declares an explicit favicon (rel="icon"), so browsers never issue the automatic /favicon.ico 404 request', async () => {
  const files = await findHtmlFiles(ROOT);
  // 7, not last-sector's earlier-observed 9+ -- last-sector (games/
  // last-sector/player-ui, tv-ui, preview) is a SEPARATE, optional game
  // pack (see this repo's own two-archive split), contributing several
  // of its OWN real HTML entry points that this sanity floor used to
  // implicitly assume were always present. This is deliberately just a
  // "did the file-finding logic accidentally find nothing" sanity
  // check, not a real assertion about which specific pages exist -- the
  // 7 known-always-present engine-owned entry points (authoring-studio,
  // rules-editor, map-editor, launcher x2, reference-ui, the admin
  // create-match page), confirmed directly on a genuine engine-only
  // checkout with no games/last-sector present, not guessed.
  assert.ok(files.length >= 7, `expected at least the known 7 engine-owned entry points, found ${files.length}`);
  const missing = [];
  for (const file of files) {
    const content = await readFile(file, 'utf8');
    if (!/rel=["']icon["']/i.test(content)) missing.push(path.relative(ROOT, file));
  }
  assert.deepEqual(missing, [], `these pages are missing an explicit favicon link, which will cause a real browser to 404-request /favicon.ico: ${missing.join(', ')}`);
});
