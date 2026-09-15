// styles.js
//
// FLIP's remix personalities. A style is not an algorithm - it's a weighting over the shared
// operation vocabulary (js/flip/operations.js) plus two scalars that say how eager and how far-
// reaching this personality is. Adding a style is a data change; adding an operation is one entry
// in the other file and a weight in however many styles want it.
//
// `weights`   relative likelihood of each operation being the one picked for a given chunk.
//             An absent or zero weight means this personality never does that.
// `rateScale` multiplies how often a chunk is touched at all. Below 1 = leaves more alone.
// `severityScale` multiplies intensity before the operations read it. Above 1 = reaches further,
//             bigger groups, longer jumps, finer stutters - at the same slider position.
// `unlocks`   per-style override of an operation's own intensity gate. A style that exists to do a
//             thing shouldn't have to wait for the slider to permit it: STUTTER stutters at 10.
//
// MIXED vs CHAOS is the distinction the brief asks for and it's deliberately not "more of the same":
// MIXED draws from the whole gentle end of the vocabulary at a NORMAL rate and severity, so it reads
// as a considered remix that happens to use several techniques. CHAOS turns up the rate AND the
// severity AND unlocks the destructive operations early, so it can genuinely wreck things.

export const STYLES = [
  {
    key: "shuffle",
    label: "Shuffle",
    blurb: "Reorders whole chunks and swaps neighbours. The material survives; the order doesn't.",
    rateScale: 0.95,
    severityScale: 0.9,
    weights: {
      "swap-groups": 3,
      "move-fragment": 2.2,
      "jump-back": 1.4,
      "jump-forward": 1.1,
      "repeat-group": 0.8,
      "repeat-half-beat": 0.5,
      "hold-downbeat": 0.6,
    },
    unlocks: { "move-fragment": 0 },
  },
  {
    key: "repeat",
    label: "Repeat",
    blurb: "Builds motifs out of what's already there - repeats, A/B alternation, call and response.",
    rateScale: 1,
    severityScale: 0.85,
    weights: {
      "repeat-slice": 2.4,
      "repeat-group": 2.6,
      "repeat-half-beat": 1.8,
      alternate: 1.9,
      "call-response": 1.6,
      "hold-downbeat": 0.8,
    },
    unlocks: { alternate: 0, "call-response": 0 },
  },
  {
    key: "jump",
    label: "Jump",
    blurb: "Skips backwards and forwards through the phrase, mostly to somewhere nearby.",
    rateScale: 1.05,
    severityScale: 1,
    weights: {
      "jump-back": 3,
      "jump-forward": 2.4,
      "move-fragment": 1.4,
      "swap-groups": 0.7,
      "repeat-group": 0.6,
      "hold-downbeat": 0.5,
    },
    unlocks: { "jump-forward": 0, "move-fragment": 0.1 },
  },
  {
    key: "stutter",
    label: "Stutter",
    blurb: "Breaks individual slices into rapid fragments, usually running into the next downbeat.",
    rateScale: 0.9,
    severityScale: 1.15,
    weights: {
      "stutter-slice": 2.8,
      "stutter-tail": 2.4,
      "repeat-slice": 1.6,
      "repeat-half-beat": 1,
      "hold-downbeat": 0.7,
      "repeat-group": 0.5,
    },
    unlocks: { "stutter-slice": 0.05, "stutter-tail": 0.05 },
  },
  {
    key: "reverse",
    label: "Reverse",
    blurb: "Turns slices and groups round - the audio inside them, not just their order.",
    rateScale: 0.9,
    severityScale: 0.95,
    weights: {
      "reverse-slice": 2.6,
      "reverse-group": 2.4,
      "call-response": 1.4,
      "repeat-group": 0.7,
      "hold-downbeat": 0.7,
    },
    unlocks: { "reverse-group": 0.05, "call-response": 0 },
  },
  {
    key: "sparse",
    label: "Sparse",
    blurb: "Takes things away. Slices drop out to deliberate silence, and what's left gets room.",
    rateScale: 1,
    severityScale: 0.85,
    weights: {
      "silence-slice": 3.2,
      "repeat-group": 1,
      "jump-back": 0.8,
      "hold-downbeat": 0.9,
      "repeat-half-beat": 0.6,
    },
    unlocks: { "silence-slice": 0 },
  },
  {
    key: "mixed",
    label: "Mixed",
    blurb: "A bit of everything, but still trying to sound like a version of your loop.",
    rateScale: 0.95,
    severityScale: 0.9,
    weights: {
      "repeat-group": 1.5,
      "repeat-slice": 1.1,
      "repeat-half-beat": 1.2,
      "swap-groups": 1.3,
      "jump-back": 1.3,
      "jump-forward": 0.9,
      "hold-downbeat": 1.2,
      "call-response": 1.2,
      alternate: 1,
      "reverse-slice": 0.8,
      "reverse-group": 0.6,
      "move-fragment": 0.8,
      "stutter-tail": 0.6,
      "stutter-slice": 0.4,
      "silence-slice": 0.5,
    },
  },
  {
    key: "chaos",
    label: "Chaos",
    blurb: "Everything at once, further and more often. Expect to throw most of these away.",
    rateScale: 1.5,
    severityScale: 1.35,
    weights: {
      "repeat-group": 1.2,
      "repeat-slice": 1.2,
      "repeat-half-beat": 1,
      "swap-groups": 1.2,
      "jump-back": 1.4,
      "jump-forward": 1.4,
      "hold-downbeat": 0.9,
      "call-response": 1,
      alternate: 0.9,
      "reverse-slice": 1.3,
      "reverse-group": 1.2,
      "move-fragment": 1.4,
      "stutter-tail": 1.3,
      "stutter-slice": 1.5,
      "silence-slice": 1,
    },
    // Chaos is the one personality allowed to reach for the destructive end immediately - that's
    // what distinguishes it from MIXED, which shares most of the same weights.
    unlocks: {
      "stutter-slice": 0.05,
      "stutter-tail": 0.05,
      "reverse-group": 0,
      "silence-slice": 0.05,
      "move-fragment": 0,
      "jump-forward": 0,
      alternate: 0,
      "call-response": 0,
    },
  },
];

export const DEFAULT_STYLE = "mixed";

const BY_KEY = new Map(STYLES.map((s) => [s.key, s]));

export function resolveStyle(key) {
  return BY_KEY.get(key) || BY_KEY.get(DEFAULT_STYLE);
}

export function styleKeys() {
  return STYLES.map((s) => s.key);
}

/** "Conservative" ... "Destructive" - the words under the intensity slider. */
export function describeIntensity(intensity) {
  const t = Math.max(0, Math.min(100, Number(intensity) || 0));
  if (t < 15) return "barely touched";
  if (t < 35) return "conservative";
  if (t < 55) return "recognisable";
  if (t < 75) return "loose";
  if (t < 90) return "wrecked";
  return "destructive";
}
