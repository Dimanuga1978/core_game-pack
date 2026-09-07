import test from 'node:test';
import assert from 'node:assert/strict';
import { hexCenter, hexPoints, computeBoardDimensions, computeBoardPixelSize } from '../client/hex-geometry.mjs';
import { offsetNeighbors } from '../src/game.js';

// The real, meaningful verification this file exists for: a genuinely
// tiled hex grid has a specific, checkable mathematical property --
// every one of a hex's neighbors sits at EXACTLY the same pixel
// distance from its center (sqrt(3)*size). This is not something that
// could accidentally pass if the row-offset math were wrong (e.g.
// shifting even rows instead of odd, or using the wrong half-width) --
// a wrong offset produces neighbors at visibly different, inconsistent
// distances, not just "slightly off" ones.
//
// Neighbors are taken from offsetNeighbors() -- the ENGINE's OWN real
// adjacency function (used for movement legality, scan radius, etc.),
// not reimplemented or guessed here, so this test can't silently drift
// from what the actual game considers "adjacent".

test('every real engine-adjacent hex neighbor sits at the same, correct pixel distance from its center -- true edge-to-edge tiling, not a rectangular grid with gaps', () => {
  const size = 28;
  const w = 9, h = 9;
  const expectedDistance = Math.sqrt(3) * size;
  let checkedPairs = 0;
  for (let r = 0; r < h; r++) {
    for (let q = 0; q < w; q++) {
      const coord = `${q},${r}`;
      const center = hexCenter(q, r, size);
      const neighbors = offsetNeighbors(coord, w, h);
      for (const n of neighbors) {
        const [nq, nr] = n.split(',').map(Number);
        const nCenter = hexCenter(nq, nr, size);
        const dx = nCenter.cx - center.cx, dy = nCenter.cy - center.cy;
        const dist = Math.sqrt(dx * dx + dy * dy);
        assert.ok(Math.abs(dist - expectedDistance) < 0.01, `neighbor ${coord}->${n} distance ${dist} !== expected ${expectedDistance}`);
        checkedPairs++;
      }
    }
  }
  assert.ok(checkedPairs > 300, `sanity: a 9x9 board should have several hundred adjacency pairs to check, got ${checkedPairs}`);
});

test('hexPoints produces exactly 6 vertices, each at exactly `size` distance from the given center', () => {
  const size = 28, cx = 100, cy = 150;
  const pointsStr = hexPoints(cx, cy, size);
  const points = pointsStr.split(' ').map(p => p.split(',').map(Number));
  assert.equal(points.length, 6);
  for (const [x, y] of points) {
    const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
    assert.ok(Math.abs(dist - size) < 1e-9, `vertex (${x},${y}) is ${dist} from center, expected exactly ${size}`);
  }
});

test('hexPoints vertices are evenly spaced 60 degrees apart (a regular hexagon, not a distorted polygon)', () => {
  const size = 28, cx = 0, cy = 0;
  const points = hexPoints(cx, cy, size).split(' ').map(p => p.split(',').map(Number));
  const angles = points.map(([x, y]) => Math.atan2(y, x));
  for (let i = 0; i < 6; i++) {
    const a = angles[i], b = angles[(i + 1) % 6];
    let delta = (b - a + Math.PI * 4) % (Math.PI * 2);
    if (delta > Math.PI) delta = Math.PI * 2 - delta;
    assert.ok(Math.abs(delta - Math.PI / 3) < 0.02, `angle step ${i}->${i + 1} is ${delta} rad, expected pi/3 (60deg)`);
  }
});

test('computeBoardDimensions infers the real board size from a realistic tiles array, including hidden/undiscovered tiles at the far edges', () => {
  const tiles = [];
  for (let r = 0; r < 7; r++) for (let q = 0; q < 5; q++) tiles.push({ coord: `${q},${r}`, kind: (q === 0 && r === 0) ? 'base' : 'hidden' });
  const { cols, rows } = computeBoardDimensions(tiles);
  assert.equal(cols, 5);
  assert.equal(rows, 7);
});

test('computeBoardDimensions handles an empty or malformed tiles list gracefully rather than throwing', () => {
  assert.deepEqual(computeBoardDimensions([]), { cols: 0, rows: 0 });
  assert.deepEqual(computeBoardDimensions(undefined), { cols: 0, rows: 0 });
  assert.deepEqual(computeBoardDimensions([{ coord: 'not-a-coord' }, { coord: null }]), { cols: 0, rows: 0 });
});

test('computeBoardPixelSize grows monotonically with cols/rows/size (no accidental negative or degenerate output)', () => {
  const small = computeBoardPixelSize(5, 5, 28);
  const bigger = computeBoardPixelSize(9, 9, 28);
  assert.ok(bigger.width > small.width);
  assert.ok(bigger.height > small.height);
  assert.ok(small.width > 0 && small.height > 0);
});
