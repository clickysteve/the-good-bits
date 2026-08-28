// Node-side unit tests for the output-stage lo-fi processing module.
// Run with: node test/outputstage.test.mjs
import assert from "node:assert/strict";
import { OUTPUT_STAGES, DRIVE_TYPES, applyOutputStage, applyDrive, applyCrunch } from "../js/outputstage.js";

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

function tone(seconds, freq = 440, amp = 0.6) {
  const n = Math.round(seconds * SR);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR);
  return out;
}

function rmsDiff(a, b) {
  let sum = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum / n);
}

// --- catalog shape -----------------------------------------------------

test("OUTPUT_STAGES: starts with clean, has 11 entries with key/label/description", () => {
  assert.equal(OUTPUT_STAGES[0].key, "clean");
  assert.equal(OUTPUT_STAGES.length, 11);
  for (const s of OUTPUT_STAGES) {
    assert.ok(s.key && s.label && s.description);
  }
});

test("DRIVE_TYPES: 4 entries with key/label/description", () => {
  assert.equal(DRIVE_TYPES.length, 4);
  for (const d of DRIVE_TYPES) {
    assert.ok(d.key && d.label && d.description);
  }
});

// --- applyOutputStage ----------------------------------------------------

test("applyOutputStage: 'clean' mode is a bypass copy, not the same array instance", () => {
  const l = tone(0.5, 440);
  const [out] = applyOutputStage([l], SR, "clean", 100, 50, 1);
  assert.notEqual(out, l);
  assert.deepEqual(Array.from(out), Array.from(l));
});

test("applyOutputStage: mix 0 is a no-op copy for any mode", () => {
  const l = tone(0.5, 440);
  const [out] = applyOutputStage([l], SR, "cassette", 0, 80, 1);
  assert.deepEqual(Array.from(out), Array.from(l));
});

test("applyOutputStage: unknown mode key falls back to a bypass copy", () => {
  const l = tone(0.3, 440);
  const [out] = applyOutputStage([l], SR, "not-a-real-mode", 100, 50, 1);
  assert.deepEqual(Array.from(out), Array.from(l));
});

test("applyOutputStage: every mode at full mix audibly changes a tone", () => {
  const dry = tone(1.0, 220, 0.5);
  for (const stage of OUTPUT_STAGES) {
    if (stage.key === "clean") continue;
    const [wet] = applyOutputStage([dry], SR, stage.key, 100, 70, 42);
    const diff = rmsDiff(dry, wet);
    assert.ok(diff > 0.001, `${stage.key} should audibly differ from dry (rmsDiff=${diff})`);
  }
});

test("applyOutputStage: mono input treated as both channels, mono output", () => {
  const l = tone(0.4, 300, 0.5);
  const out = applyOutputStage([l], SR, "vinyl", 100, 60, 7);
  assert.equal(out.length, 1);
  assert.equal(out[0].length, l.length);
});

test("applyOutputStage: stereo input stays stereo, both channels processed", () => {
  const l = tone(0.4, 300, 0.5);
  const r = tone(0.4, 305, 0.5);
  const out = applyOutputStage([l, r], SR, "cassette", 100, 60, 7);
  assert.equal(out.length, 2);
  assert.equal(out[0].length, l.length);
  assert.equal(out[1].length, r.length);
});

test("applyOutputStage: same seed is reproducible, different seed differs", () => {
  const dry = tone(0.6, 250, 0.5);
  const [a] = applyOutputStage([dry], SR, "amRadio", 100, 60, 123);
  const [b] = applyOutputStage([dry], SR, "amRadio", 100, 60, 123);
  const [c] = applyOutputStage([dry], SR, "amRadio", 100, 60, 999);
  assert.deepEqual(Array.from(a), Array.from(b), "same seed should reproduce identically");
  assert.ok(rmsDiff(a, c) > 0, "different seed should produce a different noise realization");
});

test("applyOutputStage: intensity scales how far wet drifts from dry", () => {
  const dry = tone(0.8, 220, 0.5);
  const [lowInt] = applyOutputStage([dry], SR, "reelToReel", 100, 10, 5);
  const [hiInt] = applyOutputStage([dry], SR, "reelToReel", 100, 100, 5);
  const diffLow = rmsDiff(dry, lowInt);
  const diffHigh = rmsDiff(dry, hiInt);
  assert.ok(diffHigh > diffLow, `higher intensity (${diffHigh}) should differ from dry more than low intensity (${diffLow})`);
});

test("applyOutputStage: mix blends between dry and full-wet linearly at the endpoints", () => {
  const dry = tone(0.5, 220, 0.5);
  const [full] = applyOutputStage([dry], SR, "busComp", 100, 50, 5);
  const [half] = applyOutputStage([dry], SR, "busComp", 50, 50, 5);
  for (let i = 0; i < dry.length; i++) {
    const expected = dry[i] + (full[i] - dry[i]) * 0.5;
    assert.ok(Math.abs(half[i] - expected) < 1e-6, `sample ${i}: ${half[i]} vs expected ${expected}`);
  }
});

// --- applyDrive ----------------------------------------------------------

test("applyDrive: amount 0 is a no-op copy", () => {
  const l = tone(0.3, 440);
  const [out] = applyDrive([l], "tape", 0);
  assert.deepEqual(Array.from(out), Array.from(l));
});

test("applyDrive: each drive type audibly changes a loud tone at full amount", () => {
  const dry = tone(0.5, 220, 0.9);
  for (const d of DRIVE_TYPES) {
    const [wet] = applyDrive([dry], d.key, 100);
    const diff = rmsDiff(dry, wet);
    assert.ok(diff > 0.001, `${d.key} drive should audibly differ from dry (rmsDiff=${diff})`);
  }
});

test("applyDrive: output stays within [-1, 1] for diode and fuzz at full drive", () => {
  const dry = tone(0.3, 220, 0.95);
  for (const key of ["diode", "fuzz"]) {
    const [wet] = applyDrive([dry], key, 100);
    for (const s of wet) assert.ok(s >= -1.0001 && s <= 1.0001, `${key} sample out of range: ${s}`);
  }
});

test("applyDrive: preserves channel count", () => {
  const l = tone(0.2, 220);
  const r = tone(0.2, 225);
  const out = applyDrive([l, r], "tube", 60);
  assert.equal(out.length, 2);
});

// --- applyCrunch -----------------------------------------------------------

test("applyCrunch: defaults (16-bit, no rate reduction) are a no-op copy", () => {
  const l = tone(0.3, 440);
  const [out] = applyCrunch([l]);
  assert.deepEqual(Array.from(out), Array.from(l));
});

test("applyCrunch: low bit depth quantizes to a small set of levels", () => {
  const l = tone(0.5, 220, 0.9);
  const [out] = applyCrunch([l], { bits: 3 });
  const levels = new Set(Array.from(out));
  // round-to-nearest-step over [-1, 1] can land on one extra boundary point beyond the
  // nominal 2^bits levels, so allow a one-level margin.
  assert.ok(levels.size <= 9, `3-bit crunch should have about 8 levels, got ${levels.size}`);
});

test("applyCrunch: rateDivide holds samples (sample-and-hold), reducing effective rate", () => {
  const l = tone(0.5, 220, 0.9);
  const [out] = applyCrunch([l], { rateDivide: 8 });
  // within each held block of 8, all samples should be identical to the block's first sample
  for (let i = 0; i < out.length - 8; i += 8) {
    for (let j = 1; j < 8 && i + j < out.length; j++) {
      assert.equal(out[i + j], out[i], `sample ${i + j} should equal held sample at ${i}`);
    }
  }
});

test("applyCrunch: combining bits + rateDivide still respects both constraints", () => {
  const l = tone(0.5, 220, 0.9);
  const [out] = applyCrunch([l], { bits: 4, rateDivide: 4 });
  const levels = new Set(Array.from(out));
  assert.ok(levels.size <= 17, `4-bit crunch should have about 16 levels, got ${levels.size}`);
  for (let i = 0; i < out.length - 4; i += 4) {
    for (let j = 1; j < 4 && i + j < out.length; j++) {
      assert.equal(out[i + j], out[i]);
    }
  }
});

console.log(`\n${passed} test(s) passed.`);
