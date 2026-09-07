#!/usr/bin/env node
// Generates games/<name>/manifest.json from each game pack's OWN runtime
// manifest object (the one createGamePack() actually validates), rather
// than hand-maintaining a second, independent copy that can silently
// drift out of sync -- exactly the class of bug found and fixed several
// times elsewhere in this project's history (replay.gameVersion,
// pack-linter's authoring==null handling, and Last Sector's own
// engineCompatibility field being present in manifest.json but missing
// from its runtime manifest object until that was found and fixed).
//
// This file contains ZERO references to any specific game, on purpose --
// an earlier version hardcoded a `specs` list of named games (each with
// its own directory name, package name, and export name spelled out)
// plus a special-cased comment excluding one particular game by name.
// Found and corrected after being asked directly whether the engine's
// own tooling should know about specific games at all -- it should not,
// even in a build-time script like this one. Instead:
//   - `games/` is scanned on disk (readdir), not enumerated by name.
//   - Each entry's OWN package.json supplies its real package name --
//     nothing here hardcodes what any game is called or what package it
//     lives in.
//   - The pack export is found generically (the first export whose
//     shape looks like `{manifest:{id,name,version}}`), not via a
//     hardcoded exportName per game.
//   - A game whose manifest.json ALREADY EXISTS is left alone --
//     generically, by checking for the file's existence, not by
//     special-casing a specific game's name in a comment. This protects
//     any hand-maintained manifest without needing to name which game
//     has one.
//
// This intentionally IS a build-time script that imports pack code --
// unlike the launcher server itself (tools/launcher/server.mjs), which
// deliberately never imports/executes a game pack merely to build its
// catalog (see catalog.js's own module doc comment for why that
// distinction matters: a build step run by a repo maintainer against
// packs they already trust is a different trust boundary than a live
// server discovering whatever happens to be dropped into games/).
//
// Run: node tools/launcher/generate-manifests.mjs
import { readdir, readFile, writeFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const GAMES_ROOT = new URL('../../games/', import.meta.url);

function looksLikeGamePack(value) {
  return value != null && typeof value === 'object'
    && value.manifest && typeof value.manifest === 'object'
    && typeof value.manifest.id === 'string'
    && typeof value.manifest.name === 'string'
    && typeof value.manifest.version === 'string';
}

async function fileExists(path) {
  try { await access(path); return true; } catch { return false; }
}

const entries = await readdir(GAMES_ROOT, { withFileTypes: true });
let written = 0, skippedExisting = 0, skippedNoPack = 0;

for (const entry of entries) {
  if (!entry.isDirectory()) continue;
  const gameDir = new URL(`${entry.name}/`, GAMES_ROOT);
  const manifestPath = fileURLToPath(new URL('manifest.json', gameDir));
  if (await fileExists(manifestPath)) { skippedExisting++; continue; }

  const packageJsonPath = fileURLToPath(new URL('package.json', gameDir));
  let packageJson;
  try { packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')); }
  catch { continue; } // no package.json at all (e.g. worker-pool's crash-test fixtures) -- not a real, distributable game, skip silently

  const packageName = packageJson.name;
  if (!packageName) continue;

  let mod;
  try { mod = await import(packageName); }
  catch (error) { console.warn(`skipping ${entry.name}: could not import ${packageName}: ${error instanceof Error ? error.message : String(error)}`); continue; }

  const packExport = Object.values(mod).find(looksLikeGamePack);
  if (!packExport) { skippedNoPack++; continue; } // e.g. a bare game object with no createGamePack()-wrapped manifest -- nothing to generate from

  // Full mirror of the pack's own runtime manifest, not a curated
  // subset: the launcher's catalog.js only reads a few fields today, but
  // a curated subset is exactly how manifest drift happened before
  // (engineCompatibility present in a static manifest.json but missing
  // from the runtime manifest object) -- mirroring everything means
  // there is nothing this script could omit that could later silently
  // diverge.
  const manifest = { ...packExport.manifest, status: 'preview' };
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`wrote ${manifestPath}`);
  written++;
}

console.log(`\n${written} manifest.json written, ${skippedExisting} skipped (already had one), ${skippedNoPack} skipped (no game pack export found).`);
