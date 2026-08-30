// repeat.js
//
// Deliberately primitive time-stretch: walk the source in fixed-size chunks
// and repeat each chunk enough times to hit the target duration, with only a
// short linear crossfade where consecutive segments join - no similarity
// search, no windows, no FFT. This is what a lot of early digital samplers
// actually did when asked to "time-stretch" (or just what happens when you
// loop a short region to fill time), and it's the source of the
// characteristic buzzy, pitched repetition artifact those machines are known
// for: repeating a chunk of length L produces an audible tone/buzz at
// sampleRate/L, on top of whatever the chunk's own content was.
//
// A Bresenham-style accumulator decides, chunk by chunk, whether this chunk
// repeats floor(ratio) or ceil(ratio) times, so the overall output lands
// close to the requested ratio even though every individual repeat count is
// a whole number.
import { toMono } from "../../dsp.js";
import { quantizeInPlace } from "./wsola.js";
import { makeRng } from "./rng.js";

/**
 * params: { chunkMs, crossfadeMs, bitDepth, repeatJitter (0-1, random +/-1 wobble on repeat count) }
 */
export function stretchRepeat(channels, sampleRate, ratio, params, seed) {
  const p = params || {};
  const chunkMs = p.chunkMs ?? 90;
  const crossfadeMs = p.crossfadeMs ?? 3;
  const bitDepth = p.bitDepth ?? null;
  const repeatJitter = Math.max(0, Math.min(1, p.repeatJitter ?? 0));

  const chunkSamples = Math.max(32, Math.round((chunkMs / 1000) * sampleRate));
  const crossfadeSamplesTarget = Math.max(0, Math.round((crossfadeMs / 1000) * sampleRate));

  const reference = channels.length > 1 ? toMono(channels) : channels[0];
  const inputLen = reference.length;

  // Decide, once (shared across channels), how many times each source chunk plays - 0 times
  // (dropped entirely) is a valid outcome, and is what makes ratio < 1 (compression) work: the
  // "primitive" analogue of skipping fractions of a chunk is just not playing some chunks at all.
  // Standard Bresenham-style error-diffusion accumulator, so the average across all chunks still
  // lands on the requested ratio even though every individual count is a whole number (including 0).
  const rng = makeRng(seed);
  const chunks = [];
  let acc = 0;
  for (let srcStart = 0; srcStart < inputLen; srcStart += chunkSamples) {
    acc += ratio;
    let count = Math.round(acc);
    acc -= count;
    if (repeatJitter > 0 && count > 0 && rng.bool(repeatJitter * 0.5)) {
      count = Math.max(0, count + (rng.bool() ? -1 : 1));
    }
    const len = Math.min(chunkSamples, inputLen - srcStart);
    if (len > 0 && count > 0) chunks.push({ srcStart, len, count });
  }
  if (chunks.length === 0) chunks.push({ srcStart: 0, len: Math.max(1, inputLen), count: 1 });

  // Flatten into individual playback segments (one per repeat), then figure out how much each
  // segment after the first overlaps its predecessor for the crossfade.
  const segments = [];
  for (const { srcStart, len, count } of chunks) {
    for (let r = 0; r < count; r++) segments.push({ srcStart, len });
  }

  let totalOut = 0;
  let prevLen = 0;
  for (let i = 0; i < segments.length; i++) {
    const len = segments[i].len;
    const cf = i === 0 ? 0 : Math.min(crossfadeSamplesTarget, len - 1, prevLen - 1);
    totalOut += len - cf;
    prevLen = len;
  }

  return channels.map((chan) => {
    const out = new Float32Array(Math.max(1, totalOut));
    let writePos = 0;
    let prevSegLen = 0;
    for (let i = 0; i < segments.length; i++) {
      const { srcStart, len } = segments[i];
      const cf = i === 0 ? 0 : Math.min(crossfadeSamplesTarget, len - 1, prevSegLen - 1);
      const start = writePos - cf;
      for (let k = 0; k < len; k++) {
        const idx = start + k;
        if (idx < 0 || idx >= out.length) continue;
        const s = chan[srcStart + k] || 0;
        if (k < cf) {
          const g = (k + 1) / (cf + 1);
          out[idx] = out[idx] * (1 - g) + s * g;
        } else {
          out[idx] = s;
        }
      }
      writePos = start + len;
      prevSegLen = len;
    }
    if (bitDepth) quantizeInPlace(out, bitDepth);
    return out;
  });
}
