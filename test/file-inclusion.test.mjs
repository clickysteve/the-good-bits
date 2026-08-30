// Node-side unit tests for js/file-inclusion.js - the pure logic behind per-source-file
// include/exclude in the folder/file picker. Run with: node test/file-inclusion.test.mjs
import assert from "node:assert/strict";
import { isIncluded, normalizeIncludedFiles, includedFiles, setAllIncluded, noFilesIncluded, resolveActiveKey } from "../js/file-inclusion.js";

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

console.log(`\n${passed} test(s) passed.`);
