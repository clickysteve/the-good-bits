// dsp.js
//
// Pure signal-analysis functions used to find chop boundaries.
// Nothing in this file touches the DOM, the Web Audio API, or fetch/File —
// everything operates on plain Float32Array sample data and numbers, so it
// can be unit-tested in Node as easily as it runs in the browser.
//
// This is a from-scratch rework of a phrase/onset detection approach, with
// two structural changes aimed at a large, varied library of source
// recordings rather than a single mixed/mastered record:
//
//   1. Silence detection is loudness-ADAPTIVE. Instead of a fixed absolute
//      dBFS threshold (which behaves inconsistently across quiet vs. hot
//      recordings), the threshold is set relative to each file's own
//      estimated noise floor.
//   2. Drum chop boundaries can snap to a detected tempo grid, so that a
//      chop's length is an exact whole number of beats and loops cleanly.

// ---------------------------------------------------------------------------
// Basic envelope / energy analysis
// ---------------------------------------------------------------------------

/**
 * Compute a short-time RMS envelope of a mono signal.
 * @param {Float32Array} mono
 * @param {number} sampleRate
 * @param {number} winMs   analysis window length in ms
 * @param {number} hopMs   hop size in ms
 * @returns {{times:number[], vals:number[]}} vals are linear RMS (0..~1)
 */
export function computeRmsEnvelope(mono, sampleRate, winMs = 25, hopMs = 10) {
  const win = Math.max(1, Math.round((sampleRate * winMs) / 1000));
  const hop = Math.max(1, Math.round((sampleRate * hopMs) / 1000));
  const times = [];
  const vals = [];

  for (let pos = 0; pos < mono.length; pos += hop) {
    const end = Math.min(mono.length, pos + win);
    if (end <= pos) break;
    let sumSq = 0;
    for (let i = pos; i < end; i++) {
      const s = mono[i];
      sumSq += s * s;
    }
    const rms = Math.sqrt(sumSq / (end - pos));
    vals.push(rms);
    times.push(pos / sampleRate);
  }
  return { times, vals };
}

/** Linear amplitude -> dBFS. Silent/zero input maps to a very low floor. */
export function linToDb(v) {
  return v > 1e-9 ? 20 * Math.log10(v) : -180;
}

/**
 * Estimate the noise floor of a recording from its own RMS envelope, as a
 * low percentile of the (non -180) dB values. This is what makes silence
 * detection adapt to each file instead of using one fixed threshold for
 * every recording in the library.
 */
export function estimateNoiseFloorDb(vals, percentile = 0.10) {
  // Deliberately does NOT exclude true digital silence (-180dB) — some
  // sources have exact-zero gaps between phrases, and those samples are
  // exactly what should anchor the floor estimate low enough that real
  // playing (at any reasonable level) still reads as "loud".
  if (vals.length === 0) return -60;
  const dbs = vals.map(linToDb).sort((a, b) => a - b);
  const idx = Math.min(dbs.length - 1, Math.max(0, Math.floor(dbs.length * percentile)));
  return dbs[idx];
}

// ---------------------------------------------------------------------------
// Region utilities
// ---------------------------------------------------------------------------

/**
 * Find non-silent [start,end] regions from an RMS envelope, using an
 * absolute dB threshold and a minimum silence duration to bridge over.
 * This replaces the old ffmpeg `silencedetect` + region-inversion pipeline
 * with straightforward array scanning over the envelope we already have.
 */
export function nonSilentRegions(times, vals, thresholdDb, minSilenceSec) {
  const n = times.length;
  if (n === 0) return [];
  const hop = n > 1 ? times[1] - times[0] : 0.01;
  const isLoud = vals.map((v) => linToDb(v) >= thresholdDb);

  // Collapse silent runs shorter than minSilenceSec back into "loud" so a
  // brief dip doesn't fragment a phrase.
  let i = 0;
  while (i < n) {
    if (!isLoud[i]) {
      let j = i;
      while (j < n && !isLoud[j]) j++;
      const runLen = (j - i) * hop;
      if (runLen < minSilenceSec) {
        for (let k = i; k < j; k++) isLoud[k] = true;
      }
      i = j;
    } else {
      i++;
    }
  }

  const regions = [];
  let start = null;
  for (let k = 0; k < n; k++) {
    if (isLoud[k] && start === null) {
      start = times[k];
    } else if (!isLoud[k] && start !== null) {
      regions.push([start, times[k]]);
      start = null;
    }
  }
  if (start !== null) {
    const total = times[n - 1] + hop;
    regions.push([start, total]);
  }
  return regions;
}

/** Merge regions separated by a gap of `gap` seconds or less. */
export function mergeRegions(regions, gap) {
  if (regions.length === 0) return [];
  const merged = [regions[0].slice()];
  for (let i = 1; i < regions.length; i++) {
    const [s, e] = regions[i];
    const last = merged[merged.length - 1];
    if (s - last[1] <= gap) {
      last[1] = e;
    } else {
      merged.push([s, e]);
    }
  }
  return merged;
}

/** Pad each region outward and drop anything still under minLen. */
export function padAndFilterRegions(regions, pad, minLen, totalDuration) {
  const out = [];
  for (const [s0, e0] of regions) {
    const s = Math.max(0, s0 - pad);
    const e = Math.min(totalDuration, e0 + pad);
    if (e - s >= minLen) out.push([s, e]);
  }
  return out;
}

/** Time of the lowest-energy sample of the envelope within [a,b]. */
export function lowestEnergyTime(times, vals, a, b, fallback) {
  let best = null;
  let bestVal = Infinity;
  for (let i = 0; i < times.length; i++) {
    const t = times[i];
    if (t < a || t > b) continue;
    if (vals[i] < bestVal) {
      bestVal = vals[i];
      best = t;
    }
  }
  return best === null ? fallback : best;
}

/**
 * Split any region longer than maxLen into pieces near `preferred` length,
 * choosing the cut point at the lowest-energy moment in a window around the
 * target rather than an arbitrary timestamp.
 */
export function splitLongNaturally(regions, times, vals, preferred, maxLen, minPiece) {
  const out = [];
  for (const [s, e] of regions) {
    let cur = s;
    while (e - cur > maxLen) {
      const target = cur + preferred;
      const searchA = Math.max(cur + minPiece, target - 3.0);
      const searchB = Math.min(e - minPiece, target + 3.0);
      let cut;
      if (searchB <= searchA) {
        cut = Math.min(cur + maxLen, e);
      } else {
        cut = lowestEnergyTime(times, vals, searchA, searchB, target);
      }
      if (cut - cur < minPiece) cut = Math.min(cur + maxLen, e);
      out.push([cur, cut]);
      cur = cut;
    }
    if (e - cur >= minPiece) {
      out.push([cur, e]);
    } else if (out.length && Math.abs(out[out.length - 1][1] - cur) < 1e-6) {
      out[out.length - 1][1] = e;
    }
  }
  return out;
}

/**
 * Full phrase-detection pipeline for melodic sources (sax/trumpet, Rhodes).
 * @param {Float32Array} mono
 * @param {number} sampleRate
 * @param {object} p  mode parameters, see ui defaults in app.js
 */
export function phraseRegions(mono, sampleRate, p) {
  const duration = mono.length / sampleRate;
  const { times, vals } = computeRmsEnvelope(mono, sampleRate, 25, 10);
  const noiseFloorDb = estimateNoiseFloorDb(vals);
  const thresholdDb = noiseFloorDb + p.silenceMarginDb;

  const nonSilent = nonSilentRegions(times, vals, thresholdDb, p.minSilenceDuration);
  const merged = mergeRegions(nonSilent, p.mergeGap);
  const padded = padAndFilterRegions(merged, p.pad, p.minLen, duration);
  const finalRegions = splitLongNaturally(padded, times, vals, p.preferred, p.maxLen, p.minLen);

  return { regions: finalRegions, noiseFloorDb, thresholdDb };
}

// ---------------------------------------------------------------------------
// Drum / onset analysis
// ---------------------------------------------------------------------------

function percentile(vals, p) {
  if (!vals.length) return 0;
  const s = [...vals].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.floor((s.length - 1) * p));
  return s[idx];
}

/** Positive-going jumps in log energy, used as an onset-strength curve. */
export function onsetStrengthCurve(vals) {
  const logs = vals.map((v) => Math.log10(v + 1.0));
  const diffs = [0];
  for (let i = 1; i < logs.length; i++) {
    diffs.push(Math.max(0, logs[i] - logs[i - 1]));
  }
  return diffs;
}

/** Pick local-maxima onsets above an adaptive threshold, debounced by minSpacing. */
export function pickOnsets(times, diffs, sensitivity = 0.65, minSpacing = 0.12) {
  const threshold = Math.max(0.025, percentile(diffs, 0.82) * sensitivity);
  const onsets = [];
  let last = -999;
  for (let i = 1; i < diffs.length - 1; i++) {
    if (diffs[i] >= threshold && diffs[i] >= diffs[i - 1] && diffs[i] >= diffs[i + 1]) {
      const t = times[i];
      if (t - last >= minSpacing) {
        onsets.push(t);
        last = t;
      }
    }
  }
  return onsets;
}

/**
 * Snap a candidate cut time to the nearest beat-grid line for a given tempo,
 * so that resulting chop lengths are exact whole numbers of beats and loop
 * cleanly. gridStart is the time of beat 1 (usually the first strong onset).
 * Returns the original time unmodified if it's further than `tolerance`
 * seconds from any grid line.
 */
export function snapToBeatGrid(t, bpm, gridStart, tolerance) {
  if (!bpm || bpm <= 0) return t;
  const beatPeriod = 60 / bpm;
  const n = Math.round((t - gridStart) / beatPeriod);
  const grid = gridStart + n * beatPeriod;
  return Math.abs(grid - t) <= tolerance ? grid : t;
}

/**
 * Break-sized drum phrase detection. Walks the file in ~preferred-length
 * chunks, choosing each boundary from a nearby detected onset (falling back
 * to the lowest-energy point), then — when a confident tempo is supplied —
 * snapping that boundary onto the beat grid so the chop is loop-ready.
 */
export function drumRegions(mono, sampleRate, p, bpm = null) {
  const duration = mono.length / sampleRate;
  const { times, vals } = computeRmsEnvelope(mono, sampleRate, 20, 10);
  if (!vals.length) return { regions: [[0, duration]], onsets: [] };

  const diffs = onsetStrengthCurve(vals);
  const onsets = pickOnsets(times, diffs, p.onsetSensitivity, 0.12);
  const gridStart = bpm && onsets.length ? onsets[0] : 0;
  const tolerance = bpm ? (60 / bpm) * 0.5 : 0;

  const bounds = [0];
  let cur = 0;
  while (duration - cur > p.maxLen) {
    const target = cur + p.preferred;
    const lo = Math.max(cur + p.minLen, target - 2.5);
    const hi = Math.min(cur + p.maxLen, target + 2.5);

    const nearby = onsets.filter((t) => t >= lo && t <= hi);
    let cut;
    if (nearby.length) {
      cut = nearby.reduce((a, b) => (Math.abs(a - target) <= Math.abs(b - target) ? a : b));
    } else {
      cut = lowestEnergyTime(times, vals, lo, hi, target);
    }

    if (bpm) {
      const snapped = snapToBeatGrid(cut, bpm, gridStart, tolerance);
      if (snapped >= lo - tolerance && snapped <= hi + tolerance && snapped - cur >= p.minLen) {
        cut = snapped;
      }
    }

    if (cut - cur < p.minLen) cut = Math.min(cur + p.preferred, duration);
    bounds.push(cut);
    cur = cut;
  }

  if (duration - bounds[bounds.length - 1] < p.minLen && bounds.length > 1) {
    bounds[bounds.length - 1] = duration;
  } else {
    bounds.push(duration);
  }

  const regions = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const a = bounds[i];
    const b = bounds[i + 1];
    if (b - a >= 0.5) regions.push([Math.max(0, a), Math.min(duration, b)]);
  }
  return { regions, onsets, gridStart };
}

// ---------------------------------------------------------------------------
// Click-free boundaries
// ---------------------------------------------------------------------------

/**
 * Search outward from `sampleIndex` (within +/- windowSamples) for the
 * nearest sample where the signal crosses zero, to avoid an audible click
 * at a hard cut. Falls back to the original index if no crossing is found.
 */
export function findNearestZeroCrossing(mono, sampleIndex, windowSamples) {
  const n = mono.length;
  const start = Math.max(1, sampleIndex - windowSamples);
  const end = Math.min(n - 1, sampleIndex + windowSamples);
  let best = sampleIndex;
  let bestDist = Infinity;
  for (let i = start; i <= end; i++) {
    const prev = mono[i - 1];
    const cur = mono[i];
    if ((prev <= 0 && cur >= 0) || (prev >= 0 && cur <= 0)) {
      const dist = Math.abs(i - sampleIndex);
      if (dist < bestDist) {
        bestDist = dist;
        best = i;
      }
    }
  }
  return best;
}

/** Apply a linear fade-in/out in place to a set of per-channel Float32Arrays. */
export function applyFades(channels, fadeInSamples, fadeOutSamples) {
  for (const ch of channels) {
    const n = ch.length;
    const fi = Math.min(fadeInSamples, Math.floor(n / 2));
    const fo = Math.min(fadeOutSamples, Math.floor(n / 2));
    for (let i = 0; i < fi; i++) ch[i] *= i / fi;
    for (let i = 0; i < fo; i++) ch[n - 1 - i] *= i / fo;
  }
}

// ---------------------------------------------------------------------------
// Resampling (analysis only — export always uses full-resolution audio)
// ---------------------------------------------------------------------------

/** Downmix any number of channels to mono by averaging. */
export function toMono(channels) {
  const n = channels[0].length;
  if (channels.length === 1) return channels[0];
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (const ch of channels) sum += ch[i];
    out[i] = sum / channels.length;
  }
  return out;
}

/** Simple linear-interpolation resampler, good enough for analysis use. */
export function resampleLinear(mono, fromRate, toRate) {
  if (fromRate === toRate) return mono;
  const ratio = toRate / fromRate;
  const outLen = Math.max(1, Math.round(mono.length * ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const srcPos = i / ratio;
    const i0 = Math.floor(srcPos);
    const i1 = Math.min(mono.length - 1, i0 + 1);
    const frac = srcPos - i0;
    out[i] = mono[i0] * (1 - frac) + mono[i1] * frac;
  }
  return out;
}
