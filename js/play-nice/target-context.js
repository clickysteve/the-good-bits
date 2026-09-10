// target-context.js
//
// The TargetContext: the single "what are we conforming TO?" object, and the reason the
// conforming pipeline has no idea whether the user typed a tempo or dropped a reference
// loop. Defined mode and Reference Loop mode are two ways of FILLING IN this object;
// downstream (conform.js, render.js, the export naming) only ever reads it.
//
// `source` ("manual" | "reference") is recorded for display and provenance only. Nothing
// in the pipeline is allowed to branch on it - if it ever needs to, that's a sign
// something belongs in this object as data instead.
//
// ANALYSIS PROPOSES, USER OVERRIDES applies here exactly as it does to source files (see
// js/tempo-override.js): in Reference mode the detected values seed the target and are
// kept alongside it as `reference.detected*`, but `bpm`/`key`/`mode` are always the
// user-facing, user-editable truth. Detection is an assistant, not an authority.
import { isNote, normalizeMode, formatKey } from "./key-matching.js";

/** Same generous backstop as js/tempo-override.js's MAX_SOURCE_BPM, for the same reason. */
export const MAX_TARGET_BPM = 100000;
export const MIN_TARGET_BPM = 1;

export const TARGET_MODES = ["defined", "reference"];

/** A usable starting point before the user has touched anything. */
export function createTargetContext(overrides = {}) {
  return {
    mode: "defined", // which UI is filling this in: "defined" | "reference"
    bpm: 120,
    key: "C",
    keyMode: "minor", // "major" | "minor" | null. Named keyMode, not mode, so it can't be confused with the UI mode above.
    pitchEnabled: true, // global "does key matter at all in this session?" - see the reference-loop atonal case
    source: "manual", // "manual" | "reference" - provenance only
    reference: null, // {name, detectedBpm, detectedKey, detectedScale, keyStrength, durationSec} once a reference loop is loaded
    ...overrides,
  };
}

/** Validate/clean a typed target BPM. null means "reject, keep what was there". */
export function sanitizeTargetBpm(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(MAX_TARGET_BPM, Math.max(MIN_TARGET_BPM, n));
}

/**
 * Candidate half-time/double-time readings of a detected tempo, for the
 * "Detected: 64 BPM - interpret as [32] [64] [128] [256]" control. Always includes the
 * detected value itself, in ascending order, with anything outside a plausible musical
 * range dropped so the row stays short and every chip is worth clicking.
 *
 * Exists because octave errors are BY FAR the most common tempo-detection failure -
 * a half-time reading of a fast loop is not a broken analyser, it's an ambiguous
 * question - so correcting one has to be a single click, not a retype.
 */
export function tempoInterpretations(detectedBpm, { min = 30, max = 300 } = {}) {
  const base = Number(detectedBpm);
  if (!Number.isFinite(base) || base <= 0) return [];
  const seen = new Set();
  const out = [];
  // Octaves first, because half/double is far and away the most common failure. The 2/3 and
  // 3/2 readings matter too though, and nothing else offers them: a straight 136 BPM break
  // is routinely detected at 90.67 - exactly two thirds - when the pattern has enough
  // syncopation to make the beat ambiguous. Without these the chips simply cannot reach the
  // right answer for that loop and the only way out is typing the number.
  for (const factor of [0.25, 0.5, 2 / 3, 1, 1.5, 2, 4]) {
    const value = Math.round(base * factor);
    if (value < min || value > max) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  // A detected tempo outside the plausible window would otherwise vanish from its own
  // interpretation row, leaving no chip showing what was actually detected.
  if (!seen.has(Math.round(base))) out.push(Math.round(base));
  return out.sort((a, b) => a - b);
}

/**
 * Fold a reference loop's analysis into a target context. Detected values seed the
 * editable target fields AND are retained separately, so "reset to detected" stays
 * possible after any amount of manual correction, and so the UI can show
 * "detected 117, using 120".
 *
 * A reference loop with no confident key (percussion, noise, atonal material) sets
 * pitchEnabled false rather than inventing a key: with nothing meaningful to conform
 * TO, pitch fitting is off until the user names a target key themselves.
 */
export function targetFromReference(context, { name, bpm, key, scale, keyStrength, durationSec }) {
  const detectedBpm = Number.isFinite(bpm) && bpm > 0 ? bpm : null;
  const hasKey = isNote(key);
  return {
    ...context,
    mode: "reference",
    source: "reference",
    bpm: detectedBpm != null ? Math.round(detectedBpm) : context.bpm,
    key: hasKey ? key : context.key,
    keyMode: hasKey ? normalizeMode(scale) || context.keyMode : context.keyMode,
    pitchEnabled: hasKey,
    reference: {
      name,
      detectedBpm,
      detectedKey: hasKey ? key : null,
      detectedScale: hasKey ? normalizeMode(scale) : null,
      keyStrength: Number.isFinite(keyStrength) ? keyStrength : null,
      durationSec: Number.isFinite(durationSec) ? durationSec : null,
    },
  };
}

/**
 * Is this context complete enough to conform anything to? Tempo fitting needs a BPM;
 * pitch fitting needs a key. Either alone is a perfectly usable session, so this reports
 * the two independently rather than one boolean.
 */
export function targetReadiness(context) {
  const tempoReady = Number.isFinite(context.bpm) && context.bpm > 0;
  const pitchReady = !!context.pitchEnabled && isNote(context.key);
  return { tempoReady, pitchReady, usable: tempoReady || pitchReady };
}

/** "128 BPM / D minor" / "128 BPM" / "D minor" / "no target yet" - the target as one line of text. */
export function formatTarget(context) {
  const { tempoReady, pitchReady } = targetReadiness(context);
  const parts = [];
  if (tempoReady) parts.push(`${Math.round(context.bpm)} BPM`);
  if (pitchReady) parts.push(formatKey(context.key, context.keyMode));
  return parts.length ? parts.join(" / ") : "no target yet";
}

/** The {key, mode} shape resolveTransposition() expects, or nulls when pitch fitting is off. */
export function targetKeyForMatching(context) {
  if (!context.pitchEnabled) return { key: null, mode: null };
  return { key: context.key, mode: normalizeMode(context.keyMode) };
}
