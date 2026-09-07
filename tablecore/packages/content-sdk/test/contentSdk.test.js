import test from 'node:test';
import assert from 'node:assert/strict';
import { createContentCatalog, getContent, materializeMap, requireContent, serializeContentCatalog } from '../src/index.js';

const sample = {
  terrains: {
    asteroid: { id: 'asteroid', fuelCost: 1 },
    dust: { id: 'dust', fuelCost: 1 },
  },
  objects: {
    station: { id: 'station', collectible: false },
    salvage: { id: 'salvage', collectible: true },
  },
  maps: {
    starter: {
      cells: {
        '0,0': { q: 0, r: 0, terrain: 'asteroid', object: 'station' },
        '1,0': { q: 1, r: 0, terrain: 'dust', object: 'salvage' },
      },
    },
  },
  rules: { 'salvage-goal': 3, 'fog-of-war': true },
};

test('content catalog is data-only and clone-safe', () => {
  const catalog = createContentCatalog(sample);
  const terrain = getContent(catalog, 'terrains', 'asteroid');
  terrain.fuelCost = 999;
  assert.equal(getContent(catalog, 'terrains', 'asteroid').fuelCost, 1);
});

test('map materialization validates references', () => {
  const catalog = createContentCatalog(sample);
  const cells = materializeMap(catalog, 'starter');
  assert.equal(cells['0,0'].object, 'station');
  assert.equal(cells['1,0'].terrain, 'dust');
});

test('missing content fails explicitly', () => {
  const catalog = createContentCatalog(sample);
  assert.throws(() => requireContent(catalog, 'objects', 'missing'), /Content not found/);
});

test('catalog can be serialized as JSON-compatible content', () => {
  const catalog = createContentCatalog(sample);
  const parsed = JSON.parse(serializeContentCatalog(catalog));
  assert.deepEqual(parsed, sample);
});
