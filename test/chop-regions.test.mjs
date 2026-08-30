// Node-side unit tests for js/chop-regions.js - the pure decision logic behind "Process must
// preserve user-edited chops". Run with: node test/chop-regions.test.mjs
import assert from "node:assert/strict";
import { resolveRegions, replaceRegions, resolveSelection } from "../js/chop-regions.js";

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

// --- resolveRegions -------------------------------------------------------------------------

test("resolveRegions: no existing regions -> runs detectFresh and treats the result as a new baseline", () => {
  let detectCalls = 0;
  const detectFresh = () => {
    detectCalls++;
    return [[0, 1], [1, 2]];
  };
  const result = resolveRegions(null, null, detectFresh);
  assert.equal(detectCalls, 1);
  assert.deepEqual(result.regions, [[0, 1], [1, 2]]);
  assert.deepEqual(result.baseline, [[0, 1], [1, 2]]);
  assert.equal(result.reused, false);
});

test("resolveRegions: existing (edited) regions present -> reused as-is, detectFresh never called", () => {
  let detectCalls = 0;
  const edited = [[0, 0.5], [0.5, 3]]; // e.g. a boundary dragged, or a region manually added/removed
  const result = resolveRegions(edited, [[0, 1], [1, 3]], () => {
    detectCalls++;
    return [[0, 1], [1, 3]];
  });
  assert.equal(detectCalls, 0, "Process must not re-detect once there is something to preserve");
  assert.strictEqual(result.regions, edited);
  assert.deepEqual(result.baseline, [[0, 1], [1, 3]]);
  assert.equal(result.reused, true);
});

test("resolveRegions: existing regions but no baseline yet -> baseline falls back to a clone of the current regions", () => {
  const edited = [[0, 1]];
  const result = resolveRegions(edited, null, () => {
    throw new Error("must not detect");
  });
  assert.deepEqual(result.baseline, [[0, 1]]);
  assert.notStrictEqual(result.baseline, edited, "baseline must be a clone, not an alias of the live regions");
});

test("resolveRegions: an empty array (0 regions - e.g. a manual 'Clear') is a valid existing state, not treated as absent", () => {
  let detectCalls = 0;
  const result = resolveRegions([], [], () => {
    detectCalls++;
    return [[0, 1]];
  });
  assert.equal(detectCalls, 0);
  assert.deepEqual(result.regions, []);
});

// --- replaceRegions (explicit re-chop/clear) -------------------------------------------------

test("replaceRegions: produces a fresh baseline matching the new regions, independent of any prior baseline", () => {
  const result = replaceRegions([[0, 2], [2, 4]]);
  assert.deepEqual(result.regions, [[0, 2], [2, 4]]);
  assert.deepEqual(result.baseline, [[0, 2], [2, 4]]);
  assert.notStrictEqual(result.regions, result.baseline, "regions and baseline must not alias the same arrays");
});

test("replaceRegions: clones its input rather than aliasing it, so a later external mutation can't corrupt it", () => {
  const input = [[0, 1]];
  const result = replaceRegions(input);
  input[0][0] = 99;
  assert.deepEqual(result.regions, [[0, 1]]);
});

// --- resolveSelection -------------------------------------------------------------------------

test("resolveSelection: a previously-selected index still in range is kept", () => {
  assert.equal(resolveSelection(2, 5), 2);
});

test("resolveSelection: an out-of-range index (e.g. the region was deleted) falls back to nothing selected", () => {
  assert.equal(resolveSelection(5, 3), null);
  assert.equal(resolveSelection(3, 3), null); // exactly at the boundary - also invalid
});

test("resolveSelection: null/undefined previous selection stays unselected", () => {
  assert.equal(resolveSelection(null, 5), null);
  assert.equal(resolveSelection(undefined, 5), null);
});

test("resolveSelection: a negative index is never valid", () => {
  assert.equal(resolveSelection(-1, 5), null);
});

console.log(`\n${passed} test(s) passed.`);
