// rng.js
//
// Deterministic PRNG shared by every creative stretch engine (grain jitter, phase
// randomisation, spectral scrambling, chunk-repeat roughness, ...) so that
// "same input + same settings + same seed" always produces the same output -
// this matters for repeatable exports, and lets a numeric test assert two
// different seeds diverge while the same seed reproduces exactly.
//
// mulberry32 (Tommy Ettinger's public-domain generator, widely published as a
// short reference snippet) - reimplemented here from the well-known
// construction rather than copied from any particular source file. Not
// cryptographic; plenty good for audio jitter.

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Hash any seed (number or string) down to a uint32 so callers can pass friendly seeds. */
export function hashSeed(seed) {
  if (seed === undefined || seed === null) return 1;
  if (typeof seed === "number" && Number.isFinite(seed)) return (seed >>> 0) || (Math.abs(Math.floor(seed)) >>> 0) || 1;
  let h = 0x811c9dc5;
  const s = String(seed);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) || 1;
}

/** Combine a base seed with an integer "context" (frame index, channel index, ...) into a new deterministic seed. */
export function deriveSeed(baseSeed, context) {
  const base = hashSeed(baseSeed);
  const ctx = (context >>> 0) || 0;
  return (Math.imul(base ^ ctx, 0x9e3779b1) ^ (ctx << 13)) >>> 0;
}

/**
 * A small deterministic RNG object. `seed` may be a number or string.
 * Every stretch engine that uses randomness derives its rng(s) from the same
 * seed input (see dsp/stretch/index.js), and - critically - reseeds per
 * channel with the SAME seed for decisions that must stay shared across L/R
 * (grain jitter, phase randomisation), so stereo material doesn't get torn
 * apart by independently-randomised channels.
 */
export function makeRng(seed = 1) {
  const next = mulberry32(hashSeed(seed));
  return {
    next, // [0, 1)
    signed: () => next() * 2 - 1, // [-1, 1)
    range: (lo, hi) => lo + next() * (hi - lo),
    int: (n) => Math.min(n - 1, Math.floor(next() * n)),
    bool: (p = 0.5) => next() < p,
  };
}
