// Node-side unit tests for js/naming-tokens.js - the pure string<->segment conversion behind the
// File Name Pattern token editor. Run with: node test/naming-tokens.test.mjs
import assert from "node:assert/strict";
import { parsePatternToSegments, segmentsToPattern, isKnownToken, resolveNamePattern } from "../js/naming-tokens.js";

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

test("parsePatternToSegments: plain literal text with no tokens", () => {
  assert.deepEqual(parsePatternToSegments("AMFAS_"), [{ type: "text", value: "AMFAS_" }]);
});

test("parsePatternToSegments: a single token", () => {
  assert.deepEqual(parsePatternToSegments("{number}"), [{ type: "token", key: "number" }]);
});

test("parsePatternToSegments: token then literal text", () => {
  assert.deepEqual(parsePatternToSegments("{name}_{number}"), [
    { type: "token", key: "name" },
    { type: "text", value: "_" },
    { type: "token", key: "number" },
  ]);
});

test("parsePatternToSegments: literal text around a token, and between two tokens", () => {
  assert.deepEqual(parsePatternToSegments("AMFAS_{name}_{number}"), [
    { type: "text", value: "AMFAS_" },
    { type: "token", key: "name" },
    { type: "text", value: "_" },
    { type: "token", key: "number" },
  ]);
  assert.deepEqual(parsePatternToSegments("{tag} - {name}"), [
    { type: "token", key: "tag" },
    { type: "text", value: " - " },
    { type: "token", key: "name" },
  ]);
  assert.deepEqual(parsePatternToSegments("{name} processed {number}"), [
    { type: "token", key: "name" },
    { type: "text", value: " processed " },
    { type: "token", key: "number" },
  ]);
});

test("parsePatternToSegments: tokens are recognised case-insensitively but normalised to lowercase", () => {
  assert.deepEqual(parsePatternToSegments("{NAME}_{Number}"), [
    { type: "token", key: "name" },
    { type: "text", value: "_" },
    { type: "token", key: "number" },
  ]);
});

test("parsePatternToSegments: an unrecognised brace stays literal text, not a token", () => {
  assert.deepEqual(parsePatternToSegments("{foo}_{name}"), [
    { type: "text", value: "{foo}_" },
    { type: "token", key: "name" },
  ]);
});

test("parsePatternToSegments: empty pattern is an empty segment list", () => {
  assert.deepEqual(parsePatternToSegments(""), []);
  assert.deepEqual(parsePatternToSegments(null), []);
  assert.deepEqual(parsePatternToSegments(undefined), []);
});

test("segmentsToPattern: inverse of parsePatternToSegments for every case above", () => {
  const cases = ["AMFAS_", "{number}", "{name}_{number}", "AMFAS_{name}_{number}", "{tag} - {name}", "{name} processed {number}", ""];
  for (const pattern of cases) {
    assert.equal(segmentsToPattern(parsePatternToSegments(pattern)), pattern, `round-trip failed for ${JSON.stringify(pattern)}`);
  }
});

test("segmentsToPattern: case-normalised tokens round-trip to the lowercase canonical form (not the original casing)", () => {
  assert.equal(segmentsToPattern(parsePatternToSegments("{NAME}_{Number}")), "{name}_{number}");
});

test("isKnownToken: recognises name/tag/key/tempo/number, case-insensitively, and nothing else", () => {
  assert.ok(isKnownToken("name"));
  assert.ok(isKnownToken("TAG"));
  assert.ok(isKnownToken("Number"));
  assert.ok(isKnownToken("key"));
  assert.ok(isKnownToken("KEY"));
  assert.ok(isKnownToken("tempo"));
  assert.ok(isKnownToken("Tempo"));
  assert.ok(!isKnownToken("foo"));
  assert.ok(!isKnownToken(""));
});

test("parsePatternToSegments: {tempo} and {key} parse as independent tokens, same as {tag}", () => {
  assert.deepEqual(parsePatternToSegments("{name}_{tempo}_{key}_{number}"), [
    { type: "token", key: "name" },
    { type: "text", value: "_" },
    { type: "token", key: "tempo" },
    { type: "text", value: "_" },
    { type: "token", key: "key" },
    { type: "text", value: "_" },
    { type: "token", key: "number" },
  ]);
});

// --- resolveNamePattern: the actual filename-token substitution ---------------------------------

test("resolveNamePattern: a pattern using both {tempo} and {key} independently", () => {
  assert.equal(
    resolveNamePattern("{name}_{tempo}_{key}_{number}", { name: "vocal", tempo: "120", key: "Cm", number: "01" }),
    "vocal_120_Cm_01"
  );
});

test("resolveNamePattern: {tempo} without {key} - the other token is simply absent, not forced in", () => {
  assert.equal(resolveNamePattern("{name}_{tempo}_{number}", { name: "vocal", tempo: "120", number: "01" }), "vocal_120_01");
});

test("resolveNamePattern: {key} without {tempo}", () => {
  assert.equal(resolveNamePattern("{name}_{key}_{number}", { name: "vocal", key: "Cm", number: "01" }), "vocal_Cm_01");
});

test("resolveNamePattern: neither {tempo} nor {key} - unaffected, same as before either existed", () => {
  assert.equal(resolveNamePattern("{name}_{number}", { name: "vocal", tempo: "120", key: "Cm", number: "01" }), "vocal_01");
});

test("resolveNamePattern: the combined {tag} token still works unchanged, independently of {tempo}/{key}", () => {
  assert.equal(
    resolveNamePattern("{name}_{tag}_{number}", { name: "vocal", tag: "Cm 120bpm", tempo: "120", key: "Cm", number: "01" }),
    "vocal_Cm 120bpm_01"
  );
});

test("resolveNamePattern: {tag}, {tempo} and {key} can all coexist in one pattern", () => {
  assert.equal(
    resolveNamePattern("{tag}_{tempo}_{key}_{number}", { tag: "Cm 120bpm", tempo: "120", key: "Cm", number: "01" }),
    "Cm 120bpm_120_Cm_01"
  );
});

test("resolveNamePattern: an undetected {tempo}/{key} (undefined) drops out as empty text, not a literal token", () => {
  assert.equal(resolveNamePattern("{name}_{tempo}_{key}_{number}", { name: "vocal", number: "01" }), "vocal___01");
});

test("resolveNamePattern: tokens are matched case-insensitively, same as parsePatternToSegments", () => {
  assert.equal(resolveNamePattern("{NAME}_{Tempo}_{KEY}_{number}", { name: "vocal", tempo: "120", key: "Cm", number: "01" }), "vocal_120_Cm_01");
});

test("resolveNamePattern: an unrecognised {foo} is left literal, same as parsePatternToSegments", () => {
  assert.equal(resolveNamePattern("{foo}_{name}", { name: "vocal" }), "{foo}_vocal");
});

console.log(`\n${passed} test(s) passed.`);
