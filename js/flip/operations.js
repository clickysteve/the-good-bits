// operations.js
//
// The FLIP transformation vocabulary: small, reusable, single-purpose edits to a recipe's step list
// (js/flip/recipe.js). Deliberately NOT one big randomise function - adding a new remix behaviour
// later should mean writing one more entry here and giving it a weight in one or more styles, not
// touching the generator, the renderer or the UI.
//
// Every operation obeys three rules, and the renderer relies on all three:
//
//   1. It never changes steps.length. Phrase length is preserved by construction, not by checking.
//   2. It only ever writes inside the bounds it was given, and no-ops (returns falsy) when the
//      material is too short for it. A style that weights an impossible operation heavily just
//      spends fewer edits, rather than producing a half-applied one.
//   3. It decides WHAT to do; the generator decides WHERE and HOW OFTEN. Nothing in here reads the
//      intensity slider directly - only `severity`, which is intensity already scaled by the style.
//
// A COMPOSITE OPERATION MAY ONLY BORROW WHAT ITS STYLE WOULD REACH FOR ANYWAY. Two operations here
// (call-and-response, keep-the-downbeat) vary their result by applying a second technique - a
// reverse, a stutter, a rest. Left ungated that quietly defeats the whole style system: REPEAT
// would produce silences even though dropping things out is SPARSE's entire identity, and MIXED
// would micro-edit at intensity 15 when the slider says it shouldn't until 30. They ask ctx.allows()
// first, which is the same availability test the generator uses to build its own pick list.
//
// Each operation returns a small descriptor ({len, ...}) when it did something, so the generator can
// record what happened and the UI can say so.
import { makeStep, cloneStep } from "./step.js";

/** Copy a run of steps out of the list, detached, so an overlapping write can't read its own output. */
function snapshot(steps, start, len) {
  const out = [];
  for (let i = 0; i < len; i++) out.push(cloneStep(steps[start + i]));
  return out;
}

function writeRun(steps, dest, run, op) {
  for (let i = 0; i < run.length; i++) {
    if (dest + i >= steps.length) break;
    steps[dest + i] = { ...run[i], op };
  }
}

function weightedPick(rng, candidates) {
  const total = candidates.reduce((sum, c) => sum + c.w, 0);
  if (total <= 0) return candidates[0];
  let r = rng.next() * total;
  for (const c of candidates) {
    r -= c.w;
    if (r <= 0) return c;
  }
  return candidates[candidates.length - 1];
}

/**
 * A musical group length in slices - a beat, two beats, a bar, or (when `allowSub`) half a beat.
 * Everything that moves more than one slice picks its size here, which is what keeps FLIP swapping
 * musical chunks rather than arbitrary runs of samples. Bigger groups get likelier as severity rises.
 */
function groupLen(ctx, { allowSub = false } = {}) {
  const { map, rng, severity } = ctx;
  const beat = Math.max(1, map.perBeat);
  const bar = Math.max(beat, map.perBar);
  const candidates = [];
  if (allowSub && beat >= 2) candidates.push({ len: beat >> 1, w: 0.25 + 0.55 * severity });
  candidates.push({ len: beat, w: 1 });
  candidates.push({ len: beat * 2, w: 0.5 + 0.25 * severity });
  candidates.push({ len: bar, w: 0.12 + 0.5 * severity });
  const usable = candidates.filter((c) => c.len >= 1 && c.len * 2 <= map.count);
  if (!usable.length) return 1;
  return weightedPick(rng, usable).len;
}

/** A jump distance: always a whole number of beats, near before far. */
function jumpDistance(ctx, maxDistance) {
  const { map, rng, severity } = ctx;
  const beat = Math.max(1, map.perBeat);
  const candidates = [
    { len: beat, w: 1 },
    { len: beat * 2, w: 0.75 },
    { len: map.perBar, w: 0.4 + 0.4 * severity },
    { len: map.perBar * 2, w: 0.1 + 0.6 * severity },
  ];
  const usable = candidates.filter((c) => c.len >= 1 && c.len <= maxDistance);
  if (!usable.length) return 0;
  return weightedPick(rng, usable).len;
}

/**
 * How many fragments a stutter breaks its slot into. This is FLIP's micro-editing: 4 on a
 * sixteenth-note grid is a 64th-note roll. The coarse counts are always available; the fine ones
 * unlock with severity, so a conservative setting stutters audibly but never turns into a buzz.
 */
function stutterCount(ctx) {
  const { rng, severity } = ctx;
  const candidates = [
    { len: 2, w: 1 },
    { len: 3, w: 0.45 },
    { len: 4, w: 0.55 + 0.5 * severity },
  ];
  if (severity > 0.45) candidates.push({ len: 6, w: 0.3 * severity });
  if (severity > 0.6) candidates.push({ len: 8, w: 0.45 * severity });
  return weightedPick(rng, candidates).len;
}

/** "Would this style do X at this intensity?" - see ctx.allows() in js/flip/recipe.js. Permissive
 *  when absent, so an operation can still be exercised standalone (a unit test, a future caller). */
function permits(ctx, key) {
  return typeof ctx.allows === "function" ? ctx.allows(key) : true;
}

/** The weakest metric position inside [from, from+len) - where a silence or a stutter hurts least. */
function weakestIn(map, from, len) {
  let best = from;
  let bestStrength = Infinity;
  for (let i = from; i < Math.min(map.count, from + len); i++) {
    const s = map.slices[i] ? map.slices[i].strength : 0.5;
    if (s < bestStrength) {
      bestStrength = s;
      best = i;
    }
  }
  return best;
}

/** A beat-aligned position elsewhere in the phrase, at least one beat away from `avoid`. */
function otherBeatStart(ctx, avoid, len) {
  const { map, rng } = ctx;
  const beat = Math.max(1, map.perBeat);
  const beats = Math.floor((map.count - len) / beat) + 1;
  if (beats <= 1) return -1;
  for (let tries = 0; tries < 12; tries++) {
    const pos = rng.int(beats) * beat;
    if (Math.abs(pos - avoid) >= beat && pos + len <= map.count) return pos;
  }
  return -1;
}

export const OPERATIONS = [
  {
    key: "repeat-slice",
    label: "repeat slice",
    minT: 0,
    fits: (map) => map.count >= 2,
    apply(ctx) {
      const { steps, at, rng, severity, map } = ctx;
      // One repeat is a hiccup; three is a roll. Longer runs need the intensity to justify them.
      let reps = 1;
      if (severity > 0.4 && rng.bool(0.45)) reps = 2;
      if (severity > 0.7 && rng.bool(0.3)) reps = 3;
      if (at + reps >= map.count) reps = map.count - at - 1;
      if (reps < 1) return null;
      const source = cloneStep(steps[at]);
      for (let i = 1; i <= reps; i++) steps[at + i] = { ...source, op: "repeat-slice" };
      return { len: reps + 1, reps };
    },
  },

  {
    key: "repeat-group",
    label: "repeat group",
    minT: 0,
    fits: (map) => map.count >= Math.max(2, map.perBeat * 2),
    apply(ctx) {
      const { steps, at, map } = ctx;
      const len = groupLen(ctx);
      if (at + len * 2 > map.count) return null;
      writeRun(steps, at + len, snapshot(steps, at, len), "repeat-group");
      return { len: len * 2, group: len };
    },
  },

  {
    key: "swap-groups",
    label: "swap groups",
    minT: 0,
    fits: (map) => map.count >= Math.max(2, map.perBeat * 2),
    apply(ctx) {
      const { steps, at, map } = ctx;
      const len = groupLen(ctx);
      if (at + len * 2 > map.count) return null;
      const a = snapshot(steps, at, len);
      const b = snapshot(steps, at + len, len);
      writeRun(steps, at, b, "swap-groups");
      writeRun(steps, at + len, a, "swap-groups");
      return { len: len * 2, group: len };
    },
  },

  {
    key: "jump-back",
    label: "jump back",
    minT: 0,
    fits: (map) => map.count >= Math.max(2, map.perBeat * 2),
    apply(ctx) {
      const { steps, at, map } = ctx;
      const len = groupLen(ctx);
      if (at + len > map.count) return null;
      const distance = jumpDistance(ctx, at);
      if (distance < 1) return null;
      writeRun(steps, at, snapshot(steps, at - distance, len), "jump-back");
      return { len, distance };
    },
  },

  {
    key: "jump-forward",
    label: "jump forward",
    minT: 0.12,
    fits: (map) => map.count >= Math.max(2, map.perBeat * 2),
    apply(ctx) {
      const { steps, at, map } = ctx;
      const len = groupLen(ctx);
      if (at + len > map.count) return null;
      const room = map.count - len - at;
      const distance = jumpDistance(ctx, room);
      if (distance < 1) return null;
      writeRun(steps, at, snapshot(steps, at + distance, len), "jump-forward");
      return { len, distance };
    },
  },

  {
    key: "reverse-slice",
    label: "reverse slice",
    minT: 0,
    fits: () => true,
    apply(ctx) {
      const { steps, at, map, rng } = ctx;
      // Reversing the slice that lands ON a downbeat swallows the transient the whole bar hangs
      // off, so bias towards the weaker positions in this beat unless nothing else is available.
      const target = rng.bool(0.7) ? weakestIn(map, at, Math.max(1, map.perBeat)) : at;
      steps[target].reverse = !steps[target].reverse;
      steps[target].op = "reverse-slice";
      return { len: 1, target };
    },
  },

  {
    key: "reverse-group",
    label: "reverse group",
    minT: 0.2,
    fits: (map) => map.count >= Math.max(2, map.perBeat),
    apply(ctx) {
      const { steps, at, map } = ctx;
      const len = groupLen(ctx, { allowSub: true });
      if (at + len > map.count) return null;
      // A real group reverse is both: the audio inside each slice runs backwards AND the slices
      // play in the opposite order. Doing only the second is just a shuffle; only the first is a
      // stutter of backwards fragments. Together they sound like the tape ran the other way.
      const run = snapshot(steps, at, len).reverse();
      for (const step of run) step.reverse = !step.reverse;
      writeRun(steps, at, run, "reverse-group");
      return { len, group: len };
    },
  },

  {
    key: "silence-slice",
    label: "drop to silence",
    minT: 0.15,
    fits: (map) => map.count >= 4,
    apply(ctx) {
      const { steps, at, map, rng, severity } = ctx;
      const beat = Math.max(1, map.perBeat);
      const start = weakestIn(map, at, beat);
      // A gap longer than a beat stops reading as a drop-out and starts reading as a missing bar.
      let len = 1;
      if (severity > 0.5 && beat >= 2 && rng.bool(0.4)) len = Math.min(beat, 2);
      if (severity > 0.75 && rng.bool(0.25)) len = Math.min(beat, len + 1);
      let applied = 0;
      for (let i = start; i < Math.min(map.count, start + len); i++) {
        steps[i].silent = true;
        steps[i].stutter = 0;
        steps[i].op = "silence-slice";
        applied++;
      }
      return applied ? { len: applied } : null;
    },
  },

  {
    key: "stutter-slice",
    label: "stutter",
    minT: 0.3,
    fits: (map) => map.count >= 2,
    apply(ctx) {
      const { steps, at, map, rng, severity } = ctx;
      const beat = Math.max(1, map.perBeat);
      // Landing the stutter on the LAST slice of the beat makes it a run-up into the next downbeat,
      // which is where a stutter sounds deliberate. Anywhere in the beat, once it's rough enough.
      const target = severity > 0.55 && rng.bool(0.5) ? at + rng.int(beat) : Math.min(map.count - 1, at + beat - 1);
      const step = steps[Math.min(map.count - 1, target)];
      if (step.silent) return null;
      step.stutter = stutterCount(ctx);
      step.keepHead = 0;
      step.fragFrom = 0;
      step.op = "stutter-slice";
      return { len: 1, count: step.stutter };
    },
  },

  {
    key: "stutter-tail",
    label: "stutter the tail",
    minT: 0.3,
    fits: (map) => map.count >= 2,
    apply(ctx) {
      const { steps, at, map, rng } = ctx;
      const beat = Math.max(1, map.perBeat);
      const target = Math.min(map.count - 1, rng.bool(0.65) ? at + beat - 1 : at);
      const step = steps[target];
      if (step.silent) return null;
      // The slice starts normally and only breaks up halfway through, so the attack is intact and
      // the edit reads as an ornament on the end of the note rather than a replacement for it.
      step.stutter = stutterCount(ctx);
      step.keepHead = 0.5;
      step.fragFrom = 0.5;
      step.op = "stutter-tail";
      return { len: 1, count: step.stutter };
    },
  },

  {
    key: "alternate",
    label: "alternate A/B",
    minT: 0.15,
    fits: (map) => map.count >= Math.max(4, map.perBeat * 2),
    apply(ctx) {
      const { steps, at, map } = ctx;
      const len = groupLen(ctx, { allowSub: true });
      if (at + len * 4 > map.count) return null;
      const a = snapshot(steps, at, len);
      const b = snapshot(steps, at + len, len);
      writeRun(steps, at + len * 2, a, "alternate");
      writeRun(steps, at + len * 3, b, "alternate");
      return { len: len * 4, group: len };
    },
  },

  {
    key: "move-fragment",
    label: "move a fragment",
    minT: 0.2,
    fits: (map) => map.count >= Math.max(4, map.perBeat * 2),
    apply(ctx) {
      const { steps, at, map } = ctx;
      const len = groupLen(ctx);
      if (at + len > map.count) return null;
      const from = otherBeatStart(ctx, at, len);
      if (from < 0) return null;
      // Straight from the slice map, not from the current step list: a moved fragment should be the
      // original material arriving somewhere new, not a copy of whatever has already happened there.
      const run = [];
      for (let i = 0; i < len; i++) run.push(makeStep(from + i, "move-fragment"));
      writeRun(steps, at, run, "move-fragment");
      return { len, from };
    },
  },

  {
    key: "repeat-half-beat",
    label: "repeat half a beat",
    minT: 0,
    fits: (map) => map.perBeat >= 2 && map.count >= map.perBeat,
    apply(ctx) {
      const { steps, at, map, rng } = ctx;
      const beat = map.perBeat;
      const half = beat >> 1;
      if (at + beat > map.count) return null;
      if (rng.bool(0.5)) {
        // First half twice - the beat stammers and then resolves on the next downbeat.
        writeRun(steps, at + half, snapshot(steps, at, half), "repeat-half-beat");
      } else {
        // Second half twice - the beat's attack is replaced by its own tail, a classic lurch.
        writeRun(steps, at, snapshot(steps, at + half, half), "repeat-half-beat");
      }
      return { len: beat, half };
    },
  },

  {
    key: "hold-downbeat",
    label: "keep the downbeat, change the rest",
    minT: 0,
    fits: (map) => map.perBeat >= 2 && map.count >= map.perBeat * 2,
    apply(ctx) {
      const { steps, at, map, rng, severity } = ctx;
      const beat = map.perBeat;
      if (at + beat > map.count) return null;
      const rest = beat - 1;
      const canReverse = permits(ctx, "reverse-group") || permits(ctx, "reverse-slice");
      // Re-roll the choice into the permitted range rather than skipping - a style that can't
      // reverse should still get the other two variants at their usual relative frequency.
      const choice = canReverse ? rng.next() : rng.next() * 0.8;
      if (choice < 0.45) {
        // The rest of the beat becomes repeats of the slice right after the downbeat.
        const source = cloneStep(steps[at + 1]);
        for (let i = 1; i < beat; i++) steps[at + i] = { ...source, op: "hold-downbeat" };
      } else if (choice < 0.8) {
        // The rest of the beat comes from another beat entirely - the downbeat still anchors it.
        const from = otherBeatStart(ctx, at, beat);
        if (from < 0) return null;
        for (let i = 1; i < beat; i++) steps[at + i] = makeStep(from + i, "hold-downbeat");
      } else {
        // The rest of the beat runs backwards behind an intact attack.
        const run = snapshot(steps, at + 1, rest).reverse();
        for (const step of run) step.reverse = !step.reverse;
        writeRun(steps, at + 1, run, "hold-downbeat");
      }
      if (severity > 0.7 && (permits(ctx, "stutter-slice") || permits(ctx, "stutter-tail")) && rng.bool(0.3)) {
        steps[at + beat - 1].stutter = stutterCount(ctx);
        steps[at + beat - 1].keepHead = 0;
      }
      return { len: beat };
    },
  },

  {
    key: "call-response",
    label: "call and response",
    minT: 0.1,
    fits: (map) => map.count >= Math.max(4, map.perBeat * 2),
    apply(ctx) {
      const { steps, at, map, rng } = ctx;
      const len = groupLen(ctx);
      if (at + len * 2 > map.count) return null;
      // Say it, then say it differently. A/A' is the single most reliable way to make a rearrangement
      // sound composed rather than shuffled, which is why it gets its own operation.
      //
      // How the response differs depends on what this personality is allowed to do. The turnaround
      // - the response ending on the call's own first slice instead of its last - is pure
      // reordering, so it's always available and keeps this operation useful under REPEAT and
      // SHUFFLE rather than collapsing it into a plain repeat.
      const response = snapshot(steps, at, len);
      const variants = ["turnaround"];
      if (permits(ctx, "reverse-group") || permits(ctx, "reverse-slice")) variants.push("reverse");
      if (permits(ctx, "stutter-slice") || permits(ctx, "stutter-tail")) variants.push("stutter");
      if (permits(ctx, "silence-slice")) variants.push("rest");
      const variant = variants[rng.int(variants.length)];
      const last = response[response.length - 1];

      if (variant === "reverse") {
        response.reverse();
        for (const step of response) step.reverse = !step.reverse;
      } else if (variant === "stutter" && !last.silent) {
        last.stutter = stutterCount(ctx);
        last.keepHead = rng.bool(0.5) ? 0.5 : 0;
        last.fragFrom = last.keepHead;
      } else if (variant === "rest") {
        last.silent = true;
        last.stutter = 0;
      } else {
        response[response.length - 1] = cloneStep(response[0]);
      }
      writeRun(steps, at + len, response, "call-response");
      return { len: len * 2, group: len, variant };
    },
  },
];

const BY_KEY = new Map(OPERATIONS.map((op) => [op.key, op]));

export function operationByKey(key) {
  return BY_KEY.get(key) || null;
}

export function operationKeys() {
  return OPERATIONS.map((op) => op.key);
}
