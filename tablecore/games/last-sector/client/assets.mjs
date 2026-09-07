export const ASSETS = Object.freeze({
  scout: 'ship-scout-detailed',
  transport: 'ship-transport-detailed',
  warship: 'ship-warship-detailed',
  tanker: 'ship-tanker-detailed',
  planet: 'object-planet',
  station: 'object-station',
  superstation: 'object-superstation',
  base: 'object-base',
  center: 'object-center',
  asteroid: 'object-asteroid',
  pirate: 'object-pirate',
  nebula: 'object-nebula',
  signal: 'object-signal',
  accelerator: 'object-accelerator',
  teleport: 'object-teleport',
  broken_teleport: 'object-broken_teleport',
  directional_arrow: 'object-directional_arrow',
  glitch: 'object-glitch',
  thief_mineral: 'object-thief_mineral',
  thief_scrap: 'object-thief_scrap',
  anomaly: 'object-anomaly',
  blackhole: 'object-blackhole',
});

export function createAssetIcon(documentRef, asset, options = {}) {
  const svg = documentRef.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.className = options.className || 'ls-asset';
  svg.setAttribute('viewBox', '0 0 64 64');
  svg.setAttribute('aria-hidden', options.ariaHidden === false ? 'false' : 'true');
  if (options.title) svg.setAttribute('title', options.title);
  const use = documentRef.createElementNS('http://www.w3.org/2000/svg', 'use');
  // Real bug found via live verification against a real launcher: this
  // file used to live at games/last-sector/assets.svg (the game's own
  // top-level directory), which the launcher's own public-surface
  // allowlist (PUBLIC_GAME_PREFIXES in tools/launcher/server.mjs) never
  // actually serves -- only player-ui/, preview/, tv-ui/, and client/
  // are servable, by design (a deliberate anti-source-disclosure
  // boundary, not an oversight to route around). Confirmed directly: a
  // real fetch through a real running launcher returned a genuine 404
  // for this exact path. Moved into client/ (already allowlisted, and
  // already where this game's other shared client modules live) rather
  // than adding a one-off exception to the launcher's allowlist for a
  // single file.
  use.setAttribute('href', `../client/assets.svg#${ASSETS[asset] || 'object-default'}`);
  svg.appendChild(use);
  return svg;
}

export function assetName(kind) {
  return ASSETS[kind] ? kind : 'default';
}
