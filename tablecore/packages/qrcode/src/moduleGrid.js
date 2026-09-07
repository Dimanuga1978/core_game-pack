// Version table for QR codes 1-6 (this package deliberately supports
// ONLY these -- see encoder.js's own module doc comment for why: it
// exists specifically to encode short `/j/XXXXXX` redirect URLs for the
// create-match page's QR codes, not general-purpose arbitrary payloads,
// so there is no need for the full 40-version / multi-EC-block-
// interleaving complexity real QR encoders handle).
//
// IMPORTANT, stated plainly: `totalCodewords` and `ecCodewords` below are
// STANDARDIZED VALUES from the QR specification (ISO/IEC 18004 Table 9),
// not something derivable from first principles the way this file's
// module-position logic is -- there is no way to verify these two
// specific numbers are correct other than checking them against the
// actual spec text or a real scanner. Every OTHER structural piece in
// this package (grid size, finder/timing/alignment positions, data
// placement order, format-info BCH encoding) is either computed directly
// from a formula or independently cross-checked by this package's own
// tests. `totalCodewords` specifically IS cross-checked against a
// programmatically-derived value (this file's own countAvailableDataBits
// counts actual available data-bit positions from the reserved-area
// bitmap and divides by 8) -- see the test that does this. `ecCodewords`
// has no equivalent independent check available within this package; if
// place to look.
export const VERSIONS = {
  1: { size: 21, totalCodewords: 26, ecCodewords: 10, alignmentCenters: [] },
  2: { size: 25, totalCodewords: 44, ecCodewords: 16, alignmentCenters: [18] },
  3: { size: 29, totalCodewords: 70, ecCodewords: 26, alignmentCenters: [22] },
  4: { size: 33, totalCodewords: 100, ecCodewords: 18, alignmentCenters: [26] },
  5: { size: 37, totalCodewords: 134, ecCodewords: 24, alignmentCenters: [30] },
  6: { size: 41, totalCodewords: 172, ecCodewords: 28, alignmentCenters: [34] },
};

/**
 * Builds two same-size boolean grids for the given version:
 *   - `reserved[r][c]`: true if this module is part of a function
 *     pattern (finder, separator, timing, alignment, format-info area,
 *     the fixed dark module) and must NOT be used for data/masking.
 *   - `modules[r][c]`: the actual module value (true=dark) for every
 *     function pattern position; data positions are left `false` here,
 *     filled in later by the data-placement step.
 * Building this as an explicit grid (not a set of ad-hoc position
 * checks scattered through the data-placement/masking code) is what
 * lets `totalCodewords` be cross-checked programmatically -- see this
 * file's own test.
 */
export function buildFunctionPatternGrid(version) {
  const { size, alignmentCenters } = VERSIONS[version];
  const reserved = Array.from({ length: size }, () => new Array(size).fill(false));
  const modules = Array.from({ length: size }, () => new Array(size).fill(false));

  function setModule(r, c, dark) {
    reserved[r][c] = true;
    modules[r][c] = dark;
  }

  function placeFinderPattern(topRow, leftCol) {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = topRow + r, cc = leftCol + c;
        if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
        // 7x7 finder pattern: outer ring dark, then a light ring, then a
        // solid 3x3 dark center -- the standard finder pattern shape,
        // plus a 1-module light separator border around it (the r/c
        // range -1..7 covers exactly that separator too).
        const inFinder = r >= 0 && r <= 6 && c >= 0 && c <= 6;
        let dark = false;
        if (inFinder) {
          const onOuterRing = r === 0 || r === 6 || c === 0 || c === 6;
          const onInnerSquare = r >= 2 && r <= 4 && c >= 2 && c <= 4;
          dark = onOuterRing || onInnerSquare;
        }
        setModule(rr, cc, dark);
      }
    }
  }

  placeFinderPattern(0, 0);
  placeFinderPattern(0, size - 7);
  placeFinderPattern(size - 7, 0);

  // Timing patterns: alternating dark/light modules along row 6 and
  // column 6, between the finder patterns.
  for (let i = 8; i < size - 8; i++) {
    const dark = i % 2 === 0;
    setModule(6, i, dark);
    setModule(i, 6, dark);
  }

  // Alignment pattern(s): a 5x5 dark-ring/light-ring/single-dark-center
  // pattern, centered at every (row,col) combination from
  // alignmentCenters. For versions 1-6 specifically (this package's
  // whole supported range), `alignmentCenters` has at most ONE entry, so
  // there is only ever one (row,col) combination -- always the official,
  // guaranteed-non-overlapping position the spec's own table provides
  // for that version. (A general-purpose encoder supporting all 40
  // versions would need to additionally skip finder-pattern-overlapping
  // COMBINATIONS from a longer alignmentCenters list -- not needed here,
  // and an earlier version of this exact file had a broad, INCORRECT
  // "nearFinder" heuristic attempting that anyway, which wrongly excluded
  // versions 2-6's one valid position too. Caught directly: this
  // package's own totalCodewords cross-check (countAvailableDataBits)
  // came up short by exactly 25 bits -- a 5x5 alignment pattern's worth
  // -- for every version 2-6, immediately pointing at "the alignment
  // pattern isn't actually being placed".)
  for (const centerRow of alignmentCenters) {
    for (const centerCol of alignmentCenters) {
      for (let r = -2; r <= 2; r++) {
        for (let c = -2; c <= 2; c++) {
          const ring = Math.max(Math.abs(r), Math.abs(c));
          const dark = ring !== 1; // outer ring (2) dark, middle ring (1) light, center (0) dark
          setModule(centerRow + r, centerCol + c, dark);
        }
      }
    }
  }

  // Format info reserved areas (the actual 15 bits get written later by
  // writeFormatInfo -- reserved here so data placement skips over them).
  // Two copies, per spec: one wrapping the top-left finder pattern, one
  // split across the bottom-left and top-right finder patterns.
  for (let i = 0; i <= 8; i++) { reserved[8][i] = true; reserved[i][8] = true; }
  for (let i = 0; i < 8; i++) { reserved[8][size - 1 - i] = true; reserved[size - 1 - i][8] = true; }

  // The single fixed dark module, always at (4*version+9, 8) per spec --
  // always dark, part of the format-info structure.
  setModule(4 * version + 9, 8, true);

  return { size, reserved, modules };
}

/**
 * Counts how many modules are NOT reserved (i.e. available for actual
 * data bits), for cross-checking `VERSIONS[version].totalCodewords`
 * against something this package computed itself rather than only
 * trusting the same hardcoded table both the encoder and this check
 * would otherwise share.
 */
export function countAvailableDataBits(version) {
  const { reserved } = buildFunctionPatternGrid(version);
  let count = 0;
  for (const row of reserved) for (const cell of row) if (!cell) count++;
  return count;
}
