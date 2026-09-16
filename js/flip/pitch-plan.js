// pitch-plan.js
//
// WHAT to transpose a fragment by, decided musically. Nothing here shifts audio - that's the
// renderer's job (js/flip/render.js) - and nothing here detects a key, because the app already has
// a key detector and FLIP reuses it (js/essentia-bridge.js, via the controller, with the same
// "analysis proposes, user overrides" correction the rest of the app uses).
//
// The failure this module exists to avoid: transposing slices by arbitrary chromatic amounts. That
// is not a musical accident, it is just wrong notes, and on a melodic loop it is instantly the most
// obviously artificial thing in the result. If the source is A minor, a fragment moved up three
// semitones lands on C and belongs; moved up one it lands on A# and does not.
//
// Note names, the note<->index mapping and mode normalisation all come from
// js/play-nice/key-matching.js rather than being reimplemented - it is the app's existing music
// theory, and PLAY NICE and FLIP should not be able to disagree about what "A minor" means.
import { NOTE_NAMES, noteToIndex, indexToNote, normalizeMode, formatKey } from "../play-nice/key-matching.js";

export { NOTE_NAMES, formatKey };

/** Semitone offsets from the root, for the two modes the app's key detection reports. */
export const SCALE_INTERVALS = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
};

export const PITCH_MODES = [
  { key: "off", label: "Off", blurb: "No pitch manipulation at all." },
  { key: "octaves", label: "Octaves", blurb: "Only octaves up or down. Always safe - an octave is the same note." },
  { key: "inkey", label: "In key", blurb: "Scale-degree moves inside the detected key. Small intervals favoured." },
  { key: "mixed", label: "Mixed", blurb: "Mostly in-key moves plus octaves, with the odd surprise when Depth is high." },
];

export const DEFAULT_PITCH_MODE = "inkey";

export function resolvePitchMode(key) {
  return PITCH_MODES.find((m) => m.key === key) || PITCH_MODES.find((m) => m.key === DEFAULT_PITCH_MODE);
}

/**
 * The transpositions available in a key, as semitone offsets, ordered by musical distance from
 * "no change" rather than by semitone count.
 *
 * Scale DEGREES, not semitones, is the right unit: moving a fragment up two scale degrees is a
 * third, and a third is a third whether it happens to be three semitones or four. Working in
 * semitones and filtering to the scale would make thirds sometimes major and sometimes minor for no
 * reason, and would rank a tritone as closer than an octave.
 */
export function scaleDegreeOffsets(mode, maxDegrees = 7) {
  const intervals = SCALE_INTERVALS[normalizeMode(mode)] || SCALE_INTERVALS.minor;
  const size = intervals.length;
  const out = [];
  for (let degree = -maxDegrees; degree <= maxDegrees; degree++) {
    if (degree === 0) continue;
    // Wrap through the scale, adding an octave for each full turn, so degree +9 is a third up an
    // octave rather than falling off the end of the array.
    const octave = Math.floor(degree / size);
    const step = ((degree % size) + size) % size;
    const semitones = intervals[step] + octave * 12;
    out.push({ degree, semitones });
  }
  return out;
}

/**
 * Weighted candidate transpositions for one fragment.
 *
 * `depth` (0..1) is what opens this up: at low depth the only things on offer are neighbouring
 * scale degrees and the octave, which barely register as an effect and mostly read as the loop
 * having found another note. At high depth fourths, fifths, double octaves and - in MIXED - the
 * occasional out-of-key semitone become plausible.
 */
export function pitchCandidates({ mode = "minor", pitchMode = DEFAULT_PITCH_MODE, depth = 0.5, maxSemitones = 24 } = {}) {
  const resolved = resolvePitchMode(pitchMode).key;
  if (resolved === "off") return [];

  const candidates = [];
  const push = (semitones, weight) => {
    if (!semitones || Math.abs(semitones) > maxSemitones || weight <= 0) return;
    candidates.push({ semitones, weight });
  };

  if (resolved === "octaves") {
    push(-12, 1);
    push(12, 1);
    if (depth > 0.75) {
      push(-24, 0.25 * depth);
      push(24, 0.25 * depth);
    }
    return candidates;
  }

  // IN KEY and MIXED both start from scale degrees, weighted by how far they move. A second or a
  // third is the bread and butter; a seventh is an event.
  for (const { degree, semitones } of scaleDegreeOffsets(mode)) {
    const distance = Math.abs(degree);
    let weight;
    if (distance === 1) weight = 1.0; // step
    else if (distance === 2) weight = 0.9; // third
    else if (distance === 3) weight = 0.45 + 0.35 * depth; // fourth
    else if (distance === 4) weight = 0.4 + 0.4 * depth; // fifth
    else if (distance === 7) weight = 0.3 + 0.5 * depth; // octave, via the scale
    else weight = 0.08 + 0.5 * depth; // sixths, sevenths - deliberate leaps
    // Down tends to sit under a loop more comfortably than up, which pokes out.
    if (semitones > 0) weight *= 0.85;
    push(semitones, weight);
  }
  push(-12, 0.5 + 0.2 * depth);
  push(12, 0.35 + 0.2 * depth);

  if (resolved === "mixed") {
    if (depth > 0.55) {
      // The surprises. Kept rare and depth-gated: the point of MIXED is "harmonically coherent with
      // the odd raised eyebrow", not "chromatic".
      push(-1, 0.1 * depth);
      push(1, 0.08 * depth);
      push(6, 0.06 * depth);
    }
    if (depth > 0.8) {
      push(-24, 0.15 * depth);
      push(24, 0.1 * depth);
    }
  }
  return candidates;
}

/** Deterministic weighted choice from pitchCandidates(). Returns semitones, or 0 for no shift. */
export function choosePitch(rng, candidates) {
  if (!candidates || !candidates.length) return 0;
  const total = candidates.reduce((sum, c) => sum + c.weight, 0);
  if (total <= 0) return 0;
  let r = rng.next() * total;
  for (const c of candidates) {
    r -= c.weight;
    if (r <= 0) return c.semitones;
  }
  return candidates[candidates.length - 1].semitones;
}

/**
 * A short melodic shape across `count` repetitions of the same fragment, as semitone offsets.
 *
 * This is the difference between "some slices are pitched" and "the loop found a melody in itself".
 * A fragment repeated four times with the offsets [0, 3, 7, 3] is an arpeggio; the same four
 * repetitions with four independent random pitches is noise. Shapes are chosen, not accumulated.
 */
export function melodicPattern(rng, count, candidates, { depth = 0.5 } = {}) {
  const flat = new Array(count).fill(0);
  if (count < 2 || !candidates || !candidates.length) return flat;

  const a = choosePitch(rng, candidates);
  const shapes = [
    // Alternate: original, up, original, up. The most reliably musical of the lot.
    { w: 1.2, build: () => flat.map((_, i) => (i % 2 === 1 ? a : 0)) },
    // Climb: step up through the available tones.
    {
      w: 0.9,
      build: () => {
        const sorted = candidates.filter((c) => c.semitones > 0).sort((x, y) => x.semitones - y.semitones);
        if (!sorted.length) return flat.map((_, i) => (i % 2 === 1 ? a : 0));
        return flat.map((_, i) => (i === 0 ? 0 : sorted[Math.min(sorted.length - 1, i - 1)].semitones));
      },
    },
    // Fall: the same, downwards.
    {
      w: 0.7,
      build: () => {
        const sorted = candidates.filter((c) => c.semitones < 0).sort((x, y) => y.semitones - x.semitones);
        if (!sorted.length) return flat.map((_, i) => (i % 2 === 1 ? a : 0));
        return flat.map((_, i) => (i === 0 ? 0 : sorted[Math.min(sorted.length - 1, i - 1)].semitones));
      },
    },
    // Arch: away and back. Reads as a phrase rather than a drift.
    { w: 0.8, build: () => flat.map((_, i) => (i === 0 || i === count - 1 ? 0 : a)) },
    // Last one only - a turnaround at the end of the repetition.
    { w: 1.0 + depth, build: () => flat.map((_, i) => (i === count - 1 ? a : 0)) },
  ];

  const total = shapes.reduce((sum, s) => sum + s.w, 0);
  let r = rng.next() * total;
  for (const shape of shapes) {
    r -= shape.w;
    if (r <= 0) return shape.build();
  }
  return shapes[0].build();
}

/** "A minor" from whatever detection or the user gave us, with a safe fallback. */
export function resolveKey({ root, mode } = {}) {
  const index = noteToIndex(root);
  return {
    root: index == null ? null : indexToNote(index),
    mode: normalizeMode(mode) || "minor",
    known: index != null,
  };
}
