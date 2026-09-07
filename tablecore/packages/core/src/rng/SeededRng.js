// Deterministic PRNG: xoshiro128** seeded via SplitMix32.
//
// The previous implementation (Mulberry32) carried only 32 bits of
// internal state -- a single accumulator integer. That is fine for a
// generic simulation PRNG, but this generator is used to shuffle decks
// and resolve every random outcome in player-facing, potentially
// adversarial matches. An external audit demonstrated that Mulberry32's
// full 32-bit state space (2^32 = ~4.3 billion candidates) can be brute
// forced from a *single* observed output in ~13 seconds on one CPU core
// with no optimization, sub-second with parallelism/a GPU -- and once the
// state is recovered, every future "random" draw for the rest of the
// match is fully predictable. That is a real, exploitable weakness for
// any card/dice mechanic, not a theoretical one: it only takes one raw
// random-derived value ever reaching a client (directly, or leaked
// through an under-scoped event) to break the shuffle for the rest of
// the game.
//
// xoshiro128** carries 128 bits of state (four uint32 words). Brute
// forcing 2^128 candidates is not a smaller version of the same problem;
// it is a categorically different, computationally infeasible problem
// for any adversary this engine plausibly needs to defend against. This
// is still NOT a cryptographic PRNG (do not use it to generate secrets,
// tokens, or anything where an adversary choosing to invest
// cryptanalytic effort -- rather than brute force -- would be a realistic
// threat model) -- for genuinely adversarial, money-at-stake shuffling,
// prefer a commit-reveal scheme on top of this, see the audit notes.
//
// `initialState`, when provided, must be either a `{a,b,c,d}` state
// object as returned by `getState()` (used to resume a persisted match)
// or a raw numeric seed (kept for backward compatibility with the old
// single-integer `rngState` shape and with plain reseeding).

// Explicit, importable identity for the current RNG algorithm+seeding
// scheme -- used by replay provenance (replay.js) to fail closed if a
// replay recorded under one RNG implementation is ever played back
// against a different one. "A larger internal state is resistant to
// brute force" (see the long comment above) says nothing about whether
// two DIFFERENT algorithms would even produce the same sequence from the
// same seed -- they never would, silently, without this check.
export const RNG_ALGORITHM = 'xoshiro128ss-splitmix32-v1';

function splitmix32(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x9E3779B9) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x21F0AAAD) >>> 0;
    z = Math.imul(z ^ (z >>> 15), 0x735A2D97) >>> 0;
    return (z ^ (z >>> 15)) >>> 0;
  };
}

function rotl(x, k) { return ((x << k) | (x >>> (32 - k))) >>> 0; }

function isStateObject(value) {
  return value != null && typeof value === 'object'
    && Number.isInteger(value.a) && Number.isInteger(value.b)
    && Number.isInteger(value.c) && Number.isInteger(value.d);
}

function deriveState(seed) {
  const gen = splitmix32(Number(seed) >>> 0);
  let a = gen(), b = gen(), c = gen(), d = gen();
  // All-zero is a fixed point of xoshiro128** (every output would be 0
  // forever); SplitMix32 essentially never produces it, but a match
  // seeded with an adversarial/crafted `seed` should not be able to force
  // a degenerate generator, so guard it explicitly.
  if ((a | b | c | d) === 0) a = 1;
  return { a: a >>> 0, b: b >>> 0, c: c >>> 0, d: d >>> 0 };
}

export function createSeededRng(seed = 0, initialState = undefined) {
  let { a, b, c, d } = isStateObject(initialState)
    ? initialState
    : deriveState(initialState == null ? seed : initialState);

  function nextUint32() {
    const result = (rotl(Math.imul(b, 5) >>> 0, 7) * 9) >>> 0;
    const t = (b << 9) >>> 0;
    c = (c ^ a) >>> 0;
    d = (d ^ b) >>> 0;
    b = (b ^ c) >>> 0;
    a = (a ^ d) >>> 0;
    c = (c ^ t) >>> 0;
    d = rotl(d, 11);
    return result;
  }

  return {
    nextUint32,
    next() { return nextUint32() / 4294967296; },
    int(min, max) {
      if (!Number.isInteger(min) || !Number.isInteger(max) || max < min) throw new RangeError('Invalid integer range');
      // Found via external audit review: `max - min + 1` can itself
      // exceed Number.MAX_SAFE_INTEGER for a sufficiently extreme range,
      // at which point IEEE-754 double precision can no longer represent
      // every integer in that range exactly -- Math.floor(this.next() *
      // range) could then silently produce a result that isn't the
      // uniformly-distributed, exactly-reproducible value the seeded RNG
      // contract promises. No real game shipped with this engine
      // requests anywhere near such a range today (confirmed directly:
      // the largest real usage is last-sector's own board-tile shuffling,
      // bounded by MAX_GRID_DIMENSION), so this is deliberately a cheap,
      // defensive guard against a future or third-party pack requesting
      // an extreme range, not a fix for any currently-reachable failure.
      const range = max - min + 1;
      if (range > Number.MAX_SAFE_INTEGER) throw new RangeError('Integer range too large to represent exactly');
      return min + Math.floor(this.next() * range);
    },
    pick(items) {
      if (!Array.isArray(items) || items.length === 0) throw new RangeError('Cannot pick from empty list');
      return items[this.int(0, items.length - 1)];
    },
    getState() { return { a, b, c, d }; }
  };
}
