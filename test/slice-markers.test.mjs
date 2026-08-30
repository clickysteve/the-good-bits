// Node-side unit tests for js/slice-markers.js - the pure region -> cue-frame math and the M8
// marker-count check behind "WAV with Slice Markers" export.
// Run with: node test/slice-markers.test.mjs
import assert from "node:assert/strict";
import { regionStartsToCueFrames, checkM8MarkerLimit, M8_MAX_MARKERS } from "../js/slice-markers.js";

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

// --- regionStartsToCueFrames ---------------------------------------------------------------------

test("known offset: 48kHz, region starts 0.0/1.0/2.5s -> frames 0/48000/120000", () => {
  const regions = [
    [0, 1.0],
    [1.0, 2.5],
    [2.5, 4.0],
  ];
  assert.deepEqual(regionStartsToCueFrames(regions, 48000, 48000 * 5), [0, 48000, 120000]);
});

test("only region STARTS become cue points - ends are ignored (implicit slice boundaries)", () => {
  const regions = [
    [0, 1.0],
    [1.0, 2.5],
  ];
  assert.deepEqual(regionStartsToCueFrames(regions, 48000, 48000 * 5).length, 2);
});

test("no synthetic end-of-file marker is ever added", () => {
  const regions = [[0, 1.0]];
  const got = regionStartsToCueFrames(regions, 48000, 48000 * 5);
  assert.deepEqual(got, [0], "exactly one cue for one region, no extra EOF cue");
});

test("regions are sorted by start before conversion, regardless of input order", () => {
  const regions = [
    [2.5, 4.0],
    [0, 1.0],
    [1.0, 2.5],
  ];
  assert.deepEqual(regionStartsToCueFrames(regions, 48000, 48000 * 5), [0, 48000, 120000]);
});

test("first region genuinely starting later than zero is preserved, not forced to 0", () => {
  const regions = [
    [0.5, 1.5],
    [1.5, 3.0],
  ];
  assert.deepEqual(regionStartsToCueFrames(regions, 48000, 48000 * 5), [24000, 72000]);
});

test("non-integer-second starts round to the nearest sample frame", () => {
  const sampleRate = 44100;
  const regions = [[0.3333333, 1.0]];
  const got = regionStartsToCueFrames(regions, sampleRate, sampleRate * 2);
  assert.deepEqual(got, [Math.round(0.3333333 * sampleRate)]);
});

test("a start at or past EOF clamps to the last valid frame", () => {
  const frameCount = 1000;
  const regions = [
    [0, 0.5],
    [1000 / 48000, 2], // starts exactly at frameCount
    [5, 6], // starts well past EOF
  ];
  const got = regionStartsToCueFrames(regions, 48000, frameCount);
  assert.deepEqual(got, [0, 999, 999]);
});

test("no regions -> no cue points (caller is responsible for not writing a misleading marker file)", () => {
  assert.deepEqual(regionStartsToCueFrames([], 48000, 48000), []);
});

test("one region -> one cue point", () => {
  assert.deepEqual(regionStartsToCueFrames([[0, 5]], 48000, 48000 * 5), [0]);
});

test("zero frameCount clamps every start to frame 0 rather than going negative", () => {
  assert.deepEqual(regionStartsToCueFrames([[0.1, 0.2]], 48000, 0), [0]);
});

// --- checkM8MarkerLimit ----------------------------------------------------------------------------

test("checkM8MarkerLimit: exactly at the limit (128) is ok", () => {
  const result = checkM8MarkerLimit(128);
  assert.equal(result.ok, true);
  assert.equal(result.count, 128);
  assert.equal(result.limit, M8_MAX_MARKERS);
});

test("checkM8MarkerLimit: one over the limit (129) is not ok", () => {
  const result = checkM8MarkerLimit(129);
  assert.equal(result.ok, false);
});

test("checkM8MarkerLimit: well under the limit is ok", () => {
  assert.equal(checkM8MarkerLimit(1).ok, true);
  assert.equal(checkM8MarkerLimit(0).ok, true);
});

test("M8_MAX_MARKERS is 128", () => {
  assert.equal(M8_MAX_MARKERS, 128);
});

console.log(`\n${passed} test(s) passed.`);
