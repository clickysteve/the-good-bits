// granular.js
//
// Real granular-synthesis time-stretch: reads short overlapping grains from
// the source (nominally advancing in step with the requested ratio) and
// writes them to evenly-spaced output positions, with per-grain jitter in
// source position, output timing, pitch (resampled grain playback rate) and
// optional random reversal / silent dropout. This is a structurally
// different algorithm from WSOLA (no similarity search - grains are cheap
// and can legitimately misbehave) and from the STFT engines (no FFT at all),
// which is what makes it capable of the "unstable grains" family of
// characters (Grain, Scatter, Flutter, Shred, Cloud, Nervous, Broken).
//
// Determinism/stereo: every per-grain random decision (position jitter,
// timing jitter, pitch jitter, reverse, dropout) is made ONCE from a mono
// reference and applied identically to every channel, exactly like WSOLA's
// grain-placement search - so stereo material keeps its image instead of
// each channel scattering independently.
import { toMono } from "../../dsp.js";
import { getWindow } from "./windows.js";
import { makeRng } from "./rng.js";
import { quantizeInPlace } from "./wsola.js";

function centsToRatio(cents) {
  return Math.pow(2, cents / 1200);
}

/** Reads `outLen` samples from `chan` starting at `srcStart`, resampled by `rate` (rate>1 reads faster/shorter -> higher pitch), optionally reversed. Out-of-range reads are 0. */
function readGrain(chan, srcStart, outLen, rate, reversed) {
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const srcOffset = reversed ? (outLen - 1 - i) * rate : i * rate;
    const srcPos = srcStart + srcOffset;
    const i0 = Math.floor(srcPos);
    const frac = srcPos - i0;
    const a = chan[i0] || 0;
    const b = chan[i0 + 1] || 0;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

/**
 * params: { grainMs, hopFraction, posJitterMs, timeJitterMs, pitchJitterCents, reverseProb,
 * dropoutProb, envelope ('hann'|'tri'|'rect'), bitDepth }
 */
export function stretchGranular(channels, sampleRate, ratio, params, seed) {
  const p = params || {};
  const grainMs = p.grainMs ?? 60;
  const hopFraction = p.hopFraction ?? 0.5;
  const posJitterMs = p.posJitterMs ?? 4;
  const timeJitterMs = p.timeJitterMs ?? 0;
  const pitchJitterCents = p.pitchJitterCents ?? 0;
  const reverseProb = p.reverseProb ?? 0;
  const dropoutProb = p.dropoutProb ?? 0;
  const envelopeShape = p.envelope ?? "hann";
  const bitDepth = p.bitDepth ?? null;

  const grainSamples = Math.max(16, Math.round((grainMs / 1000) * sampleRate));
  const synthesisHop = Math.max(1, Math.round(grainSamples * hopFraction));
  const analysisHop = Math.max(1, synthesisHop / ratio);
  const posJitterSamples = (posJitterMs / 1000) * sampleRate;
  const timeJitterSamples = (timeJitterMs / 1000) * sampleRate;
  const window = getWindow(envelopeShape, grainSamples);

  const reference = channels.length > 1 ? toMono(channels) : channels[0];
  const inputLen = reference.length;
  const outLen = Math.max(grainSamples, Math.round(inputLen * ratio));

  const rng = makeRng(seed);
  const grains = [];
  let analysisPos = 0;
  let synthesisPos = 0;
  while (synthesisPos < outLen && analysisPos < inputLen + grainSamples) {
    const srcStart = analysisPos + rng.signed() * posJitterSamples;
    const dstStart = synthesisPos + rng.signed() * timeJitterSamples;
    const reversed = rng.bool(reverseProb);
    const dropped = rng.bool(dropoutProb);
    const pitchRatio = centsToRatio(rng.signed() * pitchJitterCents);
    grains.push({ srcStart: Math.max(0, srcStart), dstStart: Math.max(0, Math.round(dstStart)), reversed, dropped, pitchRatio });
    analysisPos += analysisHop;
    synthesisPos += synthesisHop;
  }

  return channels.map((chan) => {
    const out = new Float32Array(outLen + grainSamples);
    const weight = new Float32Array(outLen + grainSamples);
    for (const g of grains) {
      if (g.dropped) continue;
      const grain = readGrain(chan, g.srcStart, grainSamples, g.pitchRatio, g.reversed);
      for (let i = 0; i < grainSamples; i++) {
        out[g.dstStart + i] += grain[i] * window[i];
        weight[g.dstStart + i] += window[i];
      }
    }
    const result = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) result[i] = weight[i] > 1e-6 ? out[i] / weight[i] : 0;
    if (bitDepth) quantizeInPlace(result, bitDepth);
    return result;
  });
}
