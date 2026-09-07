// Best-effort real, reachable LAN IP -- when a server is bound to
// '0.0.0.0' (all interfaces, needed for "let other machines on my
// network connect", e.g. real people testing on their own laptops/
// phones), the bind address itself is not something a browser or
// another machine can navigate to. This is the single source of truth
// for "which IP", reused by both tools/server/start.mjs's own startup
// banner AND start.sh/start.cmd's launcher scripts -- extracted here
// specifically so a shell script and the Node server can never disagree
// about which address is "the" LAN IP by each implementing their own
// slightly-different detection logic.
//
// Run directly (`node tools/lan-ip.mjs`) prints just the IP (or nothing,
// with a non-zero exit code, if none was found) -- meant to be captured
// by a shell script (`$(node tools/lan-ip.mjs)`), not parsed as JSON or
// anything more complex.
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export function findLanIp() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] ?? []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return null;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const ip = findLanIp();
  if (ip) { console.log(ip); process.exit(0); }
  process.exit(1);
}
