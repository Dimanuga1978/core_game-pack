import fs from 'node:fs/promises';
import path from 'node:path';

const JSON_MANIFEST = 'manifest.json';

async function readJson(file) {
  const text = await fs.readFile(file, 'utf8');
  return JSON.parse(text);
}

function safeSegment(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9._-]+$/.test(value);
}

export async function discoverGameCatalog({ gamesDir }) {
  const entries = await fs.readdir(gamesDir, { withFileTypes: true });
  const games = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !safeSegment(entry.name)) continue;
    const root = path.join(gamesDir, entry.name);
    const manifestPath = path.join(root, JSON_MANIFEST);
    try {
      const manifest = await readJson(manifestPath);
      if (!manifest || typeof manifest !== 'object') continue;
      // `internal: true` -- a deliberate, explicit opt-out any game pack
      // can declare in its own manifest.json, for exactly this repo's
      // own real case: grid-duel/coin-race/phase-quest/sector-expedition
      // are genuine backend rules-testing fixtures for ENGINE development
      // (see DISTRIBUTION.md's own comment on this), never meant to be
      // offered to a real end user as something to actually play -- but
      // `status` (already 'preview' for all of them, same as last-sector)
      // wasn't a reliable discriminator for this at all, since it means
      // something else (development maturity, not audience). A NAME-based
      // blocklist here would have defeated the whole point of a
      // pluggable, auto-discovered game-pack architecture -- any future
      // internal fixture (this repo's own or a third party's) can declare
      // this itself, rather than the launcher needing to know specific
      // ids in advance. Deliberately scoped to CATALOG VISIBILITY only --
      // an internal game can still be registered directly with the admin
      // API's own `games` config and used for real match creation (this
      // repo's own worker-pool tests do exactly that, on purpose); this
      // flag only controls whether a real end user browsing the launcher
      // ever sees it offered as something to play.
      if (manifest.internal === true) continue;
      if (!safeSegment(manifest.gameId) && !safeSegment(manifest.id)) continue;
      const id = manifest.gameId ?? manifest.id;
      const playIndex = manifest.playEntry ?? 'player-ui/index.html';
      const previewIndex = manifest.previewEntry ?? 'preview/index.html';
      let cover = typeof manifest.cover === 'string' ? manifest.cover : null;
      if (!cover) {
        for (const candidate of ['cover.png','cover.webp','visual-design-reference.png']) {
          if (await fileExists(path.join(root, candidate))) { cover = candidate; break; }
        }
      }
      games.push(Object.freeze({
        id,
        name: typeof manifest.name === 'string' ? manifest.name : id,
        version: typeof manifest.version === 'string' ? manifest.version : '',
        status: typeof manifest.status === 'string' ? manifest.status : 'unknown',
        description: typeof manifest.description === 'string' ? manifest.description : '',
        minPlayers: Number.isInteger(manifest.minPlayers) ? manifest.minPlayers : null,
        maxPlayers: Number.isInteger(manifest.maxPlayers) ? manifest.maxPlayers : null,
        cover,
        root: entry.name,
        hasPlay: await fileExists(path.join(root, playIndex)),
        hasPreview: await fileExists(path.join(root, previewIndex)),
        playEntry: playIndex,
        previewEntry: previewIndex,
      }));
    } catch {
      // Ignore folders that are not complete Game Packs. The catalog should
      // remain usable even when a third-party pack is currently being copied.
    }
  }
  return games.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}

async function fileExists(file) {
  try { await fs.access(file); return true; } catch { return false; }
}
