// Node-side unit tests for js/naming-tokens.js - the pure string<->segment conversion behind the
// File Name Pattern token editor. Run with: node test/naming-tokens.test.mjs
import assert from "node:assert/strict";
import { parsePatternToSegments, segmentsToPattern, isKnownToken } from "../js/naming-tokens.js";

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

test("isKnownToken: recognises exactly name/tag/number, case-insensitively, and nothing else", () => {
  assert.ok(isKnownToken("name"));
  assert.ok(isKnownToken("TAG"));
  assert.ok(isKnownToken("Number"));
  assert.ok(!isKnownToken("foo"));
  assert.ok(!isKnownToken(""));
});

console.log(`\n${passed} test(s) passed.`);
