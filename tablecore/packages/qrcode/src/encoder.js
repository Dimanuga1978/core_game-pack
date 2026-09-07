// QR code encoder for short byte-mode payloads (versions 1-6 only --
// see this file's own scoping note below). Every piece here is either
// computed from a formula, or where a genuine standardized constant is
// unavoidable, clearly labeled as such (see moduleGrid.js's own comment
// on `totalCodewords`/`ecCodewords`, and the BCH generator/mask constants
// below) so a real scan failure has an obvious, narrow place to look.
import { VERSIONS, buildFunctionPatternGrid } from './moduleGrid.js';
import { reedSolomonEncode } from './galoisField.js';

// Deliberately scoped to versions 1-6, EC level M, a SINGLE Reed-Solomon
// block, byte mode only, and always mask pattern 0. This package exists
// specifically to encode short `/j/XXXXXX`-style redirect URLs (see
// tools/server/start.mjs's join-code system) for the create-match page's
// QR codes -- roughly 20-40 characters -- not general-purpose arbitrary
// QR payloads. The full QR spec supports 40 versions, 4 EC levels, and
// multi-block Reed-Solomon interleaving for larger payloads; none of
// that complexity is needed for this actual use case, and every version
// added multiplies the number of standardized magic-number table entries
// that have to be exactly right with no first-principles way to verify
// them short of a real scanner (see moduleGrid.js's own comment on this
// same tradeoff) -- staying small on purpose keeps that risk bounded.
const EC_LEVEL_M_BITS = 0b00; // per spec: L=01, M=00, Q=11, H=10
const MASK_PATTERN = 0; // condition (row+col)%2==0 -- ALWAYS valid, just not necessarily optimal; mask selection is a QUALITY optimization (better contrast/scannability), not a correctness requirement, and skipping the full 4-penalty-rule scoring algorithm removes another whole category of "did I get this exactly right" risk for comparatively little real cost given how short these payloads are.
const FORMAT_GENERATOR = 0b10100110111; // BCH(15,5) generator polynomial, degree 10
const FORMAT_XOR_MASK = 0b101010000010010; // fixed 15-bit mask XORed onto every format-info codeword, per spec

function bchRemainder(data, generator, generatorDegree) {
  let value = data;
  const dataDegree = 31 - Math.clz32(value);
  for (let shift = dataDegree - generatorDegree; shift >= 0; shift--) {
    if (value & (1 << (shift + generatorDegree))) value ^= generator << shift;
  }
  return value;
}

function formatInfoBits(maskPattern) {
  const data = (EC_LEVEL_M_BITS << 3) | maskPattern; // 5 bits: 2 EC-level + 3 mask
  const remainder = bchRemainder(data << 10, FORMAT_GENERATOR, 10);
  const codeword = (data << 10) | remainder; // 15 bits total
  return codeword ^ FORMAT_XOR_MASK;
}

function writeFormatInfo(grid, maskPattern) {
  const bits = formatInfoBits(maskPattern);
  const { size, modules } = grid;
  const bit = i => (bits >> i) & 1;
  for (let i = 0; i <= 5; i++) modules[8][i] = !!bit(i);
  modules[8][7] = !!bit(6);
  modules[8][8] = !!bit(7);
  modules[7][8] = !!bit(8);
  for (let i = 9; i <= 14; i++) modules[14 - i][8] = !!bit(i);
  for (let i = 0; i <= 7; i++) modules[size - 1 - i][8] = !!bit(i);
  for (let i = 8; i <= 14; i++) modules[8][size - 15 + i] = !!bit(i);
}

function* dataPositions(size, reserved) {
  let upward = true;
  for (let colPair = size - 1; colPair > 0; colPair -= 2) {
    const rightCol = colPair === 6 ? 5 : colPair;
    const leftCol = rightCol - 1;
    const rows = upward ? [...Array(size).keys()].reverse() : [...Array(size).keys()];
    for (const row of rows) {
      for (const col of [rightCol, leftCol]) {
        if (!reserved[row][col]) yield [row, col];
      }
    }
    upward = !upward;
  }
}

function bytesToBits(bytes) {
  const bits = [];
  for (const byte of bytes) for (let i = 7; i >= 0; i--) bits.push((byte >> i) & 1);
  return bits;
}

function buildDataCodewords(payloadBytes, dataCodewordCount) {
  const bits = [];
  const pushBits = (value, count) => { for (let i = count - 1; i >= 0; i--) bits.push((value >> i) & 1); };
  pushBits(0b0100, 4);
  pushBits(payloadBytes.length, 8);
  for (const byte of payloadBytes) pushBits(byte, 8);
  const capacityBits = dataCodewordCount * 8;
  if (bits.length > capacityBits) {
    throw new RangeError(`payload too large for the requested capacity: needs ${bits.length} bits, have ${capacityBits} (${payloadBytes.length} bytes of payload) -- this encoder only supports versions 1-6; use a shorter payload (see the join-code system this exists for)`);
  }
  for (let i = 0; i < 4 && bits.length < capacityBits; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);
  const codewords = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
    codewords.push(byte);
  }
  const padBytes = [0xEC, 0x11];
  let padIndex = 0;
  while (codewords.length < dataCodewordCount) { codewords.push(padBytes[padIndex % 2]); padIndex++; }
  return codewords;
}

function pickVersion(payloadByteLength) {
  for (const [version, info] of Object.entries(VERSIONS)) {
    const dataCodewordCount = info.totalCodewords - info.ecCodewords;
    if (dataCodewordCount * 8 >= payloadByteLength * 8 + 4 + 8) return Number(version);
  }
  return null;
}

/**
 * Encodes `text` (a UTF-8 string, but this is meant for plain ASCII
 * URLs -- see this file's own scoping note) as a QR code. Returns
 * `{version, size, modules}` where `modules[row][col]` is true for a
 * dark module. Throws RangeError if the text is too long for any
 * supported version (1-6).
 */
export function encodeQr(text) {
  const payloadBytes = Array.from(new TextEncoder().encode(text));
  const version = pickVersion(payloadBytes.length);
  if (version === null) {
    throw new RangeError(`text too long (${payloadBytes.length} bytes) for this encoder's supported versions (1-6) -- this is meant for short redirect URLs, not arbitrary payloads`);
  }
  const info = VERSIONS[version];
  const dataCodewordCount = info.totalCodewords - info.ecCodewords;
  const dataCodewords = buildDataCodewords(payloadBytes, dataCodewordCount);
  const ecCodewords = reedSolomonEncode(dataCodewords, info.ecCodewords);
  const allCodewords = [...dataCodewords, ...ecCodewords];
  const allBits = bytesToBits(allCodewords);

  const grid = buildFunctionPatternGrid(version);
  const { size, reserved, modules } = grid;
  let bitIndex = 0;
  for (const [row, col] of dataPositions(size, reserved)) {
    const bit = bitIndex < allBits.length ? allBits[bitIndex] : 0;
    bitIndex++;
    const maskCondition = (row + col) % 2 === 0;
    modules[row][col] = maskCondition ? !bit : !!bit;
  }
  writeFormatInfo(grid, MASK_PATTERN);

  return { version, size, modules };
}
