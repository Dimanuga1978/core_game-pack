#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { lintGamePack, formatDiagnostics } from '../packages/pack-linter/src/index.js';

function usage() {
  console.error('Usage: node tools/tablecore-pack-lint.js <static-json>');
  console.error('JSON input must contain { packManifest, content?, authoring? }. JavaScript modules are never imported by the default linter.');
}

const arg = process.argv[2];
if (!arg || arg.endsWith('.js') || arg.endsWith('.mjs') || arg.endsWith('.cjs')) { usage(); process.exit(2); }
try {
  const raw = await readFile(resolve(process.cwd(), arg), 'utf8');
  const input = JSON.parse(raw);
  const pack = input.pack ?? { manifest: input.packManifest, game: input.gameContract ?? undefined };
  const diagnostics = lintGamePack({ pack, content: input.content ?? null, authoring: input.authoring ?? null, staticOnly: true });
  console.log(formatDiagnostics(diagnostics));
  process.exitCode = diagnostics.some(d => d.severity === 'error') ? 1 : 0;
} catch (error) {
  console.error(`ERROR INVALID_STATIC_PACK: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
