// GF(256) arithmetic for QR code Reed-Solomon error correction, per
// ISO/IEC 18004. Deliberately COMPUTED from the primitive polynomial
// (0x11D = x^8+x^4+x^3+x^2+1, the standard one QR codes use), not
// hand-transcribed as lookup tables -- a wrong magic number in a
// hardcoded table is a real, easy-to-make mistake with no way to notice
// it's wrong just by looking at it; a short, simple GENERATING loop is
// something whose correctness is much easier to reason about directly.
const EXP = new Uint8Array(512); // log/antilog tables, doubled to avoid modulo in multiply()
const LOG = new Uint8Array(256);

(function buildTables() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11D; // reduce mod the primitive polynomial
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

export function gfMultiply(a, b) {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

/**
 * Builds the Reed-Solomon generator polynomial for `ecCount` error
 * correction codewords, as coefficients from highest to lowest degree
 * (matching how it's used below). Standard construction: start with the
 * polynomial "1" and repeatedly multiply by (x - alpha^i) for
 * i = 0..ecCount-1 (over GF(256), so "-" is the same as "+" / XOR).
 */
export function generatorPolynomial(ecCount) {
  let poly = [1];
  for (let i = 0; i < ecCount; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMultiply(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

/**
 * Computes the Reed-Solomon error correction codewords for `data`
 * (array of byte values), producing exactly `ecCount` EC codewords.
 * This is polynomial division of the data (as a polynomial with `data`
 * as coefficients, degree-shifted up by ecCount) by the generator
 * polynomial, keeping the remainder -- the standard QR/Reed-Solomon
 * encoding algorithm.
 */
export function reedSolomonEncode(data, ecCount) {
  const generator = generatorPolynomial(ecCount);
  // generator[0] is always 1 (each factor (x - alpha^i) is monic, and the
  // product of monic polynomials is monic) -- the classic optimization
  // below only folds generator[1..ecCount] (ecCount terms) into the
  // ecCount-length remainder, since generator[0]'s contribution exactly
  // cancels the `factor` that was just shifted out. Writing the naive
  // `for (i=0;i<generator.length;i++)` version instead (iterating all
  // ecCount+1 coefficients against an ecCount-length array) silently
  // grows `remainder` past its intended length in JS (arrays auto-extend
  // on out-of-bounds writes) -- a real bug found and fixed via this
  // package's own length-assertion test.
  const remainder = new Array(ecCount).fill(0);
  for (const byte of data) {
    const factor = byte ^ remainder[0];
    remainder.shift();
    remainder.push(0);
    if (factor !== 0) {
      for (let i = 0; i < ecCount; i++) {
        remainder[i] ^= gfMultiply(generator[i + 1], factor);
      }
    }
  }
  return remainder;
}
