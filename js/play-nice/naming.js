// naming.js
//
// What a conformed file is called, and where it goes. Pure and testable, for the same
// reason js/naming-tokens.js is: filenames are the part of an export a user actually
// lives with afterwards, and getting them wrong is silent.
//
// Three rules, straight from how the rest of Good Bits already behaves:
//
//   - NEVER overwrite a source. Output always lands in its own directory (PLAY NICE's
//     equivalent of CHOP's "chops/" and "one shots/"), never beside the original.
//   - Keep the original name recognisable. The stem stays at the front, unshortened
//     unless it's genuinely enormous, so a conformed loop is still findable by the name
//     the user knows it by.
//   - Say what happened. The target it was conformed to is in the name, because six
//     months later "which of these is the 128 version?" is the actual question.
//
// Result: "amen break play nice 128bpm Em.wav" - reuses joinNameParts/buildKeyTempoTag/
// sanitizeForPath from js/dsp.js so separator and path-safety behaviour match every
// other export path in the app.
import { buildKeyTempoTag, joinNameParts, sanitizeForPath, truncateStem } from "../dsp.js";

/** The subdirectory conformed audio is written into, under the chosen destination. */
export const PLAY_NICE_OUTPUT_DIR = "play nice";

/** Same limit CHOP uses, so nothing PLAY NICE writes can hit a path length CHOP wouldn't. */
const SAFE_NAME_LIMIT = 180;
const STEM_LIMIT = 120;

/** Strip the extension off a filename, leaving the stem. */
export function stemOf(fileName) {
  const dot = fileName.lastIndexOf(".");
  return dot > 0 ? fileName.slice(0, dot) : fileName;
}

/**
 * Build the output filename for one conformed file.
 *
 * @param {string} fileName    the original filename, extension and all
 * @param {object} target      a TargetContext - what it was conformed TO
 * @param {object} plan        the conform plan, so a pitch-only or tempo-only result says so
 * @param {object} [options]
 * @param {string} [options.marker]  the "processed by PLAY NICE" marker
 * @param {string} [options.sep]     separator between name parts
 */
export function conformedFileName(fileName, target, plan, { marker = "play nice", sep = " " } = {}) {
  const stem = truncateStem(stemOf(fileName), STEM_LIMIT);

  // Only describe what actually changed. A tempo-only conform naming a key it never
  // touched would be a lie in a filename, which is worse than a longer name.
  const tag = buildKeyTempoTag(
    {
      bpm: plan.tempo.applied || plan.tempo.fit ? target.bpm : null,
      key: plan.pitch.applied || plan.pitch.fit ? target.key : null,
      scale: target.keyMode,
    },
    sep
  );

  const joined = joinNameParts([stem, marker, tag], sep);
  const safe = sanitizeForPath(joined, SAFE_NAME_LIMIT) || sanitizeForPath(stem, SAFE_NAME_LIMIT) || "play nice";
  return `${safe}.wav`;
}

/**
 * The output folder name for a batch, e.g. "play nice 128bpm Em". One clearly-named
 * folder per target, so conforming the same pile of loops to two different targets
 * produces two folders rather than one mixed one.
 */
export function batchFolderName(target, { marker = "play nice", sep = " " } = {}) {
  const tag = buildKeyTempoTag({ bpm: target.bpm, key: target.pitchEnabled ? target.key : null, scale: target.keyMode }, sep);
  return sanitizeForPath(joinNameParts([marker, tag], sep), SAFE_NAME_LIMIT) || PLAY_NICE_OUTPUT_DIR;
}

/**
 * Make a name unique within `taken` by appending " 2", " 3", ... before the extension.
 * Two different source folders can easily hold "loop.wav", and a batch export flattens
 * them into one destination - silently overwriting one with the other would lose work.
 */
export function uniqueName(name, taken) {
  if (!taken.has(name)) {
    taken.add(name);
    return name;
  }
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let n = 2; n < 10000; n++) {
    const candidate = `${stem} ${n}${ext}`;
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
  const fallback = `${stem} ${Date.now()}${ext}`;
  taken.add(fallback);
  return fallback;
}
