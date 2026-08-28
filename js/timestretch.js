// timestretch.js
//
// Optional pitch-preserving time-stretch via WSOLA (Waveform Similarity
// Overlap-Add). Pure functions operating on Float32Array channel data - no
// DOM/Web Audio dependency, so this is unit-testable in Node like the rest
// of the dsp modules.
//
// "Character" presets don't switch algorithms, just parameters: CLEAN
// searches a window on every grain for the best-matching splice point (what
// a real WSOLA implementation should do), while VINTAGE and GLITCH search
// less (or not at all) and quantize the output to a lower bit depth. That
// combination - phase discontinuities from bad splices, plus a coarse ADC -
// is exactly what gave cheap 90s hardware samplers' time-stretch its
// metallic, warbly character, so it's a reasonably honest way to get that
// sound instead of a separate "lo-fi" code path.
import { toMono } from "./dsp.js";

export const CHARACTERS = {
  clean: { windowMs: 46, searchMs: 14, hopFraction: 0.5, bitDepth: null },
  vintage: { windowMs: 24, searchMs: 5, hopFraction: 0.5, bitDepth: 12 },
  glitch: { windowMs: 12, searchMs: 0, hopFraction: 0.5, bitDepth: 8 },
  warped: { windowMs: 8, searchMs: 0, hopFraction: 0.5, bitDepth: null },
  crushed: { windowMs: 30, searchMs: 10, hopFraction: 0.5, bitDepth: 6 },
};

function hannWindow(n) {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / Math.max(1, n - 1));
  return w;
}

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

/** Crude bit-depth reduction - old samplers' ADCs were low-bit, so this is part of the "vintage"/"glitch" character. */
function quantizeInPlace(buf, bits) {
  const levels = Math.pow(2, bits);
  const step = 2 / levels;
  for (let i = 0; i < buf.length; i++) buf[i] = Math.round(buf[i] / step) * step;
}

/**
 * Time-stretch every channel in lockstep (grain positions are decided once
 * from a mono reference, then applied identically to each channel) so
 * multi-channel audio stays phase-aligned instead of each channel drifting
 * independently. ratio = output length / input length: 2.0 is twice as
 * long (slower), 0.5 is half as long (faster). Pitch is preserved
 * (approximately - WSOLA isn't phase-exact, but it's a solid, well
 * established approach for exactly this).
 */
export function wsolaStretchChannels(channels, sampleRate, ratio, character = "clean") {
  const p = CHARACTERS[character] || CHARACTERS.clean;
  ratio = Math.max(0.1, Math.min(8, ratio || 1));
  if (Math.abs(ratio - 1) < 1e-6) return channels.map((ch) => Float32Array.from(ch));

  const reference = channels.length > 1 ? toMono(channels) : channels[0];
  const inputLen = reference.length;
  const windowSize = Math.max(64, Math.round((p.windowMs / 1000) * sampleRate));
  const synthesisHop = Math.max(1, Math.round(windowSize * p.hopFraction));
  const analysisHop = Math.max(1, Math.round(synthesisHop / ratio));
  const searchRadius = Math.max(0, Math.round((p.searchMs / 1000) * sampleRate));
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
    if (p.bitDepth) quantizeInPlace(result, p.bitDepth);
    return result;
  });
}

/** ratio to feed wsolaStretchChannels so a recording detected at `detectedBpm` plays back at `targetBpm`. */
export function ratioForTargetTempo(detectedBpm, targetBpm) {
  if (!detectedBpm || !targetBpm) return 1;
  return detectedBpm / targetBpm;
}
