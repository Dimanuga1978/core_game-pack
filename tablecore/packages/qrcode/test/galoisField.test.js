import test from 'node:test';
import assert from 'node:assert/strict';
import { gfMultiply, generatorPolynomial, reedSolomonEncode } from '../src/galoisField.js';

test('gfMultiply basic identities', () => {
  assert.equal(gfMultiply(5, 0), 0);
  assert.equal(gfMultiply(0, 5), 0);
  assert.equal(gfMultiply(1, 47), 47);
  assert.equal(gfMultiply(47, 1), 47);
});

test('gfMultiply is commutative for a real sample of values', () => {
  for (let a = 1; a < 256; a += 17) {
    for (let b = 1; b < 256; b += 23) {
      assert.equal(gfMultiply(a, b), gfMultiply(b, a));
    }
  }
});

test('gfMultiply distributes over XOR (GF(256) addition), a real algebraic property, not a memorized value', () => {
  // a*(b XOR c) == (a*b) XOR (a*c) must hold in any field -- checking
  // this doesn't require knowing what the "right" answer is supposed to
  // be from an external reference, only that the arithmetic is
  // internally consistent with what a field actually is.
  for (let a = 1; a < 256; a += 13) {
    for (let b = 1; b < 256; b += 19) {
      for (let c = 1; c < 256; c += 29) {
        const left = gfMultiply(a, b ^ c);
        const right = gfMultiply(a, b) ^ gfMultiply(a, c);
        assert.equal(left, right, `distributivity failed for a=${a} b=${b} c=${c}`);
      }
    }
  }
});

test('generatorPolynomial always starts and ends with a nonzero (monic-adjacent) coefficient, for a range of realistic EC counts', () => {
  for (const ecCount of [2, 5, 7, 10, 13, 16, 18, 22, 26, 28, 30]) {
    const g = generatorPolynomial(ecCount);
    assert.equal(g.length, ecCount + 1, `generator for ecCount=${ecCount} must have degree ecCount (ecCount+1 coefficients)`);
    assert.notEqual(g[0], 0, 'leading coefficient must be nonzero');
    assert.notEqual(g[g.length - 1], 0, 'constant term must be nonzero (product of nonzero alpha powers is never zero)');
  }
});

// The real, independent-of-memorized-reference-values verification: a
// valid Reed-Solomon codeword (data codewords followed by EC codewords,
// treated as one polynomial with the EC-appended data as coefficients)
// evaluates to ZERO at every root of the generator polynomial
// (alpha^0, alpha^1, ..., alpha^(ecCount-1)). This is not something that
// could accidentally happen to be true if the encoding were wrong -- it
// is THE defining mathematical property of Reed-Solomon codes, so
// checking it directly is a real correctness proof, not a self-consistency
// tautology (the check does not reuse reedSolomonEncode's own internal
// logic, only its OUTPUT, evaluated against an independent polynomial
// identity).
function gfPow(base, exponent) {
  let result = 1;
  for (let i = 0; i < exponent; i++) result = gfMultiply(result, base);
  return result;
}
function evaluatePolynomialAt(coefficientsHighToLow, x) {
  let result = 0;
  for (const coeff of coefficientsHighToLow) result = gfMultiply(result, x) ^ coeff;
  return result;
}
const ALPHA = 2; // the standard QR primitive element (generator of the multiplicative group)

test('a real Reed-Solomon codeword evaluates to zero at every root of its generator polynomial -- the actual defining property, not a memorized reference value', () => {
  for (const ecCount of [7, 10, 13, 16, 18, 22]) {
    for (const data of [
      [1, 2, 3, 4, 5, 6, 7, 8],
      [0, 0, 0],
      [255, 128, 64, 32, 16, 8, 4, 2, 1],
      Array.from({ length: 20 }, (_, i) => (i * 37 + 11) % 256),
    ]) {
      const ec = reedSolomonEncode(data, ecCount);
      const codeword = [...data, ...ec]; // full codeword polynomial, highest-degree coefficient first
      for (let i = 0; i < ecCount; i++) {
        const root = gfPow(ALPHA, i);
        const value = evaluatePolynomialAt(codeword, root);
        assert.equal(value, 0, `codeword must evaluate to 0 at alpha^${i} (ecCount=${ecCount}, data length=${data.length}), got ${value}`);
      }
    }
  }
});

test('reedSolomonEncode produces exactly ecCount codewords, for a range of inputs', () => {
  for (const ecCount of [7, 10, 15, 20, 28, 30]) {
    const ec = reedSolomonEncode([1, 2, 3, 4, 5], ecCount);
    assert.equal(ec.length, ecCount);
    for (const byte of ec) assert.ok(byte >= 0 && byte <= 255, 'every EC codeword must be a valid byte');
  }
});

test('different data produces different EC codewords (not a constant/degenerate output)', () => {
  const ec1 = reedSolomonEncode([1, 2, 3], 10);
  const ec2 = reedSolomonEncode([4, 5, 6], 10);
  assert.notDeepEqual(ec1, ec2);
});
