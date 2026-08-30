// Node-side unit tests for js/output-scope.js - the pure task-eligibility and
// primary/secondary-export decisions behind "CHOP gets Output Stage without the redundant clean
// export bug". Run with: node test/output-scope.test.mjs
import assert from "node:assert/strict";
import { isLofiActive, lofiSnapshotForTask, wantsCleanSecondary } from "../js/output-scope.js";

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

const off = { enabled: false };
const on = { enabled: true };

// --- isLofiActive ---------------------------------------------------------------------------

test("isLofiActive: CHOP defaults to Output Stage off -> inactive", () => {
  assert.equal(isLofiActive("chop", off, off, off), false);
});

test("isLofiActive: CHOP with Output Stage on -> active", () => {
  assert.equal(isLofiActive("chop", on, off, off), true);
});

test("isLofiActive: CHOP ignores Drive/Crunch even if a stale BOTH-session setting left them on", () => {
  assert.equal(isLofiActive("chop", off, on, off), false);
  assert.equal(isLofiActive("chop", off, off, on), false);
  assert.equal(isLofiActive("chop", off, on, on), false);
});

test("isLofiActive: STRETCH/BOTH still consider Output Stage, Drive, and Crunch together (unchanged)", () => {
  for (const task of ["stretch", "both"]) {
    assert.equal(isLofiActive(task, off, off, off), false);
    assert.equal(isLofiActive(task, on, off, off), true);
    assert.equal(isLofiActive(task, off, on, off), true);
    assert.equal(isLofiActive(task, off, off, on), true);
  }
});

// --- lofiSnapshotForTask ----------------------------------------------------------------------

test("lofiSnapshotForTask: CHOP snapshot forces drive/crunch off regardless of their own enabled flag", () => {
  const snap = lofiSnapshotForTask("chop", { enabled: true, mode: "cassette" }, { enabled: true, type: "tape" }, { enabled: true, bits: 8 });
  assert.equal(snap.outputStage.enabled, true);
  assert.equal(snap.outputStage.mode, "cassette");
  assert.equal(snap.drive.enabled, false);
  assert.equal(snap.crunch.enabled, false);
});

test("lofiSnapshotForTask: BOTH/STRETCH snapshot passes all three stages through unchanged", () => {
  const outputStage = { enabled: true, mode: "vinyl" };
  const drive = { enabled: true, type: "tape" };
  const crunch = { enabled: true, bits: 8 };
  for (const task of ["stretch", "both"]) {
    const snap = lofiSnapshotForTask(task, outputStage, drive, crunch);
    assert.deepEqual(snap, { outputStage, drive, crunch });
  }
});

test("lofiSnapshotForTask: returns fresh objects, never aliasing the settings passed in", () => {
  const outputStage = { enabled: true };
  const snap = lofiSnapshotForTask("both", outputStage, off, off);
  assert.notStrictEqual(snap.outputStage, outputStage);
});

// --- wantsCleanSecondary ----------------------------------------------------------------------

test("wantsCleanSecondary: Output Stage OFF -> never a secondary clean copy, even if the checkbox is on", () => {
  assert.equal(wantsCleanSecondary(false, true), false);
  assert.equal(wantsCleanSecondary(false, false), false);
});

test("wantsCleanSecondary: Output Stage ON + also-export-clean OFF -> processed only, no secondary", () => {
  assert.equal(wantsCleanSecondary(true, false), false);
});

test("wantsCleanSecondary: Output Stage ON + also-export-clean ON -> secondary clean copy wanted", () => {
  assert.equal(wantsCleanSecondary(true, true), true);
});

console.log(`\n${passed} test(s) passed.`);
