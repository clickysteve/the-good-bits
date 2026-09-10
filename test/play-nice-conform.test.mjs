// Node-side unit tests for js/play-nice/conform.js and js/play-nice/target-context.js - PLAY NICE's
// decision layer. These cover the three separations the feature is built on: target source
// (Defined vs. Reference) not reaching the pipeline, FIT (what changes) staying independent of
// METHOD (how), and input ROLE gating what is even applicable.
// Run with: node test/play-nice-conform.test.mjs
import assert from "node:assert/strict";
import { planConform, formatRatio, formatTempoChange, betterOctaveInterpretation, snapTempoToLoopLength } from "../js/play-nice/conform.js";
import { createTargetContext, targetFromReference, tempoInterpretations, sanitizeTargetBpm, targetReadiness, formatTarget } from "../js/play-nice/target-context.js";
import { isNote } from "../js/play-nice/key-matching.js";
import { resolveMethodKey, METHOD_INHERIT, methodKeys } from "../js/play-nice/methods.js";
import { predictedDuration } from "../js/play-nice/render.js";

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL - ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

const target = (over) => createTargetContext({ bpm: 128, key: "E", keyMode: "minor", ...over });
const plan = (over = {}) =>
  planConform({
    role: "loop",
    source: { bpm: 100, key: "C", mode: "minor" },
    target: target(),
    tempoFit: true,
    pitchFit: true,
    method: METHOD_INHERIT,
    sessionMethod: "clean",
    ...over,
  });

// --- tempo -------------------------------------------------------------------

test("tempo: the ratio conforms source BPM onto target BPM", () => {
  // ratio is output length / input length, so 100 -> 128 shortens it.
  const p = plan();
  assert.ok(Math.abs(p.tempo.ratio - 100 / 128) < 1e-9);
  assert.equal(p.tempo.applied, true);
});

test("tempo: already at the target means no stretch, and says so", () => {
  const p = plan({ source: { bpm: 128, key: "E", mode: "minor" } });
  assert.equal(p.tempo.applied, false);
  assert.match(p.tempo.reason, /already at the target/);
});

test("tempo: fitting off leaves the audio alone and reports why", () => {
  const p = plan({ tempoFit: false });
  assert.equal(p.tempo.applied, false);
  assert.equal(p.tempo.ratio, 1);
  assert.match(p.tempo.reason, /off/);
});

test("tempo: no detected source BPM is a reason, not a silent 1.0", () => {
  const p = plan({ source: { bpm: null, key: "C", mode: "minor" } });
  assert.equal(p.tempo.applied, false);
  assert.match(p.tempo.reason, /no source BPM/);
});

test("tempo: a detected half-time reading is resolved automatically", () => {
  // 62 against a 128 target is a half-time detection, and with a target in hand the right
  // reading is unambiguous. Making the user click for it is the difference between "drop
  // twenty loops in and they work" and "drop twenty loops in and then go hunting".
  const p = plan({ source: { bpm: 62, key: "C", mode: "minor" } });
  assert.equal(p.tempo.autoOctave, true);
  assert.equal(p.tempo.interpretedBpm, 124);
  assert.equal(p.tempo.detectedSourceBpm, 62, "the raw detection is still reported");
  assert.ok(Math.abs(p.tempo.ratio - 124 / 128) < 1e-9);
  assert.deepEqual(p.tempo.warnings, [], "nothing to warn about once it's fixed");
});

test("tempo: auto-correction never overrules a tempo the user set themselves", () => {
  // ANALYSIS PROPOSES, USER OVERRIDES. Someone who deliberately says "this is 62" gets 62,
  // and a suggestion rather than a silent doubling.
  const p = plan({ source: { bpm: 62, key: "C", mode: "minor", bpmIsManual: true } });
  assert.equal(p.tempo.autoOctave, false);
  assert.equal(p.tempo.interpretedBpm, 62);
  const warning = p.tempo.warnings.find((w) => w.code === "octave-suggestion");
  assert.ok(warning, "it should still point at the correction, just not take it");
  assert.equal(warning.suggestedBpm, 124);
});

test("tempo: auto-correction can be switched off entirely", () => {
  const p = plan({ source: { bpm: 62, key: "C", mode: "minor" }, autoOctave: false });
  assert.equal(p.tempo.autoOctave, false);
  assert.equal(p.tempo.interpretedBpm, 62);
});

test("tempo: a correct detection is left completely alone", () => {
  const p = plan({ source: { bpm: 124, key: "C", mode: "minor" } });
  assert.equal(p.tempo.autoOctave, false);
  assert.equal(p.tempo.interpretedBpm, 124);
});

test("betterOctaveInterpretation: catches half-time errors a ratio threshold misses", () => {
  // The case that motivated this: a 140 BPM loop detected at 70 and conformed to 120 gives a
  // ratio of 0.58 - not extreme by any sensible threshold, but unmistakably an octave out.
  assert.equal(betterOctaveInterpretation(70, 120), 140);
  assert.equal(betterOctaveInterpretation(62, 128), 124);
  assert.equal(betterOctaveInterpretation(240, 120), 120, "double-time errors too");
});

test("betterOctaveInterpretation: stays quiet when the detected tempo is already the best fit", () => {
  // A warning on every loop would be worse than none - the batch workflow depends on the
  // flagged ones being the ones actually worth looking at.
  assert.equal(betterOctaveInterpretation(100, 120), null);
  assert.equal(betterOctaveInterpretation(128, 128), null);
  assert.equal(betterOctaveInterpretation(174, 120), null, "genuinely ambiguous - guessing would be noise");
  assert.equal(betterOctaveInterpretation(0, 120), null);
  assert.equal(betterOctaveInterpretation(120, 0), null);
});

test("a plan with no octave problem carries no tempo warnings at all", () => {
  assert.deepEqual(plan().tempo.warnings, []);
});

test("tempo: correcting the source BPM immediately changes the required stretch", () => {
  // The single most important interaction in the feature: the half/double buttons have to
  // move the ratio, not just a label.
  // bpmIsManual, because this is simulating the user clicking the half/double buttons -
  // without it auto-correction would resolve 62 to 124 by itself and both sides would match.
  const halfTime = plan({ source: { bpm: 62, key: "C", mode: "minor", bpmIsManual: true } }).tempo.ratio;
  const corrected = plan({ source: { bpm: 124, key: "C", mode: "minor", bpmIsManual: true } }).tempo.ratio;
  // ratio is source/target, so treating the loop as twice as fast doubles the ratio: it no
  // longer needs to be crushed to half length to reach 128.
  assert.ok(Math.abs(corrected - halfTime * 2) < 1e-9, "doubling the interpreted source BPM doubles the ratio");
  assert.ok(Math.abs(halfTime - 62 / 128) < 1e-9);
  assert.ok(Math.abs(corrected - 124 / 128) < 1e-9);
});

// --- FIT vs METHOD independence ----------------------------------------------

test("METHOD never changes the ratio FIT calculated", () => {
  // The load-bearing separation: the stretch required to reach 128 BPM is a fact about the
  // two tempos. Which algorithm performs it is taste. Every pitch-preserving method in the
  // registry must agree on the number.
  const reference = plan({ method: "clean" }).tempo.ratio;
  for (const key of methodKeys()) {
    const p = plan({ method: key });
    if (!p.method.preservesPitch) continue; // varispeed is covered separately below
    if (p.tempo.clampedByMethod) continue; // a method with a lower maxRatio is a documented cap, not a disagreement
    assert.ok(Math.abs(p.tempo.ratio - reference) < 1e-9, `${key} changed the ratio to ${p.tempo.ratio}`);
  }
});

test("METHOD is an explicit parameter, so one loop can be planned through every method", () => {
  // This is what a future TRY ALL needs and why the method isn't chosen inside the planner:
  // same source, same target, one plan per method, no new pipeline.
  const variants = methodKeys().map((key) => plan({ method: key }));
  assert.equal(variants.length, methodKeys().length);
  assert.equal(new Set(variants.map((v) => v.method.key)).size, methodKeys().length);
});

test("per-loop method overrides the session default; inherit follows it", () => {
  assert.equal(resolveMethodKey(METHOD_INHERIT, "glitch"), "glitch");
  assert.equal(resolveMethodKey("grain", "glitch"), "grain", "an explicit choice wins");
  assert.equal(resolveMethodKey(null, "glitch"), "glitch");
  assert.equal(resolveMethodKey("not-a-method", "glitch"), "glitch", "an unknown id falls back rather than throwing");
});

// --- pitch -------------------------------------------------------------------

test("pitch: C minor -> E minor is four semitones up", () => {
  assert.equal(plan().pitch.semitones, 4);
  assert.equal(plan().pitch.applied, true);
});

test("pitch: fitting off means the pitch stage does nothing", () => {
  const p = plan({ pitchFit: false });
  assert.equal(p.pitch.applied, false);
  assert.equal(p.pitch.semitones, 0);
});

test("pitch: no usable source key reports why rather than transposing blindly", () => {
  const p = plan({ source: { bpm: 100, key: null, mode: null } });
  assert.equal(p.pitch.applied, false);
  assert.match(p.pitch.reason, /source key/);
  assert.equal(p.tempo.applied, true, "an unkeyed loop still gets its tempo conformed");
});

test("pitch: a session with key conforming switched off leaves pitch alone", () => {
  const p = plan({ target: target({ pitchEnabled: false }) });
  assert.equal(p.pitch.applied, false);
  assert.equal(p.tempo.applied, true);
});

test("pitch: never an octave leap when a semitone will do", () => {
  const p = plan({ source: { bpm: 128, key: "C", mode: "major" }, target: target({ key: "B", keyMode: "major" }) });
  assert.equal(p.pitch.semitones, -1, "C -> B must be one down, not eleven up");
});

// --- METHOD-induced pitch drift ----------------------------------------------

test("a non-pitch-preserving method's drift is compensated when pitch fitting is on", () => {
  // "Tape" (varispeed) moves pitch with speed by design. Conforming tempo through it
  // arrives at the pitch stage already transposed; the pitch stage has to subtract that so
  // the result still lands on the target key.
  const p = plan({ method: "tape" });
  assert.equal(p.method.preservesPitch, false);
  assert.ok(Math.abs(p.pitch.methodDrift) > 0.1, "tape should introduce real drift here");
  assert.ok(Math.abs(p.pitch.resultingShift - 4) < 1e-6, "what is actually heard must still be the target's +4");
  assert.ok(Math.abs(p.pitch.semitones - (4 - p.pitch.methodDrift)) < 1e-9);
});

test("a non-pitch-preserving method's drift is left in - but reported - when pitch fitting is off", () => {
  // That drift IS the sound the user chose. It just must never be a mystery.
  const p = plan({ method: "tape", pitchFit: false });
  assert.equal(p.pitch.applied, false);
  assert.ok(Math.abs(p.pitch.resultingShift - p.pitch.methodDrift) < 1e-9);
  assert.ok(p.pitch.warnings.some((w) => w.code === "method-pitch-drift"));
});

test("a pitch-preserving method introduces no drift at all", () => {
  assert.equal(plan({ method: "clean" }).pitch.methodDrift, 0);
});

// --- roles -------------------------------------------------------------------

test("a one-shot is never tempo-stretched, but is still pitch-conformed", () => {
  // The architectural guard for the future one-shot workflow: nothing in the planner
  // assumes its input is a loop with a tempo.
  const p = plan({ role: "oneShot", source: { bpm: null, key: "C", mode: "minor" } });
  assert.equal(p.tempo.applied, false);
  assert.match(p.tempo.reason, /not applicable/);
  assert.equal(p.pitch.semitones, 4, "pitch still conforms to the shared target");
});

test("a one-shot ignores a tempo Fit switch left on rather than stretching anyway", () => {
  const p = plan({ role: "oneShot", source: { bpm: 100, key: "C", mode: "minor" }, tempoFit: true });
  assert.equal(p.tempo.applied, false);
});

test("a reference input conforms nothing - it defines the target", () => {
  const p = plan({ role: "reference" });
  assert.equal(p.tempo.applied, false);
  assert.equal(p.pitch.applied, false);
  assert.equal(p.changesAudio, false);
});

// --- target context ----------------------------------------------------------

test("the pipeline cannot tell a Defined target from a Reference one", () => {
  // The whole reason TargetContext exists: identical values must produce an identical plan
  // no matter which UI filled them in.
  const defined = createTargetContext({ bpm: 117, key: "A", keyMode: "minor", source: "manual" });
  const fromRef = targetFromReference(createTargetContext(), { name: "ref.wav", bpm: 117, key: "A", scale: "minor", keyStrength: 0.8, durationSec: 4 });
  const args = { role: "loop", source: { bpm: 100, key: "C", mode: "minor" }, tempoFit: true, pitchFit: true, method: "clean", sessionMethod: "clean" };
  const a = planConform({ ...args, target: defined });
  const b = planConform({ ...args, target: fromRef });
  assert.deepEqual({ r: a.tempo.ratio, s: a.pitch.semitones }, { r: b.tempo.ratio, s: b.pitch.semitones });
});

test("a reference loop keeps its detected values alongside the editable target", () => {
  // Detection is an assistant: "reset to detected" has to stay possible after any amount
  // of correction.
  const t = targetFromReference(createTargetContext(), { name: "ref.wav", bpm: 116.6, key: "A", scale: "minor", keyStrength: 0.8, durationSec: 4 });
  assert.equal(t.source, "reference");
  assert.equal(t.bpm, 117, "the editable target rounds to something typable");
  assert.equal(t.reference.detectedBpm, 116.6, "the raw detection is kept untouched");
  assert.equal(t.reference.name, "ref.wav");
});

test("a reference loop with no clear key switches key conforming off rather than inventing one", () => {
  const t = targetFromReference(createTargetContext(), { name: "drums.wav", bpm: 174, key: null, scale: null, keyStrength: 0, durationSec: 2 });
  assert.equal(t.pitchEnabled, false);
  assert.equal(t.bpm, 174, "the tempo it did find is still used");
  assert.equal(targetReadiness(t).tempoReady, true);
  assert.equal(targetReadiness(t).pitchReady, false);
});

test("tempoInterpretations: half/double options around the detected value", () => {
  // The spec case: detected 64 should offer 128 and 256 as one click.
  const options = tempoInterpretations(64);
  assert.ok(options.includes(64), "the detected value is always offered");
  assert.ok(options.includes(128) && options.includes(256));
  assert.deepEqual(options, [...options].sort((a, b) => a - b), "ascending");
  assert.deepEqual(tempoInterpretations(null), []);
  assert.deepEqual(tempoInterpretations(0), []);
});

test("tempoInterpretations: reaches a triplet misdetection, not just octaves", () => {
  // A straight 136 BPM break is routinely detected at 90.67 - exactly two thirds. With only
  // octave candidates the chips offer 45/91/181 and there is no way to click your way to the
  // right answer at all.
  const options = tempoInterpretations(90.67);
  assert.ok(options.includes(136), `expected 136 among ${options.join(", ")}`);
  assert.ok(options.includes(91), "the detected reading is always offered");
  assert.deepEqual(options, [...options].sort((a, b) => a - b), "ascending");
});

test("tempoInterpretations: never offers the same tempo twice", () => {
  for (const bpm of [60, 64, 90, 120, 136, 174]) {
    const options = tempoInterpretations(bpm);
    assert.equal(new Set(options).size, options.length, `${bpm} produced duplicates: ${options.join(", ")}`);
  }
});

test("sanitizeTargetBpm: rejects garbage instead of storing it", () => {
  assert.equal(sanitizeTargetBpm(128), 128);
  assert.equal(sanitizeTargetBpm("126.5"), 126.5);
  for (const bad of [0, -4, NaN, Infinity, "abc", null]) assert.equal(sanitizeTargetBpm(bad), null, `${bad} should be rejected`);
});

test("formatTarget: describes whichever halves of the target are usable", () => {
  assert.equal(formatTarget(target()), "128 BPM / E minor");
  assert.equal(formatTarget(target({ pitchEnabled: false })), "128 BPM");
});

// --- derived display ---------------------------------------------------------

test("predictedDuration: the pitch stage never changes length", () => {
  const tempoOnly = plan({ pitchFit: false });
  const both = plan();
  assert.equal(predictedDuration(4, tempoOnly), predictedDuration(4, both), "adding pitch fitting must not change duration");
  assert.equal(predictedDuration(4, plan({ tempoFit: false, pitchFit: true })), 4, "pitch-only leaves duration exactly alone");
});

test("formatRatio / formatTempoChange: a ratio below 1 reads as faster", () => {
  assert.equal(formatRatio(1), "1x");
  assert.equal(formatTempoChange(1), "no change");
  assert.match(formatTempoChange(0.5), /\+100\.0% faster/);
  assert.match(formatTempoChange(2), /-50\.0% slower/);
});

// --- regression: the key of C ------------------------------------------------

test("the key of C is a real key, not a falsy index", () => {
  // noteToIndex("C") is 0, and 0 is falsy. Testing the index's truthiness anywhere makes the
  // single most common key in recorded music read as "no key detected" - which is exactly what
  // it did: a reference loop in C had key conforming silently switched off, and choosing C from
  // the target key selector was rejected. isNote() exists so this can't come back.
  assert.equal(isNote("C"), true);
  assert.equal(isNote("B"), true);
  assert.equal(isNote(""), false);
  assert.equal(isNote(null), false);

  const t = targetFromReference(createTargetContext(), { name: "ref.wav", bpm: 120, key: "C", scale: "minor", keyStrength: 0.9, durationSec: 4 });
  assert.equal(t.pitchEnabled, true, "a reference loop in C must still enable key conforming");
  assert.equal(t.key, "C");
  assert.equal(targetReadiness(t).pitchReady, true);

  const p = planConform({
    role: "loop",
    source: { bpm: 120, key: "A", mode: "minor" },
    target: t,
    tempoFit: true,
    pitchFit: true,
    method: "clean",
    sessionMethod: "clean",
  });
  assert.equal(p.pitch.applied, true, "conforming TO C must actually transpose");
  assert.equal(p.pitch.semitones, 3, "A -> C is three semitones up");
});

test("a source loop in C is transposed, not treated as keyless", () => {
  const p = planConform({
    role: "loop",
    source: { bpm: 120, key: "C", mode: "minor" },
    target: target(),
    tempoFit: false,
    pitchFit: true,
    method: "clean",
    sessionMethod: "clean",
  });
  assert.equal(p.pitch.applied, true);
  assert.equal(p.pitch.semitones, 4);
});

// --- bar snapping: keeping a looping mix locked --------------------------------

test("snapTempoToLoopLength: a loop's own length beats its detected tempo", () => {
  // The real measured case: essentia reports 99.86 BPM for a four-bar loop that is exactly
  // 9.60s long. 16 beats in 9.60s is exactly 100 BPM, and 100 is obviously the truth.
  const snap = snapTempoToLoopLength(9.6, 99.86);
  assert.equal(snap.beats, 16);
  assert.ok(Math.abs(snap.bpm - 100) < 1e-9);
});

test("snapTempoToLoopLength: prefers musical bar counts over the nearest whole beat", () => {
  // The real failure: a sixteen-bar arpeggio measured at 64.6 beats rounded to SIXTY-FIVE,
  // which is not a length any loop has ever been, and conforming from it left the loop
  // over a beat wrong by the end.
  const snap = snapTempoToLoopLength(36.92, 105.6);
  assert.equal(snap.beats, 64, "16 bars, not 65 beats");
  assert.ok(Math.abs(snap.bpm - 104) < 0.5);
});

test("snapTempoToLoopLength: an honest 3-bar loop is NOT forced to a power of two", () => {
  // The tiers exist so "prefer musical" doesn't become "mangle anything unusual".
  const snap = snapTempoToLoopLength(5.538, 130);
  assert.equal(snap.beats, 12);
});

test("snapTempoToLoopLength: a genuinely odd length falls through to a plain integer", () => {
  const snap = snapTempoToLoopLength(2.5, 120);
  assert.equal(snap.beats, 5);
});

test("snapTempoToLoopLength: common loop lengths land where they should", () => {
  for (const [dur, bpm, beats] of [
    [1.7647, 136, 4],
    [9.6, 99.86, 16],
    [8.2051, 117, 16],
    [6.857, 140, 16],
  ]) {
    assert.equal(snapTempoToLoopLength(dur, bpm).beats, beats, `${dur}s at ${bpm} BPM`);
  }
});

test("snapTempoToLoopLength: an already-exact tempo is left where it is", () => {
  const snap = snapTempoToLoopLength(8, 120); // 16 beats at 120 BPM
  assert.equal(snap.beats, 16);
  assert.ok(Math.abs(snap.bpm - 120) < 1e-9);
});

test("snapTempoToLoopLength: refuses to move the tempo more than a hair", () => {
  // Snapping corrects detection error. Disagreeing about what the tempo IS is the
  // half/double buttons' job, and this must never quietly do it.
  assert.equal(snapTempoToLoopLength(10, 62), null, "a 6%+ correction is a different tempo, not a rounding fix");
  assert.equal(snapTempoToLoopLength(0, 120), null);
  assert.equal(snapTempoToLoopLength(9.6, 0), null);
  assert.equal(snapTempoToLoopLength(undefined, 120), null);
  assert.equal(snapTempoToLoopLength(0.1, 120), null, "shorter than one beat");
});

test("snapping makes loops from different sources land on identical lengths", () => {
  // This is the property the whole "play them together" feature rests on: three loops from
  // three tempos, conformed to one target, must come out EXACTLY the same length or a
  // looping mix drifts apart.
  const t = target({ bpm: 117 });
  const sources = [
    { bpm: 99.86, durationSec: 9.6 }, // detected slightly flat
    { bpm: 117.0, durationSec: 8.2051 },
    { bpm: 140.03, durationSec: 6.857 },
  ];
  const lengths = sources.map((src) => {
    const p = planConform({
      role: "loop",
      source: { ...src, key: "A", mode: "minor" },
      target: t,
      tempoFit: true,
      pitchFit: false,
      method: "clean",
      sessionMethod: "clean",
      snapToLoop: true,
    });
    assert.equal(p.tempo.snapped, true);
    assert.equal(p.tempo.snappedBeats, 16);
    return predictedDuration(src.durationSec, p);
  });
  const ideal = 16 * (60 / 117);
  for (const len of lengths) {
    // Sub-millisecond, versus the ~15ms per cycle that unsnapped detection produced.
    assert.ok(Math.abs(len - ideal) < 1e-6, `got ${len}, expected ${ideal}`);
  }
});

test("snapping off leaves the detected tempo exactly as it was", () => {
  const p = planConform({
    role: "loop",
    source: { bpm: 99.86, durationSec: 9.6, key: "A", mode: "minor" },
    target: target({ bpm: 117 }),
    tempoFit: true,
    pitchFit: false,
    method: "clean",
    sessionMethod: "clean",
    snapToLoop: false,
  });
  assert.equal(p.tempo.snapped, false);
  assert.equal(p.tempo.sourceBpm, 99.86);
});

test("snapping is impossible without a duration, and says so rather than guessing", () => {
  const p = planConform({
    role: "loop",
    source: { bpm: 100, key: "A", mode: "minor" }, // no durationSec
    target: target({ bpm: 117 }),
    tempoFit: true,
    pitchFit: false,
    method: "clean",
    sessionMethod: "clean",
    snapToLoop: true,
  });
  assert.equal(p.tempo.snapped, false);
  assert.equal(p.tempo.sourceBpm, 100, "the tempo still works, it just isn't refined");
});

test("snapping never overrides a manual half/double correction", () => {
  // A user who says "this is 124" gets 124, refined at most by a fraction of a percent.
  const p = planConform({
    role: "loop",
    source: { bpm: 124, durationSec: 7.74, key: "A", mode: "minor" },
    target: target({ bpm: 117 }),
    tempoFit: true,
    pitchFit: false,
    method: "clean",
    sessionMethod: "clean",
    snapToLoop: true,
  });
  assert.ok(Math.abs(p.tempo.sourceBpm - 124) / 124 < 0.03);
});

test("a same-root, wrong-mode loop is never reported as already in the target key", () => {
  // C minor against a C major target needs zero semitones and is still wrong. Calling that
  // "already in the target key" would present the one case the user most needs to see as a
  // success.
  const p = planConform({
    role: "loop",
    source: { bpm: 120, key: "C", mode: "minor" },
    target: createTargetContext({ bpm: 120, key: "C", keyMode: "major" }),
    tempoFit: false,
    pitchFit: true,
    method: "clean",
    sessionMethod: "clean",
    strategy: "nearest-root",
  });
  assert.equal(p.pitch.applied, false);
  assert.match(p.pitch.reason, /minor against a major target/);
  assert.ok(p.warnings.some((w) => w.code === "mode-mismatch"));
});

test("match-scale sends every loop somewhere mutually compatible", () => {
  // The practical payoff: three loops in three different minor keys, one major target.
  // Match scale lands all three in the SAME key - the target's relative minor - so they fit
  // the target and each other. Matching roots would leave them all in the target's root
  // MINOR, clashing with the target's major third.
  const t = createTargetContext({ bpm: 120, key: "C", keyMode: "major" });
  const results = ["A", "C", "G"].map((key) => {
    const p = planConform({
      role: "loop",
      source: { bpm: 120, key, mode: "minor" },
      target: t,
      tempoFit: false,
      pitchFit: true,
      method: "clean",
      sessionMethod: "clean",
      strategy: "relative",
    });
    return `${p.pitch.resultKey} ${p.pitch.resultMode}`;
  });
  assert.deepEqual(results, ["A minor", "A minor", "A minor"]);
});

console.log(`\n${passed} test(s) passed${failed ? `, ${failed} FAILED` : ""}.`);
