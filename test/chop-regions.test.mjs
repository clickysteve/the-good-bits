// Node-side unit tests for js/chop-regions.js - the pure decision logic behind "Process must
// preserve user-edited chops". Run with: node test/chop-regions.test.mjs
import assert from "node:assert/strict";
import { resolveRegions, replaceRegions, resolveSelection, splitRegionAt } from "../js/chop-regions.js";

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

// --- splitRegionAt (double-click-to-split gesture) -------------------------------------------

test("splitRegionAt: splits the containing region at a known time into two regions starting exactly there", () => {
  const result = splitRegionAt([[0, 4]], 2.3, 0.03);
  assert.ok(result);
  assert.deepEqual(result.regions, [[0, 2.3], [2.3, 4]]);
  assert.equal(result.newIndex, 1, "the new (second) half is the one that should become selected");
});

test("splitRegionAt: preserves every neighbouring region exactly, only touching the one that contains the split point", () => {
  const before = [[0, 1], [1, 4], [4, 6]];
  const result = splitRegionAt(before, 2.3, 0.03);
  assert.deepEqual(result.regions, [[0, 1], [1, 2.3], [2.3, 4], [4, 6]]);
  assert.deepEqual(before, [[0, 1], [1, 4], [4, 6]], "must not mutate the input array/regions");
});

test("splitRegionAt: refuses (returns null) when the split point is effectively on an existing boundary", () => {
  assert.equal(splitRegionAt([[0, 4]], 0, 0.03), null, "exactly at the region's own start");
  assert.equal(splitRegionAt([[0, 4]], 4, 0.03), null, "exactly at the region's own end");
  assert.equal(splitRegionAt([[0, 1], [1, 4]], 1, 0.03), null, "exactly on a shared boundary between two regions");
});

test("splitRegionAt: refuses when the split point is too close to a neighbouring boundary to leave a valid region", () => {
  assert.equal(splitRegionAt([[0, 4]], 0.02, 0.03), null, "0.02s from the start, under the 0.03s minimum");
  assert.equal(splitRegionAt([[0, 4]], 3.99, 0.03), null, "0.01s from the end, under the 0.03s minimum");
});

test("splitRegionAt: never produces a zero-length or invalid-length region - every result respects the minimum", () => {
  const result = splitRegionAt([[0, 4]], 0.03, 0.03);
  assert.ok(result, "exactly at the minimum distance from the start is a valid split");
  assert.deepEqual(result.regions, [[0, 0.03], [0.03, 4]]);
  for (const [s, e] of result.regions) assert.ok(e - s >= 0.03, `region [${s}, ${e}] is shorter than the minimum`);
});

test("splitRegionAt: a time outside every region (e.g. a gap, or past the end) is refused rather than fabricating one", () => {
  assert.equal(splitRegionAt([[0, 1], [2, 3]], 1.5, 0.03), null, "in the gap between two regions");
  assert.equal(splitRegionAt([[0, 1]], 5, 0.03), null, "past the end of the only region");
  assert.equal(splitRegionAt([], 0.5, 0.03), null, "no regions at all");
});

console.log(`\n${passed} test(s) passed.`);
