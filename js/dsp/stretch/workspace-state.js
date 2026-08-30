// workspace-state.js
//
// Small, pure (no DOM) helpers behind the Stretch workspace's "is the audio you're looking at
// actually what your current settings would produce" state model, and its Randomise button. Kept
// separate from app.js so this logic - which has real edge cases worth locking down with tests - is
// unit-testable in Node like the rest of the dsp modules, instead of only reachable through a
// browser.

/**
 * A stable, comparable snapshot of everything that affects a stretch render: if this string is the
 * same before and after a settings change, re-processing would produce byte-identical audio, so
 * there's nothing to mark stale. Key order doesn't matter for correctness (JSON.stringify on a
 * plain object is deterministic for a given engine, and both sides of every comparison here are
 * produced by this same function), only that the same shape of input always produces the same string.
 */
export function stretchRenderSignature(timestretchSettings, lofiSnapshot) {
  return JSON.stringify({ ts: timestretchSettings, lofi: lofiSnapshot });
}

/**
 * Whether a previously-rendered "processed" preview (captured with `renderedSignature` at the time
 * it was computed) still matches the CURRENT settings. `null`/`undefined` renderedSignature (nothing
 * has been processed yet) is never stale - there's no stale preview on screen to warn about.
 */
export function isProcessedPreviewStale(renderedSignature, timestretchSettings, lofiSnapshot) {
  if (!renderedSignature) return false;
  return renderedSignature !== stretchRenderSignature(timestretchSettings, lofiSnapshot);
}

/**
 * New macro values for Randomise: every macro the character actually uses gets a fresh value in
 * [0,100] from `rng` (a () => [0,1) function, e.g. Math.random or a seeded generator - callers that
 * want a reproducible randomisation can pass their own); every other key in `currentMacroValues` is
 * left untouched, so randomising e.g. Scatter's texture/variation can't clobber a smear value another
 * character was using. Returns a new object - never mutates `currentMacroValues`.
 */
export function randomiseMacroValues(character, currentMacroValues, rng = Math.random) {
  const next = { ...(currentMacroValues || {}) };
  for (const key of character.macros || []) {
    next[key] = Math.round(rng() * 100);
  }
  return next;
}

/** A new integer seed in the same [0, 999999] range the Variation seed field accepts. */
export function randomSeed(rng = Math.random) {
  return Math.floor(rng() * 1000000);
}
