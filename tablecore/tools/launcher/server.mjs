import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverGameCatalog } from '../../packages/launcher/src/index.js';
import { findLanIp } from '../lan-ip.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function json(res,status,data){res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(data));}
function redirect(res,location){res.writeHead(302,{location,'cache-control':'no-store'});res.end();}
function safePath(base,relative){
  const abs=path.resolve(base,relative);
  if(abs!==base && !abs.startsWith(base+path.sep)) return null;
  return abs;
}
// `.mjs` was missing here -- found while verifying (not assuming) that a
// real browser could actually load Last Sector's client library files
// through this launcher. Real browsers enforce strict MIME-type checking
// for ES module scripts: a `<script type="module">`/dynamic `import()`
// of a file served as `application/octet-stream` (the previous fallback
// for any unrecognized extension, which `.mjs` fell into) is REJECTED by
// the browser outright, even though the HTTP request itself succeeds
// with a 200 status -- an HTTP-status-only check would never catch this,
// which is exactly why it went unnoticed until actually checking
// response headers, not just status codes.
function contentType(file){const ext=path.extname(file).toLowerCase();return {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.webp':'image/webp','.jpg':'image/jpeg','.jpeg':'image/jpeg','.ico':'image/x-icon'}[ext]||'application/octet-stream';}
async function sendFile(res,file){
  if(!file){res.writeHead(404,{'content-type':'text/plain; charset=utf-8'});return void res.end('Not found');}
  try{const stat=await fs.stat(file);if(!stat.isFile())throw new Error('not-file');res.writeHead(200,{'content-type':contentType(file),'cache-control':'no-cache'});res.end(await fs.readFile(file));}
  catch{res.writeHead(404,{'content-type':'text/plain; charset=utf-8'});res.end('Not found');}
}

// A game's directory on disk is NOT the same thing as its public surface.
// `games/<id>/` typically also contains `src/` (rule/server logic),
// `test/` (which can contain internal comments about known weaknesses --
// see this very engine's own audit history for examples of test files
// documenting exactly that), authoring bundles, migration/audit
// markdown, etc. The original version of this launcher resolved
// `/games/<root>/<anything>` against nothing more than a path-
// containment check ("does it stay inside games/<root>?") -- which is a
// traversal guard, not a public-surface allowlist. Verified directly: it
// served arbitrary non-UI files (source code, internal notes) over HTTP
// for any path that merely stayed inside a cataloged game's folder. Only
// `player-ui/`, `preview/`, `tv-ui/`, a shared `client/` (a game's own
// browser client library, loaded BY player-ui/preview/tv-ui pages --
// added when Last Sector's real browser client was built; genuinely
// meant to be servable, the same way the three UI directories are, not
// an exception to the "public means public" rule), and the exact
// declared `cover` image are ever legitimately meant to be fetched by a
// browser -- this is the same "declare what's public, deny everything
// else by default" principle already used elsewhere in this project's
// history (an earlier engine's PACK_SECURITY model had an equivalent
// `publicPaths`-style allowlist for exactly this reason).
const PUBLIC_GAME_PREFIXES = ['player-ui', 'preview', 'tv-ui', 'client'];
function isPublicGamePath(game, relativeSegments) {
  const normalized = relativeSegments.filter(Boolean).join('/');
  if (!normalized) return false;
  if (game.cover && normalized === game.cover) return true;
  return PUBLIC_GAME_PREFIXES.some(prefix => normalized === prefix || normalized.startsWith(prefix + '/'));
}

export function createLauncherServer({ root = ROOT, host = process.env.TABLECORE_LAUNCHER_HOST || '127.0.0.1', port = Number(process.env.TABLECORE_LAUNCHER_PORT || 4170), adminApiUrl = process.env.TABLECORE_ADMIN_API_URL || 'http://127.0.0.1:4181' } = {}) {
  const gamesDir = path.resolve(root, 'games');
  const publicDir = path.resolve(root, 'packages/launcher/public');
  const engineClientDir = path.resolve(root, 'packages/browser-client/src');
  const presentationClientDir = path.resolve(root, 'packages/presentation-client/src');
  const server = http.createServer(async (req,res)=>{
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      // `adminApiUrl` is included here so the catalog page's own JS can
      // build a "Создать матч" (create-match) link per game, pointing
      // the ORGANIZER at the admin server's create-match page with that
      // game preselected (see tools/server/public/create.js's own
      // `?game=` handling). Not a secret -- it's just an address (the
      // well-known default, or whatever TABLECORE_ADMIN_API_URL was
      // set to), safe to hand to every viewer including players on the
      // LAN who can't actually reach it (the admin API stays loopback-
      // only regardless of who knows its URL -- see start.mjs's own
      // security section for why).
      if (url.pathname === '/api/games') return json(res,200,{games:await discoverGameCatalog({gamesDir}), adminApiUrl});
      if (url.pathname.startsWith('/play/') || url.pathname.startsWith('/preview/')) {
        const parts=url.pathname.split('/').filter(Boolean);
        const mode=parts[0];
        const id=decodeURIComponent(parts.slice(1).join('/'));
        const game=(await discoverGameCatalog({gamesDir})).find(g=>g.id===id);
        if(!game) return json(res,404,{error:'GAME_NOT_FOUND'});
        const entry=mode==='play'?game.playEntry:game.previewEntry;
        const available=mode==='play'?game.hasPlay:game.hasPreview;
        if(!available) return json(res,404,{error:mode==='play'?'PLAY_UNAVAILABLE':'PREVIEW_UNAVAILABLE'});
        const location=`/games/${encodeURIComponent(game.root)}/${entry.split('/').map(encodeURIComponent).join('/')}`;
        return redirect(res,location);
      }
      if(url.pathname.startsWith('/launcher/')) {
        const rel=decodeURIComponent(url.pathname.slice('/launcher/'.length)) || 'index.html';
        return sendFile(res,safePath(publicDir,rel));
      }
      if(url.pathname.startsWith('/engine-client/')) {
        // Game-agnostic engine infrastructure (packages/browser-client --
        // see its own module doc comments for why it exists as a real
        // engine package rather than living inside one game's folder),
        // served at a stable, absolute, game-independent URL specifically
        // so any game's player-ui can reference the SAME copy instead of
        // each one needing its own duplicated copy under games/<id>/.
        // This is a narrow, deliberate exception to "only /games/ and
        // /launcher/ are servable" -- ONE specific package, chosen because
        // its whole purpose is to be loaded by a browser, not a blanket
        // "serve all of packages/*" (which would re-expose the same class
        // of source-code-disclosure surface the /games/ allowlist exists
        // to prevent -- see PUBLIC_GAME_PREFIXES's own comment).
        const rel=decodeURIComponent(url.pathname.slice('/engine-client/'.length)) || 'index.html';
        return sendFile(res,safePath(engineClientDir,rel));
      }
      if(url.pathname.startsWith('/presentation-client/')) {
        // Same reasoning as /engine-client/ above, for the second real
        // game-agnostic package (packages/presentation-client) -- camera/
        // fx/sequence/dispatcher/onboarding runtimes any game's tv-ui
        // page can load, kept as a SEPARATE package/route from
        // /engine-client/ on purpose (player-ui pages don't need any of
        // this, only tv-ui does -- no reason to make every player-ui page
        // pull in code it never uses).
        const rel=decodeURIComponent(url.pathname.slice('/presentation-client/'.length)) || 'index.html';
        return sendFile(res,safePath(presentationClientDir,rel));
      }
      if(url.pathname.startsWith('/games/')) {
        const rel=url.pathname.slice('/games/'.length).split('/');
        if(rel.length<2) return sendFile(res,null);
        const rootName=decodeURIComponent(rel.shift());
        const relativeSegments=rel.map(decodeURIComponent);
        // Only serve files belonging to a game that actually appears in
        // the discovered catalog (real manifest, safe id) -- not merely
        // "any folder name under games/". Then require the requested
        // path to fall under the public-surface allowlist above.
        // safePath()'s containment check still runs too, as defense in
        // depth against a rootName/relative path that somehow encodes a
        // traversal sequence -- but the allowlist is the actual boundary
        // now, not just "did you escape the games/ directory".
        const game=(await discoverGameCatalog({gamesDir})).find(g=>g.root===rootName);
        if(!game || !isPublicGamePath(game, relativeSegments)) return sendFile(res,null);
        return sendFile(res,safePath(gamesDir,path.join(rootName,relativeSegments.join('/'))));
      }
      if(url.pathname==='/') return sendFile(res,path.join(publicDir,'index.html'));
      if(url.pathname==='/style.css'||url.pathname==='/launcher.css') return sendFile(res,path.join(publicDir,'style.css'));
      if(url.pathname==='/lobby-wait.html') return sendFile(res,path.join(publicDir,'lobby-wait.html'));
      if(url.pathname==='/lobby-wait.js') return sendFile(res,path.join(publicDir,'lobby-wait.js'));
      if(url.pathname.startsWith('/j/')) {
        // Short join-code redirect (see tools/server/start.mjs's own
        // registerJoinCode()/`/api/join-codes/:code` -- the admin API
        // there generates these short codes for the create-match page's
        // QR codes, since the FULL join link with a real signed token
        // embedded is ~350 characters, too long to safely QR-encode with
        // the deliberately small QR implementation this project uses --
        // see packages/qrcode's own module doc comments). Resolved here,
        // server-to-server (this launcher and the admin API normally run
        // on the SAME machine -- the admin API stays loopback-only
        // regardless of what THIS launcher is bound to, by design), then
        // 302-redirects the actual player's/spectator's browser to the
        // real, full join URL.
        const code=decodeURIComponent(url.pathname.slice('/j/'.length));
        if(!code) return json(res,404,{error:'MISSING_JOIN_CODE'});
        try {
          const resolved=await fetch(`${adminApiUrl}/api/join-codes/${encodeURIComponent(code)}`);
          if(resolved.status===409) return json(res,409,{error:'LOBBY_FULL',message:'Это лобби уже заполнено -- все места заняты другими игроками.'});
          // Real bug found via a genuine concurrent-load test (20
          // simultaneous seat-claim attempts): the admin API's own
          // per-IP rate limiter (adminMaxRequestsPerMinute, default 20)
          // correctly rejected one of these server-to-server lookups
          // with a real 429 -- but the OLD blanket `if(!resolved.ok)
          // return 404 JOIN_CODE_NOT_FOUND` swallowed that distinction
          // entirely, telling the player their code was invalid/missing
          // when the REAL cause was "too many requests right now, try
          // again shortly" -- actionable information a rate-limited
          // player (or someone debugging this) genuinely needs, not a
          // misleading claim that the shared link itself is broken.
          if(resolved.status===429) return json(res,429,{error:'RATE_LIMITED',message:'Слишком много попыток подключения подряд -- подождите немного и попробуйте снова.'});
          if(resolved.status===404) return json(res,404,{error:'JOIN_CODE_NOT_FOUND'});
          if(!resolved.ok) return json(res,502,{error:'ADMIN_API_ERROR',status:resolved.status});
          const body=await resolved.json();
          if(typeof body.url!=='string') return json(res,502,{error:'BAD_JOIN_CODE_RESPONSE'});
          return redirect(res,body.url);
        } catch {
          return json(res,502,{error:'ADMIN_API_UNREACHABLE'});
        }
      }
      if(url.pathname.startsWith('/api/lobby-seat-status/')) {
        // Server-to-server proxy for the lobby-wait.html page's polling
        // (see that file's own comment) -- the admin API stays loopback-
        // only regardless of what this launcher is bound to, so a remote
        // player's browser can never reach GET /api/lobbies/:id/seat/:i
        // directly; this launcher does on its behalf, same pattern as
        // /j/:code's own server-to-server resolution above.
        const rest=url.pathname.slice('/api/lobby-seat-status/'.length);
        const [lobbyId,seatIndex]=rest.split('/');
        if(!lobbyId||!seatIndex) return json(res,400,{error:'MISSING_LOBBY_OR_SEAT'});
        try {
          const resolved=await fetch(`${adminApiUrl}/api/lobbies/${encodeURIComponent(lobbyId)}/seat/${encodeURIComponent(seatIndex)}`);
          // Same class of real bug found and fixed for /j/:code above --
          // the status code here WAS already passed through correctly
          // (so lobby-wait.js's own polling loop, which only specially
          // treats a real 404 as permanent, wasn't actually mis-behaving
          // for a transient 429), but the error LABEL still claimed
          // 'LOBBY_NOT_FOUND' regardless of the real cause, which is
          // still misleading for anyone reading logs/network traffic
          // while debugging.
          if(resolved.status===429) return json(res,429,{error:'RATE_LIMITED'});
          if(!resolved.ok) return json(res,resolved.status,{error:'LOBBY_NOT_FOUND'});
          const body=await resolved.json();
          return json(res,200,body);
        } catch {
          return json(res,502,{error:'ADMIN_API_UNREACHABLE'});
        }
      }
      return json(res,404,{error:'NOT_FOUND'});
    } catch { return json(res,500,{error:'LAUNCHER_ERROR'}); }
  });
  return { server, host, port, async listen() { await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,resolve);}); return server.address();}, async close() { await new Promise(resolve=>server.close(()=>resolve())); } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const launcher=createLauncherServer();
  launcher.listen().then(address=>{
    // Same reasoning as tools/server/start.mjs's own startup banner:
    // when bound to '0.0.0.0' (all interfaces), that literal address is
    // not something a browser on another machine can navigate to --
    // print the real LAN IP instead so this URL is actually usable by
    // whoever it's shared with, not just technically correct.
    const lanIp = findLanIp();
    const displayHost = (address.address === '0.0.0.0' && lanIp) ? lanIp : address.address;
    console.log(`TableCore Launcher: http://${displayHost}:${address.port}`);
    if (lanIp && address.address === '0.0.0.0') console.log(`(bound to 0.0.0.0 -- reachable from other machines on this network at ${lanIp}, and locally at 127.0.0.1)`);
  }).catch(error=>{console.error(error);process.exitCode=1;});
  const stop=()=>launcher.close().finally(()=>process.exit(0));
  process.once('SIGINT',stop); process.once('SIGTERM',stop);
}
