import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createTableCoreServer } from '../../../tools/server/start.mjs';
import { gridDuel } from '@tablecore/game-grid-duel';
import { discoverGameCatalog } from '../src/index.js';
import { createLauncherServer } from '../../../tools/launcher/server.mjs';

// last-sector is a SEPARATE, optional game pack (see this repo's own
// two-archive split: the engine ships independently of any specific
// game, and games/last-sector -- the one real, shippable game in this
// repository, as opposed to the engine-fixture-only demo games -- is
// meant to be physically dropped into a running engine's own games/
// directory, not bundled with it). Checked via real filesystem
// presence (not a package-import try/catch, unlike this repo's OTHER
// last-sector-dependent tests) because these specific tests exercise
// the launcher's own real, on-disk game DISCOVERY, not anything
// importable as a package at all.
const lastSectorPresent = await fs.access(fileURLToPath(new URL('../../../games/last-sector', import.meta.url))).then(() => true, () => false);
const skipIfNoLastSector = lastSectorPresent ? {} : { skip: 'games/last-sector not present in this checkout' };

test('launcher discovers complete manifests and flags play/preview capability', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tablecore-launcher-'));
  try {
    await fs.mkdir(path.join(root, 'games', 'alpha', 'player-ui'), { recursive: true });
    await fs.mkdir(path.join(root, 'games', 'alpha', 'preview'), { recursive: true });
    await fs.mkdir(path.join(root, 'broken'), { recursive: true });
    await fs.writeFile(path.join(root, 'games', 'alpha', 'manifest.json'), JSON.stringify({ id:'alpha', name:'Alpha', version:'1.0.0', description:'Demo' }));
    await fs.writeFile(path.join(root, 'games', 'alpha', 'player-ui', 'index.html'), '<!doctype html>');
    await fs.writeFile(path.join(root, 'games', 'alpha', 'preview', 'index.html'), '<!doctype html>');
    await fs.writeFile(path.join(root, 'broken', 'manifest.json'), '{not-json');
    const games = await discoverGameCatalog({ gamesDir: path.join(root, 'games') });
    assert.equal(games.length, 1);
    assert.deepEqual({ id:games[0].id, name:games[0].name, hasPlay:games[0].hasPlay, hasPreview:games[0].hasPreview }, { id:'alpha', name:'Alpha', hasPlay:true, hasPreview:true });
  } finally { await fs.rm(root,{recursive:true,force:true}); }
});

test('launcher rejects path-unsafe manifest IDs', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tablecore-launcher-'));
  try {
    await fs.mkdir(path.join(root, 'unsafe'), { recursive: true });
    await fs.writeFile(path.join(root, 'unsafe', 'manifest.json'), JSON.stringify({id:'../escape',name:'Escape'}));
    const games = await discoverGameCatalog({ gamesDir: root });
    assert.equal(games.length, 0);
  } finally { await fs.rm(root,{recursive:true,force:true}); }
});

test('launcher serves catalog and redirects play/preview without exposing filesystem paths', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tablecore-launcher-http-'));
  const launcher = createLauncherServer({ root, host:'127.0.0.1', port:0 });
  try {
    await fs.mkdir(path.join(root, 'games', 'alpha', 'player-ui'), { recursive: true });
    await fs.mkdir(path.join(root, 'games', 'alpha', 'preview'), { recursive: true });
    await fs.writeFile(path.join(root, 'games', 'alpha', 'manifest.json'), JSON.stringify({ id:'alpha', name:'Alpha', version:'1.0.0' }));
    await fs.writeFile(path.join(root, 'games', 'alpha', 'player-ui', 'index.html'), 'PLAY');
    await fs.writeFile(path.join(root, 'games', 'alpha', 'preview', 'index.html'), 'PREVIEW');
    await fs.mkdir(path.join(root, 'packages/launcher/public'), { recursive: true });
    await fs.writeFile(path.join(root, 'packages/launcher/public/index.html'), '<!doctype html>');
    const address=await launcher.listen();
    const base=`http://127.0.0.1:${address.port}`;
    const catalog=await fetch(`${base}/api/games`).then(r=>r.json());
    assert.equal(catalog.games.length,1);
    const play=await fetch(`${base}/play/alpha`,{redirect:'manual'}); assert.equal(play.status,302); assert.equal(play.headers.get('location'),'/games/alpha/player-ui/index.html');
    const preview=await fetch(`${base}/preview/alpha`,{redirect:'manual'}); assert.equal(preview.status,302); assert.equal(preview.headers.get('location'),'/games/alpha/preview/index.html');
    const file=await fetch(`${base}/games/alpha/player-ui/index.html`).then(r=>r.text()); assert.equal(file,'PLAY');
    const traversal=await fetch(`${base}/games/alpha/%2e%2e/%2e%2e/package.json`); assert.equal(traversal.status,404);
  } finally { await launcher.close(); await fs.rm(root,{recursive:true,force:true}); }
});

// Regression test (found and fixed while independently reviewing this
// launcher patch, not part of its own test suite): the original version
// resolved `/games/<root>/<anything>` against nothing more than a path-
// containment check ("does the resolved path stay inside games/<root>?"),
// which is a traversal guard, not a public-surface allowlist. Confirmed
// directly: it served arbitrary files under a cataloged game's directory
// -- source code, test files, internal notes, anything -- as long as the
// path merely stayed inside that game's own folder. Only `player-ui/`,
// `preview/`, `tv-ui/`, and the exact declared `cover` file are meant to
// ever be fetched by a browser; this is the same "declare what's public,
// deny by default" allowlist principle already used elsewhere in this
// project's history for served pack content.
test('launcher never serves files outside the public player-ui/preview/tv-ui/cover surface, even without any path traversal', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tablecore-launcher-surface-'));
  const launcher = createLauncherServer({ root, host:'127.0.0.1', port:0 });
  try {
    await fs.mkdir(path.join(root, 'games', 'alpha', 'player-ui'), { recursive: true });
    await fs.mkdir(path.join(root, 'games', 'alpha', 'src'), { recursive: true });
    await fs.writeFile(path.join(root, 'games', 'alpha', 'manifest.json'), JSON.stringify({ id:'alpha', name:'Alpha', version:'1.0.0', cover:'cover.png' }));
    await fs.writeFile(path.join(root, 'games', 'alpha', 'player-ui', 'index.html'), 'PLAY');
    await fs.writeFile(path.join(root, 'games', 'alpha', 'src', 'game.js'), 'export const secret = 1;');
    await fs.writeFile(path.join(root, 'games', 'alpha', 'internal-notes.md'), 'do not ship this');
    await fs.writeFile(path.join(root, 'games', 'alpha', 'cover.png'), 'not-a-real-png-but-fine-for-this-test');
    await fs.mkdir(path.join(root, 'packages/launcher/public'), { recursive: true });
    await fs.writeFile(path.join(root, 'packages/launcher/public/index.html'), '<!doctype html>');
    const address=await launcher.listen();
    const base=`http://127.0.0.1:${address.port}`;

    const source=await fetch(`${base}/games/alpha/src/game.js`); assert.equal(source.status,404,'rule/server source code must never be served');
    const notes=await fetch(`${base}/games/alpha/internal-notes.md`); assert.equal(notes.status,404,'arbitrary top-level files must never be served');
    const manifest=await fetch(`${base}/games/alpha/manifest.json`); assert.equal(manifest.status,404,'manifest.json itself is not on the public allowlist');
    const cover=await fetch(`${base}/games/alpha/cover.png`); assert.equal(cover.status,200,'the exact declared cover file IS public');
    const ui=await fetch(`${base}/games/alpha/player-ui/index.html`); assert.equal(ui.status,200,'player-ui/ contents remain public');

    // Requesting a path under a game folder name that isn't in the
    // discovered catalog at all (e.g. a folder that failed manifest
    // validation) must not be servable either -- catalog membership is
    // required, not just "some directory exists on disk under games/".
    await fs.mkdir(path.join(root, 'games', 'not-a-real-pack', 'player-ui'), { recursive: true });
    await fs.writeFile(path.join(root, 'games', 'not-a-real-pack', 'player-ui', 'index.html'), 'should not be reachable');
    const uncataloged=await fetch(`${base}/games/not-a-real-pack/player-ui/index.html`);
    assert.equal(uncataloged.status,404,'a folder under games/ with no valid manifest must not be servable even under an otherwise-public-looking path');
  } finally { await launcher.close(); await fs.rm(root,{recursive:true,force:true}); }
});

// Real-repository integration test: the actual games/ directory in this
// checkout, not a synthetic temp fixture. Proves the stated requirement
// ("installed games should be picked up automatically") against the real
// filesystem layout, and documents the honest current state: the four
// engine reference/demo games (grid-duel, coin-race, phase-quest,
// sector-expedition) are genuine backend rules-testing fixtures for
// ENGINE development, never meant to be offered to a real end user as
// something to actually play -- each declares `internal: true` in its
// own manifest.json specifically so the launcher's real catalog (what an
// actual player browsing for a game to join would see) excludes them
// entirely, not just marks them as "no player UI yet". last-sector is
// the one real, playable game currently in this checkout.
test('real repository: internal engine-fixture games (grid-duel, coin-race, phase-quest, sector-expedition) are correctly excluded from the real catalog, last-sector is the only real game shown (when present)', async () => {
  const gamesDir = fileURLToPath(new URL('../../../games', import.meta.url));
  const games = await discoverGameCatalog({ gamesDir });
  const ids = games.map(g => g.id).sort();
  // last-sector's presence in the list depends on whether the separate
  // game pack has actually been added to this checkout's games/
  // directory, checked against the SAME real filesystem presence this
  // file's own lastSectorPresent already determined -- the four
  // engine-fixture demo games are NEVER expected here regardless,
  // confirmed directly against their own real, on-disk manifest.json
  // files (not assumed).
  const expectedIds = lastSectorPresent ? ['last-sector'] : [];
  assert.deepEqual(ids, expectedIds, 'internal:true games must never appear in the real catalog a player browses, and last-sector shows up if and only if it is actually present on disk');
  if (lastSectorPresent) {
    const lastSector = games.find(g => g.id === 'last-sector');
    assert.equal(lastSector.hasPlay, true);
    assert.equal(lastSector.hasPreview, true);
  }
});

test('real repository, real HTTP server: the whole catalog->play->page flow works end-to-end, and source code is not exposed', skipIfNoLastSector, async () => {
  const root = fileURLToPath(new URL('../../..', import.meta.url));
  const launcher = createLauncherServer({ root, host:'127.0.0.1', port:0 });
  try {
    const address = await launcher.listen();
    const base = `http://127.0.0.1:${address.port}`;
    const catalog = await fetch(`${base}/api/games`).then(r => r.json());
    // Only last-sector -- the four engine-fixture demo games declare
    // internal:true and are correctly excluded from the real catalog
    // (see the dedicated discovery test above for the full reasoning).
    assert.equal(catalog.games.length, 1);
    assert.equal(catalog.games[0].id, 'last-sector');
    const play = await fetch(`${base}/play/last-sector`, { redirect: 'manual' });
    assert.equal(play.status, 302);
    const page = await fetch(`${base}${play.headers.get('location')}`);
    assert.equal(page.status, 200);
    const leak = await fetch(`${base}/games/last-sector/src/game.js`);
    assert.equal(leak.status, 404, 'Last Sector\'s actual rule source code must not be servable over HTTP by the launcher');
  } finally { await launcher.close(); }
});

// Regression test: .mjs files were served with `application/octet-stream`
// (the fallback for any unrecognized extension) -- a real browser
// refuses to execute an ES module script with that MIME type even
// though the HTTP request itself returns 200. Found while verifying (not
// assuming) that Last Sector's real browser client library actually
// loads through this launcher: an HTTP-status-only check would never
// have caught this.
test('.mjs files are served with a real JavaScript MIME type, not application/octet-stream', skipIfNoLastSector, async () => {
  const root = fileURLToPath(new URL('../../..', import.meta.url));
  const launcher = createLauncherServer({ root, host:'127.0.0.1', port:0 });
  try {
    const address = await launcher.listen();
    const base = `http://127.0.0.1:${address.port}`;
    const r = await fetch(`${base}/games/last-sector/client/client-state.mjs`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') || '', /javascript/, 'a real browser would refuse to execute a module script served as application/octet-stream even though the request succeeds');
  } finally { await launcher.close(); }
});

// /j/:code join-code redirect tests -- see tools/server/start.mjs's own
// registerJoinCode()/GET /api/join-codes/:code for the admin-server side
// of this (short codes for the create-match page's QR codes, since a
// full join link with a real token embedded is too long to safely
// QR-encode with this project's deliberately small QR implementation).

test('/j/:code resolves a real registered code (via a fake admin API) and 302-redirects to its URL', async () => {
  // A tiny fake "admin API" standing in for the real one -- this test is
  // specifically about the LAUNCHER's own redirect logic (does it call
  // the right admin API URL, parse the response correctly, redirect
  // correctly), not re-testing the admin server's own join-code storage
  // (already covered by tools/server/test/server.test.js's real tests
  // against the real admin server).
  const fakeAdmin = http.createServer((req, res) => {
    if (req.url === '/api/join-codes/REAL123') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ url: 'http://192.168.1.42:4170/games/x/player-ui/index.html?match=m&player=A&token=t&ws=ws://x' })); return; }
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => fakeAdmin.listen(0, '127.0.0.1', resolve));
  const fakeAdminPort = fakeAdmin.address().port;

  const launcher = createLauncherServer({ port: 0, adminApiUrl: `http://127.0.0.1:${fakeAdminPort}` });
  try {
    const addr = await launcher.listen();
    const r = await fetch(`http://127.0.0.1:${addr.port}/j/REAL123`, { redirect: 'manual' });
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('location'), 'http://192.168.1.42:4170/games/x/player-ui/index.html?match=m&player=A&token=t&ws=ws://x');
  } finally {
    await launcher.close();
    await new Promise(resolve => fakeAdmin.close(resolve));
  }
});

test('/j/:code for an unknown code returns 404, not a broken redirect', async () => {
  const fakeAdmin = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  await new Promise(resolve => fakeAdmin.listen(0, '127.0.0.1', resolve));
  const fakeAdminPort = fakeAdmin.address().port;
  const launcher = createLauncherServer({ port: 0, adminApiUrl: `http://127.0.0.1:${fakeAdminPort}` });
  try {
    const addr = await launcher.listen();
    const r = await fetch(`http://127.0.0.1:${addr.port}/j/NOTREAL`);
    assert.equal(r.status, 404);
  } finally {
    await launcher.close();
    await new Promise(resolve => fakeAdmin.close(resolve));
  }
});

test('/j/:code when the admin API is completely unreachable fails cleanly (502), not a hang or crash', async () => {
  // Point at a port nothing is listening on.
  const launcher = createLauncherServer({ port: 0, adminApiUrl: 'http://127.0.0.1:1' });
  try {
    const addr = await launcher.listen();
    const r = await fetch(`http://127.0.0.1:${addr.port}/j/ANYCODE`);
    assert.equal(r.status, 502);
  } finally {
    await launcher.close();
  }
});

test('real end-to-end: the real admin server creates a match with a real join code, the real launcher resolves and redirects it', async () => {
  const server = createTableCoreServer({ secret: 'a-perfectly-fine-real-e2e-secret-32ch', games: { 'grid-duel': gridDuel } });
  const serverAddr = await server.listen();
  const launcher = createLauncherServer({ port: 0, adminApiUrl: `http://${serverAddr.adminHost}:${serverAddr.adminPort}` });
  try {
    const launcherAddr = await launcher.listen();
    // Recreate the server WITH launcherUrl now that we know the launcher's real port (chicken-and-egg: the admin server needs to know the launcher's URL to construct join links, but the launcher needs to know the admin API's URL to resolve them -- both need each other's address, resolved here by starting the admin server twice, matching how a real deployment would just configure both consistently up front via TABLECORE_LAUNCHER_URL/TABLECORE_ADMIN_API_URL env vars).
    await server.close();
    const server2 = createTableCoreServer({ secret: 'a-perfectly-fine-real-e2e-secret-32ch', games: { 'grid-duel': gridDuel }, launcherUrl: `http://127.0.0.1:${launcherAddr.port}` });
    const serverAddr2 = await server2.listen({ adminPort: serverAddr.adminPort });
    try {
      const created = await fetch(`http://127.0.0.1:${serverAddr2.adminPort}/api/matches`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ gameId: 'grid-duel', players: ['A', 'B'] }) }).then(r => r.json());
      const redirectResponse = await fetch(created.joinLinks.A.shortUrl, { redirect: 'manual' });
      assert.equal(redirectResponse.status, 302);
      assert.equal(redirectResponse.headers.get('location'), created.joinLinks.A.fullUrl);
    } finally {
      await server2.close();
    }
  } finally {
    await launcher.close();
  }
});

// Regression tests for connecting the launcher's catalog to the
// create-match page -- a real, reasonable question asked directly: "why
// doesn't clicking a game in the launcher let me create a match for it?"
// Answer, simplified after a further round of real feedback ("all of
// this is complicated and tangled again"): "Играть" itself now goes
// straight to the create-match/lobby page for that game (via `?game=`),
// no separate button -- see packages/launcher/public/index.html's own
// comment on why keeping "Играть" as a bare, useless-for-anyone
// navigation plus a SEPARATE organizer-only button was needless
// complexity solving a non-problem (real players never see this catalog
// page at all; only the organizer, on the same machine as the server,
// ever clicks a card here).

test('/api/games exposes adminApiUrl so the catalog page can build a real "Играть" link straight into lobby creation', async () => {
  const root = fileURLToPath(new URL('../../..', import.meta.url));
  const launcher = createLauncherServer({ root, host: '127.0.0.1', port: 0, adminApiUrl: 'http://127.0.0.1:9999' });
  try {
    const addr = await launcher.listen();
    const data = await fetch(`http://127.0.0.1:${addr.port}/api/games`).then(r => r.json());
    assert.equal(data.adminApiUrl, 'http://127.0.0.1:9999');
  } finally {
    await launcher.close();
  }
});

test('the catalog page\'s own JS reads adminApiUrl from /api/games (needed to build the "Играть" -> lobby-creation link)', async () => {
  const root = fileURLToPath(new URL('../../..', import.meta.url));
  const launcher = createLauncherServer({ root, host: '127.0.0.1', port: 0, adminApiUrl: 'http://127.0.0.1:9999' });
  try {
    const addr = await launcher.listen();
    const html = await fetch(`http://127.0.0.1:${addr.port}/`).then(r => r.text());
    assert.match(html, /adminApiUrl/, 'the page\'s own JS must read adminApiUrl from the /api/games response');
    assert.match(html, /playHref/, 'the page must compute a play link that depends on adminApiUrl (the lobby-creation link), not a bare static /play/ path');
  } finally {
    await launcher.close();
  }
});

// Regression tests for a real bug found via a genuine concurrent-load
// test (20 simultaneous seat-claim attempts against a real running
// server): the admin API's own per-IP rate limiter correctly rejected
// one of the launcher's server-to-server lookups with a real 429, but
// the launcher's OLD error handling collapsed that (and any other
// non-2xx/non-409 response) into a misleading JOIN_CODE_NOT_FOUND /
// LOBBY_NOT_FOUND -- telling a rate-limited player their code was
// invalid/missing instead of the real, actionable "too many attempts,
// try again shortly".

test('/j/:code correctly reports RATE_LIMITED (429), not a misleading JOIN_CODE_NOT_FOUND, when the admin API rate-limits the lookup', async () => {
  const root = fileURLToPath(new URL('../../..', import.meta.url));
  const admin = createTableCoreServer({ secret: 'a-perfectly-fine-test-secret-32-chars-plus', games: {}, adminMaxRequestsPerMinute: 1 });
  const adminAddr = await admin.listen();
  const launcher = createLauncherServer({ root, host: '127.0.0.1', port: 0, adminApiUrl: `http://${adminAddr.adminHost}:${adminAddr.adminPort}` });
  try {
    const addr = await launcher.listen();
    const base = `http://127.0.0.1:${addr.port}`;
    // Two lookups against the SAME low-limit (1/minute) admin API --
    // the first consumes the only allowed request, the second must be
    // genuinely rate-limited by the real admin API, and the launcher
    // must correctly report THAT, not claim the code doesn't exist.
    const first = await fetch(`${base}/j/anycode1`, { redirect: 'manual' });
    assert.equal(first.status, 404); // genuinely doesn't exist -- consumes the 1 allowed request
    const second = await fetch(`${base}/j/anycode2`, { redirect: 'manual' });
    assert.equal(second.status, 429, `expected a real 429 (rate-limited), got ${second.status}`);
    assert.equal((await second.json()).error, 'RATE_LIMITED');
  } finally {
    await launcher.close();
    await admin.close();
  }
});

test('/api/lobby-seat-status correctly reports RATE_LIMITED (429), not a misleading LOBBY_NOT_FOUND, when the admin API rate-limits the lookup', async () => {
  const root = fileURLToPath(new URL('../../..', import.meta.url));
  const admin = createTableCoreServer({ secret: 'a-perfectly-fine-test-secret-32-chars-plus', games: {}, adminMaxRequestsPerMinute: 1 });
  const adminAddr = await admin.listen();
  const launcher = createLauncherServer({ root, host: '127.0.0.1', port: 0, adminApiUrl: `http://${adminAddr.adminHost}:${adminAddr.adminPort}` });
  try {
    const addr = await launcher.listen();
    const base = `http://127.0.0.1:${addr.port}`;
    const first = await fetch(`${base}/api/lobby-seat-status/anylobby/0`);
    assert.equal(first.status, 404); // consumes the 1 allowed admin request
    const second = await fetch(`${base}/api/lobby-seat-status/anylobby/0`);
    assert.equal(second.status, 429, `expected a real 429 (rate-limited), got ${second.status}`);
    assert.equal((await second.json()).error, 'RATE_LIMITED');
  } finally {
    await launcher.close();
    await admin.close();
  }
});
