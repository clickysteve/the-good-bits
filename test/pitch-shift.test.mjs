// Node-side unit tests for js/dsp/pitch-shift.js - the one piece of genuinely new DSP PLAY NICE
// needed. The property that matters is independence: pitch moves, duration does not.
// Run with: node test/pitch-shift.test.mjs
import assert from "node:assert/strict";
import { pitchShiftChannels, semitonesToRatio, ratioToSemitones, MAX_PITCH_SEMITONES, DEFAULT_PITCH_CHARACTER } from "../js/dsp/pitch-shift.js";
import { renderConform } from "../js/play-nice/render.js";
import { planConform } from "../js/play-nice/conform.js";
import { createTargetContext } from "../js/play-nice/target-context.js";

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

const SR = 44100;

function sine(freq, seconds, sampleRate = SR) {
  const n = Math.round(seconds * sampleRate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = 0.5 * Math.sin((2 * Math.PI * freq * i) / sampleRate);
  return out;
}

/**
 * Rough fundamental estimate by zero-crossing rate over the steady middle of the signal -
 * enough to tell a semitone from an octave, which is all these assertions need, and it
 * avoids pulling an FFT into a test of something else.
 */
function estimateFreq(x, sampleRate = SR) {
  const a = Math.floor(x.length * 0.3);
  const b = Math.floor(x.length * 0.7);
  let crossings = 0;
  for (let i = a + 1; i < b; i++) if (x[i - 1] < 0 !== x[i] < 0) crossings++;
  return crossings / 2 / ((b - a) / sampleRate);
}

// --- conversions -------------------------------------------------------------

test("semitonesToRatio: twelve semitones is exactly an octave", () => {
  assert.ok(Math.abs(semitonesToRatio(12) - 2) < 1e-12);
  assert.ok(Math.abs(semitonesToRatio(-12) - 0.5) < 1e-12);
  assert.equal(semitonesToRatio(0), 1);
});

test("ratioToSemitones: round-trips, and survives nonsense input", () => {
  for (const st of [-7, -1, 0, 3, 12]) assert.ok(Math.abs(ratioToSemitones(semitonesToRatio(st)) - st) < 1e-9);
  assert.equal(ratioToSemitones(0), 0);
  assert.equal(ratioToSemitones(-1), 0);
});

// --- the core promise: pitch moves, duration doesn't -------------------------

test("pitch shifting never changes duration", () => {
  const src = sine(220, 1.0);
  for (const st of [-12, -5, -1, 1, 4, 7, 12]) {
    const [out] = pitchShiftChannels([src], SR, st);
    assert.equal(out.length, src.length, `${st} st changed the length`);
  }
});

test("pitch shifting moves the fundamental to the right place", () => {
  const src = sine(220, 1.0);
  for (const st of [-5, -3, 4, 7, 12]) {
    const [out] = pitchShiftChannels([src], SR, st);
    const expected = 220 * semitonesToRatio(st);
    const measured = estimateFreq(out);
    // 1.5% is comfortably tighter than a semitone (~5.9%), so this really is checking the
    // interval and not just "something changed".
    assert.ok(Math.abs(measured - expected) / expected < 0.015, `${st} st: got ${measured.toFixed(1)}Hz, expected ${expected.toFixed(1)}Hz`);
  }
});

test("a zero-semitone shift is a passthrough, but still returns copies", () => {
  const src = sine(220, 0.3);
  const [out] = pitchShiftChannels([src], SR, 0);
  assert.equal(out.length, src.length);
  assert.notEqual(out, src, "callers must always be free to modify the result");
  for (let i = 0; i < src.length; i++) assert.equal(out[i], src[i]);
});

test("output is always finite and bounded - no NaN reaching an export", () => {
  const src = sine(440, 0.4);
  for (const st of [-12, -6, 5, 12]) {
    const [out] = pitchShiftChannels([src], SR, st);
    for (let i = 0; i < out.length; i++) {
      assert.ok(Number.isFinite(out[i]), `non-finite sample at ${i} for ${st} st`);
      assert.ok(Math.abs(out[i]) <= 4, `runaway sample ${out[i]} at ${i} for ${st} st`);
    }
  }
});

test("an absurd shift is clamped rather than attempted", () => {
  const src = sine(220, 0.3);
  const [out] = pitchShiftChannels([src], SR, 999);
  assert.equal(out.length, src.length);
  assert.ok(out.some((v) => v !== 0), "clamping must still produce audio");
  assert.equal(MAX_PITCH_SEMITONES, 24);
});

test("stereo channels are shifted together and keep their length", () => {
  const l = sine(220, 0.5);
  const r = sine(220, 0.5);
  const out = pitchShiftChannels([l, r], SR, 5);
  assert.equal(out.length, 2);
  assert.equal(out[0].length, l.length);
  assert.equal(out[1].length, r.length);
});

test("the default pitch character is a real character id", () => {
  assert.equal(typeof DEFAULT_PITCH_CHARACTER, "string");
  const [out] = pitchShiftChannels([sine(220, 0.3)], SR, 3, { character: "definitely-not-a-character" });
  assert.ok(out.length > 0, "an unknown character falls back rather than throwing");
});

// --- the two stages together -------------------------------------------------

const target = createTargetContext({ bpm: 128, key: "E", keyMode: "minor" });
const conformPlan = (over = {}) =>
  planConform({ role: "loop", source: { bpm: 100, key: "C", mode: "minor" }, target, tempoFit: true, pitchFit: true, method: "clean", sessionMethod: "clean", ...over });

test("renderConform: tempo only changes length and leaves pitch alone", () => {
  const src = sine(220, 1.0);
  const [out] = renderConform([src], SR, conformPlan({ pitchFit: false }));
  assert.ok(Math.abs(out.length - src.length * (100 / 128)) < SR * 0.02, "length should follow the ratio");
  assert.ok(Math.abs(estimateFreq(out) - 220) / 220 < 0.015, "pitch must not move when only tempo is fitted");
});

test("renderConform: pitch only changes pitch and leaves length alone", () => {
  const src = sine(220, 1.0);
  const [out] = renderConform([src], SR, conformPlan({ tempoFit: false }));
  assert.equal(out.length, src.length, "duration must not move when only pitch is fitted");
  const expected = 220 * semitonesToRatio(4);
  assert.ok(Math.abs(estimateFreq(out) - expected) / expected < 0.015);
});

test("renderConform: both stages together land on both targets", () => {
  const src = sine(220, 1.0);
  const [out] = renderConform([src], SR, conformPlan());
  const expectedLength = src.length * (100 / 128);
  const expectedFreq = 220 * semitonesToRatio(4);
  assert.ok(Math.abs(out.length - expectedLength) < SR * 0.02, `length ${out.length}, expected ~${expectedLength}`);
  assert.ok(Math.abs(estimateFreq(out) - expectedFreq) / expectedFreq < 0.015);
});

test("renderConform: a plan that changes nothing still hands back copies", () => {
  const src = sine(220, 0.3);
  const p = conformPlan({ tempoFit: false, pitchFit: false });
  assert.equal(p.changesAudio, false);
  const [out] = renderConform([src], SR, p);
  assert.notEqual(out, src);
  assert.equal(out.length, src.length);
});

test("renderConform: a non-pitch-preserving method still lands on the target key", () => {
  // Tape moves pitch with speed; the plan compensates, and this proves the compensation
  // survives all the way through the actual DSP rather than only the arithmetic.
  const src = sine(220, 1.0);
  const p = conformPlan({ method: "tape" });
  const [out] = renderConform([src], SR, p);
  const expectedFreq = 220 * semitonesToRatio(4);
  assert.ok(Math.abs(estimateFreq(out) - expectedFreq) / expectedFreq < 0.02, `got ${estimateFreq(out).toFixed(1)}Hz, expected ~${expectedFreq.toFixed(1)}Hz`);
});

test("renderConform: a combined ratio beyond the engine's cap still fills the buffer", () => {
  // The combined tempo+pitch path stretches by (tempoRatio x pitchFactor) and then forces
  // the result back to the tempo-only length. If that combined ratio is more than the
  // engine can do, the engine clamps and the length-forcing pads the difference with
  // silence - the exact "right length, missing audio" failure the single-pass optimisation
  // was supposed to have nothing to do with. Reproduced at 240 BPM -> 30 BPM with a +6
  // semitone shift: ratio 8.0 (already at the cap) x 1.414 = 11.31, and the last quarter of
  // the output was digital silence.
  const src = sine(220, 0.5);
  const t = createTargetContext({ bpm: 30, key: "F#", keyMode: "major" });
  const plan = planConform({
    role: "loop",
    source: { bpm: 240, key: "C", mode: "major", durationSec: src.length / SR, bpmIsManual: true },
    target: t,
    tempoFit: true,
    pitchFit: true,
    method: "clean",
    sessionMethod: "clean",
    snapToLoop: false,
    alignDownbeat: false,
  });
  assert.equal(plan.pitch.semitones, 6);
  assert.ok(plan.tempo.ratio * semitonesToRatio(plan.pitch.semitones) > plan.method.maxRatio, "this case must actually exceed the cap or it proves nothing");

  const [out] = renderConform([src], SR, plan);
  assert.equal(out.length, Math.round(src.length * plan.tempo.ratio), "length must still be exact");
  let peak = 0;
  for (let i = Math.floor(out.length * 0.75); i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]));
  assert.ok(peak > 1e-3, `last quarter of the output is silent (peak ${peak.toExponential(2)})`);
});

test("renderConform: pitch still lands correctly when the combined path is refused", () => {
  // Falling back to two passes must not change the musical result, only the smearing.
  const src = sine(220, 0.5);
  const t = createTargetContext({ bpm: 30, key: "F#", keyMode: "major" });
  const plan = planConform({
    role: "loop",
    source: { bpm: 240, key: "C", mode: "major", durationSec: src.length / SR, bpmIsManual: true },
    target: t,
    tempoFit: true,
    pitchFit: true,
    method: "clean",
    sessionMethod: "clean",
    snapToLoop: false,
    alignDownbeat: false,
  });
  const [out] = renderConform([src], SR, plan);
  const expected = 220 * semitonesToRatio(6);
  assert.ok(Math.abs(estimateFreq(out) - expected) / expected < 0.02, `got ${estimateFreq(out).toFixed(1)}Hz, expected ~${expected.toFixed(1)}Hz`);
});

console.log(`\n${passed} test(s) passed${failed ? `, ${failed} FAILED` : ""}.`);
