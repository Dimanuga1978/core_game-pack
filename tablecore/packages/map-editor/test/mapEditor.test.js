import test from 'node:test';
import assert from 'node:assert/strict';
import { axialDistance, axialToPixel, createHexMapEditor, hexesInRadius, hexKey, parseHexKey, pixelToAxial } from '../src/index.js';

function fixture(radius = 2) {
  const cells = {};
  for (const { q, r } of hexesInRadius(radius)) cells[hexKey(q, r)] = { q, r, terrain: 'plain', object: null };
  return {
    catalog: { terrains: { plain: {}, nebula: {} }, objects: { station: {}, salvage: {} } },
    map: { id: 'sector', radius, cells },
  };
}

test('hex coordinate helpers round-trip through pixel space', () => {
  for (const cell of hexesInRadius(3)) {
    const p = axialToPixel(cell.q, cell.r, 30);
    assert.deepEqual(pixelToAxial(p.x, p.y, 30), cell);
  }
  assert.deepEqual(parseHexKey('2,-1'), { q: 2, r: -1 });
});

test('axial distance and radius enumeration are consistent', () => {
  assert.equal(axialDistance({ q: 2, r: -1 }), 2);
  assert.equal(hexesInRadius(2).length, 19);
  assert.equal(hexesInRadius(4).length, 61);
});

test('map editor selects, paints terrain and places objects without runtime dependencies', () => {
  const editor = createHexMapEditor(fixture());
  editor.setBrush({ terrain: 'nebula', object: 'salvage' });
  const cell = editor.paint(1, -1);
  assert.equal(cell.terrain, 'nebula');
  assert.equal(cell.object, 'salvage');
  assert.deepEqual(editor.select(1, -1), cell);
});

test('map editor can erase objects and reports neighbors', () => {
  const editor = createHexMapEditor(fixture());
  editor.setBrush({ object: 'station' });
  editor.paint(0, 0);
  assert.equal(editor.getCell(0, 0).object, 'station');
  editor.clearObject(0, 0);
  assert.equal(editor.getCell(0, 0).object, null);
  const neighbors = editor.neighbors(0, 0);
  assert.equal(neighbors.length, 6);
  assert.ok(neighbors.every((item) => item.cell != null));
});

test('map editor rejects invalid refs and malformed map shape', () => {
  const base = fixture();
  assert.throws(() => createHexMapEditor({ ...base, map: { ...base.map, cells: { '0,0': { q: 0, r: 0, terrain: 'plain' } } } }));
  const editor = createHexMapEditor(base);
  assert.throws(() => editor.setBrush({ terrain: 'missing' }));
  assert.throws(() => editor.paint(9, 9));
});
