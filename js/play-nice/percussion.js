// percussion.js
//
// "Is this a drum loop?" - asked so that key matching can switch itself off for material
// that has no key worth matching.
//
// WHY NOT THE OBVIOUS SIGNALS. Two candidates looked promising and both fail on real
// material, measured across twelve loops pulled from actual sample folders:
//
//   - essentia's key STRENGTH. Drums scored 0.61-0.74; melodic material scored 0.36-0.94.
//     The single lowest-confidence file in the set was a chiptune lead, not a drum loop, so
//     a threshold low enough to catch drums catches leads too.
//   - onset-grid confidence (see downbeat.js). Drums scored 3.1-4.5 against 1.2-2.1 for
//     most melodic loops - but that same chiptune lead scored 4.16, because staccato square
//     waves have attacks every bit as sharp as a snare.
//
// SPECTRAL FLATNESS separates them, because it measures the thing that actually differs:
// snares and hats are broadband noise, while leads, keys and bass are harmonic peaks with
// gaps between them. Geometric mean over arithmetic mean of the magnitude spectrum tends
// towards 1 for noise and towards 0 for tonal material. Measured: drums 0.62-0.73, every
// melodic loop 0.005-0.55, and the chiptune lead lands at 0.25 where it belongs.
//
// CONSERVATIVE ON PURPOSE. Being wrong in the two directions is not symmetrical. Failing to
// spot a drum loop transposes it a few semitones, which is usually inaudible on percussion.
// Wrongly calling a melodic loop percussion leaves it in the wrong key against everything
// else, which is a bum note. So this requires BOTH a noisy spectrum and a strongly
// rhythmic one, and when it does fire it says so in the UI with a switch to undo it.
//
// And it is one threshold set against three drum loops. It will be wrong sometimes. That is
// why the per-loop "No key" control it drives is a checkbox the user can always flip.
import { fft } from "../dsp/stretch/fft.js";

/** Noise-like spectrum. Below this, harmonic content dominates. */
export const PERCUSSIVE_FLATNESS = 0.58;
/** Onset-grid confidence - drums are rhythmic as well as noisy. See downbeat.js. */
export const PERCUSSIVE_GRID_CONFIDENCE = 2.5;

const FRAME = 2048;
/** Sparse on purpose: this is a whole-file character judgement, not a per-onset one. */
const HOP = 4096;
/** Below 200Hz is bass fundamental and above 10k is mostly air; neither tells drums from keys. */
const BAND_LO_HZ = 200;
const BAND_HI_HZ = 10000;

/**
 * Mean spectral flatness of `mono`, in 0..1. Silent frames are skipped so a loop with a
 * long tail isn't judged on its own silence.
 */
export function spectralFlatness(mono, sampleRate) {
  if (!mono || mono.length < FRAME) return null;
  const window = new Float64Array(FRAME);
  for (let i = 0; i < FRAME; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FRAME - 1));

  const binHz = sampleRate / FRAME;
  const lo = Math.max(1, Math.floor(BAND_LO_HZ / binHz));
  const hi = Math.min(FRAME / 2, Math.floor(BAND_HI_HZ / binHz));
  if (hi <= lo) return null;

  let total = 0;
  let frames = 0;
  const re = new Float64Array(FRAME);
  const im = new Float64Array(FRAME);
  for (let pos = 0; pos + FRAME < mono.length; pos += HOP) {
    let energy = 0;
    for (let i = 0; i < FRAME; i++) {
      re[i] = (mono[pos + i] || 0) * window[i];
      im[i] = 0;
      energy += re[i] * re[i];
    }
    if (energy < 1e-6) continue;
    fft(re, im);
    let logSum = 0;
    let sum = 0;
    for (let k = lo; k < hi; k++) {
      const m = Math.hypot(re[k], im[k]) + 1e-12;
      logSum += Math.log(m);
      sum += m;
    }
    const n = hi - lo;
    total += Math.exp(logSum / n) / (sum / n);
    frames++;
  }
  return frames ? total / frames : null;
}

/**
 * Does this look like percussion? Both conditions must hold - see the module header on why
 * this leans towards saying no.
 *
 * @param {number|null} flatness         from spectralFlatness()
 * @param {number|null} gridConfidence   from gridAlignmentOffset() - null if unmeasured
 */
export function looksPercussive(flatness, gridConfidence) {
  if (flatness == null) return false;
  if (flatness < PERCUSSIVE_FLATNESS) return false;
  // No tempo, no grid measurement - fall back to the spectrum alone, but only when it is
  // well clear of the threshold rather than sitting on it.
  if (gridConfidence == null) return flatness >= PERCUSSIVE_FLATNESS + 0.08;
  return gridConfidence >= PERCUSSIVE_GRID_CONFIDENCE;
}
