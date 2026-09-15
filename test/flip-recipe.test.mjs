// Node-side unit tests for FLIP's decision layer - js/flip/slice-map.js, js/flip/recipe.js,
// js/flip/operations.js and js/flip/styles.js. These are the parts that decide WHERE the cuts are
// and WHAT happens to them; nothing here touches audio (see flip-render.test.mjs for that).
//
// The properties worth guarding are the ones a listener would notice immediately if they broke:
// the grid tiles the source exactly, a recipe never changes the phrase length, the same seed always
// reproduces the same arrangement, intensity actually means something monotonic, and conservative
// settings really do leave the downbeats alone.
// Run with: node test/flip-recipe.test.mjs
import assert from "node:assert/strict";
import { createSliceMap, sliceMapReadiness, describeSliceMap, metricStrength, SUBDIVISIONS, MIN_SLICES } from "../js/flip/slice-map.js";
import { generateRecipe, describeRecipe, recipePattern, recipeDeparture, isIdentityRecipe, identitySteps } from "../js/flip/recipe.js";
import { OPERATIONS, operationByKey, operationKeys } from "../js/flip/operations.js";
import { STYLES, resolveStyle, styleKeys, describeIntensity, DEFAULT_STYLE } from "../js/flip/styles.js";

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (err) {
    console.error(`FAIL - ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

const SR = 44100;
/** A clean four-bar loop at 120 BPM - the shape FLIP is designed around. */
const loopMap = (subdivision = "1/16", bpm = 120, bars = 4) =>
  createSliceMap({ totalSamples: Math.round(((bars * 4 * 60) / bpm) * SR), sampleRate: SR, bpm, subdivision });

// --- slice map -------------------------------------------------------------------------------

test("createSliceMap: boundaries tile the whole source with no gaps, no overlap, no leftover", () => {
  for (const sub of SUBDIVISIONS) {
    // A deliberately awkward length, so this can't pass by the numbers happening to divide.
    const total = 191237;
    const map = createSliceMap({ totalSamples: total, sampleRate: SR, bpm: 93.7, subdivision: sub.key });
    assert.equal(map.slices[0].startSample, 0, `${sub.key}: starts at 0`);
    assert.equal(map.slices[map.count - 1].endSample, total, `${sub.key}: ends at the last sample`);
    let covered = 0;
    for (let i = 0; i < map.count; i++) {
      if (i > 0) assert.equal(map.slices[i].startSample, map.slices[i - 1].endSample, `${sub.key}: slice ${i} starts where ${i - 1} ended`);
      assert.ok(map.slices[i].length > 0, `${sub.key}: slice ${i} is non-empty`);
      covered += map.slices[i].length;
    }
    assert.equal(covered, total, `${sub.key}: slices sum to the source length exactly`);
  }
});

test("createSliceMap: a finer subdivision gives proportionally more slices over the same audio", () => {
  const counts = SUBDIVISIONS.map((s) => loopMap(s.key).count);
  assert.deepEqual(counts, [16, 32, 64, 128]);
});

test("createSliceMap: prefers a whole number of bars when the detected tempo is slightly off", () => {
  // 119.87 BPM over a true four-bar 120 BPM loop asks for 256.3 sixteenths.
  const total = Math.round(8 * SR);
  const map = createSliceMap({ totalSamples: total, sampleRate: SR, bpm: 119.87, subdivision: "1/16" });
  assert.equal(map.count, 64);
  assert.equal(map.fit.aligned, "bar");
  assert.equal(Math.round(map.bars), 4);
});

test("createSliceMap: reports 'slice' alignment when no musical count is within reach", () => {
  // 5.644s read as 132.51 BPM is 3.13 bars - a real detection failure, not a rounding one.
  const map = createSliceMap({ totalSamples: Math.round(5.644 * SR), sampleRate: SR, bpm: 132.51, subdivision: "1/16" });
  assert.equal(map.fit.aligned, "slice");
  const readiness = sliceMapReadiness(map);
  assert.equal(readiness.ok, true, "a misaligned grid is still usable, just worth warning about");
  assert.match(readiness.warning, /not a whole number/);
});

test("createSliceMap: correcting that tempo by hand snaps the grid back onto the bar", () => {
  const map = createSliceMap({ totalSamples: Math.round(5.644 * SR), sampleRate: SR, bpm: 85, subdivision: "1/16" });
  assert.equal(map.count, 32);
  assert.equal(map.fit.aligned, "bar");
  assert.equal(sliceMapReadiness(map).warning, null);
});

test("createSliceMap: no tempo falls back to an even division and says so", () => {
  const map = createSliceMap({ totalSamples: Math.round(8 * SR), sampleRate: SR, bpm: null, subdivision: "1/16" });
  assert.equal(map.fit.source, "even");
  assert.equal(map.count, 64);
  assert.match(sliceMapReadiness(map).warning, /No confident tempo/);
});

test("sliceMapReadiness: refuses audio too short to rearrange, and only suggests a finer grid when one would help", () => {
  const tiny = createSliceMap({ totalSamples: Math.round(0.15 * SR), sampleRate: SR, bpm: 120, subdivision: "1/16" });
  const tinyResult = sliceMapReadiness(tiny);
  assert.equal(tinyResult.ok, false);
  assert.ok(tiny.count < MIN_SLICES);
  assert.doesNotMatch(tinyResult.reason, /Try 1\//, "nothing finer rescues a 0.15s file");

  const shortish = createSliceMap({ totalSamples: Math.round(0.6 * SR), sampleRate: SR, bpm: 120, subdivision: "1/4" });
  const shortResult = sliceMapReadiness(shortish);
  assert.equal(shortResult.ok, false);
  assert.match(shortResult.reason, /Try 1\/16/, "a finer grid does rescue this one, so say so");
});

test("sliceMapReadiness: handles no audio at all without throwing", () => {
  const map = createSliceMap({ totalSamples: 0, sampleRate: SR, bpm: 120, subdivision: "1/16" });
  assert.equal(sliceMapReadiness(map).ok, false);
});

test("metricStrength: downbeat beats beat 3 beats other beats beats off-beats", () => {
  const perBeat = 4;
  const downbeat = metricStrength(0, perBeat, 4);
  const beatThree = metricStrength(8, perBeat, 4);
  const beatTwo = metricStrength(4, perBeat, 4);
  const offBeat = metricStrength(1, perBeat, 4);
  assert.ok(downbeat > beatThree, "downbeat over beat 3");
  assert.ok(beatThree > beatTwo, "beat 3 over beat 2");
  assert.ok(beatTwo > offBeat, "any beat over an off-beat");
});

test("describeSliceMap: one readable line, with whole bars shown as whole numbers", () => {
  assert.equal(describeSliceMap(loopMap("1/16")), "4 bars · 64 × 1/16 · 120 BPM");
});

// --- recipes ---------------------------------------------------------------------------------

test("generateRecipe: phrase length is preserved for every style, intensity and subdivision", () => {
  for (const sub of SUBDIVISIONS) {
    const map = loopMap(sub.key);
    for (const style of styleKeys()) {
      for (const intensity of [0, 25, 50, 75, 100]) {
        const recipe = generateRecipe({ map, style, intensity, seed: 12345 });
        assert.equal(recipe.steps.length, map.count, `${sub.key}/${style}/${intensity}: one step per slot`);
      }
    }
  }
});

test("generateRecipe: every step points at a slice that exists", () => {
  const map = loopMap("1/16");
  for (const style of styleKeys()) {
    for (let seed = 1; seed <= 25; seed++) {
      const recipe = generateRecipe({ map, style, intensity: 100, seed });
      for (const step of recipe.steps) {
        assert.ok(Number.isInteger(step.src), `${style}: src is an integer`);
        assert.ok(step.src >= 0 && step.src < map.count, `${style}/${seed}: src ${step.src} is in range`);
      }
    }
  }
});

test("generateRecipe: same source, settings and seed reproduce the same arrangement exactly", () => {
  const map = loopMap("1/16");
  for (const style of styleKeys()) {
    const a = generateRecipe({ map, style, intensity: 65, seed: 4242 });
    const b = generateRecipe({ map, style, intensity: 65, seed: 4242 });
    assert.deepEqual(a.steps, b.steps, `${style}: identical steps`);
    assert.deepEqual(a.edits, b.edits, `${style}: identical edit log`);
  }
});

test("generateRecipe: a string seed works and is hashed to the same number every time", () => {
  const map = loopMap("1/16");
  const a = generateRecipe({ map, style: "chaos", intensity: 70, seed: "keep this one" });
  const b = generateRecipe({ map, style: "chaos", intensity: 70, seed: "keep this one" });
  assert.equal(a.seed, b.seed);
  assert.deepEqual(a.steps, b.steps);
});

test("generateRecipe: different seeds diverge", () => {
  const map = loopMap("1/16");
  const patterns = new Set();
  for (let seed = 1; seed <= 12; seed++) patterns.add(recipePattern(generateRecipe({ map, style: "mixed", intensity: 60, seed: seed * 7919 })));
  assert.ok(patterns.size >= 10, `expected mostly-distinct arrangements, got ${patterns.size}/12`);
});

test("generateRecipe: never returns the source untouched - an identical variation is a wasted slot", () => {
  const map = loopMap("1/16");
  for (const style of styleKeys()) {
    for (const intensity of [0, 10, 50]) {
      for (let seed = 1; seed <= 15; seed++) {
        const recipe = generateRecipe({ map, style, intensity, seed: seed * 104729 });
        assert.equal(isIdentityRecipe(recipe), false, `${style}/${intensity}/${seed} came back unchanged`);
      }
    }
  }
});

test("generateRecipe: intensity is monotonic - more of it means more of the phrase changes", () => {
  const map = loopMap("1/16");
  for (const style of styleKeys()) {
    const average = (intensity) => {
      let total = 0;
      for (let seed = 1; seed <= 50; seed++) total += recipeDeparture(generateRecipe({ map, style, intensity, seed: seed * 104729 }));
      return total / 50;
    };
    const low = average(10);
    const mid = average(50);
    const high = average(95);
    assert.ok(low < mid, `${style}: 10 (${low.toFixed(3)}) should change less than 50 (${mid.toFixed(3)})`);
    assert.ok(mid < high, `${style}: 50 (${mid.toFixed(3)}) should change less than 95 (${high.toFixed(3)})`);
    assert.ok(low < 0.25, `${style}: low intensity should leave most of the phrase alone, got ${low.toFixed(3)}`);
    // A floor rather than a target: STUTTER earns its keep by ornamenting individual slices, so it
    // moves far less of the phrase than SHUFFLE does at the same setting and always will. The
    // restructuring personalities are held to a higher bar below.
    assert.ok(high > 0.2, `${style}: high intensity should change a lot of the phrase, got ${high.toFixed(3)}`);
    if (["shuffle", "jump", "mixed", "chaos", "repeat"].includes(style)) {
      assert.ok(high > 0.35, `${style}: this one restructures, so high intensity should go further, got ${high.toFixed(3)}`);
    }
  }
});

test("generateRecipe: conservative settings protect downbeats far more often than off-beats", () => {
  const map = loopMap("1/16");
  let downbeatsMoved = 0;
  let downbeatsTotal = 0;
  let offbeatsMoved = 0;
  let offbeatsTotal = 0;
  for (let seed = 1; seed <= 60; seed++) {
    const recipe = generateRecipe({ map, style: "mixed", intensity: 20, seed: seed * 104729 });
    for (let i = 0; i < recipe.steps.length; i++) {
      const moved = recipe.steps[i].src !== i || recipe.steps[i].silent;
      if (map.slices[i].isDownbeat) {
        downbeatsTotal++;
        if (moved) downbeatsMoved++;
      } else if (!map.slices[i].isBeat) {
        offbeatsTotal++;
        if (moved) offbeatsMoved++;
      }
    }
  }
  const downbeatRate = downbeatsMoved / downbeatsTotal;
  const offbeatRate = offbeatsMoved / offbeatsTotal;
  assert.ok(downbeatRate < offbeatRate, `downbeats (${downbeatRate.toFixed(3)}) should move less than off-beats (${offbeatRate.toFixed(3)})`);
  assert.ok(downbeatRate < 0.2, `downbeats should mostly survive at intensity 20, got ${downbeatRate.toFixed(3)}`);
});

test("generateRecipe: conservative settings keep runs of the original in place, not a wash of tiny edits", () => {
  const map = loopMap("1/16");
  let longestRuns = 0;
  const takes = 40;
  for (let seed = 1; seed <= takes; seed++) {
    const recipe = generateRecipe({ map, style: "mixed", intensity: 15, seed: seed * 104729 });
    let run = 0;
    let best = 0;
    for (let i = 0; i < recipe.steps.length; i++) {
      const untouched = recipe.steps[i].src === i && !recipe.steps[i].reverse && !recipe.steps[i].silent && !recipe.steps[i].stutter;
      run = untouched ? run + 1 : 0;
      best = Math.max(best, run);
    }
    longestRuns += best;
  }
  const average = longestRuns / takes;
  assert.ok(average >= map.perBar, `expected at least a bar of the original to survive intact on average, got ${average.toFixed(1)} slices`);
});

test("generateRecipe: styles actually do the thing they are named after", () => {
  const map = loopMap("1/16");
  const sample = (style, intensity, predicate) => {
    let hits = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const recipe = generateRecipe({ map, style, intensity, seed: seed * 104729 });
      if (recipe.steps.some(predicate)) hits++;
    }
    return hits / 40;
  };
  assert.ok(sample("reverse", 50, (s) => s.reverse) > 0.8, "Reverse reverses");
  assert.ok(sample("stutter", 50, (s) => s.stutter > 0) > 0.8, "Stutter stutters");
  assert.ok(sample("sparse", 50, (s) => s.silent) > 0.8, "Sparse drops things out");
  assert.equal(sample("repeat", 60, (s) => s.silent), 0, "Repeat never silences - that's Sparse's job");
  assert.equal(sample("shuffle", 60, (s) => s.reverse || s.stutter > 0 || s.silent), 0, "Shuffle only reorders");
});

test("generateRecipe: Stutter reaches for micro-editing immediately; Mixed saves it for higher intensity", () => {
  const map = loopMap("1/16");
  const stutterRate = (style, intensity) => {
    let hits = 0;
    for (let seed = 1; seed <= 40; seed++) {
      if (generateRecipe({ map, style, intensity, seed: seed * 104729 }).steps.some((s) => s.stutter > 0)) hits++;
    }
    return hits / 40;
  };
  assert.ok(stutterRate("stutter", 15) > 0.5, "the Stutter style stutters even at low intensity - it's what you picked it for");
  assert.equal(stutterRate("mixed", 15), 0, "Mixed leaves micro-editing alone until the slider asks for it");
  assert.ok(stutterRate("mixed", 85) > 0.2, "...and uses it once it does");
});

test("generateRecipe: Chaos is both more eager and more far-reaching than Mixed at the same setting", () => {
  const map = loopMap("1/16");
  const average = (style) => {
    let total = 0;
    for (let seed = 1; seed <= 50; seed++) total += recipeDeparture(generateRecipe({ map, style, intensity: 60, seed: seed * 104729 }));
    return total / 50;
  };
  assert.ok(average("chaos") > average("mixed"), "Chaos should out-wreck Mixed at identical intensity");
});

test("generateRecipe: survives a phrase barely long enough to rearrange", () => {
  const map = createSliceMap({ totalSamples: Math.round(SR * 0.5), sampleRate: SR, bpm: 120, subdivision: "1/4" });
  assert.ok(map.count >= 1);
  for (const style of styleKeys()) {
    const recipe = generateRecipe({ map, style, intensity: 100, seed: 9 });
    assert.equal(recipe.steps.length, map.count);
  }
});

test("generateRecipe: an unknown style falls back rather than throwing", () => {
  const map = loopMap("1/16");
  const recipe = generateRecipe({ map, style: "no-such-style", intensity: 50, seed: 1 });
  assert.equal(recipe.style, DEFAULT_STYLE);
  assert.equal(recipe.steps.length, map.count);
});

test("describeRecipe / recipePattern: say what happened, and elide long phrases in the middle", () => {
  const map = loopMap("1/16");
  const recipe = generateRecipe({ map, style: "mixed", intensity: 60, seed: 2024 });
  assert.ok(describeRecipe(recipe).length > 0);
  assert.equal(describeRecipe({ edits: [] }), "untouched");
  const pattern = recipePattern(recipe, 16);
  assert.ok(pattern.includes("…"), "a 64-slice phrase elided to 16 tokens should show the elision");
  assert.equal(recipePattern({ steps: identitySteps(4) }), "1 2 3 4");
});

// --- operations & styles ---------------------------------------------------------------------

test("operations: every one is registered, unique, and applies without changing the step count", () => {
  const map = loopMap("1/16");
  const keys = operationKeys();
  assert.equal(new Set(keys).size, keys.length, "no duplicate operation keys");
  const rng = { next: () => 0.5, signed: () => 0, range: (a, b) => (a + b) / 2, int: (n) => Math.floor(n / 2), bool: () => true };
  for (const op of OPERATIONS) {
    assert.equal(operationByKey(op.key), op, `${op.key} is findable by key`);
    const steps = identitySteps(map.count);
    op.apply({ rng, map, steps, t: 0.6, severity: 0.6, at: map.perBeat * 2 });
    assert.equal(steps.length, map.count, `${op.key} must never change the phrase length`);
    for (const step of steps) assert.ok(step.src >= 0 && step.src < map.count, `${op.key} kept src in range`);
  }
});

test("styles: every weighted operation exists, and every style is resolvable", () => {
  const known = new Set(operationKeys());
  for (const style of STYLES) {
    assert.equal(resolveStyle(style.key), style);
    assert.ok(style.label && style.blurb, `${style.key} has a label and a blurb`);
    for (const key of Object.keys(style.weights)) assert.ok(known.has(key), `${style.key} weights an unknown operation: ${key}`);
    for (const key of Object.keys(style.unlocks || {})) assert.ok(known.has(key), `${style.key} unlocks an unknown operation: ${key}`);
    assert.ok(Object.values(style.weights).some((w) => w > 0), `${style.key} weights something`);
  }
  assert.equal(resolveStyle("nonsense").key, DEFAULT_STYLE);
});

test("styles: the brief's seven personalities plus MIXED all exist", () => {
  for (const key of ["shuffle", "repeat", "jump", "stutter", "reverse", "sparse", "chaos", "mixed"]) {
    assert.ok(styleKeys().includes(key), `missing style: ${key}`);
  }
});

test("describeIntensity: a word for every point on the slider, and it changes as you move", () => {
  const words = new Set();
  for (let i = 0; i <= 100; i++) {
    const word = describeIntensity(i);
    assert.ok(word && typeof word === "string", `intensity ${i} has a word`);
    words.add(word);
  }
  assert.ok(words.size >= 4, "the slider should read differently at different ends");
});

console.log(`\n${passed} test(s) passed.`);
