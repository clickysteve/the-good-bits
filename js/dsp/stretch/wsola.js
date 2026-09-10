// wsola.js
//
// WSOLA (Waveform Similarity Overlap-Add) time-stretch engine. This is the
// original engine timestretch.js shipped with, moved here unchanged in
// behaviour: "character" is entirely a matter of parameters, not a different
// algorithm. A short window with no similarity search and a low bit depth is
// exactly what gave cheap 90s hardware samplers' time-stretch its metallic,
// warbly character, so deliberately imperfect search/short windows are a
// first-class part of the palette here, not a bug.
import { toMono } from "../../dsp.js";
import { hannWindow } from "./windows.js";

/** A window's own energy (sum of squares) - split out of similarity() below so the search loop can
 * compute it once per grain instead of redundantly recomputing the same value for every candidate
 * offset scored against that grain's fixed reference window. */
function energy(ref, len) {
  let sum = 0;
  for (let i = 0; i < len; i++) {
    const x = ref[i] || 0;
    sum += x * x;
  }
  return sum;
}

/**
 * Normalized cross-correlation between a reference window and a candidate window, for splice-point
 * search. `refEnergy` is `energy(ref, len)`, passed in rather than recomputed here: this is called
 * once per candidate offset in the search loop below (up to ~searchRadius*2 times per grain) against
 * the SAME reference window every time, so hoisting that one term out is a pure, exact win - it's
 * the same value, just computed once per grain instead of once per candidate.
 */
function similarity(ref, refEnergy, cand, candOff, len) {
  let dot = 0;
  let nc = 0;
  for (let i = 0; i < len; i++) {
    const x = ref[i] || 0;
    const y = cand[candOff + i] || 0;
    dot += x * y;
    nc += y * y;
  }
  const denom = Math.sqrt(refEnergy * nc);
  return denom > 1e-9 ? dot / denom : 0;
}

/** Crude bit-depth reduction - old samplers' ADCs were low-bit, so this is part of several "old digital" characters. */
export function quantizeInPlace(buf, bits) {
  const levels = Math.pow(2, bits);
  const step = 2 / levels;
  for (let i = 0; i < buf.length; i++) buf[i] = Math.round(buf[i] / step) * step;
}

/**
 * Time-stretch every channel in lockstep (grain positions are decided once
 * from a mono reference, then applied identically to each channel) so
 * multi-channel audio stays phase-aligned instead of each channel drifting
 * independently. ratio = output length / input length. Pitch is preserved
 * (approximately - WSOLA isn't phase-exact, but it's a solid, well
 * established approach for exactly this).
 *
 * params: { windowMs, searchMs, hopFraction, bitDepth }
 */
export function stretchWsola(channels, sampleRate, ratio, params) {
  const p = params || {};
  const windowMs = p.windowMs ?? 46;
  const searchMs = p.searchMs ?? 14;
  const hopFraction = p.hopFraction ?? 0.5;
  const bitDepth = p.bitDepth ?? null;

  if (Math.abs(ratio - 1) < 1e-6) return channels.map((ch) => Float32Array.from(ch));

  const reference = channels.length > 1 ? toMono(channels) : channels[0];
  const inputLen = reference.length;
  const windowSize = Math.max(64, Math.round((windowMs / 1000) * sampleRate));
  const synthesisHop = Math.max(1, Math.round(windowSize * hopFraction));
  // Kept for clarity about what the ratio means in grain terms: the input advances this far
  // for every synthesisHop of output. The loop below derives each grain's position from the
  // output rather than stepping by this, so drift can't accumulate - see there.
  const analysisHop = Math.max(1, Math.round(synthesisHop / ratio));
  void analysisHop;
  const searchRadius = Math.max(0, Math.round((searchMs / 1000) * sampleRate));
  const window = hannWindow(windowSize);
  const outLen = Math.max(windowSize, Math.round(inputLen * ratio));

  // Decide grain placement once, from the mono reference, so every channel splices at the same points.
  //
  // The analysis position for each grain is DERIVED from where that grain lands in the
  // output (synthesisPos / ratio), not accumulated from the previous grain's chosen start.
  // That distinction matters more than it looks:
  //
  //   - Accumulating meant every nudge the similarity search made was permanent. The search
  //     is free to move a splice point forwards, and those nudges compound, so the read
  //     position ran through the input faster than the ratio intended. The loop then hit
  //     "analysisPos >= inputLen" while the output buffer was only part-written, and the
  //     rest of it stayed silent - a break stretched with Clean/Tight/Vintage came out the
  //     right LENGTH with a gap on the end.
  //   - The same compounding drift also pulled the output off the beat, which is why the
  //     WSOLA characters measured far looser than the phase-vocoder ones.
  //
  // Deriving the position instead makes the search what it should be: a local choice about
  // where to splice, bounded by searchRadius, with no memory. Window size, search radius,
  // hop fraction and bit depth are untouched, so each character still sounds like itself -
  // the deliberately rough ones included. A stretch that doesn't reach the end of its own
  // buffer isn't character, it's a bug.
  const grains = [];
  let synthesisPos = 0;
  let prevTail = null;
  const maxGrainStart = Math.max(0, inputLen - windowSize);
  while (synthesisPos < outLen) {
    const idealStart = Math.min(maxGrainStart, Math.round(synthesisPos / ratio));
    let bestOffset = 0;
    if (searchRadius > 0 && prevTail) {
      let bestScore = -Infinity;
      const overlapLen = Math.min(windowSize, prevTail.length);
      const refEnergy = energy(prevTail, overlapLen);
      const lo = Math.max(0, idealStart - searchRadius);
      const hi = Math.min(Math.max(lo, maxGrainStart), idealStart + searchRadius);
      for (let cand = lo; cand <= hi; cand++) {
        const score = similarity(prevTail, refEnergy, reference, cand, overlapLen);
        if (score > bestScore) {
          bestScore = score;
          bestOffset = cand - idealStart;
        }
      }
    }
    const grainStart = Math.max(0, Math.min(maxGrainStart, idealStart + bestOffset));
    grains.push({ grainStart, synthesisPos });

    const tailLen = Math.min(windowSize, synthesisHop);
    prevTail = reference.slice(grainStart + windowSize - tailLen, grainStart + windowSize);
    synthesisPos += synthesisHop;
  }

  return channels.map((chan) => {
    const out = new Float32Array(outLen + windowSize);
    const weight = new Float32Array(outLen + windowSize);
    for (const { grainStart, synthesisPos: sp } of grains) {
      for (let i = 0; i < windowSize; i++) {
        const s = chan[grainStart + i] || 0;
        out[sp + i] += s * window[i];
        weight[sp + i] += window[i];
      }
    }
    const result = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) result[i] = weight[i] > 1e-6 ? out[i] / weight[i] : out[i];
    if (bitDepth) quantizeInPlace(result, bitDepth);
    return result;
  });
}
