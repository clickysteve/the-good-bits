// time-feel.js
//
// Half-time, double-time, and the rest - conforming a loop to a MULTIPLE of the target
// tempo rather than to the target itself.
//
// The musical idea: take a 174 BPM break into a 87 BPM track and it either has to be
// crushed to fit, or you play it half-time - twice as long per bar, big and stretchy, and
// still locked to the grid because every bar of the break is exactly two bars of the track.
// That second option is a creative staple and conforming "correctly" is precisely what
// prevents it.
//
// HOW IT WORKS: the multiplier scales the tempo the loop is conformed TO, not the loop.
// Half-time against a 120 BPM target means conforming to 60 BPM, so the audio comes out
// twice as long and half as fast - and its beats still land on the 120 grid, on every other
// beat. Nothing downstream needs to know: the conform pipeline just receives a different
// target tempo, the bar-snapping still snaps, and the mixer already tiles loops of
// different lengths against each other.
//
// So a half-time loop in a mix of normal ones plays once per two cycles of theirs, in time
// throughout. That is the whole point.

/**
 * `length` is what the conformed audio's duration is multiplied by, which is also what the
 * target tempo is DIVIDED by. 2 = half-time (twice as long, half as fast).
 */
export const TIME_FEELS = [
  { key: "quarter", label: "¼ time", short: "¼×", length: 4, description: "Four times as long. Extreme, smeared, barely a loop any more - which is sometimes the point." },
  { key: "half", label: "½ time", short: "½×", length: 2, description: "Twice as long and half as fast. The classic stretched-break sound, still on the grid." },
  { key: "normal", label: "Normal", short: "1×", length: 1, description: "Conformed straight to the target tempo." },
  { key: "double", label: "2× time", short: "2×", length: 0.5, description: "Half as long and twice as fast. Busy, urgent, good for turning a loop into a fill." },
  { key: "quadruple", label: "4× time", short: "4×", length: 0.25, description: "Four times as fast. Effectively a stutter." },
];

export const DEFAULT_TIME_FEEL = "normal";

const BY_KEY = Object.fromEntries(TIME_FEELS.map((f) => [f.key, f]));

/** Look up a feel, falling back to normal for anything unrecognised (an old saved value, a typo). */
export function resolveTimeFeel(key) {
  return BY_KEY[key] || BY_KEY[DEFAULT_TIME_FEEL];
}

/**
 * The tempo a loop with this feel should actually be conformed to.
 *
 * Everything else in the pipeline consumes THIS rather than the raw target, which is what
 * keeps the feature to one concept in one place: half-time is not a special rendering mode,
 * it is a different target tempo.
 */
export function effectiveTargetBpm(targetBpm, feelKey) {
  if (!(targetBpm > 0)) return targetBpm;
  return targetBpm / resolveTimeFeel(feelKey).length;
}

/** "½ time · 60 BPM" - what the loop is actually being conformed to, when that isn't the target. */
export function formatTimeFeel(feelKey, targetBpm) {
  const feel = resolveTimeFeel(feelKey);
  if (feel.length === 1) return null;
  const bpm = effectiveTargetBpm(targetBpm, feelKey);
  return bpm > 0 ? `${feel.label} · ${Math.round(bpm)} BPM` : feel.label;
}
