// pitch-shift.js
//
// Independent pitch shifting: change pitch WITHOUT changing duration, the exact
// complement of the time-stretch system next door in js/dsp/stretch/ (which changes
// duration without changing pitch). Together they're what lets PLAY NICE conform a
// loop's tempo and its key as two genuinely separate decisions - see
// js/play-nice/conform.js.
//
// No new DSP engine and no new dependency: this is the classic stretch-then-resample
// construction built entirely out of parts the app already had.
//
//   1. Time-stretch by `factor` (pitch preserved, duration multiplied by factor) using
//      the existing character/engine dispatcher, stretchChannels().
//   2. Resample the result by 1/factor (dsp.js's resampleLinear, already used for
//      analysis-rate conversion and by the varispeed engine). Resampling moves pitch
//      and duration together, so this puts the duration back where it started and
//      leaves the pitch multiplied by `factor`.
//
// Net effect: duration unchanged, pitch shifted by the requested number of semitones.
//
// Which stretch character does step 1 is an explicit parameter rather than a constant
// baked in here, for the same reason PLAY NICE's tempo METHOD is a parameter: the
// choice of algorithm is a creative one and belongs to the caller. The default
// ("transient") is the phase-locked, transient-reset phase vocoder - the most
// transparent option in the registry, which is what pitch fitting wants when the
// creative choice is being made about the TEMPO transformation instead.
import { stretchChannels } from "./stretch/index.js";
import { resampleLinear } from "../dsp.js";

/** The most transparent character in the registry for a pitch-only transformation. */
export const DEFAULT_PITCH_CHARACTER = "transient";

/**
 * Hard limit on how far pitch fitting will ever move something, in semitones. An octave
 * either way is already well past the point where stretch-then-resample sounds like the
 * source material; anything beyond it is a bug or a garbage key detection, not a
 * musical intention. js/play-nice/key-matching.js separately keeps ordinary key
 * matching inside ±6 semitones - this is only the backstop.
 */
export const MAX_PITCH_SEMITONES = 24;

/** Frequency ratio for a semitone interval. 12 semitones = 2x = one octave. */
export function semitonesToRatio(semitones) {
  return Math.pow(2, semitones / 12);
}

/** Inverse of semitonesToRatio - how many semitones a given frequency ratio represents. */
export function ratioToSemitones(ratio) {
  if (!(ratio > 0)) return 0;
  return 12 * Math.log2(ratio);
}

/**
 * Shift every channel by `semitones` while keeping the duration the same.
 *
 * @param {Float32Array[]} channels
 * @param {number} sampleRate
 * @param {number} semitones      positive = up, negative = down, 0 = untouched passthrough
 * @param {object} [options]
 * @param {string} [options.character]  stretch character used for the internal stretch pass
 * @param {object} [options.macroValues]
 * @param {number} [options.seed]
 * @returns {Float32Array[]} new arrays, same length as the input channels
 */
export function pitchShiftChannels(channels, sampleRate, semitones, options = {}) {
  const st = Number(semitones) || 0;
  // Copy rather than hand the caller's own arrays back, so a no-op shift behaves
  // identically to a real one from the caller's point of view (stretchChannels does the
  // same for a ratio of 1).
  if (Math.abs(st) < 1e-6) return channels.map((ch) => Float32Array.from(ch));

  const clamped = Math.max(-MAX_PITCH_SEMITONES, Math.min(MAX_PITCH_SEMITONES, st));
  const factor = semitonesToRatio(clamped);

  const stretched = stretchChannels(channels, sampleRate, factor, options.character || DEFAULT_PITCH_CHARACTER, {
    macroValues: options.macroValues,
    seed: options.seed ?? 1,
  });

  const originalLength = channels[0] ? channels[0].length : 0;
  return stretched.map((ch) => {
    // resampleLinear(x, 1, r) produces an output r times as long, so 1/factor undoes the
    // stretch pass's length change and leaves the pitch shift behind.
    const resampled = resampleLinear(ch, 1, 1 / factor);
    // Rounding inside two independent length calculations (the stretch engine's own
    // output length, then the resampler's) can leave the result a handful of samples
    // either side of the input length. Duration is the one thing pitch shifting promises
    // not to touch, so pin it exactly rather than "near enough".
    return fitToLength(resampled, originalLength);
  });
}

/** Trim or zero-pad `arr` to exactly `length` samples. */
function fitToLength(arr, length) {
  if (arr.length === length) return arr;
  const out = new Float32Array(length);
  out.set(arr.subarray(0, Math.min(arr.length, length)));
  return out;
}
