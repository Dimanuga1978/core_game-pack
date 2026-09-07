/**
 * Hex map authoring model.
 * Data-only editor layer: never imports runtime/server/networking code.
 */
const clone = (value) => structuredClone(value);
const ID_RE = /^[a-z][a-z0-9._-]*$/;
const HEX_DIRECTIONS = [
  { id: 'E', dq: 1, dr: 0 },
  { id: 'NE', dq: 1, dr: -1 },
  { id: 'NW', dq: 0, dr: -1 },
  { id: 'W', dq: -1, dr: 0 },
  { id: 'SW', dq: -1, dr: 1 },
  { id: 'SE', dq: 0, dr: 1 },
];

export const hexKey = (q, r) => `${q},${r}`;
export const parseHexKey = (key) => {
  if (typeof key !== 'string') throw new TypeError('Hex key must be a string');
  const match = /^(0|-?[1-9][0-9]*),(0|-?[1-9][0-9]*)$/.exec(key);
  if (!match) throw new TypeError(`Invalid hex key: ${key}`);
  return { q: Number(match[1]), r: Number(match[2]) };
};

export function axialDistance(a, b = { q: 0, r: 0 }) {
  return Math.max(Math.abs(a.q - b.q), Math.abs(a.r - b.r), Math.abs((a.q + a.r) - (b.q + b.r)));
}

export function hexesInRadius(radius) {
  if (!Number.isInteger(radius) || radius < 0) throw new RangeError('radius must be a non-negative integer');
  const cells = [];
  for (let q = -radius; q <= radius; q += 1) {
    const rMin = Math.max(-radius, -q - radius);
    const rMax = Math.min(radius, -q + radius);
    for (let r = rMin; r <= rMax; r += 1) cells.push({ q, r });
  }
  return cells;
}

export function axialToPixel(q, r, size = 32) {
  if (![q, r, size].every(Number.isFinite) || size <= 0) throw new TypeError('Invalid axial pixel parameters');
  return {
    x: size * Math.sqrt(3) * (q + r / 2),
    y: size * 1.5 * r,
  };
}

export function pixelToAxial(x, y, size = 32) {
  if (![x, y, size].every(Number.isFinite) || size <= 0) throw new TypeError('Invalid pixel parameters');
  const q = (Math.sqrt(3) / 3 * x - 1 / 3 * y) / size;
  const r = (2 / 3 * y) / size;
  return cubeRound({ x: q, y: -q - r, z: r });
}

function cubeRound(frac) {
  let x = Math.round(frac.x);
  let y = Math.round(frac.y);
  let z = Math.round(frac.z);
  const dx = Math.abs(x - frac.x);
  const dy = Math.abs(y - frac.y);
  const dz = Math.abs(z - frac.z);
  if (dx > dy && dx > dz) x = -y - z;
  else if (dy > dz) y = -x - z;
  else z = -x - y;
  return { q: Object.is(x, -0) ? 0 : x, r: Object.is(z, -0) ? 0 : z };
}

export function hexPolygonPoints(size = 32) {
  if (!Number.isFinite(size) || size <= 0) throw new RangeError('size must be > 0');
  return Array.from({ length: 6 }, (_, i) => {
    const angle = Math.PI / 180 * (60 * i - 30);
    return { x: size * Math.cos(angle), y: size * Math.sin(angle) };
  });
}

function assertId(id, label) {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new TypeError(`Invalid ${label} id: ${id}`);
}

function assertCatalog(catalog) {
  if (!catalog || typeof catalog !== 'object') throw new TypeError('catalog is required');
  if (!catalog.terrains || !catalog.objects) throw new TypeError('catalog requires terrains and objects');
}

export class HexMapEditorModel {
  constructor({ map, catalog, radius = null } = {}) {
    assertCatalog(catalog);
    if (!map || typeof map !== 'object' || Array.isArray(map)) throw new TypeError('map is required');
    this.catalog = clone(catalog);
    this.map = clone(map);
    this.selected = null;
    this.brush = { terrain: null, object: null, eraseObject: false };
    this.radius = radius ?? map.radius ?? inferRadius(map.cells ?? {});
    this.validateMapShape();
  }

  listCells() {
    return Object.entries(this.map.cells ?? {}).map(([key, cell]) => ({ key, ...clone(cell) }));
  }

  getCell(q, r) {
    const value = this.map.cells?.[hexKey(q, r)];
    return value == null ? null : clone(value);
  }

  select(q, r) {
    const key = hexKey(q, r);
    if (!(key in (this.map.cells ?? {}))) return null;
    this.selected = { q, r };
    return this.getCell(q, r);
  }

  setBrush({ terrain = null, object = null, eraseObject = false } = {}) {
    if (terrain != null) {
      assertId(terrain, 'terrain');
      if (!this.catalog.terrains[terrain]) throw new TypeError(`Unknown terrain: ${terrain}`);
    }
    if (object != null) {
      assertId(object, 'object');
      if (!this.catalog.objects[object]) throw new TypeError(`Unknown object: ${object}`);
    }
    this.brush = { terrain, object, eraseObject: Boolean(eraseObject) };
    return clone(this.brush);
  }

  paint(q, r, patch = this.brush) {
    const key = hexKey(q, r);
    const cell = this.map.cells?.[key];
    if (!cell) throw new RangeError(`Hex outside map: ${key}`);
    if (patch.terrain != null) {
      assertId(patch.terrain, 'terrain');
      if (!this.catalog.terrains[patch.terrain]) throw new TypeError(`Unknown terrain: ${patch.terrain}`);
      cell.terrain = patch.terrain;
    }
    if (patch.eraseObject) cell.object = null;
    else if (patch.object != null) {
      assertId(patch.object, 'object');
      if (!this.catalog.objects[patch.object]) throw new TypeError(`Unknown object: ${patch.object}`);
      cell.object = patch.object;
    }
    this.selected = { q, r };
    return this.getCell(q, r);
  }

  clearObject(q, r) {
    return this.paint(q, r, { terrain: null, object: null, eraseObject: true });
  }

  fillTerrain(terrain) {
    assertId(terrain, 'terrain');
    if (!this.catalog.terrains[terrain]) throw new TypeError(`Unknown terrain: ${terrain}`);
    for (const cell of Object.values(this.map.cells ?? {})) cell.terrain = terrain;
    return this.listCells();
  }

  neighbors(q, r) {
    return HEX_DIRECTIONS.map((direction) => ({
      direction: direction.id,
      q: q + direction.dq,
      r: r + direction.dr,
      cell: this.getCell(q + direction.dq, r + direction.dr),
    }));
  }

  validateMapShape() {
    const expected = new Set(hexesInRadius(this.radius).map(({ q, r }) => hexKey(q, r)));
    const actual = new Set(Object.keys(this.map.cells ?? {}));
    for (const key of actual) parseHexKey(key);
    const missing = [...expected].filter((key) => !actual.has(key));
    const extra = [...actual].filter((key) => !expected.has(key));
    if (missing.length || extra.length) {
      const err = new Error(`Map shape mismatch: missing=${missing.length}, extra=${extra.length}`);
      err.missing = missing;
      err.extra = extra;
      throw err;
    }
    return true;
  }

  snapshot() {
    return clone(this.map);
  }
}

function inferRadius(cells) {
  const max = Object.keys(cells).reduce((acc, key) => {
    const { q, r } = parseHexKey(key);
    return Math.max(acc, Math.abs(q), Math.abs(r), Math.abs(q + r));
  }, 0);
  return max;
}

export function createHexMapEditor(options) {
  return new HexMapEditorModel(options);
}
