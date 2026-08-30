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

/** Normalized cross-correlation between a reference window and a candidate window, for splice-point search. */
function similarity(ref, cand, candOff, len) {
  let dot = 0;
  let nr = 0;
  let nc = 0;
  for (let i = 0; i < len; i++) {
    const x = ref[i] || 0;
    const y = cand[candOff + i] || 0;
    dot += x * y;
    nr += x * x;
    nc += y * y;
  }
  const denom = Math.sqrt(nr * nc);
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
  const analysisHop = Math.max(1, Math.round(synthesisHop / ratio));
  const searchRadius = Math.max(0, Math.round((searchMs / 1000) * sampleRate));
  const window = hannWindow(windowSize);
  const outLen = Math.max(windowSize, Math.round(inputLen * ratio));

  // Decide grain placement once, from the mono reference, so every channel splices at the same points.
  const grains = [];
  let analysisPos = 0;
  let synthesisPos = 0;
  let prevTail = null;
  while (synthesisPos < outLen && analysisPos < inputLen) {
    let bestOffset = 0;
    if (searchRadius > 0 && prevTail) {
      let bestScore = -Infinity;
      const overlapLen = Math.min(windowSize, prevTail.length);
      const lo = Math.max(0, analysisPos - searchRadius);
      const hi = Math.min(Math.max(lo, inputLen - windowSize), analysisPos + searchRadius);
      for (let cand = lo; cand <= hi; cand++) {
        const score = similarity(prevTail, reference, cand, overlapLen);
        if (score > bestScore) {
          bestScore = score;
          bestOffset = cand - analysisPos;
        }
      }
    }
    const grainStart = Math.max(0, Math.min(Math.max(0, inputLen - windowSize), analysisPos + bestOffset));
    grains.push({ grainStart, synthesisPos });

    const tailLen = Math.min(windowSize, synthesisHop);
    prevTail = reference.slice(grainStart + windowSize - tailLen, grainStart + windowSize);
    analysisPos = grainStart + analysisHop;
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
