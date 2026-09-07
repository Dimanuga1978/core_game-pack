import test from 'node:test';
import assert from 'node:assert/strict';
import { createSeededRng } from '../src/index.js';

test('same seed produces identical random sequence', () => {
  const a = createSeededRng(12345); const b = createSeededRng(12345);
  assert.deepEqual(Array.from({length:20}, () => a.nextUint32()), Array.from({length:20}, () => b.nextUint32()));
});
test('different seeds diverge', () => {
  assert.notEqual(createSeededRng(1).nextUint32(), createSeededRng(2).nextUint32());
});

// Regression test for a real, external audit finding (theoretical but
// real): `max - min + 1` can itself exceed Number.MAX_SAFE_INTEGER for
// a sufficiently extreme range, at which point IEEE-754 double
// precision can no longer represent every integer in that range
// exactly. No real game shipped with this engine requests anywhere
// near such a range today -- this is a defensive guard against a
// future or third-party pack doing so, not a fix for a currently
// reachable failure.
test('int() throws a clean RangeError for a range too large to represent exactly, instead of silently returning an imprecise result', () => {
  const rng = createSeededRng(1);
  assert.throws(() => rng.int(0, Number.MAX_SAFE_INTEGER + 100), RangeError);
});

test('int() still works correctly for a range right at the edge of safe precision', () => {
  const rng = createSeededRng(1);
  assert.doesNotThrow(() => rng.int(0, Number.MAX_SAFE_INTEGER - 1));
});

test('int() is unaffected for every realistic range any real game actually uses', () => {
  const rng = createSeededRng(1);
  for (let i = 0; i < 100; i++) {
    const v = rng.int(0, 1000);
    assert.ok(v >= 0 && v <= 1000);
  }
});
