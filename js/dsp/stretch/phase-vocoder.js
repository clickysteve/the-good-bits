// phase-vocoder.js
//
// FFT-based phase-vocoder stretch engine, real STFT analysis/resynthesis
// (not a WSOLA variant wearing a different name). Supports two genuinely
// different behaviours via its own parameters rather than two code paths:
//
//   - phaseLocking (identity phase locking, Laroche/Dolson): synthesis phase
//     around each spectral peak is locked to that peak's phase trajectory,
//     which keeps the spectral shape coherent frame-to-frame and is what a
//     "transient-aware" vocoder needs to sound punchy rather than washy.
//   - transientReset: frames flagged as transients (spectral-flux jump on a
//     shared mono reference, so stereo channels reset together) get their
//     phase accumulator reset to the raw analysis phase instead of
//     propagated, which stops the smeared pre-echo a stretched drum hit
//     would otherwise get.
//   - phaseRandomize: deliberately detunes the per-bin synthesis phase, the
//     classic naive-vocoder "phasiness"/robotic/underwater artifact. Left
//     audible on purpose for the "naive" characters (Phase, Underwater,
//     Metallic) - see js/dsp/stretch/characters.js.
//
// Real-signal STFT: only bins [0, N/2] are analysed/synthesised, then
// mirrored (conjugate symmetry) before the inverse FFT so the reconstructed
// frame stays real-valued.
import { toMono } from "../../dsp.js";
import { ifft, nextPow2, wrapPhase } from "./fft.js";
import { getWindow } from "./windows.js";
import { makeRng } from "./rng.js";
import { analyzeFrame, synthesizeSpectrum, normalizeOverlapAdd } from "./stft.js";

/** Local maxima of `mag`, above a small fraction of the frame's own peak, used for identity phase locking. */
function findPeaks(mag, half) {
  let frameMax = 0;
  for (let k = 0; k <= half; k++) if (mag[k] > frameMax) frameMax = mag[k];
  const floor = frameMax * 0.02;
  const peaks = [];
  for (let k = 1; k < half; k++) {
    if (mag[k] >= mag[k - 1] && mag[k] >= mag[k + 1] && mag[k] > floor) peaks.push(k);
  }
  if (peaks.length === 0) peaks.push(0);
  return peaks;
}

/** Which peak "owns" each bin (nearest peak, ties to the lower one), for identity phase locking. */
function ownerForEachBin(peaks, half) {
  const owner = new Int32Array(half + 1);
  let pi = 0;
  for (let k = 0; k <= half; k++) {
    while (pi < peaks.length - 1 && Math.abs(peaks[pi + 1] - k) <= Math.abs(peaks[pi] - k)) pi++;
    owner[k] = peaks[pi];
  }
  return owner;
}

/** Spectral flux (positive-only) between two magnitude frames, used to flag transient frames. */
function spectralFlux(mag, prevMag, half) {
  let flux = 0;
  for (let k = 0; k <= half; k++) flux += Math.max(0, mag[k] - (prevMag ? prevMag[k] : 0));
  return flux;
}

/** Frame indices (shared across channels) whose spectral flux is a sharp outlier vs. the running average. */
function detectTransientFrames(reference, fftSize, hop, window, half, numFrames, sensitivity) {
  const fluxes = new Float64Array(numFrames);
  let prevMag = null;
  for (let m = 0; m < numFrames; m++) {
    const { mag } = analyzeFrame(reference, m * hop, fftSize, window, half);
    fluxes[m] = spectralFlux(mag, prevMag, half);
    prevMag = mag;
  }
  const mean = fluxes.reduce((a, b) => a + b, 0) / Math.max(1, numFrames);
  const threshold = mean * (2.2 - 1.2 * sensitivity); // higher sensitivity -> lower threshold -> more resets
  const flags = new Uint8Array(numFrames);
  for (let m = 1; m < numFrames; m++) flags[m] = fluxes[m] > threshold && fluxes[m] > 1e-6 ? 1 : 0;
  return flags;
}

/**
 * params: { fftMs, overlap, phaseLocking, phaseRandomize (0-1), transientReset, transientSensitivity (0-1) }
 */
export function stretchPhaseVocoder(channels, sampleRate, ratio, params, seed) {
  const p = params || {};
  const fftSize = nextPow2(Math.max(64, Math.round(((p.fftMs ?? 46) / 1000) * sampleRate)));
  const half = fftSize / 2;
  const hopDivisor = Math.max(2, p.overlap ?? 4);
  const Ha = Math.max(1, Math.round(fftSize / hopDivisor));
  const Hs = Math.max(1, Math.round(Ha * ratio));
  const window = getWindow("hann", fftSize);
  const phaseLocking = !!p.phaseLocking;
  const phaseRandomize = Math.max(0, Math.min(1, p.phaseRandomize ?? 0));
  const transientReset = !!p.transientReset;
  const transientSensitivity = Math.max(0, Math.min(1, p.transientSensitivity ?? 0.5));

  const reference = channels.length > 1 ? toMono(channels) : channels[0];
  const inputLen = reference.length;
  const outLen = Math.max(fftSize, Math.round(inputLen * ratio));
  const numFrames = Math.max(1, Math.ceil(inputLen / Ha) + 1);

  const transientFlags = transientReset ? detectTransientFrames(reference, fftSize, Ha, window, half, numFrames, transientSensitivity) : null;

  const expectedAdvance = new Float64Array(half + 1);
  for (let k = 0; k <= half; k++) expectedAdvance[k] = (2 * Math.PI * k * Ha) / fftSize;

  return channels.map((chan) => {
    // Reseeded identically per channel: the random phase sequence lines up bin-for-bin and
    // frame-for-frame across L/R, so randomisation colours the stereo image without smearing it.
    const rng = phaseRandomize > 0 ? makeRng(seed) : null;

    const out = new Float64Array(outLen + fftSize);
    const weight = new Float64Array(outLen + fftSize);
    const outPhase = new Float64Array(half + 1);
    let prevAnalysisPhase = null;
    let havePrev = false;

    const synRe = new Float64Array(fftSize);
    const synIm = new Float64Array(fftSize);

    for (let m = 0; m < numFrames; m++) {
      const analysisPos = m * Ha;
      const synthesisPos = m * Hs;
      if (synthesisPos > outLen + fftSize) break;

      const { mag, phase } = analyzeFrame(chan, analysisPos, fftSize, window, half);
      const isTransient = transientFlags ? !!transientFlags[m] : false;

      if (!havePrev) {
        for (let k = 0; k <= half; k++) outPhase[k] = phase[k];
        havePrev = true;
      } else if (isTransient) {
        for (let k = 0; k <= half; k++) outPhase[k] = phase[k];
      } else {
        for (let k = 0; k <= half; k++) {
          const delta = wrapPhase(phase[k] - prevAnalysisPhase[k] - expectedAdvance[k]);
          const trueFreq = (2 * Math.PI * k) / fftSize + delta / Ha;
          outPhase[k] += trueFreq * Hs;
        }
      }

      if (phaseLocking) {
        const peaks = findPeaks(mag, half);
        const owner = ownerForEachBin(peaks, half);
        // Snapshot peak phases before rewriting non-peak bins relative to them.
        const peakOutPhase = new Float64Array(half + 1);
        for (const pk of peaks) peakOutPhase[pk] = outPhase[pk];
        for (let k = 0; k <= half; k++) {
          const own = owner[k];
          if (k !== own) outPhase[k] = peakOutPhase[own] + (phase[k] - phase[own]);
        }
      }

      if (rng) {
        for (let k = 1; k < half; k++) outPhase[k] += phaseRandomize * rng.signed() * Math.PI;
      }

      synthesizeSpectrum(synRe, synIm, mag, outPhase, fftSize, half);
      ifft(synRe, synIm);

      for (let i = 0; i < fftSize; i++) {
        const s = synRe[i] * window[i];
        out[synthesisPos + i] += s;
        weight[synthesisPos + i] += window[i] * window[i];
      }

      prevAnalysisPhase = phase;
    }

    return normalizeOverlapAdd(out, weight, outLen);
  });
}
