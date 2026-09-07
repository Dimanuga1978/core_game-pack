// Pure hex-grid geometry, no DOM dependency at all -- deliberately kept
// separate from hex-board.mjs's DOM-building code (mirroring the same
// separation the original pre-engine game's own src/board.js used: its
// `center(q,r)`/`points(cx,cy)` were plain functions, with DOM
// construction layered on top). Ported byte-for-byte in formula terms
// from that original implementation -- this project's OWN current
// board rendering (player-ui's `.grid{grid-template-columns:repeat(9,
// ...)}`) was a plain rectangular CSS grid with a gap between cells,
// which is why hexes visually never actually touched each other; this
// restores the real "odd-r offset" hex tiling the original game used,
// where adjacent hex CENTERS really do sit exactly `sqrt(3)*size` (same
// row) or a corresponding diagonal distance apart -- the actual
// geometric property that makes them tile edge-to-edge with no gaps.
//
// Coordinate convention: `q` is column, `r` is row, matching this
// project's own coord string format ("q,r" -- see game.cjs/game.js's
// own `key(q,r)` and offsetNeighbors()). Odd rows (`r%2===1`) are
// shifted right by half a hex width -- the "odd-r" offset scheme,
// confirmed to match this engine's own `cube(coord)` cube-conversion
// formula (`x=q-(r-(r&1))/2`), which is specifically the odd-r inverse.

/**
 * Pixel center of hex (q,r) for a hex of the given `size` (center-to-
 * vertex radius), with an internal (size*2)-ish margin baked in via the
 * `+size` term so the very first tile's polygon never clips off the
 * left/top edge of a viewBox starting at (0,0). Callers needing a
 * tighter/padded viewBox should compute it from `computeBoardPixelSize`
 * below rather than fighting this offset.
 */
export function hexCenter(q, r, size) {
  const w = Math.sqrt(3) * size;
  return { cx: size + q * w + (r % 2 ? w / 2 : 0), cy: size + r * (1.5 * size) };
}

/** The 6 vertex points of a hex centered at (cx,cy), as an SVG `points` attribute string. Vertices at 30,90,150,210,270,330 degrees -- flat-top hexagon orientation, matching hexCenter's odd-r row layout (each row's hexes sit directly beside each other horizontally with a flat vertical seam, not a pointy one). */
export function hexPoints(cx, cy, size) {
  const pts = [];
  for (let i = 0; i < 6; i++) {
    const a = ((60 * i + 30) * Math.PI) / 180;
    pts.push(`${cx + Math.cos(a) * size},${cy + Math.sin(a) * size}`);
  }
  return pts.join(' ');
}

/** The full pixel width/height a `cols`x`rows` hex board occupies at the given `size`, for sizing an SVG viewBox around it (see hexCenter's own doc comment on the built-in `+size` margin this already accounts for on the low end). */
export function computeBoardPixelSize(cols, rows, size) {
  const w = Math.sqrt(3) * size;
  return {
    width: (cols - 1) * w + w + size * 2,
    height: (rows - 1) * 1.5 * size + 2 * size,
  };
}

/**
 * Infers {cols, rows} from a real tiles array/iterable of `{coord}`
 * objects (coord = "q,r" strings) -- deliberately NOT read from any
 * `cfg.w`/`cfg.h` field, because the wire protocol's projected state
 * (see game.cjs's own `project()`) does not currently include board
 * dimensions at all. This is safe and always accurate rather than a
 * fallback/guess: `project()` always includes EVERY board coordinate in
 * the returned tiles array, even ones the viewer hasn't discovered yet
 * (as `{coord, kind:'hidden', ...}` entries) -- confirmed directly
 * against game.cjs's own `project()` source, not assumed. So the
 * coordinate range actually present always covers the real, full board.
 */
export function computeBoardDimensions(tiles) {
  let maxQ = -1, maxR = -1;
  for (const tile of tiles ?? []) {
    const coord = tile?.coord;
    if (typeof coord !== 'string') continue;
    const commaIndex = coord.indexOf(',');
    if (commaIndex < 0) continue;
    const q = Number(coord.slice(0, commaIndex));
    const r = Number(coord.slice(commaIndex + 1));
    if (!Number.isFinite(q) || !Number.isFinite(r)) continue;
    if (q > maxQ) maxQ = q;
    if (r > maxR) maxR = r;
  }
  return { cols: maxQ + 1, rows: maxR + 1 };
}
