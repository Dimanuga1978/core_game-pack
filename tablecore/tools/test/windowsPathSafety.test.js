import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Regression test for a real bug found on a real Windows machine (not
// caught on Linux, where the underlying flaw happens to be invisible):
// `new URL(fileUrl).pathname` is NOT a safe cross-platform way to get a
// filesystem path. On Windows, a file:// URL's pathname keeps a leading
// slash before the drive letter ('/C:/game/tablecore/...'), which
// downstream path tools (path.isAbsolute + pathToFileURL, fs.readdir,
// etc.) misinterpret -- observed for real as a doubled drive letter
// ('C:\C:\game\tablecore\games') causing ENOENT/ERR_MODULE_NOT_FOUND.
// `fileURLToPath()` (from node:url) is the correct, safe function for
// this on every platform and was already used correctly elsewhere in
// this codebase -- the bug was specifically a handful of test files that
// took the `.pathname` shortcut instead. This test scans the real
// repository source for that exact anti-pattern reappearing, rather than
// only relying on someone happening to run the tests on Windows again to
// notice.
const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const SKIP_DIRS = new Set(['node_modules', '.git']);
// `url.pathname` on an HTTP request URL (not a file:// URL) is completely
// legitimate and unrelated to this bug -- e.g. `new URL(req.url, base).pathname`
// for route matching. Only flag the file-URL-constructing shape:
// `new URL(...import.meta.url...).pathname`, which is the shape that
// actually attempts to derive a filesystem path.
const UNSAFE_PATTERN = /new URL\([^)]*import\.meta\.url\)\s*\.pathname/;

async function collectFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await collectFiles(full));
    // Exclude this file itself -- it necessarily contains the pattern
    // being searched for, in its own comment and regex literal.
    else if ((entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) && full !== SELF) files.push(full);
  }
  return files;
}

test('no source file derives a filesystem path via new URL(..., import.meta.url).pathname -- must use fileURLToPath() instead (Windows-unsafe pattern, found and fixed once already)', async () => {
  const files = await collectFiles(ROOT);
  const offenders = [];
  for (const file of files) {
    const content = await readFile(file, 'utf8');
    if (UNSAFE_PATTERN.test(content)) offenders.push(path.relative(ROOT, file));
  }
  assert.deepEqual(offenders, [], `found the Windows-unsafe .pathname pattern in: ${offenders.join(', ')} -- use fileURLToPath(new URL(...)) instead`);
});
