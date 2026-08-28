// Node-side unit tests for the WSOLA time-stretch module.
// Run with: node test/timestretch.test.mjs
import assert from "node:assert/strict";
import { wsolaStretchChannels, ratioForTargetTempo, CHARACTERS } from "../js/timestretch.js";

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

const SR = 22050;
function tone(seconds, freq = 220, amp = 0.6) {
  const n = Math.round(seconds * SR);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR);
  return out;
}

test("ratioForTargetTempo: higher target tempo -> shorter (ratio < 1), lower target -> longer (ratio > 1)", () => {
  assert.ok(Math.abs(ratioForTargetTempo(120, 120) - 1) < 1e-9);
  assert.ok(ratioForTargetTempo(120, 140) < 1);
  assert.ok(ratioForTargetTempo(120, 100) > 1);
  assert.equal(ratioForTargetTempo(null, 120), 1);
  assert.equal(ratioForTargetTempo(120, 0), 1);
});

test("wsolaStretchChannels: ratio 1 returns an unchanged copy (same length + content)", () => {
  const input = tone(0.5, 220);
  const [out] = wsolaStretchChannels([input], SR, 1, "clean");
  assert.equal(out.length, input.length);
  assert.deepEqual(Array.from(out), Array.from(input));
  assert.notEqual(out, input, "should be a copy, not the same array reference");
});

test("wsolaStretchChannels: ratio 2 roughly doubles length, ratio 0.5 roughly halves it", () => {
  const input = tone(1.0, 220);
  const [longer] = wsolaStretchChannels([input], SR, 2.0, "clean");
  const [shorter] = wsolaStretchChannels([input], SR, 0.5, "clean");
  assert.ok(Math.abs(longer.length - input.length * 2) / (input.length * 2) < 0.15, `expected ~2x length, got ${longer.length} vs input ${input.length}`);
  assert.ok(Math.abs(shorter.length - input.length * 0.5) / (input.length * 0.5) < 0.15, `expected ~0.5x length, got ${shorter.length}`);
});

test("wsolaStretchChannels: stereo channels stay phase-aligned (grain placement decided once)", () => {
  const mono = tone(0.6, 300);
  // Identical signal on both channels; if grain placement diverged between channels, L and R would
  // no longer match sample-for-sample after stretching.
  const [l, r] = wsolaStretchChannels([mono, mono], SR, 1.6, "clean");
  assert.equal(l.length, r.length);
  let maxDiff = 0;
  for (let i = 0; i < l.length; i++) maxDiff = Math.max(maxDiff, Math.abs(l[i] - r[i]));
  assert.ok(maxDiff < 1e-6, `expected identical L/R after stretch, max diff ${maxDiff}`);
});

test("wsolaStretchChannels: output stays within a sane amplitude range (no runaway gain from overlap-add)", () => {
  const input = tone(0.8, 220, 0.8);
  const [out] = wsolaStretchChannels([input], SR, 1.7, "vintage");
  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  assert.ok(peak < 1.5, `expected no runaway gain, peak was ${peak}`);
});

test("CHARACTERS: clean searches more / quantizes less than vintage, vintage more than glitch", () => {
  assert.ok(CHARACTERS.clean.searchMs > CHARACTERS.vintage.searchMs);
  assert.ok(CHARACTERS.vintage.searchMs >= CHARACTERS.glitch.searchMs);
  assert.equal(CHARACTERS.clean.bitDepth, null);
  assert.ok(CHARACTERS.vintage.bitDepth > CHARACTERS.glitch.bitDepth);
});

test("wsolaStretchChannels: glitch character's bit-crush measurably reduces the number of distinct sample values", () => {
  const input = tone(0.4, 220, 0.9);
  const [clean] = wsolaStretchChannels([input], SR, 1.3, "clean");
  const [glitch] = wsolaStretchChannels([input], SR, 1.3, "glitch");
  const distinct = (arr) => new Set(Array.from(arr).map((v) => v.toFixed(5))).size;
  assert.ok(distinct(glitch) < distinct(clean), `expected fewer distinct levels in glitch (${distinct(glitch)}) than clean (${distinct(clean)})`);
});

console.log(`\n${passed} test(s) passed.`);
