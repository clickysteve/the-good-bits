// recipe.js
//
// FLIP stage 2: SLICE MAP -> TRANSFORMATION RECIPE.
//
// A recipe is a list of INSTRUCTIONS, not audio. One step per output slot, in output order, each
// saying which source slice to take and what to do to it. Nothing here touches a sample; rendering
// is a separate stage (js/flip/render.js) that can be run, re-run, thrown away and run again from
// the same recipe, and a recipe is small enough to log, diff, describe in the UI and reproduce from
// a seed.
//
// That indirection is the whole reason FLIP can promise identical duration: the step list is always
// exactly as long as the slice map, every step occupies exactly one slot's worth of time, and
// there is no operation anywhere in this module that can add or remove a step. Repeats and stutters
// REPLACE time, they never append it.
//
// MUSICALITY LIVES HERE, not in the operations. The operations (js/flip/operations.js) are dumb and
// reusable - "repeat this group", "jump back from here". What makes a result sound intentional is
// WHERE and HOW OFTEN they're applied, which is this file's job:
//
//   - work in musical chunks (a beat at a time), never per-sample or per-arbitrary-index
//   - weight against mutating strong metric positions, hard at low intensity, barely at high
//   - at conservative settings, protect a contiguous opening section outright, so the result reads
//     as "the original, then something happens" rather than as an even wash of small edits
//   - cap the number of edits, so low intensity means FEW changes as well as SMALL ones
//   - guarantee at least one edit, because a variation identical to the source is not a variation
//
// SEEDING: one generator, made once, consumed by everything downstream (see js/dsp/stretch/rng.js,
// shared with the stretch engines rather than duplicated). Same source + same settings + same seed
// is the same recipe, every time, on any machine.
import { makeRng, hashSeed } from "../dsp/stretch/rng.js";
import { OPERATIONS, operationByKey } from "./operations.js";
import { resolveStyle } from "./styles.js";
import { identitySteps, isUntouched } from "./step.js";

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

/**
 * Generate one variation's recipe.
 *
 * @param {object} opts
 * @param {object} opts.map        a slice map (js/flip/slice-map.js)
 * @param {string} opts.style      a style key (js/flip/styles.js)
 * @param {number} opts.intensity  0..100, conservative -> destructive
 * @param {number|string} opts.seed
 * @returns {{seed:number, style:string, intensity:number, sliceCount:number, subdivision:string, steps:object[], edits:object[]}}
 */
export function generateRecipe({ map, style, intensity, seed }) {
  const st = resolveStyle(style);
  const t = clamp01((Number(intensity) || 0) / 100);
  const rng = makeRng(hashSeed(seed));
  const steps = identitySteps(map.count);
  const edits = [];

  // Severity is what every operation reads to decide "how far": jump distance, group size, stutter
  // subdivision, how many repeats. Styles scale it so Chaos at 50 is already rougher than Shuffle
  // at 50, without the intensity slider having to mean different things per style.
  const severity = clamp01(t * st.severityScale);

  // How often a chunk gets touched at all. The floor matters: at intensity 0 this is still non-zero,
  // because "generate me a variation" that returns the original is a bug, not conservatism.
  const baseRate = clamp01((0.18 + 0.62 * t) * st.rateScale);

  // PROTECTED OPENING. The example in the brief - 1 2 3 4 5 6 5 6 - is not "a few small random
  // edits", it's "the first half is the original, then it breaks". Getting that shape reliably at
  // low intensity needs an explicit contiguous hold, not luck: a probabilistic per-chunk rate low
  // enough to usually leave the opening alone is also too low to do anything interesting later.
  let protectUntil = 0;
  if (map.count >= map.perBar * 2 && rng.next() < 0.78 - 0.68 * t) {
    // A whole number of bars where possible, so the hold ends where the ear expects a change.
    const holdBars = Math.max(1, Math.floor(map.bars / 2));
    protectUntil = Math.min(map.count - map.perBeat, holdBars * map.perBar);
  }

  // Chunk = one beat, or one slice when the subdivision IS the beat. Anchoring every operation to a
  // beat boundary is most of what stops results sounding like an accident rather than an edit.
  const chunk = Math.max(1, map.perBeat);
  const chunkCount = Math.ceil(map.count / chunk);

  // Which chunks this variation is even allowed to touch, after the protected opening.
  const eligible = [];
  for (let c = 0; c < chunkCount; c++) {
    const at = c * chunk;
    if (at >= protectUntil && at < map.count) eligible.push(at);
  }
  if (!eligible.length) eligible.push(Math.max(0, map.count - chunk));

  // A CEILING AND A FLOOR. The ceiling is what makes low intensity mean FEW changes rather than
  // just small ones. The floor is what makes the slider honest: a probabilistic walk over eight
  // beats at a 45% rate lands on one edit often enough that half a batch comes back as "the
  // original with a hiccup in it", which is a waste of eight slots and reads as the tool not
  // working. The top-up pass below spends whatever the walk didn't.
  const maxEdits = Math.max(1, Math.round(eligible.length * baseRate * 1.6));
  const minEdits = Math.max(1, Math.min(maxEdits, Math.round(eligible.length * baseRate * 0.7)));

  /**
   * "Is this personality allowed to do X, at this intensity, on this material?"
   *
   * The single answer, used both to build the pick list and - via ctx.allows - by the composite
   * operations that borrow a technique from another one. Without that second use the gates leak:
   * call-and-response would silence its response under REPEAT (silence is SPARSE's whole identity)
   * and keep the downbeat would stutter under MIXED at intensity 15 (micro-editing is meant to
   * unlock much later). An operation may only reach for a technique the style itself would reach for.
   */
  function allows(key) {
    const op = operationByKey(key);
    if (!op) return false;
    const weight = st.weights[key] || 0;
    if (weight <= 0) return false;
    // Gated operations (micro-editing, silence, wholesale displacement) only unlock as intensity
    // rises - unless this style is ABOUT that operation, in which case it's the point of picking it.
    const gate = st.unlocks && st.unlocks[key] != null ? st.unlocks[key] : op.minT || 0;
    if (t < gate) return false;
    return op.fits(map);
  }

  const available = OPERATIONS.filter((op) => allows(op.key));

  if (!available.length) {
    return { seed: hashSeed(seed), style: st.key, intensity: Math.round(t * 100), sliceCount: map.count, subdivision: map.subdivision, steps, edits };
  }

  const totalWeight = available.reduce((sum, op) => sum + (st.weights[op.key] || 0), 0);

  function pickOperation() {
    let r = rng.next() * totalWeight;
    for (const op of available) {
      r -= st.weights[op.key] || 0;
      if (r <= 0) return op;
    }
    return available[available.length - 1];
  }

  const ctx = { rng, map, steps, t, severity, style: st, allows };

  function attempt(at) {
    const op = pickOperation();
    const result = op.apply({ ...ctx, at });
    if (!result) return false;
    edits.push({ op: op.key, label: op.label, at, ...result });
    return true;
  }

  for (const at of eligible) {
    if (edits.length >= maxEdits) break;
    // Metric protection: the stronger the position, the less likely it is to be disturbed - and the
    // higher the intensity, the less that matters. At t = 1 this term disappears entirely.
    const strength = map.slices[at] ? map.slices[at].strength : 0.5;
    const protection = (0.72 - 0.72 * t) * strength;
    if (rng.next() >= baseRate * (1 - protection)) continue;
    attempt(at);
  }

  // Top-up. Not every operation fits every anchor (a bar-long swap near the end has nowhere to go),
  // so a refusal costs an edit the intensity had already budgeted for; this spends what's left,
  // still only inside the eligible region and still one operation per attempt. The try budget stops
  // a short phrase where nothing fits from spinning.
  for (let guard = 0; edits.length < minEdits && guard < 40; guard++) {
    attempt(eligible[rng.int(eligible.length)]);
  }

  return {
    seed: hashSeed(seed),
    style: st.key,
    intensity: Math.round(t * 100),
    sliceCount: map.count,
    subdivision: map.subdivision,
    steps,
    edits,
  };
}

/** True when the recipe leaves the source completely untouched (nothing to hear, nothing to export). */
export function isIdentityRecipe(recipe) {
  if (!recipe || !recipe.steps) return true;
  return recipe.steps.every((s, i) => isUntouched(s, i));
}

/** How much of the original survives in place, 0..1 - the headline "how far from the source is this?". */
export function recipeDeparture(recipe) {
  if (!recipe || !recipe.steps || !recipe.steps.length) return 0;
  let intact = 0;
  for (let i = 0; i < recipe.steps.length; i++) {
    if (isUntouched(recipe.steps[i], i)) intact++;
  }
  return 1 - intact / recipe.steps.length;
}

/**
 * "repeat group ×2 · jump back · stutter" - what actually happened, in the order it happened,
 * de-duplicated into counts. Short enough to sit on a variation row.
 */
export function describeRecipe(recipe) {
  if (!recipe || !recipe.edits || !recipe.edits.length) return "untouched";
  const counts = new Map();
  for (const edit of recipe.edits) {
    const label = edit.label || edit.op;
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  return [...counts.entries()].map(([label, n]) => (n > 1 ? `${label} ×${n}` : label)).join(" · ");
}

/**
 * The step list as a readable sequence - "1 2 3 4 5 6 5 6" for the brief's own example. Used for
 * the row's tooltip and for tests; long recipes are elided in the middle rather than truncated, so
 * the end (where most of the interesting material ends up) is still visible.
 */
export function recipePattern(recipe, maxSlices = 64) {
  if (!recipe || !recipe.steps) return "";
  const token = (s) => {
    if (s.silent) return "–";
    let out = String(s.src + 1);
    if (s.reverse) out = `<${out}`;
    if (s.stutter) out += `×${s.stutter}`;
    return out;
  };
  const steps = recipe.steps;
  if (steps.length <= maxSlices) return steps.map(token).join(" ");
  const head = steps.slice(0, maxSlices / 2).map(token).join(" ");
  const tail = steps.slice(steps.length - maxSlices / 2).map(token).join(" ");
  return `${head} … ${tail}`;
}

/** Everything that decides what a recipe renders to. Used to spot a stale variation after a settings change. */
export function recipeSignature(recipe, map) {
  if (!recipe) return "";
  return JSON.stringify([recipe.seed, recipe.style, recipe.intensity, map ? map.subdivision : recipe.subdivision, map ? map.count : recipe.sliceCount, map ? Math.round((map.bpm || 0) * 100) : 0]);
}

export { operationByKey };
export { makeStep, cloneStep, identitySteps } from "./step.js";
