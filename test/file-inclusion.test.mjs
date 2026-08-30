// Node-side unit tests for js/file-inclusion.js - the pure logic behind per-source-file
// include/exclude in the folder/file picker (`included`), AND the separate per-source "Include in
// export" toggle on the results card (`exportIncluded`). Run with: node test/file-inclusion.test.mjs
import assert from "node:assert/strict";
import {
  isIncluded,
  normalizeIncludedFiles,
  includedFiles,
  setAllIncluded,
  noFilesIncluded,
  resolveActiveKey,
  isExportIncluded,
  normalizeExportIncludedFiles,
  exportableFiles,
  setAllExportIncluded,
  noFilesExportIncluded,
} from "../js/file-inclusion.js";

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

// --- isIncluded -------------------------------------------------------------------------------

test("isIncluded: a freshly-discovered file with no `included` field at all counts as included", () => {
  assert.equal(isIncluded({ name: "a.wav" }), true);
});

test("isIncluded: included:true is included, included:false is not", () => {
  assert.equal(isIncluded({ name: "a.wav", included: true }), true);
  assert.equal(isIncluded({ name: "a.wav", included: false }), false);
});

// --- normalizeIncludedFiles ---------------------------------------------------------------------

test("normalizeIncludedFiles: stamps included:true onto files discovered with no inclusion state yet", () => {
  const files = [{ name: "a.wav" }, { name: "b.wav" }];
  const normalized = normalizeIncludedFiles(files);
  assert.ok(normalized.every((f) => f.included === true));
});

test("normalizeIncludedFiles: leaves an already-decided file's inclusion state alone", () => {
  const files = [{ name: "a.wav", included: false }, { name: "b.wav" }];
  const normalized = normalizeIncludedFiles(files);
  assert.equal(normalized[0].included, false);
  assert.equal(normalized[1].included, true);
});

// --- includedFiles ------------------------------------------------------------------------------

test("includedFiles: filters out only the explicitly-excluded files", () => {
  const files = [{ name: "a", included: true }, { name: "b", included: false }, { name: "c" }];
  assert.deepEqual(
    includedFiles(files).map((f) => f.name),
    ["a", "c"]
  );
});

// --- setAllIncluded (Select All / Deselect All) --------------------------------------------------

test("setAllIncluded: Select All sets every file's flag to true, in place", () => {
  const files = [{ name: "a", included: false }, { name: "b", included: false }];
  setAllIncluded(files, true);
  assert.ok(files.every((f) => f.included === true));
});

test("setAllIncluded: Deselect All sets every file's flag to false, in place", () => {
  const files = [{ name: "a" }, { name: "b", included: true }];
  setAllIncluded(files, false);
  assert.ok(files.every((f) => f.included === false));
});

test("setAllIncluded: mutates the existing objects rather than replacing them (identity preserved)", () => {
  const fileA = { name: "a" };
  const files = [fileA];
  setAllIncluded(files, false);
  assert.strictEqual(files[0], fileA);
  assert.equal(fileA.included, false);
});

// --- noFilesIncluded ------------------------------------------------------------------------------

test("noFilesIncluded: true when every folder's every file is excluded", () => {
  const folders = [{ files: [{ included: false }, { included: false }] }, { files: [{ included: false }] }];
  assert.equal(noFilesIncluded(folders), true);
});

test("noFilesIncluded: false as soon as a single included file exists anywhere", () => {
  const folders = [{ files: [{ included: false }] }, { files: [{ included: true }] }];
  assert.equal(noFilesIncluded(folders), false);
});

test("noFilesIncluded: true for an empty folder list, and for folders with no files", () => {
  assert.equal(noFilesIncluded([]), true);
  assert.equal(noFilesIncluded([{ files: [] }]), true);
});

// --- resolveActiveKey (active-file fallback after exclusion) ---------------------------------------

test("resolveActiveKey: keeps the current key if it's still among the included items", () => {
  const items = [{ key: "a" }, { key: "b" }];
  assert.equal(resolveActiveKey(items, "b", (i) => i.key), "b");
});

test("resolveActiveKey: falls back to the first included item when the current one was excluded", () => {
  const items = [{ key: "a" }, { key: "b" }];
  assert.equal(resolveActiveKey(items, "excluded-one", (i) => i.key), "a");
});

test("resolveActiveKey: falls back to null when nothing remains included (the zero-included-files case)", () => {
  assert.equal(resolveActiveKey([], "anything", (i) => i.key), null);
});

// --- isExportIncluded ---------------------------------------------------------------------------
// (test 1: new imported file defaults export ON)

test("isExportIncluded: a freshly-processed file with no `exportIncluded` field at all counts as included", () => {
  assert.equal(isExportIncluded({ name: "a.wav" }), true);
});

test("isExportIncluded: exportIncluded:true is included, exportIncluded:false is not", () => {
  assert.equal(isExportIncluded({ name: "a.wav", exportIncluded: true }), true);
  assert.equal(isExportIncluded({ name: "a.wav", exportIncluded: false }), false);
});

// --- exportIncluded is independent of included (test 2: per-file OFF state is independent) --------

test("exportIncluded and included are independent flags - toggling one never affects the other", () => {
  const jobExcludedButExportable = { included: false, exportIncluded: true };
  assert.equal(isIncluded(jobExcludedButExportable), false);
  assert.equal(isExportIncluded(jobExcludedButExportable), true);

  const jobIncludedButExportOff = { included: true, exportIncluded: false };
  assert.equal(isIncluded(jobIncludedButExportOff), true);
  assert.equal(isExportIncluded(jobIncludedButExportOff), false);
});

test("setAllExportIncluded never touches `included`, and setAllIncluded never touches `exportIncluded`", () => {
  const files = [{ included: true, exportIncluded: true }, { included: true, exportIncluded: true }];
  setAllExportIncluded(files, false);
  assert.ok(files.every((f) => f.included === true && f.exportIncluded === false));
  setAllIncluded(files, false);
  assert.ok(files.every((f) => f.included === false && f.exportIncluded === false));
});

// --- normalizeExportIncludedFiles (recursive folder import: every discovered source starts ON) ----

test("normalizeExportIncludedFiles: stamps exportIncluded:true onto every freshly-discovered file", () => {
  const files = [{ name: "a.wav" }, { relativeDir: "kicks", name: "a.wav" }, { relativeDir: "snares", name: "a.wav" }];
  const normalized = normalizeExportIncludedFiles(files);
  assert.ok(normalized.every((f) => f.exportIncluded === true));
});

test("normalizeExportIncludedFiles: leaves an already-decided file's export state alone", () => {
  const files = [{ name: "a.wav", exportIncluded: false }, { name: "b.wav" }];
  const normalized = normalizeExportIncludedFiles(files);
  assert.equal(normalized[0].exportIncluded, false);
  assert.equal(normalized[1].exportIncluded, true);
});

test("duplicate basenames in different folders retain independent export flags (test 15)", () => {
  const files = [
    { relativeDir: "kicks", name: "sample.wav" },
    { relativeDir: "snares", name: "sample.wav" },
  ];
  const normalized = normalizeExportIncludedFiles(files);
  normalized[0].exportIncluded = false; // turn off only the kicks/sample.wav copy
  assert.equal(isExportIncluded(normalized[0]), false);
  assert.equal(isExportIncluded(normalized[1]), true, "the snares/sample.wav copy must be untouched");
});

// --- exportableFiles (what Export/marker-WAV/Output Stage export paths should actually act on) ----

test("exportableFiles: requires BOTH included AND exportIncluded - a job-excluded file can never be exportable", () => {
  const files = [
    { name: "a", included: false, exportIncluded: true }, // job-excluded: never processed, so never exportable
    { name: "b", included: true, exportIncluded: false }, // processed, but export turned off
    { name: "c", included: true, exportIncluded: true }, // the only genuinely exportable one
  ];
  assert.deepEqual(
    exportableFiles(files).map((f) => f.name),
    ["c"]
  );
});

test("exportableFiles: turning export back ON restores eligibility immediately (test 9)", () => {
  const file = { name: "a", included: true, exportIncluded: false };
  assert.equal(exportableFiles([file]).length, 0);
  file.exportIncluded = true;
  assert.equal(exportableFiles([file]).length, 1);
});

// --- noFilesExportIncluded (the zero-exportable-files guard - test 14) -----------------------------

test("noFilesExportIncluded: true when every file in every folder has export off", () => {
  const folders = [{ files: [{ included: true, exportIncluded: false }] }, { files: [{ included: true, exportIncluded: false }] }];
  assert.equal(noFilesExportIncluded(folders), true);
});

test("noFilesExportIncluded: false as soon as a single exportable file exists anywhere", () => {
  const folders = [{ files: [{ included: true, exportIncluded: false }] }, { files: [{ included: true, exportIncluded: true }] }];
  assert.equal(noFilesExportIncluded(folders), false);
});

test("noFilesExportIncluded: true for an empty folder list, and for folders with no files", () => {
  assert.equal(noFilesExportIncluded([]), true);
  assert.equal(noFilesExportIncluded([{ files: [] }]), true);
});

test("noFilesExportIncluded: true when files are job-included but ALL export-excluded (Process can still run)", () => {
  const folders = [{ files: [{ included: true, exportIncluded: false }, { included: true, exportIncluded: false }] }];
  assert.equal(noFilesExportIncluded(folders), true);
  // ...but noFilesIncluded (the Process gate) is false - Process must stay available.
  assert.equal(noFilesIncluded(folders), false);
});

console.log(`\n${passed} test(s) passed.`);
