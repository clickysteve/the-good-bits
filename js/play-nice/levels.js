// levels.js
//
// How loud is this loop, and what would it take to sit it alongside the others?
//
// The problem this solves is not cosmetic. A batch of real loops routinely spans 20dB or
// more - a mastered break next to a raw Rhodes recording - and the mix sums them flat. Hit
// Play all and the loud one buries the quiet one, and the conclusion you draw is "these
// don't play nice", when nothing about the conforming is wrong at all. The tool's central
// claim gets undermined by something it wasn't even measuring.
//
// MONITORING ONLY, BY DEFAULT. Level matching is applied to what you hear, never silently
// to what you export - an exported file that has been gain-changed without being asked is
// a nasty surprise, and the whole point of the export is a faithful conform. The user can
// opt into baking it in.
//
// The measure is loudness-weighted RMS rather than peak: peak tells you about one sample,
// and what buries a Rhodes under a break is sustained energy. This is not ITU-R BS.1770 -
// there is no K-weighting filter here - but for "make these sit together while I audition
// them" the difference is inaudible and the cost is a single pass.

/** Gain is never pushed further than this, so a near-silent file can't be dragged up into its own noise floor. */
export const MAX_MATCH_GAIN_DB = 12;
export const MIN_MATCH_GAIN_DB = -12;

/** Everything is matched towards this, chosen to leave headroom for a dozen loops summed. */
export const REFERENCE_RMS_DB = -20;

export function linToDb(v) {
  return v > 1e-9 ? 20 * Math.log10(v) : -120;
}

export function dbToLin(db) {
  return Math.pow(10, db / 20);
}

/**
 * Integrated RMS of a mono signal, in dBFS, ignoring near-silence.
 *
 * Silence is excluded on purpose: a loop with two bars of music and two bars of tail has
 * half its duration at the noise floor, and averaging that in makes it read as much quieter
 * than it sounds. Gating to frames above a floor measures the loud parts, which is what the
 * ear is judging.
 */
export function integratedRmsDb(mono, sampleRate, { windowMs = 50 } = {}) {
  if (!mono || !mono.length) return null;
  const win = Math.max(1, Math.round((sampleRate * windowMs) / 1000));
  const frames = [];
  let peak = 0;
  for (let pos = 0; pos < mono.length; pos += win) {
    const end = Math.min(mono.length, pos + win);
    let sum = 0;
    for (let i = pos; i < end; i++) sum += mono[i] * mono[i];
    const rms = Math.sqrt(sum / (end - pos));
    frames.push(rms);
    if (rms > peak) peak = rms;
  }
  if (!frames.length || peak <= 0) return null;

  // Absolute gate (true digital silence) plus a relative one 25dB below the loudest frame,
  // which is roughly where a tail stops contributing to perceived loudness.
  const gate = Math.max(1e-5, peak * dbToLin(-25));
  let sum = 0;
  let counted = 0;
  for (const rms of frames) {
    if (rms < gate) continue;
    sum += rms * rms;
    counted++;
  }
  if (!counted) return null;
  return linToDb(Math.sqrt(sum / counted));
}

/**
 * Gain (linear) that brings `rmsDb` to the reference level, clamped so the correction stays
 * a balance adjustment rather than a rescue attempt.
 */
export function matchGain(rmsDb, { referenceDb = REFERENCE_RMS_DB } = {}) {
  if (rmsDb == null) return 1;
  const wanted = referenceDb - rmsDb;
  const clamped = Math.max(MIN_MATCH_GAIN_DB, Math.min(MAX_MATCH_GAIN_DB, wanted));
  return dbToLin(clamped);
}

/** "-8.4 dB · +6.0 dB to match" - what was measured and what monitoring is doing about it. */
export function formatLevel(rmsDb, gain) {
  if (rmsDb == null) return "unknown";
  const measured = `${rmsDb.toFixed(1)} dB`;
  const gainDb = linToDb(gain);
  if (Math.abs(gainDb) < 0.1) return measured;
  return `${measured} · ${gainDb > 0 ? "+" : ""}${gainDb.toFixed(1)} dB to match`;
}
