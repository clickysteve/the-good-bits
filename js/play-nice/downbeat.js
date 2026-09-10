// downbeat.js
//
// Where does this loop actually START, and how do we make it start THERE?
//
// The single biggest reason conformed loops flam against each other. Everything else in
// PLAY NICE - tempo, ratio, key - can be perfect and the result still sounds sloppy,
// because a loop exported from a DAW, trimmed by hand, or ripped from a longer file
// almost never begins exactly on its first transient. Twenty milliseconds of lead-in is
// invisible on a waveform, inaudible on its own, and unmistakable the moment it plays
// against another loop.
//
// Conforming does not remove that offset. It SCALES it - a 37ms lead-in conformed from
// 100 to 117 BPM comes out at 32ms, still wrong, and now wrong by an amount that isn't
// even a musical subdivision. So the offset has to be dealt with directly.
//
// HOW THE OFFSET IS CORRECTED: by rotating the loop, not trimming it. Trimming would make
// the loop shorter than a whole number of bars, which breaks the one property the rest of
// the pipeline works hard to guarantee. Rotating cyclically - moving the leading material
// to the end - keeps the length exactly and is musically right for a loop: whatever sat
// before the first downbeat is the tail of the previous cycle.
//
// HOW MUCH IT IS ALLOWED TO MOVE: only the sub-grid residual. The first onset is measured
// against a sixteenth-note grid, and the loop is rotated by its distance to the NEAREST
// grid line, never to zero. That distinction matters:
//
//   - A loop whose first hit is 18ms late is editing slop. Residual 18ms, corrected.
//   - A loop that deliberately starts on the "e" of beat 1 is already on the grid.
//     Residual ~0, left alone. Rotating it to zero would destroy the intended feel.
//   - A loop that opens with a bar of silence has its first hit near a grid line too.
//     Residual ~0, silence preserved, because that rest is part of the music.
//
// So the correction is bounded by half a sixteenth (about 31ms at 120 BPM) and only ever
// removes the part of the offset that isn't musical.
import { computeRmsEnvelope, findNearestZeroCrossing } from "../dsp.js";

/** Envelope resolution for onset finding. Much finer than the 10ms the chop detectors use - this is looking for a flam, not a phrase. */
const ONSET_HOP_MS = 1;
const ONSET_WIN_MS = 4;

/** Grid the first onset is measured against. Sixteenths are the finest subdivision loops routinely start on. */
export const GRID_DIVISIONS_PER_BEAT = 4;

/**
 * How much better the winning grid phase has to be than the average one before the result
 * is trusted, expressed as best-score / mean-score.
 *
 * This gate is the difference between alignment helping and alignment doing harm. On
 * percussive material the correlation is decisive - the right phase scores five to eight
 * times the average, because the attacks really are all in one place. On a sustained pad or
 * a soft-attack arpeggio there are no attacks to find, every phase scores within about 4%
 * of every other, and the "winner" is noise. Acting on that noise shoves the loop by up to
 * half a sixteenth for no reason, which is exactly the kind of move that makes a conformed
 * loop sound late.
 *
 * Measured: percussive loops score 5.0-7.6, a soft arpeggio 1.045, a drone 1.036. 1.6 sits
 * in the middle of a very wide gap, so this is not a finely-tuned number.
 */
export const MIN_GRID_CONFIDENCE = 1.6;

/**
 * Sample-accurate position of the first real attack in `mono`.
 *
 * Two passes, because neither alone is good enough: a short-window energy envelope finds
 * the first frame that is unambiguously sound rather than noise floor, then a backwards
 * walk through the raw samples from that frame finds where the attack actually begins.
 * The envelope alone would be quantised to its hop; the raw walk alone would trigger on
 * the first stray sample of dither or room tone.
 *
 * Returns null when nothing clears the noise floor (a silent or near-silent file).
 */
export function findFirstOnsetSample(mono, sampleRate, precomputedEnvelope = null) {
  if (!mono || !mono.length) return null;

  let peak = 0;
  for (let i = 0; i < mono.length; i++) {
    const v = Math.abs(mono[i]);
    if (v > peak) peak = v;
  }
  if (peak < 1e-5) return null;

  // The caller often has this envelope already - gridAlignmentOffset builds one with
  // exactly these parameters - and it is the single most expensive thing in the alignment
  // path, so recomputing it here doubled the cost of every pass for nothing.
  const { times, vals } = precomputedEnvelope || computeRmsEnvelope(mono, sampleRate, ONSET_WIN_MS, ONSET_HOP_MS);
  if (!vals.length) return null;
  let envPeak = 0;
  for (const v of vals) if (v > envPeak) envPeak = v;
  if (envPeak <= 0) return null;

  // 20% of the loudest frame: high enough to ignore room tone, bleed and the tail of a
  // previous hit, low enough that a soft first note still registers.
  const threshold = envPeak * 0.2;
  let frame = -1;
  for (let i = 0; i < vals.length; i++) {
    if (vals[i] >= threshold) {
      frame = i;
      break;
    }
  }
  if (frame === -1) return null;

  // computeRmsEnvelope timestamps each frame at the window's START, so a window that only
  // CLIPS the attack still crosses the threshold and reports a time up to one window early.
  // Refine forward from a window before that point to the first sample that is genuinely
  // above the noise floor - walking backwards instead (the obvious approach) inherits that
  // bias rather than removing it, and lands every onset a few milliseconds early.
  const windowSamples = Math.round((ONSET_WIN_MS / 1000) * sampleRate);
  const coarse = Math.round(times[frame] * sampleRate);
  const floor = peak * 0.02;
  const from = Math.max(0, coarse - windowSamples);
  const to = Math.min(mono.length - 1, coarse + windowSamples * 4);
  for (let i = from; i <= to; i++) {
    if (Math.abs(mono[i]) >= floor) return i;
  }
  return Math.max(0, Math.min(mono.length - 1, coarse));
}

/**
 * Onset-strength envelope: positive frame-to-frame energy change, normalised. This is a
 * proxy for "where are the attacks", and it is what the grid search below votes on.
 * Positive-only (rising energy) because a note ending is not an onset.
 */
function onsetEnvelope(rms) {
  const { vals } = rms;
  const flux = new Float64Array(vals.length);
  let peak = 0;
  for (let i = 1; i < vals.length; i++) {
    const d = vals[i] - vals[i - 1];
    flux[i] = d > 0 ? d : 0;
    if (flux[i] > peak) peak = flux[i];
  }
  if (peak > 0) for (let i = 0; i < flux.length; i++) flux[i] /= peak;
  return flux;
}

/**
 * How far the loop must be rotated for its attacks to sit ON the beat grid.
 *
 * This is the heart of getting two loops to lock, and it deliberately does NOT work by
 * finding the first onset and moving it to zero. That approach - the obvious one - fails in
 * several ordinary situations: a loop that opens with a rest has no onset at the start; a
 * loop whose first hit is a soft pickup has a misleading one; and every time-stretch engine
 * smears an attack forwards and backwards, so "the first sample above a threshold" drifts
 * with whatever the engine did rather than tracking where the beat is heard.
 *
 * Instead, every attack in the loop votes. The loop's onset envelope is correlated against
 * a pulse train at its own tempo, and the offset that lines the two up best wins. Sixteen
 * beats agreeing is enormously more reliable than one onset guessed at, and it is robust to
 * a missing downbeat, a smeared transient, or a stray early noise.
 *
 * The search covers exactly one grid step, so the correction is always sub-subdivision: a
 * loop that genuinely starts on the "e" of beat 1 already correlates best at offset ~0 and
 * is left alone, while editing slop is pulled onto the grid. Nothing is ever moved by a
 * musically meaningful amount.
 *
 * Returns {samples, confidence} - samples to rotate left by (may be negative), folded into
 * [-gridStep/2, +gridStep/2] so it is always the smaller of the two equivalent moves - or
 * null if there is nothing to measure at all. `confidence` is best-score / mean-score; see
 * MIN_GRID_CONFIDENCE for what counts as enough.
 */
export function gridAlignmentOffset(mono, sampleRate, bpm, options = {}) {
  if (!(bpm > 0) || !mono || !mono.length) return null;
  const divisions = options.divisionsPerBeat || GRID_DIVISIONS_PER_BEAT;
  const hopMs = options.hopMs || ONSET_HOP_MS;
  const gridSec = 60 / bpm / divisions;
  const gridFrames = gridSec * 1000 / hopMs;
  if (!(gridFrames >= 2)) return null;

  // Built once and shared with findFirstOnsetSample below - same window, same hop.
  const rms = computeRmsEnvelope(mono, sampleRate, hopMs * 4, hopMs);
  const flux = onsetEnvelope(rms);
  const n = flux.length;
  if (n < gridFrames * 2) return null;

  let energy = 0;
  for (let i = 0; i < n; i++) energy += flux[i];
  if (energy <= 0) return null;

  const steps = Math.max(2, Math.round(gridFrames));
  const gridCount = Math.floor(n / gridFrames);
  let bestOffset = 0;
  let bestScore = -Infinity;
  let scoreSum = 0;
  for (let step = 0; step < steps; step++) {
    const offset = (step * gridFrames) / steps;
    let score = 0;
    for (let k = 0; k < gridCount; k++) {
      const pos = k * gridFrames + offset;
      // Linear interpolation between frames, so the search resolves finer than the hop.
      const i0 = Math.floor(pos);
      const frac = pos - i0;
      const a = flux[i0 % n] || 0;
      const b = flux[(i0 + 1) % n] || 0;
      score += a * (1 - frac) + b * frac;
    }
    scoreSum += score;
    if (score > bestScore) {
      bestScore = score;
      bestOffset = offset;
    }
  }

  // How decisive was that? On material with real attacks the winning phase towers over the
  // rest; on a pad every phase scores much the same and the winner means nothing.
  const meanScore = scoreSum / steps;
  const confidence = meanScore > 0 ? bestScore / meanScore : 0;

  // Fold to the smaller equivalent move: an offset of 0.9 grid steps is really 0.1 back.
  let offsetFrames = bestOffset;
  if (offsetFrames > gridFrames / 2) offsetFrames -= gridFrames;
  const coarse = Math.round((offsetFrames * hopMs / 1000) * sampleRate);

  // The correlation is robust about WHICH grid line, but not exact about where that line
  // is: computeRmsEnvelope timestamps each frame at its window's start, so an energy rise
  // is reported a few milliseconds away from the attack that caused it. That bias is
  // roughly constant, which is why loops aligned this way already lock to each other - but
  // it would leave every one of them a few milliseconds off an absolute grid, which matters
  // the moment these files land in a DAW.
  //
  // findFirstOnsetSample IS sample-accurate. So: let the correlation choose the grid line
  // (which it is good at and a single onset is bad at), then let the onset fix the exact
  // position within it (which it is good at and the correlation is bad at). If the two
  // disagree by more than a fraction of a grid step the onset is not trustworthy here -
  // smeared, or a soft pickup - and the correlation stands on its own.
  const onset = findFirstOnsetSample(mono, sampleRate, hopMs === ONSET_HOP_MS ? rms : null);
  if (onset == null) return { samples: coarse, confidence };
  const gridSamples = gridSec * sampleRate;
  const relative = onset - coarse;
  const residual = relative - Math.round(relative / gridSamples) * gridSamples;
  if (Math.abs(residual) > gridSamples * 0.4) return { samples: coarse, confidence };
  return { samples: coarse + Math.round(residual), confidence };
}

/**
 * Rotate `channels` left by `offset` samples, wrapping the removed head onto the tail.
 * Length is preserved exactly - that is the whole reason this rotates instead of trimming.
 * A negative offset rotates right (the loop started early).
 *
 * No crossfade, deliberately. A rotation seam looks like it wants smoothing, but on a loop
 * that is already an exact number of beats the wrap point IS the loop point - the sample
 * after the end is the sample at the start, every cycle, by construction. Dipping the gain
 * there would put an audible hole at an arbitrary spot inside the loop (potentially right
 * on a hit), and it perturbs the very envelope the alignment is measured from, which stops
 * a second alignment pass converging. Leaving it alone is both cleaner and more accurate.
 */
export function rotateChannels(channels, offset) {
  const len = channels[0] ? channels[0].length : 0;
  if (!len) return channels.map((ch) => Float32Array.from(ch));
  const shift = ((Math.round(offset) % len) + len) % len;
  if (shift === 0) return channels.map((ch) => Float32Array.from(ch));

  // A cyclic rotation is two contiguous runs, so it is two memcpy-speed set() calls rather
  // than a modulo per sample - which on a 32s stereo loop, across up to six alignment
  // passes, was tens of millions of needless operations.
  const out = channels.map((ch) => {
    const dst = new Float32Array(len);
    dst.set(ch.subarray(shift), 0);
    dst.set(ch.subarray(0, shift), len - shift);
    return dst;
  });

  return out;
}

/**
 * The whole correction in one call: find how far the loop's attacks sit off its own grid
 * and rotate that away.
 *
 * Returns {channels, offsetSamples, offsetMs, applied, found} so the UI can say what it
 * did - silently moving someone's audio is not acceptable, even when the move is right.
 */
export function alignToDownbeat(channels, sampleRate, bpm, options = {}) {
  // Sub-millisecond corrections are below the threshold of audibility and below the
  // resolution of the envelope this is measured on; moving audio for them is noise.
  const minSamples = Math.max(1, Math.round(sampleRate * 0.001));
  const maxPasses = options.maxPasses ?? 3;

  let current = channels;
  let total = 0;
  let found = false;
  let converged = false;
  let confident = false;
  let lastOffset = 0;

  // Iterated, because one pass does not always land it. The correlation is measured on a
  // smoothed envelope, so a large first correction can leave a small second-order error -
  // and on material the engine has smeared, the best-fitting grid phase shifts slightly
  // once the bulk of the offset is gone. Each pass is strictly smaller than the last and
  // the loop stops as soon as there is nothing left worth moving, so this converges in two
  // or three passes rather than oscillating.
  const minConfidence = options.minConfidence ?? MIN_GRID_CONFIDENCE;
  let confidence = 0;

  for (let pass = 0; pass < maxPasses; pass++) {
    const mono = current.length > 1 ? mixToMono(current) : current[0];
    const measured = gridAlignmentOffset(mono, sampleRate, bpm, options);
    if (measured == null) break;
    found = true;
    confidence = measured.confidence;

    // Not confident enough to touch it. On sustained or atonal material this is the RIGHT
    // answer: there is no rhythmic evidence to align to, so leaving the loop exactly where
    // the musician put it beats moving it somewhere the noise floor pointed at.
    if (confidence < minConfidence) {
      confident = false;
      break;
    }
    confident = true;

    const offset = measured.samples;
    lastOffset = offset;
    if (Math.abs(offset) < minSamples) {
      converged = true;
      break;
    }
    current = rotateChannels(current, offset);
    total += offset;
  }

  const applied = total !== 0;
  return {
    channels: applied ? current : channels.map((ch) => Float32Array.from(ch)),
    offsetSamples: total,
    offsetMs: (total / sampleRate) * 1000,
    applied,
    found,
    // Ran out of passes with a real offset still outstanding. That means the audio's
    // attacks don't sit convincingly on any one grid phase - which on a heavily smeared or
    // rhythmically destructive stretch method is the honest answer, and worth surfacing
    // rather than pretending the loop is tight.
    converged: found ? converged : false,
    residualMs: found && confident && !converged ? (lastOffset / sampleRate) * 1000 : 0,
    // Was there enough rhythmic evidence to act on at all? A card showing "left alone -
    // no clear beat" is far more useful than one silently not aligning.
    confident,
    confidence,
  };
}

function mixToMono(channels) {
  const len = channels[0].length;
  const out = new Float32Array(len);
  for (const ch of channels) for (let i = 0; i < len; i++) out[i] += ch[i];
  for (let i = 0; i < len; i++) out[i] /= channels.length;
  return out;
}
