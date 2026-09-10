// key-matching.js
//
// PLAY NICE's pitch half: "this loop is in F minor, the target is D minor - how many
// semitones?" Pure, DOM-free, DSP-free arithmetic on note names, kept separate from both
// the conforming pipeline (conform.js) and the UI (controller.js) so the musical rules
// are unit-testable and reusable anywhere else in Good Bits later.
//
// Two things this deliberately does NOT do:
//
//   - It never returns an octave-scale transposition just because one is mathematically
//     valid. C -> B is one semitone down, not eleven up. See nearestSemitones().
//   - It never tries to convert a major loop into a minor one. Transposition moves a
//     recording's root; it cannot change its mode. When the source and target modes
//     differ the transposition is still calculated (root to root) but flagged
//     `modeMismatch`, so the UI can say so and the user can decide - turn pitch fitting
//     off for that loop, or correct the detected key, or keep it because it sounds good.
//
// HOW ALTERNATIVE BEHAVIOUR GETS ADDED LATER: TRANSPOSE_STRATEGIES below is a registry,
// not a switch statement. A future "compatible keys" strategy (relative major/minor,
// dominant/subdominant, modal interchange, "nearest key within N semitones that shares a
// scale with the target") is a new entry with a resolve() of its own; nothing in
// conform.js or the UI needs to know which one it's calling.

/** Chromatic scale in sharps - the spelling essentia's KeyExtractor returns. */
export const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

/** Flat spellings the note selector offers alongside the sharps, for readability. */
export const FLAT_NAMES = { "C#": "Db", "D#": "Eb", "F#": "Gb", "G#": "Ab", "A#": "Bb" };

export const MODES = ["major", "minor"];

/** Extra spellings accepted from manual input / other analysers: flats, unicode accidentals, and the theoretical enharmonics. */
const NOTE_ALIASES = {
  DB: "C#", EB: "D#", GB: "F#", AB: "G#", BB: "A#",
  "E#": "F", "B#": "C", FB: "E", CB: "B",
};

/**
 * Note name -> 0-11 chromatic index. Tolerant on purpose: case, whitespace, unicode ♯/♭
 * and flat spellings all resolve, because this parses values a human typed as well as
 * values an analyser produced. Returns null for anything that isn't a note.
 */
export function noteToIndex(name) {
  if (typeof name !== "string") return null;
  const cleaned = name.trim().replace(/♯/g, "#").replace(/♭/g, "b").toUpperCase();
  if (!cleaned) return null;
  // "Bb" upper-cases to "BB", so aliases are keyed in that same upper-cased form.
  const canonical = NOTE_ALIASES[cleaned] || cleaned;
  const idx = NOTE_NAMES.indexOf(canonical);
  return idx === -1 ? null : idx;
}

/** 0-11 chromatic index -> sharp note name. Wraps, so 12 is C and -1 is B. */
export function indexToNote(index) {
  if (!Number.isFinite(index)) return null;
  return NOTE_NAMES[((Math.round(index) % 12) + 12) % 12];
}

/**
 * "minor"/"min"/"m"/"aeolian" -> "minor", everything else that is a non-empty string ->
 * "major", null only for a genuinely absent mode. The permissive fallback is deliberate:
 * essentia's KeyExtractor only ever reports "major" or "minor", so an unrecognised
 * non-empty value came from manual input or another analyser and defaulting it to major
 * is far better than dropping a perfectly good root note on the floor. Absent stays
 * absent, because "no mode was detected" is a real state the UI shows differently.
 */
export function normalizeMode(mode) {
  if (typeof mode !== "string") return null;
  const m = mode.trim().toLowerCase();
  if (!m) return null;
  return m === "minor" || m === "min" || m === "m" || m === "aeolian" ? "minor" : "major";
}

/**
 * The signed semitone distance from `fromIndex` to `toIndex` taking the SHORT way round
 * the chromatic circle: always in [-5, +6], never a near-octave leap.
 *
 * The tie at exactly six semitones (a tritone, equally far in both directions) resolves
 * upward. Arbitrary but consistent, and consistency is what matters - a batch where half
 * the tritone cases went up and half went down would be the surprising outcome.
 */
export function nearestSemitones(fromIndex, toIndex) {
  const raw = (((toIndex - fromIndex) % 12) + 12) % 12;
  return raw > 6 ? raw - 12 : raw;
}

/**
 * A major key and its relative minor contain exactly the same notes: C major and A minor
 * are the same seven pitches with a different tonic. The relative minor sits three
 * semitones below the major root, and the relative major three semitones above the minor
 * root.
 *
 * This is what makes the major/minor problem solvable rather than merely reportable - see
 * the "relative" strategy below.
 */
const RELATIVE_MINOR_OFFSET = -3;
const RELATIVE_MAJOR_OFFSET = 3;

/** The root of the key that shares `mode`'s notes but has the opposite mode. */
function relativeRootIndex(rootIndex, mode) {
  const offset = mode === "minor" ? RELATIVE_MAJOR_OFFSET : RELATIVE_MINOR_OFFSET;
  return ((rootIndex + offset) % 12 + 12) % 12;
}

/**
 * Strategy registry - see the module header. Each strategy takes resolved {key, mode}
 * pairs and returns {semitones, modeMismatch, resultRootIndex, resultMode, note}.
 */
export const TRANSPOSE_STRATEGIES = {
  /**
   * Root to root, shortest path. Honest and predictable: a C minor loop conformed to an
   * E minor target comes out in E minor. Its limitation is the mode - conforming a MAJOR
   * loop to a MINOR target this way puts a major third against a minor context, which is
   * a real clash, so the mismatch is flagged rather than hidden.
   */
  "nearest-root": {
    label: "Match root",
    description: "Move the source root onto the target root. Modes that differ are left differing, and flagged.",
    resolve(source, target) {
      const semitones = nearestSemitones(source.index, target.index);
      const modeMismatch = !!(source.mode && target.mode && source.mode !== target.mode);
      return {
        semitones,
        modeMismatch,
        resultRootIndex: target.index,
        resultMode: source.mode,
      };
    },
  },

  /**
   * Match the SCALE rather than the tonic, which is what actually solves major vs. minor.
   *
   * Transposition cannot change a recording's mode - the third is baked into the audio,
   * and no amount of pitch shifting turns a major loop minor. But it does not have to.
   * When the modes differ, transposing the source onto the target's RELATIVE key lands it
   * in the same seven notes as the target while leaving its own mode intact: a loop in
   * F minor conformed to a C major target goes to A minor (C major's relative minor), and
   * every note in it belongs to C major.
   *
   * So this strategy is identical to Match root whenever the modes agree, and only differs
   * in exactly the case Match root cannot handle well. That is why it is the default.
   *
   * What it does NOT claim: the source keeps its own tonal centre, so a minor loop over a
   * major track still sounds like the relative minor rather than the major - related, not
   * transformed. That is a musical fact about transposition, not a shortcut, and the
   * result key is reported so it is never a surprise.
   */
  relative: {
    label: "Match scale",
    description: "Modes that differ are matched to the target's relative major/minor, so the notes agree even though the mode can't change.",
    resolve(source, target) {
      const modesDiffer = !!(source.mode && target.mode && source.mode !== target.mode);
      if (!modesDiffer) {
        return { semitones: nearestSemitones(source.index, target.index), modeMismatch: false, resultRootIndex: target.index, resultMode: source.mode };
      }
      // The target's relative key shares the target's notes and has the SOURCE's mode, so
      // the source can actually be moved onto it.
      const destination = relativeRootIndex(target.index, target.mode);
      return {
        semitones: nearestSemitones(source.index, destination),
        // Handled, not ignored - the UI reports what it did rather than warning.
        modeMismatch: false,
        relativeUsed: true,
        resultRootIndex: destination,
        resultMode: source.mode,
      };
    },
  },
};

export const DEFAULT_TRANSPOSE_STRATEGY = "relative";

/**
 * The one entry point conform.js calls. Resolves both key/mode pairs, runs the chosen
 * strategy, and returns a result that always explains itself rather than silently
 * collapsing to zero - "no transposition needed" and "couldn't work one out" are
 * different answers and the UI shows them differently.
 *
 * @param {{key:string|null, mode:string|null}} source
 * @param {{key:string|null, mode:string|null}} target
 * @param {string} [strategyKey]
 * @returns {{semitones:number, ok:boolean, reason:string|null, modeMismatch:boolean, strategy:string}}
 */
export function resolveTransposition(source, target, strategyKey = DEFAULT_TRANSPOSE_STRATEGY) {
  const strategy = TRANSPOSE_STRATEGIES[strategyKey] || TRANSPOSE_STRATEGIES[DEFAULT_TRANSPOSE_STRATEGY];
  const sourceIndex = noteToIndex(source && source.key);
  const targetIndex = noteToIndex(target && target.key);

  if (sourceIndex === null) {
    return { semitones: 0, ok: false, reason: "no source key", modeMismatch: false, strategy: strategyKey };
  }
  if (targetIndex === null) {
    return { semitones: 0, ok: false, reason: "no target key", modeMismatch: false, strategy: strategyKey };
  }

  const sourceMode = normalizeMode(source.mode);
  const out = strategy.resolve({ index: sourceIndex, mode: sourceMode }, { index: targetIndex, mode: normalizeMode(target.mode) });
  return {
    semitones: out.semitones,
    ok: true,
    reason: null,
    modeMismatch: !!out.modeMismatch,
    relativeUsed: !!out.relativeUsed,
    // What the audio is actually in once conformed - not always the target key, and worth
    // saying out loud when it isn't.
    resultKey: indexToNote(out.resultRootIndex ?? targetIndex),
    resultMode: out.resultMode ?? sourceMode,
    strategy: strategyKey,
  };
}

/**
 * Is `name` a usable note?
 *
 * Exists because noteToIndex("C") is 0, and 0 is falsy - so `if (noteToIndex(key))` silently
 * treats the single most common key in recorded music as "no key detected". Every caller that
 * only needs a yes/no should use this rather than testing the index's truthiness.
 */
export function isNote(name) {
  return noteToIndex(name) !== null;
}

/**
 * "D minor" / "F# major" / "" - the one place a key+mode pair becomes display text.
 *
 * The name is normalised through the chromatic index rather than printed as given, so a
 * source key that arrived spelled "Eb" and a result computed as "D#" read as the same note
 * - which they are. Showing "Eb major -> D# major" for a loop that was not transposed at
 * all is a small thing that makes the tool look like it does not know what it is doing.
 */
export function formatKey(key, mode) {
  if (!key) return "";
  const canonical = indexToNote(noteToIndex(key)) || key;
  const m = normalizeMode(mode);
  return m ? `${canonical} ${m}` : canonical;
}

/** "+3 st" / "-2 st" / "0 st" - signed, so the direction is never ambiguous in a dense list. */
export function formatSemitones(semitones) {
  const n = Math.round(semitones * 100) / 100;
  if (n === 0) return "0 st";
  return `${n > 0 ? "+" : ""}${n} st`;
}
