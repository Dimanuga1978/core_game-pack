// A decoder built specifically to round-trip-verify encoder.js's output
// -- NOT a general camera-image QR decoder (this package has no image
// processing at all; it only ever reads a module grid this same package
// already produced). Deliberately written to read the grid "from
// scratch" using the same structural spec rules the encoder used
// (finder/format-info positions are fixed by the spec, not chosen by the
// encoder; the zigzag data traversal order is a spec rule, not an
// encoder implementation detail) rather than reusing any of the
// encoder's own internal state -- this is what makes a successful round
// trip a REAL check rather than a tautology that would pass even if
// encoder and decoder shared the same wrong assumption about, say, which
// direction the zigzag goes.
//
// It genuinely cannot prove a code will scan on a real phone camera --
// it has no way to verify VISUAL/OPTICAL properties (module contrast,
// print/screen resolution, finder pattern detectability under real
// lighting) at all, only that the STRUCTURED DATA a compliant reader
// would extract from this exact module grid comes back correctly. A
// real phone scan is still the final word on scannability.
import { VERSIONS, buildFunctionPatternGrid } from './moduleGrid.js';

const FORMAT_GENERATOR = 0b10100110111;
const FORMAT_XOR_MASK = 0b101010000010010;

function bchRemainder(data, generator, generatorDegree) {
  let value = data;
  const dataDegree = 31 - Math.clz32(value);
  for (let shift = dataDegree - generatorDegree; shift >= 0; shift--) {
    if (value & (1 << (shift + generatorDegree))) value ^= generator << shift;
  }
  return value;
}

function readFormatInfo(modules) {
  const bit = (r, c) => (modules[r][c] ? 1 : 0);
  let copy1 = 0;
  for (let i = 0; i <= 5; i++) copy1 |= bit(8, i) << i;
  copy1 |= bit(8, 7) << 6;
  copy1 |= bit(8, 8) << 7;
  copy1 |= bit(7, 8) << 8;
  for (let i = 9; i <= 14; i++) copy1 |= bit(14 - i, 8) << i;
  return copy1 ^ FORMAT_XOR_MASK;
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

/**
 * Decodes a module grid produced by encodeQr() back into
 * `{version, maskPattern, ecLevelBits, formatValid, text}`.
 */
export function decodeQr({ version, size, modules }) {
  const info = VERSIONS[version];
  const grid = buildFunctionPatternGrid(version);
  const reserved = grid.reserved;

  const formatCodeword = readFormatInfo(modules);
  const formatData = formatCodeword >> 10;
  const formatCheck = bchRemainder(formatCodeword, FORMAT_GENERATOR, 10);
  const formatValid = formatCheck === 0;
  const ecLevelBits = (formatData >> 3) & 0b11;
  const maskPattern = formatData & 0b111;

  const bits = [];
  for (const [row, col] of dataPositions(size, reserved)) {
    const maskCondition = maskPattern === 0 ? (row + col) % 2 === 0 : false;
    const raw = modules[row][col];
    bits.push((maskCondition ? !raw : raw) ? 1 : 0);
  }
  const codewords = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
    codewords.push(byte);
  }
  const dataCodewordCount = info.totalCodewords - info.ecCodewords;
  const dataCodewords = codewords.slice(0, dataCodewordCount);

  const dataBits = [];
  for (const byte of dataCodewords) for (let i = 7; i >= 0; i--) dataBits.push((byte >> i) & 1);
  let pos = 0;
  const readBits = n => { let v = 0; for (let i = 0; i < n; i++) v = (v << 1) | dataBits[pos++]; return v; };
  const modeIndicator = readBits(4);
  if (modeIndicator !== 0b0100) throw new Error(`expected byte-mode indicator 0100, got ${modeIndicator.toString(2).padStart(4, '0')}`);
  const length = readBits(8);
  const payloadBytes = [];
  for (let i = 0; i < length; i++) payloadBytes.push(readBits(8));

  return {
    version, maskPattern, ecLevelBits, formatValid,
    text: new TextDecoder().decode(new Uint8Array(payloadBytes)),
  };
}
