// Node-side unit tests for js/tempo-override.js - the pure resolve/validate rules behind
// user-correctable source BPM (ANALYSIS PROPOSES, USER OVERRIDES).
// Run with: node test/tempo-override.test.mjs
import assert from "node:assert/strict";
import { sanitizeSourceBpm, resolveEffectiveTempo, formatBpmText, MAX_SOURCE_BPM } from "../js/tempo-override.js";

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

// --- resolveEffectiveTempo ---------------------------------------------------

test("resolveEffectiveTempo: no override -> effective tempo equals detected tempo", () => {
  assert.equal(resolveEffectiveTempo(null, 118), 118);
  assert.equal(resolveEffectiveTempo(undefined, 87), 87);
});

test("resolveEffectiveTempo: manual override -> effective tempo equals the override, not detected", () => {
  assert.equal(resolveEffectiveTempo(140, 70), 140);
});

test("resolveEffectiveTempo: clearing the override (back to null) -> detected tempo becomes effective again", () => {
  const detected = 118;
  let override = 120;
  assert.equal(resolveEffectiveTempo(override, detected), 120);
  override = null; // Reset to Detected
  assert.equal(resolveEffectiveTempo(override, detected), 118);
});

test("resolveEffectiveTempo: re-analysis with an existing override keeps the override, not the new detection", () => {
  // old detected = 118, manual override = 120, new analysis detects = 119 -> effective stays 120
  assert.equal(resolveEffectiveTempo(120, 119), 120);
  // Reset to Detected afterwards resolves to the NEW detected value, not the old one.
  assert.equal(resolveEffectiveTempo(null, 119), 119);
});

test("resolveEffectiveTempo: no detected tempo + a manual override still works", () => {
  assert.equal(resolveEffectiveTempo(120, null), 120);
});

test("resolveEffectiveTempo: neither override nor detection -> null, never NaN/0/undefined", () => {
  assert.equal(resolveEffectiveTempo(null, null), null);
  assert.equal(resolveEffectiveTempo(undefined, undefined), null);
  assert.equal(resolveEffectiveTempo(null, 0), null); // a falsy/invalid detected value is treated as "nothing detected"
});

test("resolveEffectiveTempo: never mutates or otherwise touches its inputs (raw detected value stays untouched)", () => {
  const detected = 70;
  resolveEffectiveTempo(140, detected);
  assert.equal(detected, 70, "the caller's raw detected value must be unaffected by resolving an override");
});

// --- sanitizeSourceBpm --------------------------------------------------------

test("sanitizeSourceBpm: accepts an ordinary typed BPM unchanged", () => {
  assert.equal(sanitizeSourceBpm(120), 120);
  assert.equal(sanitizeSourceBpm("87"), 87);
  assert.equal(sanitizeSourceBpm(140.5), 140.5); // fractional values aren't rejected just for being unusual
});

test("sanitizeSourceBpm: rejects NaN, non-numeric strings, zero, negative, and Infinity", () => {
  assert.equal(sanitizeSourceBpm(NaN), null);
  assert.equal(sanitizeSourceBpm("not a number"), null);
  assert.equal(sanitizeSourceBpm(""), null);
  assert.equal(sanitizeSourceBpm(0), null);
  assert.equal(sanitizeSourceBpm(-70), null);
  assert.equal(sanitizeSourceBpm(Infinity), null);
  assert.equal(sanitizeSourceBpm(-Infinity), null);
});

test("sanitizeSourceBpm: does not arbitrarily reject an unusual but technically valid tempo", () => {
  assert.equal(sanitizeSourceBpm(300), 300);
  assert.equal(sanitizeSourceBpm(20), 20);
});

test("sanitizeSourceBpm: caps only as a backstop against pathological input, well beyond any real tempo", () => {
  assert.equal(sanitizeSourceBpm(MAX_SOURCE_BPM + 500), MAX_SOURCE_BPM);
});

// --- half/double (composition of resolveEffectiveTempo + sanitizeSourceBpm, as app.js's
// adjustSourceTempo() does) --------------------------------------------------------------------

function halveOrDouble(override, detected, factor) {
  const current = resolveEffectiveTempo(override, detected);
  if (current == null) return override; // nothing to operate on - leave the override as-is
  return sanitizeSourceBpm(current * factor);
}

test("x2: detected 70, no override -> pressing x2 creates a manual override of 140", () => {
  const next = halveOrDouble(null, 70, 2);
  assert.equal(next, 140);
});

test("half: detected 140, no override -> pressing 1/2 creates a manual override of 70", () => {
  const next = halveOrDouble(null, 140, 0.5);
  assert.equal(next, 70);
});

test("x2: already manually set to 120 -> pressing x2 updates the override to 240 (compounds on the override, not detected)", () => {
  const next = halveOrDouble(120, 70, 2);
  assert.equal(next, 240);
});

test("half/x2: operate on the CURRENT EFFECTIVE tempo, never touching the raw detected value", () => {
  const detected = 70;
  halveOrDouble(140, detected, 0.5);
  assert.equal(detected, 70);
});

test("x2/half: with neither detected nor overridden, there is nothing to operate on", () => {
  assert.equal(halveOrDouble(null, null, 2), null);
});

// --- formatBpmText -------------------------------------------------------------

test("formatBpmText: a plain detected tempo has no manual suffix", () => {
  assert.equal(formatBpmText(118, false, true), "118 BPM");
});

test("formatBpmText: a manual tempo is marked distinctly from a detected one", () => {
  assert.equal(formatBpmText(140, true, true), "140 BPM (manual)");
});

test("formatBpmText: no usable tempo falls back to unclear/unavailable depending on detector availability", () => {
  assert.equal(formatBpmText(null, false, true), "unclear");
  assert.equal(formatBpmText(null, false, false), "unavailable");
});

console.log(`\n${passed} test(s) passed.`);
