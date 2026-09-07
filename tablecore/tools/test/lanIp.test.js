import test from 'node:test';
import assert from 'node:assert/strict';
import { findLanIp } from '../lan-ip.mjs';

// Regression coverage for the real gap found by a real person testing
// this project: neither the server nor the launcher printed anything
// usable when bound to 0.0.0.0 -- '127.0.0.1' was always shown, which is
// only ever reachable from the exact machine running it, useless for
// sharing with other people testing over the same network. findLanIp()
// is the single, shared implementation both tools/server/start.mjs's own
// startup banner and tools/launcher/server.mjs's now use -- extracted
// specifically so they can't independently drift and disagree about
// which address is "the" LAN IP.

test('findLanIp returns either null or a plausible, non-loopback IPv4 address', () => {
  const ip = findLanIp();
  if (ip === null) return; // legitimate outcome in an environment with no real network interface (e.g. some sandboxes/containers)
  assert.match(ip, /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/, `must look like an IPv4 address, got: ${ip}`);
  assert.notEqual(ip, '127.0.0.1', 'must never return the loopback address itself -- that defeats the entire purpose of this function');
});

test('tools/server/start.mjs imports findLanIp from the shared module rather than its own duplicated copy', async () => {
  const fs = await import('node:fs/promises');
  const content = await fs.readFile(new URL('../server/start.mjs', import.meta.url), 'utf8');
  assert.match(content, /import \{ findLanIp \} from ['"]\.\.\/lan-ip\.mjs['"]/, 'must import the shared implementation, not redefine its own');
});

test('tools/launcher/server.mjs imports findLanIp from the shared module rather than its own duplicated copy', async () => {
  const fs = await import('node:fs/promises');
  const content = await fs.readFile(new URL('../launcher/server.mjs', import.meta.url), 'utf8');
  assert.match(content, /import \{ findLanIp \} from ['"]\.\.\/lan-ip\.mjs['"]/, 'must import the shared implementation, not redefine its own');
});

test('start.sh and start.cmd both bind the server and launcher to 0.0.0.0 by default, not loopback-only', async () => {
  const fs = await import('node:fs/promises');
  const root = new URL('../..', import.meta.url);
  const sh = await fs.readFile(new URL('start.sh', root), 'utf8');
  const cmd = await fs.readFile(new URL('start.cmd', root), 'utf8');
  for (const [name, content] of [['start.sh', sh], ['start.cmd', cmd]]) {
    assert.match(content, /TABLECORE_SERVER_HOST[=:].*0\.0\.0\.0/, `${name} must default TABLECORE_SERVER_HOST to 0.0.0.0`);
    assert.match(content, /TABLECORE_LAUNCHER_HOST[=:].*0\.0\.0\.0/, `${name} must default TABLECORE_LAUNCHER_HOST to 0.0.0.0`);
    // The admin API deliberately stays loopback-only, by design -- see
    // ADMIN.md's security section (it can create matches and mint valid
    // tokens; not something every tester's machine needs to reach).
    assert.match(content, /TABLECORE_SERVER_ADMIN_HOST[=:].*127\.0\.0\.1/, `${name} must keep the admin API on loopback-only by default`);
  }
});
