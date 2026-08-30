// Node-side unit tests for js/edit-history.js - the pure per-(file, region-set) undo/redo stack
// behind the Chop editor's Undo/Redo. Run with: node test/edit-history.test.mjs
import assert from "node:assert/strict";
import { regionsEqual, ensureHistory, commitHistory, canUndo, canRedo, undoHistory, redoHistory } from "../js/edit-history.js";

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

// --- regionsEqual -----------------------------------------------------------------------------

test("regionsEqual: identical content, different arrays -> equal", () => {
  assert.ok(regionsEqual([[0, 1], [1, 2]], [[0, 1], [1, 2]]));
});

test("regionsEqual: different length or different boundary -> not equal", () => {
  assert.ok(!regionsEqual([[0, 1]], [[0, 1], [1, 2]]));
  assert.ok(!regionsEqual([[0, 1]], [[0, 1.001]]));
});

test("regionsEqual: null/undefined never equal to a real list", () => {
  assert.ok(!regionsEqual(null, [[0, 1]]));
  assert.ok(!regionsEqual([[0, 1]], undefined));
});

// --- ensureHistory (lazy baseline) -------------------------------------------------------------

test("ensureHistory: null history -> creates a fresh one rooted at the given baseline", () => {
  const h = ensureHistory(null, [[0, 1], [1, 2]], 1);
  assert.deepEqual(h, { entries: [{ regions: [[0, 1], [1, 2]], selected: 1 }], index: 0 });
});

test("ensureHistory: already has entries -> returned unchanged, baseline args ignored", () => {
  const existing = { entries: [{ regions: [[0, 5]], selected: null }], index: 0 };
  const h = ensureHistory(existing, [[9, 9]], 7);
  assert.strictEqual(h, existing);
});

test("ensureHistory: clones the baseline regions rather than aliasing them", () => {
  const baseline = [[0, 1]];
  const h = ensureHistory(null, baseline);
  baseline[0][0] = 99;
  assert.deepEqual(h.entries[0].regions, [[0, 1]]);
});

// --- commitHistory ------------------------------------------------------------------------------

test("commitHistory: pushes a new current entry and advances index", () => {
  let h = ensureHistory(null, [[0, 1]], null);
  h = commitHistory(h, [[0, 0.5], [0.5, 1]], 0);
  assert.equal(h.index, 1);
  assert.deepEqual(h.entries, [
    { regions: [[0, 1]], selected: null },
    { regions: [[0, 0.5], [0.5, 1]], selected: 0 },
  ]);
});

test("commitHistory: a new edit after Undo discards the redo tail", () => {
  let h = ensureHistory(null, [[0, 1]]);
  h = commitHistory(h, [[0, 1], [1, 2]]); // edit A, index 1
  h = commitHistory(h, [[0, 1], [1, 2], [2, 3]]); // edit B, index 2
  const undone = undoHistory(h); // back to A
  h = undone.history;
  assert.equal(h.index, 1);
  h = commitHistory(h, [[0, 9]]); // a genuinely new edit
  assert.equal(h.index, 2);
  assert.equal(h.entries.length, 3, "edit B must be gone, replaced by the new edit");
  assert.deepEqual(h.entries[2].regions, [[0, 9]]);
  assert.equal(canRedo(h), false);
});

test("commitHistory: clones regions so a later external mutation can't corrupt the stored entry", () => {
  let h = ensureHistory(null, [[0, 1]]);
  const live = [[0, 2]];
  h = commitHistory(h, live);
  live[0][0] = 999;
  assert.deepEqual(h.entries[1].regions, [[0, 2]]);
});

test("commitHistory: enforces a history limit by dropping the oldest entry", () => {
  let h = ensureHistory(null, [[0, 0]]);
  for (let i = 1; i <= 5; i++) h = commitHistory(h, [[0, i]], null, 3);
  assert.equal(h.entries.length, 3, "must never exceed the limit");
  assert.equal(h.index, 2, "index stays pointing at the current (most recent) entry");
  assert.deepEqual(h.entries[h.index].regions, [[0, 5]]);
});

// --- canUndo / canRedo ---------------------------------------------------------------------------

test("canUndo/canRedo: freshly-established baseline (index 0, one entry) - nothing to undo or redo", () => {
  const h = ensureHistory(null, [[0, 1]]);
  assert.equal(canUndo(h), false);
  assert.equal(canRedo(h), false);
});

test("canUndo/canRedo: null history - both false, never throws", () => {
  assert.equal(canUndo(null), false);
  assert.equal(canRedo(null), false);
});

test("canUndo/canRedo: after one commit, undo is available and redo is not", () => {
  let h = ensureHistory(null, [[0, 1]]);
  h = commitHistory(h, [[0, 2]]);
  assert.equal(canUndo(h), true);
  assert.equal(canRedo(h), false);
});

// --- undoHistory / redoHistory --------------------------------------------------------------------

test("undoHistory: nothing to undo -> null", () => {
  const h = ensureHistory(null, [[0, 1]]);
  assert.equal(undoHistory(h), null);
});

test("undoHistory: single Undo restores the state immediately before the last edit", () => {
  let h = ensureHistory(null, [[0, 2.5]], null); // baseline, e.g. "2.500"
  h = commitHistory(h, [[0, 3.2]], null); // dragged to 3.200
  const result = undoHistory(h);
  assert.deepEqual(result.snapshot, { regions: [[0, 2.5]], selected: null });
  assert.equal(result.history.index, 0);
});

test("redoHistory: nothing to redo -> null", () => {
  const h = ensureHistory(null, [[0, 1]]);
  assert.equal(redoHistory(h), null);
});

test("Undo then Redo round-trips: edit A, edit B, undo B, undo A, redo A, redo B", () => {
  let h = ensureHistory(null, [[0, 1]], null); // baseline
  h = commitHistory(h, [[0, 1], [1, 2]], 0); // edit A
  h = commitHistory(h, [[0, 1], [1, 2], [2, 3]], 1); // edit B

  let r = undoHistory(h);
  h = r.history;
  assert.deepEqual(r.snapshot.regions, [[0, 1], [1, 2]], "undo B -> back to A");

  r = undoHistory(h);
  h = r.history;
  assert.deepEqual(r.snapshot.regions, [[0, 1]], "undo A -> back to baseline");

  r = redoHistory(h);
  h = r.history;
  assert.deepEqual(r.snapshot.regions, [[0, 1], [1, 2]], "redo -> A again");

  r = redoHistory(h);
  h = r.history;
  assert.deepEqual(r.snapshot.regions, [[0, 1], [1, 2], [2, 3]], "redo -> B again");
});

test("undoHistory/redoHistory: snapshot is a clone, independent of the entry still held in the stack", () => {
  let h = ensureHistory(null, [[0, 1]]);
  h = commitHistory(h, [[0, 2]]);
  const result = undoHistory(h);
  result.snapshot.regions[0][0] = 999;
  assert.deepEqual(h.entries[0].regions, [[0, 1]], "mutating the returned snapshot must not touch the stack");
});

console.log(`\n${passed} test(s) passed.`);
