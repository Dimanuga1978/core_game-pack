/** Data-only content layer for Game Packs.
 * Content definitions are JSON-compatible data: no engine or network dependencies.
 */
const clone = (v) => structuredClone(v);

const ID_RE = /^[a-z][a-z0-9._-]*$/;
const assertId = (id, label) => {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new TypeError(`Invalid ${label} id: ${id}`);
};

function validateMapCell(cell, key) {
  if (!cell || typeof cell !== 'object') throw new TypeError(`Invalid map cell: ${key}`);
  if (!Number.isInteger(cell.q) || !Number.isInteger(cell.r)) throw new TypeError(`Invalid coordinates: ${key}`);
  if (typeof cell.terrain !== 'string') throw new TypeError(`Map cell ${key} requires terrain`);
  if (cell.object != null && typeof cell.object !== 'string') throw new TypeError(`Map cell ${key} has invalid object`);
}

export function validateContentCatalog(definition) {
  if (!definition || typeof definition !== 'object') throw new TypeError('Content catalog must be an object');
  const groups = ['terrains', 'objects', 'maps', 'rules'];
  for (const group of groups) {
    if (definition[group] != null && (typeof definition[group] !== 'object' || Array.isArray(definition[group]))) {
      throw new TypeError(`${group} must be an object`);
    }
  }
  for (const [id, value] of Object.entries(definition.terrains ?? {})) {
    assertId(id, 'terrain');
    if (!value || typeof value !== 'object') throw new TypeError(`Invalid terrain: ${id}`);
    if (value.id != null && value.id !== id) throw new TypeError(`Terrain id mismatch: ${id}`);
  }
  for (const [id, value] of Object.entries(definition.objects ?? {})) {
    assertId(id, 'object');
    if (!value || typeof value !== 'object') throw new TypeError(`Invalid object: ${id}`);
    if (value.id != null && value.id !== id) throw new TypeError(`Object id mismatch: ${id}`);
  }
  for (const [mapId, map] of Object.entries(definition.maps ?? {})) {
    assertId(mapId, 'map');
    if (!map || typeof map !== 'object' || Array.isArray(map)) throw new TypeError(`Invalid map: ${mapId}`);
    for (const [key, cell] of Object.entries(map.cells ?? {})) validateMapCell(cell, key);
  }
  for (const [id, value] of Object.entries(definition.rules ?? {})) {
    assertId(id, 'rule');
    if (value == null || typeof value !== 'number' && typeof value !== 'string' && typeof value !== 'boolean' && typeof value !== 'object') {
      throw new TypeError(`Invalid rule value: ${id}`);
    }
  }
  return true;
}

export function createContentCatalog(definition) {
  validateContentCatalog(definition);
  const catalog = {
    terrains: clone(definition.terrains ?? {}),
    objects: clone(definition.objects ?? {}),
    maps: clone(definition.maps ?? {}),
    rules: clone(definition.rules ?? {}),
  };
  return Object.freeze(catalog);
}

export function getContent(catalog, group, id) {
  if (!catalog || !catalog[group]) return null;
  const value = catalog[group][id];
  return value == null ? null : clone(value);
}

export function requireContent(catalog, group, id) {
  const value = getContent(catalog, group, id);
  if (value == null) throw new Error(`Content not found: ${group}.${id}`);
  return value;
}

export function materializeMap(catalog, mapId) {
  const map = requireContent(catalog, 'maps', mapId);
  const terrainIds = new Set(Object.keys(catalog.terrains ?? {}));
  const objectIds = new Set(Object.keys(catalog.objects ?? {}));
  const cells = {};
  for (const [key, cell] of Object.entries(map.cells ?? {})) {
    if (!terrainIds.has(cell.terrain)) throw new Error(`Unknown terrain reference: ${cell.terrain}`);
    if (cell.object != null && !objectIds.has(cell.object)) throw new Error(`Unknown object reference: ${cell.object}`);
    cells[key] = clone(cell);
  }
  return cells;
}

export function serializeContentCatalog(catalog) {
  validateContentCatalog(catalog);
  return JSON.stringify(catalog, null, 2);
}
