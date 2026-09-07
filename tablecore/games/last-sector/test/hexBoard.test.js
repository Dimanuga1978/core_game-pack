import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeSvgDocument } from './fakeSvgDom.js';
import { createHexBoard, updateHexTile, setTileReachable, setTileSelected, updateHexShips, colorForOwner } from '../client/hex-board.mjs';
import { hexPoints } from '../client/hex-geometry.mjs';

test('createHexBoard builds exactly cols*rows tile groups, each with a correctly-shaped polygon', () => {
  const doc = createFakeSvgDocument();
  const { tiles } = createHexBoard(doc, 5, 4, 28);
  assert.equal(tiles.size, 20);
  for (const [coord, ref] of tiles) {
    assert.equal(ref.g.dataset.coord, coord);
    assert.equal(ref.g.children.includes(ref.polygon), true);
    const expectedPoints = hexPoints(ref.cx, ref.cy, 28);
    assert.equal(ref.polygon.getAttribute('points'), expectedPoints, `tile ${coord} polygon points must match hexPoints() exactly, not a rectangle`);
    assert.equal(ref.polygon.classList.contains('hex'), true);
  }
});

test('createHexBoard produces a real viewBox that actually contains every tile center (no tile clipped off-canvas)', () => {
  const doc = createFakeSvgDocument();
  const size = 28;
  const { svg, tiles } = createHexBoard(doc, 6, 6, size);
  const [minX, minY, w, h] = svg.getAttribute('viewBox').split(' ').map(Number);
  for (const ref of tiles.values()) {
    assert.ok(ref.cx - size >= minX, `tile (${ref.q},${ref.r}) left edge clipped: cx-size=${ref.cx - size} < viewBox minX=${minX}`);
    assert.ok(ref.cx + size <= minX + w, `tile (${ref.q},${ref.r}) right edge clipped`);
    assert.ok(ref.cy - size >= minY, `tile (${ref.q},${ref.r}) top edge clipped`);
    assert.ok(ref.cy + size <= minY + h, `tile (${ref.q},${ref.r}) bottom edge clipped`);
  }
});

test('updateHexTile sets kind/collapsed on the tile and only rebuilds the icon when kind actually changes', () => {
  const doc = createFakeSvgDocument();
  const { tiles } = createHexBoard(doc, 2, 2, 28);
  const ref = tiles.get('0,0');
  let iconCalls = 0;
  const createIcon = (d, kind) => { iconCalls++; const el = d.createElementNS('ns', 'g'); el.dataset.kind = kind; return el; };

  updateHexTile(doc, ref, { kind: 'planet' }, createIcon);
  assert.equal(ref.g.dataset.kind, 'planet');
  assert.equal(ref.iconGroup.children.length, 1);
  assert.equal(iconCalls, 1);

  updateHexTile(doc, ref, { kind: 'planet' }, createIcon);
  assert.equal(iconCalls, 1, 'icon must not be recreated when kind is unchanged');

  updateHexTile(doc, ref, { kind: 'hidden' }, createIcon);
  assert.equal(ref.g.classList.contains('hidden'), true);
  assert.equal(ref.iconGroup.children.length, 0, 'a hidden tile must not show an object icon');

  updateHexTile(doc, ref, { kind: 'asteroid', collapsed: true }, createIcon);
  assert.equal(ref.g.classList.contains('collapsed'), true);
});

test('updateHexTile never shows an icon for empty/center kinds (matching the real game rules -- those are not objects)', () => {
  const doc = createFakeSvgDocument();
  const { tiles } = createHexBoard(doc, 1, 1, 28);
  const ref = tiles.get('0,0');
  let iconCalls = 0;
  const createIcon = (d) => { iconCalls++; return d.createElementNS('ns', 'g'); };
  updateHexTile(doc, ref, { kind: 'empty' }, createIcon);
  updateHexTile(doc, ref, { kind: 'center' }, createIcon);
  assert.equal(iconCalls, 0);
});

test('setTileReachable/setTileSelected toggle the right classes without touching anything else', () => {
  const doc = createFakeSvgDocument();
  const { tiles } = createHexBoard(doc, 1, 1, 28);
  const ref = tiles.get('0,0');
  setTileReachable(ref, true);
  assert.equal(ref.g.classList.contains('reachable'), true);
  setTileReachable(ref, false);
  assert.equal(ref.g.classList.contains('reachable'), false);
  setTileSelected(ref, true);
  assert.equal(ref.g.classList.contains('selected'), true);
});

test('updateHexShips places a ship exactly at its tile\'s hex center, creates it once, and moves it (not recreates it) on subsequent updates', () => {
  const doc = createFakeSvgDocument();
  const { tiles, shipsGroup } = createHexBoard(doc, 4, 4, 28);
  const shipRefs = new Map();
  let createCalls = 0;
  const createShipIcon = (d) => { createCalls++; return d.createElementNS('ns', 'g'); };

  const units = [{ id: 'u1', coord: '1,1' }];
  updateHexShips(doc, shipsGroup, units, tiles, shipRefs, createShipIcon);
  assert.equal(createCalls, 1);
  const tileRef = tiles.get('1,1');
  const ref = shipRefs.get('u1');
  assert.equal(ref.g.getAttribute('transform'), `translate(${tileRef.cx} ${tileRef.cy})`);

  const movedUnits = [{ id: 'u1', coord: '2,2' }];
  updateHexShips(doc, shipsGroup, movedUnits, tiles, shipRefs, createShipIcon);
  assert.equal(createCalls, 1, 'moving a ship must reposition the existing element, not create a new one');
  const newTileRef = tiles.get('2,2');
  assert.equal(ref.g.getAttribute('transform'), `translate(${newTileRef.cx} ${newTileRef.cy})`);
});

test('updateHexShips removes a ship element when its unit disappears from the list (e.g. destroyed)', () => {
  const doc = createFakeSvgDocument();
  const { tiles, shipsGroup } = createHexBoard(doc, 3, 3, 28);
  const shipRefs = new Map();
  const createShipIcon = (d) => d.createElementNS('ns', 'g');

  updateHexShips(doc, shipsGroup, [{ id: 'u1', coord: '0,0' }], tiles, shipRefs, createShipIcon);
  assert.equal(shipsGroup.children.length, 1);
  assert.equal(shipRefs.size, 1);

  updateHexShips(doc, shipsGroup, [], tiles, shipRefs, createShipIcon);
  assert.equal(shipsGroup.children.length, 0);
  assert.equal(shipRefs.size, 0);
});

test('updateHexShips silently skips a unit whose coord is off the known board rather than throwing', () => {
  const doc = createFakeSvgDocument();
  const { tiles, shipsGroup } = createHexBoard(doc, 2, 2, 28);
  const shipRefs = new Map();
  assert.doesNotThrow(() => updateHexShips(doc, shipsGroup, [{ id: 'u1', coord: '99,99' }], tiles, shipRefs, (d) => d.createElementNS('ns', 'g')));
  assert.equal(shipRefs.size, 0);
});

test('colorForOwner: the tanker always gets its own fixed color, regardless of viewer', () => {
  assert.equal(colorForOwner('tanker', 'A'), colorForOwner('tanker', 'B'));
  assert.equal(colorForOwner('tanker', null), colorForOwner('tanker', 'C'));
});

test('colorForOwner: the viewer\'s own ship always gets the fixed "this is you" color, regardless of which palette slot their id would otherwise hash to', () => {
  for (const id of ['A', 'B', 'C', 'D', 'my-weird-id-99']) {
    assert.equal(colorForOwner(id, id), 'var(--ls-color-player-strong)');
  }
});

test('colorForOwner: the same owner id always gets the same color for a GIVEN viewer, called repeatedly (deterministic, not random)', () => {
  const first = colorForOwner('B', 'A');
  for (let i = 0; i < 20; i++) assert.equal(colorForOwner('B', 'A'), first);
});

test('colorForOwner: two different real player ids (neither being the viewer) usually get DIFFERENT colors -- real multi-opponent differentiation, not everyone lumped into one "other" color', () => {
  const colors = new Set(['B', 'C', 'D'].map(id => colorForOwner(id, 'A')));
  assert.ok(colors.size >= 2, `expected at least 2 distinct colors among 3 different opponents, got ${colors.size}: ${[...colors]}`);
});

test('colorForOwner: a spectator (selfId=null) never matches the "this is you" branch for any real player', () => {
  for (const id of ['A', 'B', 'C', 'D']) {
    assert.notEqual(colorForOwner(id, null), 'var(--ls-color-player-strong)');
  }
});

test('updateHexTile shows a loot marker (real radius + color) when a tile has known loot, and hides it (r=0) when there is none', () => {
  const doc = createFakeSvgDocument();
  const { tiles } = createHexBoard(doc, 2, 2, 28);
  const ref = tiles.get('0,0');
  assert.equal(ref.lootMarker.getAttribute('r'), '0', 'no loot marker before any real loot is known');

  updateHexTile(doc, ref, { kind: 'planet', loot: { type: 'scrap' } }, (d, k) => d.createElementNS('ns', 'g'));
  assert.notEqual(ref.lootMarker.getAttribute('r'), '0', 'a real, known loot item must show a visible marker');
  assert.ok(ref.lootMarker.getAttribute('fill'), 'the marker must have a real fill color set');

  updateHexTile(doc, ref, { kind: 'planet', loot: null }, (d, k) => d.createElementNS('ns', 'g'));
  assert.equal(ref.lootMarker.getAttribute('r'), '0', 'once the loot is gone (collected), the marker must hide again');
});

test('updateHexTile gives each real loot type its own distinct marker color', () => {
  const doc = createFakeSvgDocument();
  const { tiles } = createHexBoard(doc, 3, 2, 28);
  const colors = new Set();
  const types = ['scrap', 'mineral', 'technology', 'artifact', 'ancient'];
  let i = 0;
  for (const type of types) {
    const ref = tiles.get([...tiles.keys()][i++ % tiles.size]);
    updateHexTile(doc, ref, { kind: 'planet', loot: { type } }, (d, k) => d.createElementNS('ns', 'g'));
    colors.add(ref.lootMarker.getAttribute('fill'));
  }
  assert.equal(colors.size, types.length, `expected ${types.length} distinct colors, one per loot type, got ${colors.size}: ${[...colors]}`);
});

test('the loot marker is a genuinely separate element from the tile\'s main object icon, positioned off-center, so it never visually overlaps a real object icon', () => {
  const doc = createFakeSvgDocument();
  const { tiles } = createHexBoard(doc, 1, 1, 28);
  const ref = tiles.get('0,0');
  assert.notEqual(ref.lootMarker, ref.iconGroup);
  const markerCx = Number(ref.lootMarker.getAttribute('cx'));
  const markerCy = Number(ref.lootMarker.getAttribute('cy'));
  assert.notEqual(markerCx, ref.cx, 'the loot marker must not sit at the exact tile center (where the main object icon renders)');
  assert.notEqual(markerCy, ref.cy);
});

test('a tile kind that never has loot (e.g. hidden or an asteroid) correctly shows no loot marker even if malformed data claims otherwise', () => {
  const doc = createFakeSvgDocument();
  const { tiles } = createHexBoard(doc, 1, 1, 28);
  const ref = tiles.get('0,0');
  updateHexTile(doc, ref, { kind: 'hidden', loot: { type: 'not-a-real-loot-type' } }, (d, k) => d.createElementNS('ns', 'g'));
  assert.equal(ref.lootMarker.getAttribute('r'), '0', 'an unrecognized loot type must not render a marker with no color at all');
});

test('the loot marker\'s CSS color property matches its fill exactly -- the CSS glow effect reads currentColor (color), not fill, so these must stay in sync or the glow silently mismatches the marker\'s own visible color', () => {
  const doc = createFakeSvgDocument();
  const { tiles } = createHexBoard(doc, 1, 1, 28);
  const ref = tiles.get('0,0');
  updateHexTile(doc, ref, { kind: 'planet', loot: { type: 'ancient' } }, (d, k) => d.createElementNS('ns', 'g'));
  assert.equal(ref.lootMarker.style.color, ref.lootMarker.getAttribute('fill'));
});

test('updateHexTile skips ALL DOM writes entirely when nothing about the tile actually changed (real perf optimization: a live render loop calls this once per tile, 81 times for a 9x9 board, on every state update, but a real turn usually only changes a handful of tiles)', () => {
  const doc = createFakeSvgDocument();
  const { tiles } = createHexBoard(doc, 1, 1, 28);
  const ref = tiles.get('0,0');
  let createIconCalls = 0;
  const createIcon = (d, k) => { createIconCalls++; return d.createElementNS('ns', 'g'); };

  updateHexTile(doc, ref, { kind: 'planet' }, createIcon);
  assert.equal(createIconCalls, 1, 'the FIRST call for a tile must do real work (nothing to compare against yet)');
  // Snapshot the real, OBSERVABLE state a browser/CSS would actually see
  // -- this is what "did any DOM mutation happen" genuinely means, not
  // "did some specific internal method get called" (dataset writes and
  // classList.toggle in the real implementation don't go through
  // setAttribute at all, so intercepting THAT specifically would prove
  // nothing either way; an earlier version of this test made exactly
  // that mistake and failed for the wrong reason).
  const snapshotBefore = JSON.stringify({ kind: ref.g.dataset.kind, hidden: ref.g.classList.contains('hidden'), collapsed: ref.g.classList.contains('collapsed'), iconChildren: ref.iconGroup.children.length, lootR: ref.lootMarker.getAttribute('r') });

  // Second call with the EXACT SAME cell data -- a real, common case:
  // most tiles do not change between two consecutive renders.
  updateHexTile(doc, ref, { kind: 'planet' }, createIcon);
  assert.equal(createIconCalls, 1, 'the icon factory must not be called again -- nothing changed');
  const snapshotAfter = JSON.stringify({ kind: ref.g.dataset.kind, hidden: ref.g.classList.contains('hidden'), collapsed: ref.g.classList.contains('collapsed'), iconChildren: ref.iconGroup.children.length, lootR: ref.lootMarker.getAttribute('r') });
  assert.equal(snapshotAfter, snapshotBefore, 'a repeat call with unchanged cell data must leave every observable DOM property exactly as it was');
});

test('updateHexTile still correctly updates when ONLY collapsed changes (kind and loot unchanged) -- the fingerprint check must not accidentally skip a real, partial change', () => {
  const doc = createFakeSvgDocument();
  const { tiles } = createHexBoard(doc, 1, 1, 28);
  const ref = tiles.get('0,0');
  updateHexTile(doc, ref, { kind: 'asteroid', collapsed: false }, (d, k) => d.createElementNS('ns', 'g'));
  assert.equal(ref.g.classList.contains('collapsed'), false);
  updateHexTile(doc, ref, { kind: 'asteroid', collapsed: true }, (d, k) => d.createElementNS('ns', 'g'));
  assert.equal(ref.g.classList.contains('collapsed'), true, 'a collapsed-only change must still be applied even though kind and loot are unchanged');
});

test('updateHexTile still correctly updates when ONLY loot changes (kind and collapsed unchanged)', () => {
  const doc = createFakeSvgDocument();
  const { tiles } = createHexBoard(doc, 1, 1, 28);
  const ref = tiles.get('0,0');
  updateHexTile(doc, ref, { kind: 'planet', loot: null }, (d, k) => d.createElementNS('ns', 'g'));
  assert.equal(ref.lootMarker.getAttribute('r'), '0');
  updateHexTile(doc, ref, { kind: 'planet', loot: { type: 'scrap' } }, (d, k) => d.createElementNS('ns', 'g'));
  assert.notEqual(ref.lootMarker.getAttribute('r'), '0', 'a loot-only change must still be applied even though kind and collapsed are unchanged');
});

test('updateHexShips skips the transform write entirely for a ship that has not moved (same coord as last update) -- same class of real, measured waste as updateHexTile\'s own fingerprint fix', () => {
  const doc = createFakeSvgDocument();
  const { tiles, shipsGroup } = createHexBoard(doc, 4, 4, 28);
  const shipRefs = new Map();
  const createShipIcon = (d) => d.createElementNS('ns', 'g');

  updateHexShips(doc, shipsGroup, [{ id: 'u1', coord: '1,1' }], tiles, shipRefs, createShipIcon);
  const ref = shipRefs.get('u1');
  const transformAfterFirst = ref.g.getAttribute('transform');
  assert.ok(transformAfterFirst, 'the first update for a new ship must set a real transform');

  // Monkey-patch AFTER the first call so we only observe the SECOND one.
  let setAttributeCalls = 0;
  const original = ref.g.setAttribute.bind(ref.g);
  ref.g.setAttribute = (...args) => { setAttributeCalls++; return original(...args); };

  // Same unit, SAME coord -- a real, common case: most units don't move
  // on most renders (only the acting player's own unit does, on their
  // own turn).
  updateHexShips(doc, shipsGroup, [{ id: 'u1', coord: '1,1' }], tiles, shipRefs, createShipIcon);
  assert.equal(setAttributeCalls, 0, 'a ship at an unchanged coord must not have its transform rewritten');
  assert.equal(ref.g.getAttribute('transform'), transformAfterFirst, 'the transform value itself must be unchanged');

  // Now actually move it -- the transform MUST update.
  updateHexShips(doc, shipsGroup, [{ id: 'u1', coord: '2,2' }], tiles, shipRefs, createShipIcon);
  assert.equal(setAttributeCalls, 1, 'a real coord change must still trigger exactly one transform write');
  assert.notEqual(ref.g.getAttribute('transform'), transformAfterFirst);
});
