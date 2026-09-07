import test from 'node:test';
import assert from 'node:assert/strict';
import { VERSIONS, buildFunctionPatternGrid, countAvailableDataBits } from '../src/moduleGrid.js';

// The real, meaningful independent verification for this file: three
// separately-sourced pieces of information (a memorized totalCodewords
// value, a memorized remainder-bits value, and a bitmap of reserved
// modules built purely from structural placement RULES, not from any
// codeword count) must all agree, for every supported version. This is
// not a tautology -- an earlier version of the alignment-pattern
// placement logic had a real bug (an overly broad "avoid the finder
// pattern" heuristic that wrongly skipped versions 2-6's one valid
// alignment position entirely), and this exact cross-check is what
// caught it: available bits came up short by precisely 25 (a 5x5
// alignment pattern's worth) for every affected version.
const REMAINDER_BITS = { 1: 0, 2: 7, 3: 7, 4: 7, 5: 7, 6: 7 };

test('countAvailableDataBits, independently derived from the reserved-module bitmap, matches the memorized totalCodewords table for every supported version', () => {
  for (const [version, info] of Object.entries(VERSIONS)) {
    const bits = countAvailableDataBits(Number(version));
    const computedCodewords = (bits - REMAINDER_BITS[version]) / 8;
    assert.equal(computedCodewords, info.totalCodewords, `version ${version}: computed ${computedCodewords} codewords from the reserved-bitmap, but the table says ${info.totalCodewords}`);
  }
});

test('grid size matches the standard (version*4+17) formula for every supported version', () => {
  for (const [version, info] of Object.entries(VERSIONS)) {
    assert.equal(info.size, Number(version) * 4 + 17);
  }
});

test('the three finder patterns are placed at the correct corners and have the correct 7x7 ring/ring/solid shape', () => {
  const { size, modules } = buildFunctionPatternGrid(3);
  for (let i = 0; i < 7; i++) {
    assert.equal(modules[0][i], true, `top-left finder top edge, col ${i}`);
    assert.equal(modules[6][i], true, `top-left finder bottom edge, col ${i}`);
    assert.equal(modules[i][0], true, `top-left finder left edge, row ${i}`);
    assert.equal(modules[i][6], true, `top-left finder right edge, row ${i}`);
  }
  for (let r = 2; r <= 4; r++) for (let c = 2; c <= 4; c++) assert.equal(modules[r][c], true, `top-left finder center (${r},${c})`);
  assert.equal(modules[1][1], false, 'the ring between the outer border and the center must be light');
  assert.equal(modules[3][size - 4], true, 'top-right finder center');
  assert.equal(modules[size - 4][3], true, 'bottom-left finder center');
});

test('the timing patterns alternate dark/light along row 6 and column 6', () => {
  const { size, modules, reserved } = buildFunctionPatternGrid(2);
  for (let i = 8; i < size - 8; i++) {
    assert.equal(reserved[6][i], true);
    assert.equal(reserved[i][6], true);
    assert.equal(modules[6][i], i % 2 === 0, `row-6 timing pattern at col ${i}`);
    assert.equal(modules[i][6], i % 2 === 0, `col-6 timing pattern at row ${i}`);
  }
});

test('version 1 has no alignment pattern, versions 2-6 each have exactly one, at the documented center', () => {
  const v1 = buildFunctionPatternGrid(1);
  assert.equal(v1.reserved[10][10], false);

  for (let version = 2; version <= 6; version++) {
    const { reserved } = buildFunctionPatternGrid(version);
    const center = VERSIONS[version].alignmentCenters[0];
    assert.equal(reserved[center][center], true, `version ${version} alignment pattern center (${center},${center}) must be reserved`);
    for (let r = -2; r <= 2; r++) for (let c = -2; c <= 2; c++) {
      assert.equal(reserved[center + r][center + c], true, `version ${version} alignment pattern extent at offset (${r},${c})`);
    }
  }
});

test('the fixed dark module is placed at (4*version+9, 8) and is dark', () => {
  for (const version of [1, 2, 3, 4, 5, 6]) {
    const { modules, reserved } = buildFunctionPatternGrid(version);
    const row = 4 * version + 9;
    assert.equal(reserved[row][8], true);
    assert.equal(modules[row][8], true);
  }
});
