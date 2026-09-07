// Builds and incrementally updates the REAL SVG hex-grid board (real
// polygons, real edge-to-edge tiling -- see hex-geometry.mjs's own doc
// comment for why this replaces the previous plain rectangular
// CSS-grid-with-gaps rendering). Deliberately kept separate from
// hex-geometry.mjs's pure coordinate math, mirroring the same split the
// original pre-engine game's own src/board.js used (`center`/`points`
// as plain functions, DOM construction layered on top) -- makes the
// geometry itself trivially testable without any DOM at all (see
// hexGeometry.test.js), while this file's own tests (hexBoard.test.js)
// verify the DOM STRUCTURE this layer produces on top of it.
import { hexCenter, hexPoints, computeBoardPixelSize } from './hex-geometry.mjs';
import { createAmbientScene } from './ambient-scene.mjs';

const NS = 'http://www.w3.org/2000/svg';

// A small, stable per-owner color palette -- distinct colors for up to 4
// real players (this engine's own real max, see game.js's own
// normalizePlayers()), assigned deterministically from the owner id
// STRING itself (not registration order/arrival sequence, which could
// in principle differ between reconnects or across different viewers'
// own event history) so every connected client always renders the SAME
// player in the SAME color. The old pre-engine game had this exact
// same idea (PLAYER_COLORS keyed by fixed seat names 'player'/'p2'/
// 'p3'/'npc') but could hardcode it since seats were fixed; this
// engine's real player ids are arbitrary strings a match's organizer
// chooses, so a hash-based assignment is used instead of a fixed table.
const OWNER_PALETTE = ['#63e6ff', '#ff5f73', '#7ce87a', '#c48be0'];
const TANKER_COLOR = '#ffb247';

function hashOwnerId(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h;
}

/**
 * The color a ship belonging to `owner` should render in, from this
 * viewer's own perspective (`selfId`, e.g. the connected player_id or
 * null for a spectator with no "self"). `selfId`'s own ship always gets
 * the same fixed "this is you" color regardless of which palette slot
 * their raw id would otherwise hash to, matching this project's own
 * existing convention (player-ui always shows your own ship in
 * `--ls-color-player-strong`).
 */
export function colorForOwner(owner, selfId) {
  if (owner === 'tanker') return TANKER_COLOR;
  if (selfId != null && owner === selfId) return 'var(--ls-color-player-strong)';
  return OWNER_PALETTE[hashOwnerId(String(owner)) % OWNER_PALETTE.length];
}


/**
 * Builds the full SVG board structure for a `cols`x`rows` hex grid.
 * Returns `{svg, tiles, shipsGroup}` where `tiles` is a Map keyed by
 * "q,r" coord strings, each value `{q, r, cx, cy, g, polygon, iconGroup,
 * kind}` -- the same per-tile handles later update calls need, without
 * having to re-walk the DOM to find them.
 */
export function createHexBoard(documentRef, cols, rows, size = 28) {
  const { width, height } = computeBoardPixelSize(cols, rows, size);
  const pad = Math.max(40, size * 1.5);
  const svg = documentRef.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `${-pad} ${-pad} ${width + pad * 2} ${height + pad * 2}`);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  svg.classList.add('ls-hex-board');

  // Ambient background scene (nebula clouds, multi-layer starfield, a
  // repeating shooting star) -- built once, as the FIRST child so it
  // renders behind everything else, and never touched again by any of
  // the update functions below (it's purely decorative, unrelated to
  // live game state, matching the original pre-engine game's own
  // approach of building this once in rebuild()). ambient-scene.mjs's
  // own coordinate system starts at (0,0); the board's actual viewBox
  // starts at (-pad,-pad) (see below), so the whole scene group is
  // translated by (-pad,-pad) here to line up with it -- otherwise the
  // scene would render visibly offset from the hex grid it's supposed
  // to sit behind, found and fixed before this ever got wired up live.
  const ambientScene = createAmbientScene(documentRef, width + pad * 2, height + pad * 2);
  ambientScene.setAttribute('transform', `translate(${-pad} ${-pad})`);
  svg.appendChild(ambientScene);

  const gridGroup = documentRef.createElementNS(NS, 'g');
  gridGroup.setAttribute('id', 'ls-hexes');

  const tiles = new Map();
  for (let r = 0; r < rows; r++) {
    for (let q = 0; q < cols; q++) {
      const coord = `${q},${r}`;
      const { cx, cy } = hexCenter(q, r, size);
      const g = documentRef.createElementNS(NS, 'g');
      g.dataset.coord = coord;
      const polygon = documentRef.createElementNS(NS, 'polygon');
      polygon.setAttribute('points', hexPoints(cx, cy, size));
      polygon.classList.add('hex');
      const iconGroup = documentRef.createElementNS(NS, 'g');
      iconGroup.classList.add('tile-icon');
      iconGroup.setAttribute('transform', `translate(${cx} ${cy})`);
      // A small, separate marker for real, known loot sitting on this
      // tile (e.g. a planet's resource) -- positioned off-center (a
      // corner offset, not translate(cx,cy) like the main object icon)
      // so it never visually overlaps the tile's own object icon,
      // mirroring the original pre-engine game's own lootMarker()
      // (a small positioned circle distinct from the tile's main
      // icon). Hidden by default (r=0); updateHexTile below is the only
      // place that ever shows/colors it.
      const lootMarker = documentRef.createElementNS(NS, 'circle');
      lootMarker.classList.add('tile-loot');
      lootMarker.setAttribute('cx', String(cx + size * 0.5));
      lootMarker.setAttribute('cy', String(cy - size * 0.5));
      lootMarker.setAttribute('r', '0');
      g.append(polygon, iconGroup, lootMarker);
      gridGroup.appendChild(g);
      tiles.set(coord, { q, r, cx, cy, g, polygon, iconGroup, lootMarker, kind: undefined, collapsed: undefined, lootType: undefined });
    }
  }
  svg.appendChild(gridGroup);

  const shipsGroup = documentRef.createElementNS(NS, 'g');
  shipsGroup.setAttribute('id', 'ls-ships');
  svg.appendChild(shipsGroup);

  return { svg, tiles, shipsGroup, size };
}

// Rarity-ordered loot colors, matching the real content pack's own
// value ordering (games/last-sector/content/pack.json's own `loot`
// table: scrap < mineral < technology < artifact < ancient) -- dull
// gray-blue for the most common, warm gold for the rarest, the same
// "common to legendary" color progression this kind of game usually
// uses. This project's own `loot` field on a projected tile is only
// ever populated once actually known/discovered (see game.cjs's own
// project()), so no marker shows for loot the viewer hasn't found yet.
const LOOT_COLORS = {
  scrap: '#9db3c4',
  mineral: '#5eead4',
  technology: '#63e6ff',
  artifact: '#c48be0',
  ancient: '#f0c869',
};

/**
 * Applies a tile's `kind` (and reachable/selected/collapsed flags) to
 * its DOM handles. `createIcon(documentRef, kind)` is an injected
 * callback (not hardcoded here) so this module stays focused purely on
 * hex STRUCTURE/geometry correctness -- which icon set to actually draw
 * (this project's existing simple sprite icons, or a richer ported set)
 * is a separate, swappable concern.
 */
export function updateHexTile(documentRef, tileRef, cell, createIcon) {
  const kind = cell?.kind || 'hidden';
  const collapsed = !!cell?.collapsed;
  const lootType = cell?.loot?.type;
  // Real optimization, not a hypothetical one: a live match calls this
  // once per tile on EVERY render() pass (see player-ui/tv-ui main.js's
  // own render loop), typically 81 times for a 9x9 board -- but a real
  // turn usually changes the CONTENTS of only a handful of tiles at
  // most (one move destination, maybe a combat resolution), while the
  // other 70+ (mostly still-'hidden' ones) haven't changed at all.
  // Comparing a small fingerprint up front and skipping EVERY DOM write
  // entirely when nothing about this specific tile actually changed
  // (not just skipping the icon rebuild, which was the only thing
  // already gated before this) is what actually avoids the wasted work,
  // not just some of it.
  if (tileRef.kind === kind && tileRef.collapsed === collapsed && tileRef.lootType === lootType) return;

  if (tileRef.kind !== kind) {
    tileRef.g.dataset.kind = kind;
    tileRef.g.classList.toggle('hidden', kind === 'hidden');
    tileRef.iconGroup.replaceChildren();
    const visible = kind && kind !== 'hidden' && kind !== 'empty' && kind !== 'center';
    if (visible && typeof createIcon === 'function') {
      const icon = createIcon(documentRef, kind);
      if (icon) tileRef.iconGroup.appendChild(icon);
    }
    tileRef.kind = kind;
  }
  if (tileRef.collapsed !== collapsed) {
    tileRef.g.classList.toggle('collapsed', collapsed);
    tileRef.collapsed = collapsed;
  }
  // Real, known loot sitting on this tile (see LOOT_COLORS' own comment
  // above for exactly which field/visibility rules this reads). `cell.loot`
  // is an object like {type:'scrap',...} once known, or null/undefined
  // otherwise -- never rendered at all before this, even though the data
  // was already being sent to the client.
  if (tileRef.lootType !== lootType) {
    tileRef.lootType = lootType;
    if (lootType && LOOT_COLORS[lootType]) {
      tileRef.lootMarker.setAttribute('r', '4.5');
      tileRef.lootMarker.setAttribute('fill', LOOT_COLORS[lootType]);
      // Also set `color` (not just `fill`) to the SAME value -- the CSS
      // glow (filter:drop-shadow(...currentColor...)) reads `color`,
      // not `fill`; without this the glow would inherit whatever color
      // this element happens to sit under in the DOM instead of
      // matching the marker's own actual fill, a real, if minor, visual
      // mismatch caught before it ever shipped.
      tileRef.lootMarker.style.color = LOOT_COLORS[lootType];
    } else {
      tileRef.lootMarker.setAttribute('r', '0');
    }
  }
}

export function setTileReachable(tileRef, on) {
  tileRef.g.classList.toggle('reachable', !!on);
}

export function setTileSelected(tileRef, on) {
  tileRef.g.classList.toggle('selected', !!on);
}

/**
 * Positions (or creates, on first sight of a given ship id) a ship icon
 * group at its tile's hex center. `createShipIcon(documentRef, unit)`
 * is injected the same way `createIcon` is above -- this module only
 * owns WHERE a ship sits, not what it looks like.
 */
export function updateHexShips(documentRef, shipsGroup, units, tiles, shipRefs, createShipIcon) {
  const seen = new Set();
  for (const unit of units ?? []) {
    const tileRef = tiles.get(unit.coord);
    if (!tileRef) continue;
    seen.add(unit.id);
    let ref = shipRefs.get(unit.id);
    if (!ref) {
      const g = createShipIcon ? createShipIcon(documentRef, unit) : documentRef.createElementNS(NS, 'g');
      g.dataset.shipId = unit.id;
      shipsGroup.appendChild(g);
      ref = { g, coord: undefined };
      shipRefs.set(unit.id, ref);
    }
    // Same class of real, measured waste as hex-board.mjs's own
    // updateHexTile fix: a ship sitting still (the common case between
    // its own turns, while OTHER units act) doesn't need its transform
    // rewritten every single render just because SOMETHING on the board
    // changed. Smaller absolute win here (a match has at most a
    // handful of units, not ~81 tiles), but the same real, unconditional
    // DOM write on every call either way.
    if (ref.coord !== unit.coord) {
      ref.g.setAttribute('transform', `translate(${tileRef.cx} ${tileRef.cy})`);
      ref.coord = unit.coord;
    }
  }
  for (const [id, ref] of [...shipRefs]) {
    if (!seen.has(id)) { ref.g.remove(); shipRefs.delete(id); }
  }
}
